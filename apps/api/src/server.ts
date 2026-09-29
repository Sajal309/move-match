import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import Fastify from 'fastify';
import { z } from 'zod';
import { ERROR_CODES, ExerciseSchema } from '@move-match/contracts';
import { authenticate, requireActiveProfile, requireAuth, verifyAccessToken } from './auth.js';
import { config, assertConfigured } from './config.js';
import { pool, redis, transaction } from './db.js';
import { AppError, asAppError } from './errors.js';
import { cancelQueue, configSnapshot, createInvite, enqueue, getPublicLeaderboard, heartbeatMatch, heartbeatQueue,
  leaveMatch, matchSnapshot, processDisconnectedMatches, redeemInvite, readyMatch, settleDueMatches } from './matches.js';
import { attachRealtime, disconnectUser, notifyMatchEnded, publishOutbox } from './realtime.js';

const app = Fastify({
  bodyLimit: 8 * 1024,
  requestIdHeader: 'x-request-id',
  genReqId: () => randomUUID(),
  logger: { level: process.env.LOG_LEVEL ?? 'info', redact: ['req.headers.authorization', 'req.headers.cookie', 'req.body.email', 'req.body.description'] },
});

app.decorateRequest('authUser', null);
app.setErrorHandler((error, request, reply) => {
  const appError = asAppError(error);
  const status = error instanceof AppError ? appError.statusCode : 500;
  if (status >= 500) request.log.error({ err: error, requestId: request.id }, 'request failed');
  return reply.code(status).send({ code: appError.code, message: appError.message, retryable: appError.retryable, requestId: request.id });
});

function parsed<T>(schema: z.ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body);
  if (!result.success) throw new AppError(result.error.issues[0]?.message ?? 'Request data is invalid.', 400, ERROR_CODES.INVALID_REQUEST);
  return result.data;
}

async function requireProfile(userId: string) {
  const profile = await requireActiveProfile(userId);
  if (!profile) throw new AppError('Finish account setup before using online features.', 403, ERROR_CODES.FORBIDDEN);
  return profile;
}

async function rateLimit(userId: string, key: string, maximum: number, seconds: number) {
  let count: number;
  try {
    count = await redis.incr(`limit:${key}:${userId}:${Math.floor(Date.now() / (seconds * 1000))}`);
    if (count === 1) await redis.expire(`limit:${key}:${userId}:${Math.floor(Date.now() / (seconds * 1000))}`, seconds + 1);
  } catch { throw new AppError('The online service is temporarily unavailable.', 503, ERROR_CODES.SERVICE_UNAVAILABLE, true); }
  if (count > maximum) throw new AppError('Too many requests. Wait a little and try again.', 429, ERROR_CODES.RATE_LIMITED, true);
}

app.get('/health/live', async () => ({ status: 'live', time: new Date().toISOString() }));
app.get('/account-deletion', async (_request, reply) => {
  const email = process.env.PUBLIC_SUPPORT_EMAIL?.trim() ?? '';
  const safeEmail = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(email) ? email : '';
  const contact = safeEmail
    ? `<a href="mailto:${encodeURIComponent(safeEmail)}?subject=MOVE%20%2F%20MATCH%20account%20deletion">${safeEmail}</a>`
    : '<strong>The publisher has not configured a support email for deletion requests yet.</strong>';
  return reply.type('text/html; charset=utf-8').send(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>MOVE / MATCH account deletion</title><style>body{font:17px/1.6 system-ui,sans-serif;max-width:720px;margin:10vh auto;padding:0 22px;color:#102839}h1{line-height:1.15}a{color:#087e82}</style><main><h1>MOVE / MATCH account deletion</h1><p>You can request deletion of your MOVE / MATCH account and associated personal data from this page. If you can sign in, use <strong>You → Settings → Delete account</strong> to start the authenticated deletion flow.</p><p>If you cannot sign in, contact ${contact} from the email address on your account and include “Account deletion request”. The support team must verify account ownership before processing it. Do not include a password or one-time code.</p><p>When deletion is processed, the account is signed out and its profile, contact link, personal movement events and ranking identity are removed. Match scores needed to preserve another player’s result may be retained with the deleted player anonymized. Backups expire under the service provider’s documented backup cycle.</p><p>The publisher will confirm the processing timeline after verifying the request. For help, contact ${contact}.</p></main></html>`);
});
app.get('/health/ready', async (_request, reply) => {
  try {
    await pool.query('select 1');
    if (redis.status === 'wait') await redis.connect();
    await redis.ping();
    return { status: 'ready' };
  } catch {
    return reply.code(503).send({ status: 'not_ready' });
  }
});

app.get('/v1/config', async () => ({ apiVersion: 1, ...(await configSnapshot()) }));

app.post('/v1/me', { preHandler: authenticate }, async (request, reply) => {
  const user = requireAuth(request);
  const input = parsed(z.object({ adultConfirmed: z.literal(true), consentVersion: z.string().min(3).max(80) }), request.body);
  if (!user.email) throw new AppError('Verify an email address before account setup.', 403, ERROR_CODES.FORBIDDEN);
  const { rows } = await pool.query(`insert into public.profiles(id, adult_confirmed_at, consent_version)
    values ($1, now(), $2)
    on conflict (id) do update set adult_confirmed_at = coalesce(public.profiles.adult_confirmed_at, now()),
      consent_version = excluded.consent_version, updated_at = now()
      where public.profiles.status = 'active'
    returning id, display_name, avatar_id, status, adult_confirmed_at`, [user.id, input.consentVersion]);
  if (!rows[0]) throw new AppError('This account cannot be activated.', 403, ERROR_CODES.FORBIDDEN);
  await pool.query('insert into public.user_preferences(user_id) values ($1) on conflict do nothing', [user.id]);
  await pool.query('insert into public.user_progress(user_id) values ($1) on conflict do nothing', [user.id]);
  return reply.code(201).send(rows[0]);
});

app.get('/v1/me', { preHandler: authenticate }, async (request) => {
  const user = requireAuth(request);
  const { rows } = await pool.query(`select p.id, p.display_name as "displayName", p.avatar_id as "avatarId", p.status,
      p.created_at as "createdAt", coalesce(pr.total_xp, 0) as "totalXp", 1 + floor(coalesce(pr.total_xp, 0) / 100.0) as level,
      prefs.audio, prefs.haptics, prefs.spoken_count as "spokenCount", prefs.theme, prefs.locale, prefs.analytics_opt_in as "analyticsOptIn"
    from public.profiles p left join public.user_progress pr on pr.user_id = p.id
    left join public.user_preferences prefs on prefs.user_id = p.id where p.id = $1 and p.status = 'active'`, [user.id]);
  if (!rows[0]) throw new AppError('Account profile not found.', 404, ERROR_CODES.NOT_FOUND);
  return rows[0];
});

app.get('/v1/me/progress', { preHandler: authenticate }, async (request) => {
  const user = requireAuth(request); await requireProfile(user.id);
  const [profile, ratings, badges, activity] = await Promise.all([
    pool.query('select p.display_name as "displayName", p.avatar_id as "avatarId", pr.total_xp as "totalXp", 1 + floor(pr.total_xp / 100.0) as level from public.profiles p join public.user_progress pr on pr.user_id = p.id where p.id = $1', [user.id]),
    pool.query(`select r.exercise, r.rating, r.games as played, r.eligible, s.name as season
      from public.exercise_ratings r join public.seasons s on s.id = r.season_id
      where r.user_id = $1 and now() >= s.start_at and now() < s.end_at order by r.exercise`, [user.id]),
    pool.query('select badge_key as "badgeKey", awarded_at as "awardedAt" from public.badges where user_id = $1 order by awarded_at desc', [user.id]),
    pool.query(`select count(*)::int as days from public.activity_days where user_id = $1
      and utc_date >= date_trunc('week', (now() at time zone 'utc'))::date`, [user.id]),
  ]);
  return { profile: profile.rows[0] ?? null, ratings: ratings.rows, badges: badges.rows,
    weeklyActiveDays: Math.min(3, activity.rows[0]?.days ?? 0) };
});

app.patch('/v1/me', { preHandler: authenticate }, async (request) => {
  const user = requireAuth(request); await requireProfile(user.id);
  const input = parsed(z.object({
    displayName: z.string().min(3).max(64).optional(),
    avatarId: z.enum(['move-01', 'move-02', 'move-03', 'move-04', 'move-05', 'move-06']).optional(),
    audio: z.boolean().optional(), haptics: z.boolean().optional(), spokenCount: z.boolean().optional(),
    theme: z.enum(['system', 'light', 'dark']).optional(), locale: z.string().min(2).max(12).optional(), analyticsOptIn: z.boolean().optional(),
  }).strict().refine((value) => Object.keys(value).length > 0), request.body);
  let normalizedName: string | undefined; let normalizedHandle: string | undefined;
  if (input.displayName !== undefined) {
    normalizedName = input.displayName.normalize('NFKC').trim().replace(/\s+/g, ' ');
    const length = [...normalizedName].length;
    if (length < 3 || length > 20 || /[\u0000-\u001f\u007f]/u.test(normalizedName) || /\b(admin|moderator|movematch|move match|support)\b/iu.test(normalizedName)) {
      throw new AppError('Choose a 3–20 character display name without control text or official account terms.', 400, ERROR_CODES.INVALID_REQUEST);
    }
    normalizedHandle = normalizedName.toLocaleLowerCase('en-US');
    const duplicate = await pool.query('select 1 from public.profiles where normalized_handle = $1 and id <> $2 limit 1', [normalizedHandle, user.id]);
    if (duplicate.rowCount) throw new AppError('That display name is already in use. Choose another.', 409, ERROR_CODES.INVALID_REQUEST);
  }
  await transaction(async (client) => {
    if (normalizedName) await client.query('update public.profiles set display_name = $2, normalized_handle = $3, updated_at = now() where id = $1', [user.id, normalizedName, normalizedHandle]);
    if (input.avatarId) await client.query('update public.profiles set avatar_id = $2, updated_at = now() where id = $1', [user.id, input.avatarId]);
    const prefs: Array<[string, unknown]> = [
      ['audio', input.audio], ['haptics', input.haptics], ['spoken_count', input.spokenCount], ['theme', input.theme],
      ['locale', input.locale], ['analytics_opt_in', input.analyticsOptIn],
    ];
    for (const [column, value] of prefs) if (value !== undefined) {
      const allowed = new Set(['audio', 'haptics', 'spoken_count', 'theme', 'locale', 'analytics_opt_in']);
      if (!allowed.has(column)) throw new AppError('Invalid preference.', 400, ERROR_CODES.INVALID_REQUEST);
      await client.query(`update public.user_preferences set ${column} = $2, updated_at = now() where user_id = $1`, [user.id, value]);
    }
  });
  return { status: 'updated' };
});

app.get('/v1/me/history', { preHandler: authenticate }, async (request) => {
  const user = requireAuth(request); await requireProfile(user.id);
  const query = parsed(z.object({ cursor: z.string().datetime().optional(), limit: z.coerce.number().int().min(1).max(50).default(20) }), request.query);
  const { rows } = await pool.query(`select m.id as "matchId", m.mode, m.exercise, m.rule_version as "ruleVersion", m.created_at as "createdAt",
      r.outcome, r.score_player_1 as "scorePlayer1", r.score_player_2 as "scorePlayer2", r.reason,
      mine.slot as "mySlot", other.display_name_snapshot as "opponentName", other.avatar_id_snapshot as "opponentAvatar"
    from public.match_participants mine join public.matches m on m.id = mine.match_id
    left join public.match_results r on r.match_id = m.id
    left join public.match_participants other on other.match_id = m.id and other.slot <> mine.slot
    where mine.user_id = $1 and ($2::timestamptz is null or m.created_at < $2)
    order by m.created_at desc limit $3`, [user.id, query.cursor ?? null, query.limit]);
  return { items: rows, nextCursor: rows.length === query.limit ? rows[rows.length - 1].createdAt : null };
});

app.post('/v1/invites', { preHandler: authenticate }, async (request) => {
  const user = requireAuth(request); await requireProfile(user.id);
  await rateLimit(user.id, 'invite-create', 10, 60);
  const input = parsed(z.object({ exercise: ExerciseSchema, idempotencyKey: z.string().uuid() }), request.body);
  return createInvite(user.id, input.exercise, input.idempotencyKey);
});

app.post('/v1/invites/redeem', { preHandler: authenticate }, async (request) => {
  const user = requireAuth(request); await requireProfile(user.id);
  await rateLimit(user.id, 'invite-redeem', 10, 60);
  const input = parsed(z.object({ code: z.string().min(6).max(16) }), request.body);
  return redeemInvite(user.id, input.code);
});

app.post('/v1/queue', { preHandler: authenticate }, async (request) => {
  const user = requireAuth(request); await requireProfile(user.id);
  await rateLimit(user.id, 'queue', 10, 60);
  const input = parsed(z.object({ exercise: ExerciseSchema }), request.body);
  return enqueue(user.id, input.exercise);
});
app.delete('/v1/queue/current', { preHandler: authenticate }, async (request) => {
  const user = requireAuth(request); await requireProfile(user.id); return cancelQueue(user.id);
});
app.post('/v1/queue/heartbeat', { preHandler: authenticate }, async (request) => {
  const user = requireAuth(request); await requireProfile(user.id); return heartbeatQueue(user.id);
});

app.get('/v1/matches/:id', { preHandler: authenticate }, async (request) => {
  const user = requireAuth(request); await requireProfile(user.id);
  const params = parsed(z.object({ id: z.string().uuid() }), request.params);
  return matchSnapshot(user.id, params.id, false);
});
app.post('/v1/matches/:id/ready', { preHandler: authenticate }, async (request) => {
  const user = requireAuth(request); await requireProfile(user.id);
  const params = parsed(z.object({ id: z.string().uuid() }), request.params);
  const input = parsed(z.object({ sessionNonce: z.string().min(24).max(160), modelVersion: z.string().max(120) }), request.body);
  if (input.modelVersion !== 'google-pose-landmarker-lite-float16') throw new AppError('Update the app before joining this match.', 409, ERROR_CODES.RULE_UNSUPPORTED);
  return readyMatch(user.id, params.id, input.sessionNonce);
});
app.post('/v1/matches/:id/heartbeat', { preHandler: authenticate }, async (request) => {
  const user = requireAuth(request); await requireProfile(user.id);
  const params = parsed(z.object({ id: z.string().uuid() }), request.params); return heartbeatMatch(user.id, params.id);
});
app.post('/v1/matches/:id/leave', { preHandler: authenticate }, async (request) => {
  const user = requireAuth(request); await requireProfile(user.id);
  const params = parsed(z.object({ id: z.string().uuid() }), request.params);
  const result = await leaveMatch(user.id, params.id);
  await notifyMatchEnded(params.id, result).catch(() => undefined);
  return result;
});

app.get('/v1/leaderboards', { preHandler: authenticate }, async (request) => {
  const user = requireAuth(request); await requireProfile(user.id);
  const query = parsed(z.object({ exercise: ExerciseSchema, season: z.string().uuid().optional(), cursor: z.coerce.number().int().min(1).optional() }), request.query);
  return getPublicLeaderboard(query.exercise, query.season, user.id);
});

app.post('/v1/practice-sessions', { preHandler: authenticate }, async (request) => {
  const user = requireAuth(request); await requireProfile(user.id);
  const input = parsed(z.object({ id: z.string().uuid(), exercise: ExerciseSchema, durationMs: z.number().int().min(45_000).max(50_000),
    acceptedReps: z.number().int().min(1).max(200), ruleVersion: z.string().min(1).max(40), modelVersion: z.string().min(1).max(120) }), request.body);
  if (input.ruleVersion !== `${input.exercise}_v1` || input.modelVersion !== 'google-pose-landmarker-lite-float16') throw new AppError('Practice session uses an unsupported rule or model.', 409, ERROR_CODES.RULE_UNSUPPORTED);
  return transaction(async (client) => {
    await client.query("select pg_advisory_xact_lock(hashtextextended('practice-xp:' || $1::text || ':' || (now() at time zone 'utc')::date::text, 0))", [user.id]);
    const { rowCount } = await client.query(`insert into public.practice_syncs(id, user_id, exercise, duration_ms, accepted_reps, rule_version)
      values ($1, $2, $3, $4, $5, $6) on conflict do nothing`, [input.id, user.id, input.exercise, input.durationMs, input.acceptedReps, input.ruleVersion]);
    if (!rowCount) return { status: 'duplicate' as const, xpAwarded: 0 };
    const daily = await client.query("select 1 from public.xp_ledger where user_id = $1 and source_type = 'practice' and utc_day = (now() at time zone 'utc')::date limit 1", [user.id]);
    const xpAwarded = daily.rowCount ? 0 : 10;
    if (xpAwarded) {
      await client.query(`insert into public.xp_ledger(user_id, source_type, source_id, reward_type, amount, utc_day)
        values ($1, 'practice', $2, 'daily_qualifying_practice', 10, (now() at time zone 'utc')::date) on conflict do nothing`, [user.id, input.id]);
      await client.query(`insert into public.user_progress(user_id, total_xp) values ($1, 10)
        on conflict (user_id) do update set total_xp = public.user_progress.total_xp + 10, updated_at = now()`, [user.id]);
    }
    await client.query('insert into public.activity_days(user_id, utc_date, source_id) values ($1, (now() at time zone \'utc\')::date, $2) on conflict do nothing', [user.id, input.id]);
    const { rows: activeDays } = await client.query<{ count: number }>(`select count(*)::int as count from public.activity_days
      where user_id = $1 and utc_date >= date_trunc('week', (now() at time zone 'utc'))::date`, [user.id]);
    if ((activeDays[0]?.count ?? 0) >= 3) await client.query("insert into public.badges(user_id, badge_key, source_id) values ($1, 'three_active_days_week', $2) on conflict do nothing", [user.id, input.id]);
    return { status: 'recorded' as const, xpAwarded };
  });
});

app.post('/v1/reports', { preHandler: authenticate }, async (request) => {
  const user = requireAuth(request); await requireProfile(user.id); await rateLimit(user.id, 'report', 5, 3_600);
  const input = parsed(z.object({ targetId: z.string().uuid().optional(), matchId: z.string().uuid().optional(),
    category: z.enum(['offensive_name', 'suspected_cheating', 'harassment', 'tracking_result']), description: z.string().max(500).optional() })
    .refine((value) => value.targetId !== undefined || value.matchId !== undefined), request.body);
  if (input.targetId === user.id) throw new AppError('You cannot report yourself.', 400, ERROR_CODES.INVALID_REQUEST);
  let targetId = input.targetId ?? null;
  if (input.matchId) {
    const match = await pool.query<{ opponent_id: string | null }>(`select other.user_id as opponent_id from public.match_participants mine
      join public.match_participants other on other.match_id = mine.match_id and other.slot <> mine.slot
      where mine.match_id = $1 and mine.user_id = $2`, [input.matchId, user.id]);
    if (!match.rows[0]) throw new AppError('Match not found.', 404, ERROR_CODES.NOT_FOUND);
    targetId = match.rows[0].opponent_id;
  }
  if (targetId === user.id) throw new AppError('You cannot report yourself.', 400, ERROR_CODES.INVALID_REQUEST);
  const { rows } = await pool.query(`insert into public.reports(reporter_id, target_id, match_id, category, description)
    values ($1, $2, $3, $4, $5) returning id, state, created_at as "createdAt"`, [user.id, targetId, input.matchId ?? null, input.category, input.description?.trim() || null]);
  return rows[0];
});

app.post('/v1/blocks/:userId', { preHandler: authenticate }, async (request, reply) => {
  const user = requireAuth(request); await requireProfile(user.id);
  const params = parsed(z.object({ userId: z.string().uuid() }), request.params);
  if (params.userId === user.id) throw new AppError('You cannot block yourself.', 400, ERROR_CODES.INVALID_REQUEST);
  await pool.query('insert into public.blocks(blocker_id, blocked_id) values ($1, $2) on conflict do nothing', [user.id, params.userId]);
  return reply.code(204).send();
});
app.get('/v1/blocks', { preHandler: authenticate }, async (request) => {
  const user = requireAuth(request); await requireProfile(user.id);
  const { rows } = await pool.query(`select b.blocked_id as "userId", p.display_name as "displayName", p.avatar_id as "avatarId", b.created_at as "createdAt"
    from public.blocks b join public.profiles p on p.id = b.blocked_id where b.blocker_id = $1 order by b.created_at desc`, [user.id]);
  return { items: rows };
});
app.delete('/v1/blocks/:userId', { preHandler: authenticate }, async (request, reply) => {
  const user = requireAuth(request); await requireProfile(user.id); const params = parsed(z.object({ userId: z.string().uuid() }), request.params);
  await pool.query('delete from public.blocks where blocker_id = $1 and blocked_id = $2', [user.id, params.userId]);
  return reply.code(204).send();
});
app.post('/v1/matches/:id/block-opponent', { preHandler: authenticate }, async (request, reply) => {
  const user = requireAuth(request); await requireProfile(user.id);
  const params = parsed(z.object({ id: z.string().uuid() }), request.params);
  const { rows } = await pool.query<{ opponent_id: string | null }>(`select other.user_id as opponent_id from public.match_participants mine
    join public.match_participants other on other.match_id = mine.match_id and other.slot <> mine.slot
    where mine.match_id = $1 and mine.user_id = $2`, [params.id, user.id]);
  const opponent = rows[0]?.opponent_id;
  if (!opponent) throw new AppError('Match or opponent not found.', 404, ERROR_CODES.NOT_FOUND);
  await pool.query('insert into public.blocks(blocker_id, blocked_id) values ($1, $2) on conflict do nothing', [user.id, opponent]);
  return reply.code(204).send();
});

app.post('/v1/me/export', { preHandler: authenticate }, async (request) => {
  const user = requireAuth(request); await requireProfile(user.id);
  const [profile, preferences, matches, ratings, badges, reports, blocks, practice, xpLedger, activity] = await Promise.all([
    pool.query('select id, display_name, avatar_id, created_at, adult_confirmed_at, consent_version from public.profiles where id = $1', [user.id]),
    pool.query('select audio, haptics, spoken_count, theme, locale, analytics_opt_in from public.user_preferences where user_id = $1', [user.id]),
    pool.query(`select m.id, m.mode, m.exercise, m.rule_version, m.created_at, r.outcome, r.score_player_1, r.score_player_2, r.reason
      from public.match_participants p join public.matches m on m.id = p.match_id left join public.match_results r on r.match_id = m.id where p.user_id = $1 order by m.created_at desc`, [user.id]),
    pool.query('select exercise, season_id, rating, games, eligible from public.exercise_ratings where user_id = $1', [user.id]),
    pool.query('select badge_key, awarded_at from public.badges where user_id = $1', [user.id]),
    pool.query('select id, category, description, state, created_at from public.reports where reporter_id = $1', [user.id]),
    pool.query('select blocked_id, created_at from public.blocks where blocker_id = $1', [user.id]),
    pool.query('select id, exercise, duration_ms, accepted_reps, rule_version, created_at from public.practice_syncs where user_id = $1 order by created_at desc', [user.id]),
    pool.query('select source_type, source_id, reward_type, amount, utc_day, created_at from public.xp_ledger where user_id = $1 order by created_at desc', [user.id]),
    pool.query('select utc_date, source_id from public.activity_days where user_id = $1 order by utc_date desc', [user.id]),
  ]);
  return { status: 'ready', exportedAt: new Date().toISOString(), data: { profile: profile.rows[0], preferences: preferences.rows[0],
    email: user.email ?? null, matches: matches.rows, ratings: ratings.rows, badges: badges.rows, reports: reports.rows, blocks: blocks.rows,
    practice: practice.rows, xpLedger: xpLedger.rows, activityDays: activity.rows } };
});

app.delete('/v1/me', { preHandler: authenticate }, async (request, reply) => {
  const user = requireAuth(request); const input = parsed(z.object({ confirmation: z.literal('DELETE') }), request.body);
  if (!input || !config.supabaseUrl || !process.env.SUPABASE_SERVICE_ROLE_KEY) throw new AppError('Account deletion is not configured on this service yet.', 503, ERROR_CODES.SERVICE_UNAVAILABLE, true);
  const issuedAt = user.claims.iat;
  if (typeof issuedAt !== 'number' || Date.now() - issuedAt * 1000 > 5 * 60_000) throw new AppError('Sign in again before requesting account deletion.', 401, ERROR_CODES.AUTH_EXPIRED);
  const { rows: active } = await pool.query<{ match_id: string | null }>('select match_id from public.active_sessions where user_id = $1', [user.id]);
  if (active[0]?.match_id) {
    const result = await leaveMatch(user.id, active[0].match_id);
    await notifyMatchEnded(active[0].match_id, result).catch(() => undefined);
  }
  const jobId = await transaction(async (client) => {
    const profile = await client.query<{ status: string }>('select status from public.profiles where id = $1 for update', [user.id]);
    if (!profile.rows[0]) throw new AppError('Account profile not found.', 404, ERROR_CODES.NOT_FOUND);
    if (profile.rows[0].status === 'deleting') {
      const existing = await client.query<{ id: string }>("select id from public.deletion_jobs where user_id = $1 and status in ('queued','processing','failed') order by requested_at desc limit 1", [user.id]);
      if (existing.rows[0]) return existing.rows[0].id;
    }
    const remainingMatch = await client.query('select 1 from public.active_sessions where user_id = $1 and match_id is not null', [user.id]);
    if (remainingMatch.rowCount) throw new AppError('A match is still active. Try the deletion request again in a moment.', 409, ERROR_CODES.ALREADY_ACTIVE, true);
    const queues = await client.query("update public.queue_entries set state = 'CANCELLED' where user_id = $1 and state in ('WAITING','RESERVED') returning id", [user.id]);
    if (queues.rows.length) await client.query('delete from public.active_sessions where user_id = $1 and queue_id = any($2::uuid[])', [user.id, queues.rows.map((row) => row.id)]);
    await client.query("update public.invites set state = 'CANCELLED' where host_id = $1 and state = 'OPEN'", [user.id]);
    await client.query("update public.match_participants set user_id = null, display_name_snapshot = 'Deleted player', avatar_id_snapshot = 'move-01', session_nonce_hash = '' where user_id = $1", [user.id]);
    await client.query('delete from public.rep_events where user_id = $1', [user.id]);
    const { rows } = await client.query(`insert into public.deletion_jobs(user_id) values ($1) returning id`, [user.id]);
    await client.query("update public.profiles set display_name = 'Deleted player', normalized_handle = null, status = 'deleting', updated_at = now() where id = $1", [user.id]);
    return rows[0].id as string;
  });
  return reply.code(202).send({ status: 'queued', requestId: jobId });
});

app.get('/v1/admin/reports', { preHandler: authenticate }, async (request) => {
  const user = requireAuth(request);
  if (!config.opsAdmins.has(user.id)) throw new AppError('Not found.', 404, ERROR_CODES.NOT_FOUND);
  const { rows } = await pool.query(`select r.id, r.category, r.description, r.state, r.created_at,
      p.display_name as reporter_name, t.display_name as target_name
    from public.reports r join public.profiles p on p.id = r.reporter_id
    left join public.profiles t on t.id = r.target_id where r.state in ('open','reviewing') order by r.created_at asc limit 200`);
  return { items: rows };
});

app.patch('/v1/admin/reports/:id', { preHandler: authenticate }, async (request) => {
  const user = requireAuth(request);
  if (!config.opsAdmins.has(user.id)) throw new AppError('Not found.', 404, ERROR_CODES.NOT_FOUND);
  const params = parsed(z.object({ id: z.string().uuid() }), request.params);
  const input = parsed(z.object({ state: z.enum(['open', 'reviewing', 'resolved', 'dismissed']), reason: z.string().min(3).max(300) }), request.body);
  return transaction(async (client) => {
    const { rows } = await client.query('update public.reports set state = $2 where id = $1 returning id, state', [params.id, input.state]);
    if (!rows[0]) throw new AppError('Report not found.', 404, ERROR_CODES.NOT_FOUND);
    await client.query('insert into public.moderation_actions(actor_admin_id, reason, action) values ($1, $2, $3)', [user.id, input.reason, `report:${params.id}:${input.state}`]);
    return rows[0];
  });
});

app.patch('/v1/admin/feature-flags/:key', { preHandler: authenticate }, async (request) => {
  const user = requireAuth(request);
  if (!config.opsAdmins.has(user.id)) throw new AppError('Not found.', 404, ERROR_CODES.NOT_FOUND);
  const params = parsed(z.object({ key: z.enum(['friend_matches_enabled', 'quick_match_enabled', 'ranked_push_up_enabled', 'ranked_pull_up_enabled']) }), request.params);
  const input = parsed(z.object({ enabled: z.boolean(), reason: z.string().min(3).max(300) }), request.body);
  return transaction(async (client) => {
    const { rows } = await client.query('update public.feature_flags set enabled = $2, updated_by = $3, updated_at = now() where key = $1 returning key, enabled, updated_at as "updatedAt"',
      [params.key, input.enabled, user.id]);
    if (!rows[0]) throw new AppError('Feature flag not found.', 404, ERROR_CODES.NOT_FOUND);
    await client.query('insert into public.moderation_actions(actor_admin_id, reason, action) values ($1, $2, $3)',
      [user.id, input.reason, `feature_flag:${params.key}:${input.enabled ? 'enabled' : 'disabled'}`]);
    return rows[0];
  });
});

app.patch('/v1/admin/profiles/:id', { preHandler: authenticate }, async (request) => {
  const user = requireAuth(request);
  if (!config.opsAdmins.has(user.id)) throw new AppError('Not found.', 404, ERROR_CODES.NOT_FOUND);
  const params = parsed(z.object({ id: z.string().uuid() }), request.params);
  const input = parsed(z.object({ status: z.enum(['active', 'suspended']), reason: z.string().min(3).max(300) }), request.body);
  const changed = await transaction(async (client) => {
    const { rows } = await client.query('update public.profiles set status = $2, updated_at = now() where id = $1 returning id', [params.id, input.status]);
    if (!rows[0]) throw new AppError('Profile not found.', 404, ERROR_CODES.NOT_FOUND);
    await client.query('insert into public.moderation_actions(actor_admin_id, target_id, reason, action) values ($1, $2, $3, $4)', [user.id, params.id, input.reason, `profile_status:${input.status}`]);
    return rows[0];
  });
  if (input.status === 'suspended') {
    const queued = await pool.query("update public.queue_entries set state = 'CANCELLED' where user_id = $1 and state = 'WAITING' returning id", [params.id]);
    if (queued.rows.length) await pool.query('delete from public.active_sessions where user_id = $1 and queue_id = any($2::uuid[])', [params.id, queued.rows.map((row) => row.id)]);
    const { rows: active } = await pool.query<{ match_id: string }>('select match_id from public.active_sessions where user_id = $1 and match_id is not null', [params.id]);
    disconnectUser(params.id);
    for (const item of active) {
      const result = await leaveMatch(params.id, item.match_id).catch(() => undefined);
      if (result) await notifyMatchEnded(item.match_id, result).catch(() => undefined);
    }
  }
  return { id: changed.id, status: input.status };
});

async function processDeletionJobs() {
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!serviceKey || !config.supabaseUrl) return;
  const jobs = await transaction(async (client) => {
    const { rows } = await client.query<{ id: string; user_id: string }>(
      "select id, user_id from public.deletion_jobs where (status in ('queued','failed') or (status = 'processing' and updated_at < now() - interval '5 minutes')) and attempts < 5 and user_id is not null order by requested_at for update skip locked limit 10",
    );
    for (const job of rows) {
      await client.query("update public.deletion_jobs set status = 'processing', attempts = attempts + 1, updated_at = now() where id = $1", [job.id]);
    }
    return rows;
  });
  for (const job of jobs) {
    let response: Response | undefined;
    try {
      response = await fetch(`${config.supabaseUrl.replace(/\/$/, '')}/auth/v1/admin/users/${job.user_id}`, {
        method: 'DELETE', headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` },
        signal: AbortSignal.timeout(5_000),
      });
    } catch { /* retry below */ }
    if (response?.ok || response?.status === 404) {
      await pool.query("update public.deletion_jobs set status = 'complete', user_id = null, completion_at = now(), updated_at = now(), error_code = null where id = $1", [job.id]);
    } else {
      await pool.query("update public.deletion_jobs set status = 'failed', updated_at = now(), error_code = 'AUTH_DELETE_FAILED' where id = $1", [job.id]);
    }
  }
}

export async function start() {
  assertConfigured();
  if (redis.status === 'wait') await redis.connect();
  await redis.ping();
  await app.ready();
  await attachRealtime(app.server, app.log);
  await app.listen({ port: config.port, host: config.host });
  const sweeper = setInterval(() => {
    void settleDueMatches().catch((error) => app.log.error({ error }, 'match sweeper failed'));
    void processDisconnectedMatches().catch((error) => app.log.error({ error }, 'disconnect sweeper failed'));
    void publishOutbox().catch((error) => app.log.error({ error }, 'outbox publisher failed'));
  }, 1_000);
  sweeper.unref();
  const deletionWorker = setInterval(() => void processDeletionJobs().catch((error) => app.log.error({ error }, 'deletion worker failed')), 30_000);
  deletionWorker.unref();
  const retentionWorker = setInterval(() => void Promise.all([
    pool.query("delete from public.rep_events where id in (select id from public.rep_events where received_at < now() - interval '7 days' order by received_at limit 5000)"),
    pool.query("delete from public.reports where state in ('resolved','dismissed') and created_at < now() - interval '90 days'"),
  ]).catch((error) => app.log.error({ error }, 'retention worker failed')), 6 * 60 * 60 * 1_000);
  retentionWorker.unref();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  start().catch((error) => { app.log.error(error); process.exitCode = 1; });
}
