import { createHash, createHmac, randomBytes } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { Exercise, MatchMode, RepObservation } from '@move-match/contracts';
import { RepObservationSchema } from '@move-match/contracts';
import { pool, redis, transaction } from './db.js';
import { AppError } from './errors.js';

const INVITE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const MODEL_VERSION = 'google-pose-landmarker-lite-float16';
const RULE: Record<Exercise, string> = { push_up: 'push_up_v1', pull_up: 'pull_up_v1' };
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
const nonce = () => randomBytes(32).toString('base64url');

function inviteCode(userId: string, idempotencyKey: string) {
  const secret = process.env.INVITE_CODE_SECRET;
  if (!secret || secret.length < 32) throw new AppError('Friend invites are not configured on this service.', 503, 'SERVICE_UNAVAILABLE', true);
  const digest = createHmac('sha256', secret).update(`invite:${userId}:${idempotencyKey}`).digest();
  const sessionNonce = createHmac('sha256', secret).update(`nonce:${userId}:${idempotencyKey}`).digest('base64url');
  const code = Array.from({ length: 8 }, (_, index) => INVITE_ALPHABET[digest[index] & 31]).join('');
  return { code, sessionNonce };
}

export async function configSnapshot() {
  const [{ rows: flags }, { rows: rules }, { rows: seasons }] = await Promise.all([
    pool.query<{ key: string; enabled: boolean }>('select key, enabled from public.feature_flags'),
    pool.query<{ exercise: Exercise; version: string; model_version: string; enabled: boolean }>('select exercise, version, model_version, enabled from public.exercise_rules'),
    pool.query<{ id: string; name: string; start_at: Date; end_at: Date }>('select id, name, start_at, end_at from public.seasons where now() >= start_at and now() < end_at limit 1'),
  ]);
  return {
    protocolVersion: 1,
    durationMs: 45_000,
    countdownMs: 5_000,
    flags: Object.fromEntries(flags.map((flag) => [flag.key, flag.enabled])),
    rules: rules.map((rule) => ({ exercise: rule.exercise, version: rule.version, modelVersion: rule.model_version, enabled: rule.enabled })),
    season: seasons[0] ?? null,
  };
}

async function enabled(exercise: Exercise, mode: MatchMode) {
  const flagKey = mode === 'friend' ? 'friend_matches_enabled' : `ranked_${exercise}_enabled`;
  const requiredFlags = mode === 'friend' ? [flagKey] : ['quick_match_enabled', flagKey];
  const { rows } = await pool.query<{ key: string; enabled: boolean }>('select key, enabled from public.feature_flags where key = any($1::text[])', [requiredFlags]);
  if (requiredFlags.some((key) => !rows.find((row) => row.key === key)?.enabled)) {
    throw new AppError(mode === 'friend' ? 'Friend challenges are not available yet.' : `${exercise === 'push_up' ? 'Push-up' : 'Pull-up'} ranked play is temporarily unavailable.`, 503, 'FEATURE_UNAVAILABLE', true);
  }
  const rule = await pool.query('select 1 from public.exercise_rules where exercise = $1 and version = $2 and enabled = true', [exercise, RULE[exercise]]);
  if (!rule.rowCount) throw new AppError('This movement rule is not enabled for online play.', 409, 'RULE_UNSUPPORTED');
  if (mode === 'ranked') {
    const season = await pool.query('select 1 from public.seasons where now() >= start_at and now() < end_at limit 1');
    if (!season.rowCount) throw new AppError('Ranked play is unavailable between seasons.', 503, 'FEATURE_UNAVAILABLE', true);
  }
}

function assertProfile(profile: { status: string; adult_confirmed_at: Date | null } | null) {
  if (!profile || !profile.adult_confirmed_at || profile.status !== 'active') throw new AppError('Complete adult account setup before online play.', 403, 'FORBIDDEN');
}

async function profileFor(client: PoolClient, userId: string) {
  const { rows } = await client.query<{ id: string; display_name: string; avatar_id: string; status: string; adult_confirmed_at: Date | null }>(
    'select id, display_name, avatar_id, status, adult_confirmed_at from public.profiles where id = $1 for update', [userId],
  );
  return rows[0] ?? null;
}

export async function createInvite(userId: string, exercise: Exercise, idempotencyKey: string) {
  await enabled(exercise, 'friend');
  return transaction(async (client) => {
    const profile = await profileFor(client, userId);
    assertProfile(profile);
    const deterministic = inviteCode(userId, idempotencyKey);
    const { rows: prior } = await client.query<{ match_id: string; expires_at: Date; state: string; exercise: Exercise }>(
      `select i.match_id, i.expires_at, i.state, m.exercise from public.invites i
       join public.matches m on m.id = i.match_id where i.host_id = $1 and i.idempotency_key = $2 for update of i`, [userId, idempotencyKey]);
    if (prior[0]) {
      if (prior[0].exercise !== exercise) throw new AppError('That request key belongs to a different exercise.', 409, 'INVALID_REQUEST');
      if (prior[0].state === 'OPEN' && prior[0].expires_at.getTime() > Date.now()) {
        await client.query('update public.match_participants set session_nonce_hash = $3 where match_id = $1 and user_id = $2', [prior[0].match_id, userId, sha256(deterministic.sessionNonce)]);
        return { matchId: prior[0].match_id, inviteCode: deterministic.code,
          expiresInSeconds: Math.max(0, Math.floor((prior[0].expires_at.getTime() - Date.now()) / 1000)),
          sessionNonce: deterministic.sessionNonce, exercise: prior[0].exercise, mode: 'friend' as const };
      }
      throw new AppError('That invite has expired or closed. Cancel it before creating another.', 410, 'INVITE_EXPIRED');
    }
    const active = await client.query('select 1 from public.active_sessions where user_id = $1', [userId]);
    if (active.rowCount) throw new AppError('You already have an active lobby or queue.', 409, 'ALREADY_ACTIVE');
    const { code, sessionNonce } = deterministic;
    const { rows: matches } = await client.query<{ id: string }>(
      `insert into public.matches(mode, exercise, rule_version, model_version, state)
       values ('friend', $1, $2, $3, 'WAITING_READY') returning id`, [exercise, RULE[exercise], MODEL_VERSION],
    );
    const matchId = matches[0].id;
    await client.query(`insert into public.match_participants(match_id, user_id, slot, display_name_snapshot, avatar_id_snapshot, session_nonce_hash)
      values ($1, $2, 1, $3, $4, $5)`, [matchId, userId, profile!.display_name, profile!.avatar_id, sha256(sessionNonce)]);
    const reserved = await client.query('insert into public.active_sessions(user_id, match_id) values ($1, $2) on conflict do nothing returning user_id', [userId, matchId]);
    if (!reserved.rowCount) throw new AppError('You already have an active lobby or queue.', 409, 'ALREADY_ACTIVE');
    await client.query('insert into public.invites(code_hash, host_id, idempotency_key, match_id, expires_at) values ($1, $2, $3, $4, now() + interval \'10 minutes\')',
      [sha256(code), userId, idempotencyKey, matchId]);
    return { matchId, inviteCode: code, expiresInSeconds: 600, sessionNonce, exercise, mode: 'friend' as const };
  });
}

export async function redeemInvite(userId: string, codeInput: string) {
  const code = codeInput.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (code.length !== 8) throw new AppError('Enter the 8-character invite code.', 400, 'INVALID_REQUEST');
  const joined = await transaction(async (client) => {
    const profile = await profileFor(client, userId);
    assertProfile(profile);
    const { rows } = await client.query<{ id: string; host_id: string; match_id: string; state: string; expires_at: Date; redeemed_by: string | null }>(
      'select id, host_id, match_id, state, expires_at, redeemed_by from public.invites where code_hash = $1 for update', [sha256(code)],
    );
    const invite = rows[0];
    if (!invite) throw new AppError('That invite is unavailable or has already been used.', 404, 'NOT_FOUND');
    const { rows: matchRows } = await client.query<{ exercise: Exercise; state: string }>('select exercise, state from public.matches where id = $1 for update', [invite.match_id]);
    if (invite.state === 'REDEEMED' && invite.redeemed_by === userId && matchRows[0]) {
      const { rows: joinedRows } = await client.query<{ slot: number }>(
        'select slot from public.match_participants where match_id = $1 and user_id = $2 for update', [invite.match_id, userId]);
      if (!joinedRows[0]) throw new AppError('This invite has already been used.', 404, 'NOT_FOUND');
      const sessionNonce = nonce();
      await client.query('update public.match_participants set session_nonce_hash = $3 where match_id = $1 and user_id = $2', [invite.match_id, userId, sha256(sessionNonce)]);
      return { hostId: invite.host_id, match: { matchId: invite.match_id, sessionNonce, exercise: matchRows[0].exercise, mode: 'friend' as const } };
    }
    if (invite.state !== 'OPEN') throw new AppError('That invite is unavailable or has already been used.', 404, 'NOT_FOUND');
    if (invite.expires_at.getTime() <= Date.now()) throw new AppError('That invite has expired. Ask for a new code.', 410, 'INVITE_EXPIRED');
    if (invite.host_id === userId) throw new AppError('You cannot join your own invite.', 409, 'INVALID_REQUEST');
    const active = await client.query('select 1 from public.active_sessions where user_id = $1', [userId]);
    if (active.rowCount) throw new AppError('You already have an active lobby or queue.', 409, 'ALREADY_ACTIVE');
    const blocked = await client.query('select 1 from public.blocks where (blocker_id = $1 and blocked_id = $2) or (blocker_id = $2 and blocked_id = $1) limit 1', [userId, invite.host_id]);
    if (blocked.rowCount) throw new AppError('This invite cannot be joined.', 403, 'FORBIDDEN');
    if (!matchRows[0] || matchRows[0].state !== 'WAITING_READY') throw new AppError('The lobby is no longer waiting for a player.', 409, 'NOT_FOUND');
    const sessionNonce = nonce();
    await client.query(`insert into public.match_participants(match_id, user_id, slot, display_name_snapshot, avatar_id_snapshot, session_nonce_hash)
      values ($1, $2, 2, $3, $4, $5)`, [invite.match_id, userId, profile!.display_name, profile!.avatar_id, sha256(sessionNonce)]);
    const reserved = await client.query('insert into public.active_sessions(user_id, match_id) values ($1, $2) on conflict do nothing returning user_id', [userId, invite.match_id]);
    if (!reserved.rowCount) throw new AppError('You already have an active lobby or queue.', 409, 'ALREADY_ACTIVE');
    await client.query("update public.invites set state = 'REDEEMED', redeemed_by = $2 where id = $1", [invite.id, userId]);
    await client.query("update public.matches set ready_deadline_at = null where id = $1", [invite.match_id]);
    return { hostId: invite.host_id, match: { matchId: invite.match_id, sessionNonce, exercise: matchRows[0].exercise, mode: 'friend' as const } };
  });
  await redis.publish('match-events', JSON.stringify({ type: 'match.found', matchId: joined.match.matchId, users: [userId, joined.hostId] })).catch(() => undefined);
  return joined.match;
}

export async function enqueue(userId: string, exercise: Exercise) {
  await enabled(exercise, 'ranked');
  const result = await transaction(async (client) => {
    const profile = await profileFor(client, userId);
    assertProfile(profile);
    const { rows: currentSeasons } = await client.query<{ id: string }>(
      'select id from public.seasons where now() >= start_at and now() < end_at limit 1',
    );
    if (!currentSeasons[0]) throw new AppError('Ranked play is between seasons. Try again when the next season opens.', 503, 'FEATURE_UNAVAILABLE', true);
    const seasonId = currentSeasons[0].id;
    await client.query("select pg_advisory_xact_lock(hashtextextended('queue:' || $1, 0))", [exercise]);
    const active = await client.query('select 1 from public.active_sessions where user_id = $1', [userId]);
    if (active.rowCount) throw new AppError('You already have an active lobby or queue.', 409, 'ALREADY_ACTIVE');
    const rating = await client.query<{ rating: number; games: number }>(
      'select rating, games from public.exercise_ratings where user_id = $1 and exercise = $2 and season_id = $3', [userId, exercise, seasonId],
    );
    const currentRating = rating.rows[0]?.rating ?? 1000;
    const currentGames = rating.rows[0]?.games ?? 0;
    const { rows: candidates } = await client.query<{ id: string; user_id: string; rating: number; display_name: string; avatar_id: string }>(
      `select q.id, q.user_id, q.rating, p.display_name, p.avatar_id from public.queue_entries q
       join public.profiles p on p.id = q.user_id and p.status = 'active' and p.adult_confirmed_at is not null
       left join public.exercise_ratings candidate_rating on candidate_rating.user_id = q.user_id
         and candidate_rating.exercise = q.exercise and candidate_rating.season_id = $4
       where q.exercise = $1 and q.rule_version = $6 and q.app_protocol = $7 and q.state = 'WAITING' and q.user_id <> $2
         and q.heartbeat_at > now() - interval '15 seconds'
         and abs(q.rating - $3) <= case when now() - q.created_at < interval '15 seconds' then 150
           when now() - q.created_at < interval '30 seconds' then 300 else 500 end
         and not exists (select 1 from public.blocks b where (b.blocker_id = $2 and b.blocked_id = q.user_id) or (b.blocker_id = q.user_id and b.blocked_id = $2))
         and not exists (select 1 from public.active_sessions a where a.user_id = q.user_id and (a.match_id is not null or a.queue_id <> q.id))
         and (select count(*) from public.matches m join public.match_participants me on me.match_id = m.id
            join public.match_participants them on them.match_id = m.id and them.user_id = q.user_id
            where me.user_id = $2 and m.mode = 'ranked' and m.exercise = $1 and m.state = 'COMPLETED'
              and m.created_at >= date_trunc('day', now() at time zone 'utc') at time zone 'utc') < 3
       order by case when $5::boolean and coalesce(candidate_rating.games, 0) < 5 then 0 else 1 end, q.created_at asc
       for update of q skip locked limit 1`, [exercise, userId, currentRating, seasonId, currentGames < 5, RULE[exercise], 1],
    );
    const { rows: ownRows } = await client.query<{ id: string }>(
      `insert into public.queue_entries(user_id, exercise, rule_version, rating) values ($1, $2, $3, $4) returning id`,
      [userId, exercise, RULE[exercise], currentRating],
    );
    const queueId = ownRows[0].id;
    await client.query('insert into public.active_sessions(user_id, queue_id) values ($1, $2)', [userId, queueId]);
    if (!candidates[0]) return { status: 'queued' as const, queueId, waitStartedAt: new Date().toISOString() };

    const opponent = candidates[0];
    const { rows: opponentRows } = await client.query<{ avatar_id: string; display_name: string }>(
      'select avatar_id, display_name from public.profiles where id = $1', [opponent.user_id],
    );
    const opponentNonce = nonce(); const ownNonce = nonce();
    const { rows: matchRows } = await client.query<{ id: string }>(
      `insert into public.matches(mode, exercise, rule_version, model_version, state, season_id, ready_deadline_at)
       values ('ranked', $1, $2, $3, 'WAITING_READY', $4, now() + interval '20 seconds') returning id`,
      [exercise, RULE[exercise], MODEL_VERSION, seasonId],
    );
    const matchId = matchRows[0].id;
    await client.query(`insert into public.match_participants(match_id, user_id, slot, display_name_snapshot, avatar_id_snapshot, session_nonce_hash)
      values ($1, $2, 1, $3, $4, $5), ($1, $6, 2, $7, $8, $9)`,
      [matchId, opponent.user_id, opponentRows[0]?.display_name ?? 'Player', opponentRows[0]?.avatar_id ?? 'move-01', sha256(opponentNonce), userId, profile!.display_name, profile!.avatar_id, sha256(ownNonce)]);
    await client.query("update public.queue_entries set state = 'MATCHED' where id = any($1::uuid[])", [[opponent.id, queueId]]);
    await client.query('update public.active_sessions set match_id = $2, queue_id = null where user_id = any($1::uuid[])', [[opponent.user_id, userId], matchId]);
    return { status: 'matched' as const, matchId, sessionNonce: ownNonce, exercise, mode: 'ranked' as const,
      usersToNotify: [userId, opponent.user_id] };
  }, 'SERIALIZABLE');
  if (result.status === 'matched') {
    await redis.publish('match-events', JSON.stringify({ type: 'match.found', matchId: result.matchId, users: result.usersToNotify })).catch(() => undefined);
    const { usersToNotify: _users, ...response } = result;
    return response;
  }
  return result;
}

export async function cancelQueue(userId: string) {
  return transaction(async (client) => {
    const { rows: activeRows } = await client.query<{ queue_id: string | null; match_id: string | null }>(
      'select queue_id, match_id from public.active_sessions where user_id = $1 for update', [userId]);
    const active = activeRows[0];
    if (active?.match_id) return { status: 'reserved' as const, matchId: active.match_id };
    if (!active?.queue_id) return { status: 'cancelled' as const };
    await client.query("update public.queue_entries set state = 'CANCELLED' where id = $1 and state in ('WAITING','RESERVED')", [active.queue_id]);
    await client.query('delete from public.active_sessions where user_id = $1 and queue_id = $2', [userId, active.queue_id]);
    return { status: 'cancelled' as const };
  });
}

export async function readyMatch(userId: string, matchId: string, sessionNonce: string) {
  return transaction(async (client) => {
    const { rows: matchRows } = await client.query<{ state: string; exercise: Exercise; duration_ms: number; mode: MatchMode; ready_deadline_at: Date | null }>(
      'select state, exercise, duration_ms, mode, ready_deadline_at from public.matches where id = $1 for update', [matchId],
    );
    const match = matchRows[0];
    if (!match) throw new AppError('Match not found.', 404, 'NOT_FOUND');
    if (!['WAITING_READY', 'COUNTDOWN'].includes(match.state)) throw new AppError('This match is no longer accepting readiness.', 409, 'INVALID_REQUEST');
    if (match.state === 'WAITING_READY' && match.mode === 'ranked' && match.ready_deadline_at && match.ready_deadline_at.getTime() <= Date.now()) {
      await client.query("update public.matches set state = 'CANCELLED', reason = 'ready_timeout', updated_at = now() where id = $1", [matchId]);
      await client.query('delete from public.active_sessions where match_id = $1', [matchId]);
      return { state: 'CANCELLED' as const, reason: 'ready_timeout' };
    }
    const updated = await client.query(
      `update public.match_participants set ready_at = now(), ready_expires_at = now() + interval '20 seconds', last_seen_at = now()
       where match_id = $1 and user_id = $2 and session_nonce_hash = $3`, [matchId, userId, sha256(sessionNonce)],
    );
    if (!updated.rowCount) throw new AppError('Match session expired. Reopen the match to reconnect.', 401, 'AUTH_EXPIRED');
    const { rows: participants } = await client.query<{ user_id: string; ready_at: Date | null; ready_expires_at: Date | null }>(
      'select user_id, ready_at, ready_expires_at from public.match_participants where match_id = $1 order by slot', [matchId],
    );
    if (participants.length !== 2) return { state: 'WAITING_READY' as const, readyCount: participants.filter((item) => item.ready_at).length };
    if (match.state === 'COUNTDOWN') {
      const { rows: current } = await client.query<{ start_at: Date; end_at: Date }>('select start_at, end_at from public.matches where id = $1', [matchId]);
      return { state: 'COUNTDOWN' as const, startAt: current[0].start_at.toISOString(), endAt: current[0].end_at.toISOString() };
    }
    const ready = participants.every((participant) => participant.ready_at && participant.ready_expires_at && participant.ready_expires_at.getTime() > Date.now());
    if (!ready) return { state: 'WAITING_READY' as const, readyCount: participants.filter((item) => item.ready_at).length };
    const startAt = new Date(Date.now() + 5_000);
    const endAt = new Date(startAt.getTime() + match.duration_ms);
    let seasonId: string | null = null;
    if (match.mode === 'ranked') {
      const { rows: seasons } = await client.query<{ id: string }>(
        'select id from public.seasons where start_at <= $1 and end_at > $1 for update', [startAt]);
      if (!seasons[0]) throw new AppError('The current season ended. Rejoin the queue when the next season opens.', 503, 'FEATURE_UNAVAILABLE', true);
      seasonId = seasons[0].id;
    }
    await client.query("update public.matches set state = 'COUNTDOWN', start_at = $2, end_at = $3, season_id = $4, updated_at = now() where id = $1", [matchId, startAt, endAt, seasonId]);
    return { state: 'COUNTDOWN' as const, startAt: startAt.toISOString(), endAt: endAt.toISOString() };
  });
}

export async function matchSnapshot(userId: string, matchId: string, renewNonce = true) {
  return transaction(async (client) => {
    const { rows: ownRows } = await client.query<{ slot: number; session_nonce_hash: string }>(
      'select slot, session_nonce_hash from public.match_participants where match_id = $1 and user_id = $2 for update', [matchId, userId],
    );
    if (!ownRows[0]) throw new AppError('Match not found.', 404, 'NOT_FOUND');
    let sessionNonce = '';
    if (renewNonce) {
      sessionNonce = nonce();
      await client.query('update public.match_participants set session_nonce_hash = $3 where match_id = $1 and user_id = $2', [matchId, userId, sha256(sessionNonce)]);
    }
    const { rows } = await client.query(`select m.id, m.mode, m.exercise, m.rule_version, m.model_version, m.state, m.start_at, m.end_at,
      p.slot, (p.user_id = $2::uuid) as is_self, p.display_name_snapshot, p.avatar_id_snapshot, p.accepted_count, p.connection_state,
      (r.winner_user_id = p.user_id) as is_winner, r.outcome, r.score_player_1, r.score_player_2, r.settled_at, r.reason,
      rl.before_rating as rating_before, rl.delta as rating_delta, rl.after_rating as rating_after,
      coalesce((select sum(x.amount) from public.xp_ledger x where x.source_type = 'match' and x.source_id = m.id and x.user_id = p.user_id), 0) as xp_awarded
      from public.matches m join public.match_participants p on p.match_id = m.id
      left join public.match_results r on r.match_id = m.id
      left join public.rating_ledger rl on rl.match_id = m.id and rl.user_id = p.user_id
      where m.id = $1 order by p.slot`, [matchId, userId]);
    const { rows: sequence } = await client.query<{ next_seq: number }>(
      'select coalesce(max(seq), 0) + 1 as next_seq from public.rep_events where match_id = $1 and user_id = $2', [matchId, userId]);
    return { matchId, sessionNonce: sessionNonce || undefined, nextSeq: sequence[0]?.next_seq ?? 1, participants: rows, serverTime: new Date().toISOString() };
  });
}

export async function acceptRep(userId: string, raw: unknown) {
  const parsed = RepObservationSchema.safeParse(raw);
  if (!parsed.success) throw new AppError('Rep event data is incomplete or outside protocol bounds.', 400, 'INVALID_REQUEST');
  const event = parsed.data;
  return transaction(async (client) => {
    const { rows: matches } = await client.query<{ state: string; exercise: Exercise; rule_version: string; model_version: string; start_at: Date | null; end_at: Date | null; duration_ms: number; mode: MatchMode }>(
      'select state, exercise, rule_version, model_version, start_at, end_at, duration_ms, mode from public.matches where id = $1 for update', [event.matchId],
    );
    const match = matches[0];
    if (!match) throw new AppError('Match not found.', 404, 'NOT_FOUND');
    const { rows: participants } = await client.query<{ session_nonce_hash: string; accepted_count: number; slot: number }>(
      'select session_nonce_hash, accepted_count, slot from public.match_participants where match_id = $1 and user_id = $2 for update', [event.matchId, userId],
    );
    const participant = participants[0];
    if (!participant || participant.session_nonce_hash !== sha256(event.sessionNonce)) throw new AppError('Match session is not valid.', 401, 'AUTH_EXPIRED');
    const { rows: sameEvent } = await client.query<{ match_id: string; user_id: string | null; seq: number; status: string; reason: string | null }>(
      'select match_id, user_id, seq, status, reason from public.rep_events where event_id = $1', [event.eventId]);
    if (sameEvent[0]) {
      if (sameEvent[0].match_id !== event.matchId || sameEvent[0].user_id !== userId || sameEvent[0].seq !== event.seq) {
        throw new AppError('This event identifier was already used.', 409, 'INVALID_REQUEST');
      }
      return { eventId: event.eventId, status: sameEvent[0].status, reason: sameEvent[0].reason, duplicate: true };
    }
    const rateKey = `rep-rate:${event.matchId}:${userId}:${Math.floor(Date.now() / 1000)}`;
    let rate: number;
    try { rate = await redis.incr(rateKey); if (rate === 1) await redis.expire(rateKey, 2); }
    catch { throw new AppError('The match service is temporarily unavailable.', 503, 'SERVICE_UNAVAILABLE', true); }
    if (rate > 5) throw new AppError('Rep events are arriving too quickly.', 429, 'RATE_LIMITED', true);
    const previous = await client.query<{ cycle_end_ms: number }>(
      "select cycle_end_ms from public.rep_events where match_id = $1 and user_id = $2 and status = 'accepted' order by seq desc limit 1", [event.matchId, userId],
    );
    let reason: string | null = null;
    const now = Date.now();
    if (event.exercise !== match.exercise || event.ruleVersion !== match.rule_version) reason = 'wrong_rule';
    else if (event.modelVersion !== match.model_version) reason = 'wrong_model';
    else if (match.state !== 'ACTIVE' || !match.start_at || !match.end_at || now > match.end_at.getTime() + 3_000) reason = 'outside_active_interval';
    else if (event.cycleEndMs > match.duration_ms || event.cycleStartMs < 0 || event.cycleEndMs > 45_000) reason = 'outside_active_interval';
    else if (event.cycleEndMs - event.cycleStartMs < (event.exercise === 'push_up' ? 600 : 900)) reason = 'incomplete_cycle';
    else if (event.minimumRequiredVisibility < 0.7 || event.trackingGapMs > 250) reason = 'invalid_measurement';
    else if (previous.rows[0] && event.cycleStartMs < previous.rows[0].cycle_end_ms) reason = 'impossible_sequence';
    else if (event.exercise === 'push_up' && (event.minElbowDeg > 95 || event.maxElbowDeg < 155)) reason = 'incomplete_cycle';
    else if (event.exercise === 'pull_up' && (event.minElbowDeg > 80 || event.maxElbowDeg < 155)) reason = 'incomplete_cycle';
    const { rows: sameSequence } = await client.query<{ event_id: string; status: string; reason: string | null }>(
      'select event_id, status, reason from public.rep_events where match_id = $1 and user_id = $2 and seq = $3', [event.matchId, userId, event.seq]);
    if (sameSequence[0]) {
      if (sameSequence[0].event_id === event.eventId) return { eventId: event.eventId, status: sameSequence[0].status, reason: sameSequence[0].reason, duplicate: true };
      throw new AppError('This event sequence was already used.', 409, 'INVALID_REQUEST');
    }
    const status = reason ? 'rejected' : 'accepted';
    const inserted = await client.query(`insert into public.rep_events(event_id, match_id, user_id, seq, cycle_start_ms, cycle_end_ms, status, reason, summary)
      values ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb) on conflict (event_id) do nothing returning id`,
      [event.eventId, event.matchId, userId, event.seq, event.cycleStartMs, event.cycleEndMs, status, reason, JSON.stringify(event)]);
    if (!inserted.rowCount) {
      const { rows: duplicate } = await client.query('select status, reason from public.rep_events where event_id = $1', [event.eventId]);
      return { eventId: event.eventId, status: duplicate[0]?.status ?? 'rejected', reason: duplicate[0]?.reason ?? 'duplicate_event', duplicate: true };
    }
    if (!reason) await client.query('update public.match_participants set accepted_count = accepted_count + 1 where match_id = $1 and user_id = $2', [event.matchId, userId]);
    return { eventId: event.eventId, status, reason, score: participant.accepted_count + (reason ? 0 : 1), duplicate: false, slot: participant.slot };
  });
}

async function settle(matchId: string, forfeitUserId?: string, voidReason?: string) {
  return transaction(async (client) => {
    const { rows: matches } = await client.query<{ mode: MatchMode; exercise: Exercise; state: string; end_at: Date | null; start_at: Date | null; season_id: string | null }>(
      'select mode, exercise, state, start_at, end_at, season_id from public.matches where id = $1 for update', [matchId],
    );
    const match = matches[0];
    if (!match) throw new AppError('Match not found.', 404, 'NOT_FOUND');
    const { rows: existing } = await client.query('select * from public.match_results where match_id = $1', [matchId]);
    if (existing[0]) return existing[0];
    if (!forfeitUserId && !voidReason && (!match.end_at || Date.now() < match.end_at.getTime() + 3_000)) {
      throw new AppError('This round is still in progress.', 409, 'RESULT_PENDING', true);
    }
    await client.query("update public.matches set state = 'SETTLING', updated_at = now() where id = $1", [matchId]);
    const { rows: participants } = await client.query<{ user_id: string | null; slot: number; accepted_count: number; connection_state: string }>(
      'select user_id, slot, accepted_count, connection_state from public.match_participants where match_id = $1 order by slot for update', [matchId],
    );
    const left = participants.find((item) => item.slot === 1);
    const right = participants.find((item) => item.slot === 2);
    const score1 = left?.accepted_count ?? 0;
    const score2 = right?.accepted_count ?? 0;
    const isVoid = Boolean(voidReason) || !right;
    const forfeitWinner = forfeitUserId ? participants.find((item) => item.user_id && item.user_id !== forfeitUserId) : undefined;
    const winner = isVoid ? null : forfeitUserId ? forfeitWinner?.user_id ?? null : score1 === score2 ? null : score1 > score2 ? left?.user_id ?? null : right?.user_id ?? null;
    const outcome = isVoid ? 'void' : forfeitUserId ? 'forfeit' : score1 === score2 ? 'draw' : score1 > score2 ? 'player_1_win' : 'player_2_win';
    const reason = voidReason ?? (forfeitUserId ? 'player_forfeit' : null);

    if (!isVoid && match.mode === 'ranked' && left?.user_id && right?.user_id) {
      if (match.season_id) await applyRating(client, matchId, match.exercise, match.season_id, left.user_id, right.user_id, winner);
    }
    if (!isVoid) await applyProgress(client, matchId, match.mode, match.exercise, participants, winner, forfeitUserId,
      match.start_at ? Date.now() - match.start_at.getTime() : 0);
    const digest = sha256(JSON.stringify({ matchId, outcome, score1, score2, reason }));
    await client.query(`insert into public.match_results(match_id, outcome, winner_user_id, score_player_1, score_player_2, reason, result_hash)
      values ($1, $2, $3, $4, $5, $6, $7) on conflict (match_id) do nothing`, [matchId, outcome, winner, score1, score2, reason, digest]);
    await client.query("update public.matches set state = $2, reason = $3, updated_at = now() where id = $1", [matchId, isVoid ? 'VOIDED' : 'COMPLETED', reason]);
    await client.query('delete from public.active_sessions where match_id = $1', [matchId]);
    await client.query('insert into public.outbox(aggregate_id, event_type, payload) values ($1, \'match.settled\', $2::jsonb)',
      [matchId, JSON.stringify({ matchId, outcome, winnerUserId: winner, scorePlayer1: score1, scorePlayer2: score2, reason })]);
    return { match_id: matchId, outcome, winner_user_id: winner, score_player_1: score1, score_player_2: score2, reason };
  });
}

async function applyRating(client: PoolClient, matchId: string, exercise: Exercise, seasonId: string, user1: string, user2: string, winner: string | null) {
  await client.query('select id from public.seasons where id = $1 for update', [seasonId]);
  const ids = [user1, user2].sort();
  const current: Record<string, number> = {};
  for (const userId of ids) {
    await client.query('insert into public.exercise_ratings(user_id, exercise, season_id) values ($1, $2, $3) on conflict do nothing', [userId, exercise, seasonId]);
    const result = await client.query<{ rating: number; games: number; distinct_opponents: string[] }>(
      'select rating, games, distinct_opponents from public.exercise_ratings where user_id = $1 and exercise = $2 and season_id = $3 for update', [userId, exercise, seasonId]);
    current[userId] = result.rows[0]?.rating ?? 1000;
  }
  const [r1, r2] = [current[user1], current[user2]];
  const actual1 = winner === user1 ? 1 : winner === user2 ? 0 : 0.5;
  const delta1 = Math.round(32 * (actual1 - 1 / (1 + 10 ** ((r2 - r1) / 400))));
    for (const [userId, opponent, before, delta] of [[user1, user2, r1, delta1], [user2, user1, r2, -delta1]] as const) {
      const next = before + delta;
      await client.query(`update public.exercise_ratings set rating = $4, games = games + 1,
      distinct_opponents = case when not ($5::uuid = any(distinct_opponents)) then array_append(distinct_opponents, $5::uuid) else distinct_opponents end,
      placement_opponents_count = greatest(placement_opponents_count, cardinality(distinct_opponents) + case when $5::uuid = any(distinct_opponents) then 0 else 1 end),
      eligible = games + 1 >= 5 and cardinality(distinct_opponents) + case when $5::uuid = any(distinct_opponents) then 0 else 1 end >= 3, updated_at = now()
      where user_id = $1 and exercise = $2 and season_id = $3`, [userId, exercise, seasonId, next, opponent]);
    await client.query(`insert into public.rating_ledger(match_id, user_id, before_rating, delta, after_rating, reason)
      values ($1, $2, $3, $4, $5, 'ranked_settlement') on conflict do nothing`, [matchId, userId, before, delta, next]);
  }
}

async function applyProgress(client: PoolClient, matchId: string, mode: MatchMode, exercise: Exercise,
  participants: Array<{ user_id: string | null; slot: number; accepted_count: number }>, winner: string | null, forfeitUserId?: string, activeMs = 0) {
  for (const participant of participants) {
    const userId = participant.user_id;
    if (!userId) continue;
    if (forfeitUserId === userId) continue;
    if (forfeitUserId && (userId === forfeitUserId || activeMs < 15_000 || participant.accepted_count < 1)) continue;
    const { rows: today } = await client.query<{ count: string }>(
      `select count(*)::text as count from public.xp_ledger where user_id = $1 and source_type = 'match'
       and utc_day = (now() at time zone 'utc')::date`, [userId]);
    const completion = 20;
    const bonus = mode === 'friend' || forfeitUserId ? 0 : winner === userId ? 10 : winner === null ? 5 : 0;
    const amount = Number(today[0]?.count ?? 0) >= 5 ? 0 : completion + bonus;
    if (amount > 0) {
      await client.query(`insert into public.xp_ledger(user_id, source_type, source_id, reward_type, amount, utc_day)
        values ($1, 'match', $2, 'completion', $3, (now() at time zone 'utc')::date) on conflict do nothing`, [userId, matchId, amount]);
      await client.query(`insert into public.user_progress(user_id, total_xp) values ($1, $2)
        on conflict (user_id) do update set total_xp = public.user_progress.total_xp + $2, updated_at = now()`, [userId, amount]);
    }
    await client.query('insert into public.activity_days(user_id, utc_date, source_id) values ($1, (now() at time zone \'utc\')::date, $2) on conflict do nothing', [userId, matchId]);
    const completedCount = await client.query<{ count: number }>(`select count(*)::int as count from public.match_results r
      join public.match_participants p on p.match_id = r.match_id where p.user_id = $1 and r.outcome <> 'void'`, [userId]);
    if ((completedCount.rows[0]?.count ?? 0) === 0) await client.query("insert into public.badges(user_id, badge_key, source_id) values ($1, 'first_match', $2) on conflict do nothing", [userId, matchId]);
    if ((completedCount.rows[0]?.count ?? 0) >= 9) await client.query("insert into public.badges(user_id, badge_key, source_id) values ($1, 'ten_completed_matches', $2) on conflict do nothing", [userId, matchId]);
    const rivals = await client.query<{ count: number }>(`select count(distinct other.user_id)::int as count from public.match_participants mine
      join public.match_participants other on other.match_id = mine.match_id and other.user_id is not null and other.user_id <> mine.user_id
      join public.match_results r on r.match_id = mine.match_id and r.outcome <> 'void' where mine.user_id = $1`, [userId]);
    const currentOpponent = participants.find((other) => other.user_id && other.user_id !== userId)?.user_id;
    const priorRivals = rivals.rows[0]?.count ?? 0;
    if (currentOpponent && priorRivals >= 4) {
      const alreadyMet = await client.query(`select 1 from public.match_participants mine
        join public.match_participants other on other.match_id = mine.match_id and other.user_id = $2
        join public.match_results r on r.match_id = mine.match_id and r.outcome <> 'void'
        where mine.user_id = $1 and mine.match_id <> $3 limit 1`, [userId, currentOpponent, matchId]);
      if (!alreadyMet.rowCount) await client.query("insert into public.badges(user_id, badge_key, source_id) values ($1, 'five_distinct_rivals', $2) on conflict do nothing", [userId, matchId]);
    }
    const { rows: activeDays } = await client.query<{ count: number }>(`select count(*)::int as count from public.activity_days
      where user_id = $1 and utc_date >= date_trunc('week', (now() at time zone 'utc'))::date`, [userId]);
    if ((activeDays[0]?.count ?? 0) >= 3) await client.query("insert into public.badges(user_id, badge_key, source_id) values ($1, 'three_active_days_week', $2) on conflict do nothing", [userId, matchId]);
    if (exercise === 'pull_up' && participant.accepted_count > 0) await client.query("insert into public.badges(user_id, badge_key, source_id) values ($1, 'first_pull_up_session', $2) on conflict do nothing", [userId, matchId]);
  }
}

export async function leaveMatch(userId: string, matchId: string) {
  const { rows } = await pool.query<{ state: string }>(
    'select m.state from public.matches m join public.match_participants p on p.match_id = m.id where m.id = $1 and p.user_id = $2', [matchId, userId],
  );
  if (!rows[0]) throw new AppError('Match not found.', 404, 'NOT_FOUND');
  if (rows[0].state === 'WAITING_READY' || rows[0].state === 'COUNTDOWN') {
    await transaction(async (client) => {
      await client.query("update public.matches set state = 'CANCELLED', reason = 'player_left_before_start', updated_at = now() where id = $1", [matchId]);
      await client.query('delete from public.active_sessions where match_id = $1', [matchId]);
    });
    return { status: 'cancelled' as const, reason: 'player_left_before_start' };
  }
  const { rowCount } = await pool.query("update public.match_participants set connection_state = 'forfeit' where match_id = $1 and user_id = $2", [matchId, userId]);
  if (!rowCount) throw new AppError('Match not found.', 404, 'NOT_FOUND');
  return settle(matchId, userId);
}

export async function heartbeatMatch(userId: string, matchId: string) {
  const { rowCount } = await pool.query("update public.match_participants set last_seen_at = now(), connection_state = 'connected' where match_id = $1 and user_id = $2", [matchId, userId]);
  if (!rowCount) throw new AppError('Match not found.', 404, 'NOT_FOUND');
  return { ok: true, serverTime: new Date().toISOString() };
}

export async function heartbeatQueue(userId: string) {
  const { rowCount } = await pool.query(`update public.queue_entries q set heartbeat_at = now() from public.active_sessions a
    where a.user_id = $1 and a.queue_id = q.id and q.state = 'WAITING'`, [userId]);
  return { ok: (rowCount ?? 0) > 0, serverTime: new Date().toISOString() };
}

export async function processDisconnectedMatches() {
  const { rows } = await pool.query<{ match_id: string; stale_users: string[]; active_users: string[] }>(
    `select m.id as match_id,
      array_agg(p.user_id::text order by p.slot) filter (where p.user_id is not null and (p.last_seen_at is null or p.last_seen_at < now() - interval '10 seconds')) as stale_users,
      array_agg(p.user_id::text order by p.slot) filter (where p.user_id is not null and p.last_seen_at >= now() - interval '10 seconds') as active_users
     from public.matches m join public.match_participants p on p.match_id = m.id
     where m.state = 'ACTIVE' and m.start_at <= now() - interval '10 seconds'
     group by m.id having count(*) = 2 and count(*) filter (where p.last_seen_at is null or p.last_seen_at < now() - interval '10 seconds') > 0`,
  );
  for (const match of rows) {
    if (match.active_users?.length) {
      const absent = match.stale_users?.[0];
      if (absent) await leaveMatch(absent, match.match_id).catch(() => undefined);
    } else if (match.stale_users?.length === 2) await settle(match.match_id, undefined, 'both_players_disconnected').catch(() => undefined);
  }
}

export async function settleDueMatches() {
  await pool.query("update public.matches set state = 'CANCELLED', reason = 'ready_timeout', updated_at = now() where state = 'WAITING_READY' and mode = 'ranked' and ready_deadline_at <= now()");
  await pool.query("delete from public.active_sessions a using public.matches m where a.match_id = m.id and m.state = 'CANCELLED'");
  await pool.query("update public.matches m set state = 'ACTIVE', updated_at = now() where m.state = 'COUNTDOWN' and m.start_at <= now() and m.end_at > now() and not exists (select 1 from public.match_participants p where p.match_id = m.id and (p.ready_expires_at is null or p.ready_expires_at <= now()))");
  await pool.query("update public.matches m set state = 'CANCELLED', reason = 'readiness_expired', updated_at = now() where m.state = 'COUNTDOWN' and m.start_at <= now() and exists (select 1 from public.match_participants p where p.match_id = m.id and (p.ready_expires_at is null or p.ready_expires_at <= now()))");
  await pool.query("delete from public.active_sessions a using public.matches m where a.match_id = m.id and m.state = 'CANCELLED'");
  const { rows } = await pool.query<{ id: string }>(
    "select id from public.matches where state in ('COUNTDOWN','ACTIVE','SETTLING') and end_at < now() - interval '3 seconds' order by end_at limit 100",
  );
  for (const match of rows) await settle(match.id).catch(() => undefined);
  await pool.query("update public.queue_entries set state = 'EXPIRED' where state = 'WAITING' and heartbeat_at < now() - interval '15 seconds'");
  await pool.query("delete from public.active_sessions a using public.queue_entries q where a.queue_id = q.id and q.state in ('EXPIRED','CANCELLED','MATCHED')");
  await pool.query("update public.invites set state = 'EXPIRED' where state = 'OPEN' and expires_at <= now()");
  await pool.query("update public.matches m set state = 'CANCELLED', reason = 'lobby_expired', updated_at = now() where m.state = 'WAITING_READY' and m.created_at < now() - interval '10 minutes' and m.mode = 'friend'");
  await pool.query("delete from public.active_sessions a using public.matches m where a.match_id = m.id and m.state = 'CANCELLED'");
}

export async function getPublicLeaderboard(exercise: Exercise, seasonId?: string, userId?: string) {
  const { rows: seasonRows } = await pool.query<{ id: string; name: string }>(
    `select id, name from public.seasons where ($1::uuid is not null and id = $1)
      or ($1::uuid is null and now() >= start_at and now() < end_at) limit 1`, [seasonId ?? null],
  );
  if (!seasonRows[0]) return { season: null, rows: [], ownRank: null, cachedAt: new Date().toISOString() };
  const season = seasonRows[0];
  const { rows } = await pool.query(`with ranked as (
    select rank() over(order by r.rating desc) as rank, p.display_name as "displayName", p.avatar_id as "avatarId",
      r.rating, r.games as played, r.user_id, r.updated_at as "updatedAt"
    from public.exercise_ratings r join public.profiles p on p.id = r.user_id
    where r.exercise = $1 and r.season_id = $2 and r.eligible = true and p.status = 'active'
  ) select rank, "displayName", "avatarId", rating, played, (user_id = $3::uuid) as "isSelf", "updatedAt", user_id
    from ranked where rank <= 100 or user_id = $3::uuid order by rank, user_id`, [exercise, season.id, userId ?? null]);
  const own = rows.find((row) => row.isSelf) ?? null;
  return { season, rows: rows.map(({ user_id: _id, ...row }) => row), ownRank: own?.rank ?? null, cachedAt: new Date().toISOString() };
}
