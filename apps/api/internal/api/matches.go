package api

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

type Exercise string
type MatchMode string

const (
	PushUp       Exercise  = "push_up"
	PullUp       Exercise  = "pull_up"
	Friend       MatchMode = "friend"
	Ranked       MatchMode = "ranked"
	modelVersion           = "google-pose-landmarker-lite-float16"
)

func ruleVersion(exercise Exercise) string { return string(exercise) + "_v1" }

func validExercise(exercise Exercise) bool { return exercise == PushUp || exercise == PullUp }

func (a *App) configSnapshot(ctx context.Context) (map[string]any, error) {
	flags, err := queryRows(ctx, a.DB, "select key, enabled from public.feature_flags")
	if err != nil {
		return nil, err
	}
	rawRules, err := queryRows(ctx, a.DB, "select exercise, version, model_version, enabled from public.exercise_rules")
	if err != nil {
		return nil, err
	}
	rules := make([]map[string]any, 0, len(rawRules))
	for _, rule := range rawRules {
		rules = append(rules, map[string]any{
			"exercise": rule["exercise"], "version": rule["version"],
			"modelVersion": rule["model_version"], "enabled": rule["enabled"],
		})
	}
	season, err := queryOne(ctx, a.DB, "select id, name, start_at, end_at from public.seasons where now() >= start_at and now() < end_at limit 1")
	if errors.Is(err, pgx.ErrNoRows) {
		season = nil
		err = nil
	}
	if err != nil {
		return nil, err
	}
	flagMap := make(map[string]any, len(flags))
	for _, flag := range flags {
		flagMap[fmt.Sprint(flag["key"])] = flag["enabled"]
	}
	return map[string]any{"protocolVersion": 1, "durationMs": 45_000, "countdownMs": 5_000,
		"flags": flagMap, "rules": rules, "season": season}, nil
}

func (a *App) checkEnabled(ctx context.Context, exercise Exercise, mode MatchMode) error {
	flagKey := "friend_matches_enabled"
	keys := []string{flagKey}
	if mode == Ranked {
		flagKey = "ranked_" + string(exercise) + "_enabled"
		keys = []string{"quick_match_enabled", flagKey}
	}
	flags, err := queryRows(ctx, a.DB, "select key, enabled from public.feature_flags where key = any($1::text[])", keys)
	if err != nil {
		return err
	}
	active := make(map[string]bool, len(flags))
	for _, flag := range flags {
		active[fmt.Sprint(flag["key"])] = flag["enabled"] == true
	}
	for _, key := range keys {
		if !active[key] {
			message := "Friend challenges are not available yet."
			if mode == Ranked {
				name := "Pull-up"
				if exercise == PushUp {
					name = "Push-up"
				}
				message = name + " ranked play is temporarily unavailable."
			}
			return fail(503, "FEATURE_UNAVAILABLE", message, true)
		}
	}
	var ruleEnabled bool
	if err := a.DB.QueryRow(ctx, "select exists(select 1 from public.exercise_rules where exercise = $1 and version = $2 and enabled)", exercise, ruleVersion(exercise)).Scan(&ruleEnabled); err != nil {
		return err
	}
	if !ruleEnabled {
		return fail(409, "RULE_UNSUPPORTED", "This movement rule is not enabled for online play.", false)
	}
	if mode == Ranked {
		var hasSeason bool
		if err := a.DB.QueryRow(ctx, "select exists(select 1 from public.seasons where now() >= start_at and now() < end_at)").Scan(&hasSeason); err != nil {
			return err
		}
		if !hasSeason {
			return fail(503, "FEATURE_UNAVAILABLE", "Ranked play is unavailable between seasons.", true)
		}
	}
	return nil
}

func (a *App) requireEligible(ctx context.Context, userID string) (map[string]any, error) {
	profile, err := queryOne(ctx, a.DB, "select id, display_name as \"displayName\", avatar_id as \"avatarId\", status, adult_confirmed_at as \"adultConfirmedAt\" from public.profiles where id = $1", userID)
	if errors.Is(err, pgx.ErrNoRows) || err == nil && (profile["status"] != "active" || profile["adultConfirmedAt"] == nil) {
		return nil, fail(403, "FORBIDDEN", "Complete adult account setup before online play.", false)
	}
	return profile, err
}

func (a *App) profileForUpdate(ctx context.Context, tx pgx.Tx, userID string) (map[string]any, error) {
	profile, err := queryOne(ctx, tx, "select id, display_name, avatar_id, status, adult_confirmed_at from public.profiles where id = $1 for update", userID)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, fail(403, "FORBIDDEN", "Complete adult account setup before online play.", false)
	}
	if err == nil && (profile["status"] != "active" || profile["adult_confirmed_at"] == nil) {
		return nil, fail(403, "FORBIDDEN", "Complete adult account setup before online play.", false)
	}
	return profile, err
}

func (a *App) createInvite(ctx context.Context, userID string, exercise Exercise, idempotencyKey string) (map[string]any, error) {
	if err := a.checkEnabled(ctx, exercise, Friend); err != nil {
		return nil, err
	}
	code, sessionNonce, err := a.inviteCode(userID, idempotencyKey)
	if err != nil {
		return nil, err
	}
	var result map[string]any
	err = a.transaction(ctx, false, func(tx pgx.Tx) error {
		profile, err := a.profileForUpdate(ctx, tx, userID)
		if err != nil {
			return err
		}
		prior, err := queryOne(ctx, tx, `select i.match_id as "matchId", i.expires_at as "expiresAt", i.state, m.exercise
			from public.invites i join public.matches m on m.id = i.match_id where i.host_id = $1 and i.idempotency_key = $2 for update of i`, userID, idempotencyKey)
		if err == nil {
			if prior["exercise"] != string(exercise) {
				return fail(409, "INVALID_REQUEST", "That request key belongs to a different exercise.", false)
			}
			until, ok := prior["expiresAt"].(time.Time)
			if prior["state"] == "OPEN" && ok && until.After(time.Now()) {
				matchID := prior["matchId"]
				if _, err := tx.Exec(ctx, "update public.match_participants set session_nonce_hash = $3 where match_id = $1 and user_id = $2", matchID, userID, sha256Hex(sessionNonce)); err != nil {
					return err
				}
				result = map[string]any{"matchId": matchID, "inviteCode": code, "expiresInSeconds": int(time.Until(until).Seconds()), "sessionNonce": sessionNonce, "exercise": exercise, "mode": Friend}
				return nil
			}
			return fail(410, "INVITE_EXPIRED", "That invite has expired or closed. Cancel it before creating another.", false)
		}
		if !errors.Is(err, pgx.ErrNoRows) {
			return err
		}
		var active bool
		if err := tx.QueryRow(ctx, "select exists(select 1 from public.active_sessions where user_id = $1)", userID).Scan(&active); err != nil {
			return err
		}
		if active {
			return fail(409, "ALREADY_ACTIVE", "You already have an active lobby or queue.", false)
		}
		var matchID string
		if err := tx.QueryRow(ctx, `insert into public.matches(mode, exercise, rule_version, model_version, state)
			values ('friend', $1, $2, $3, 'WAITING_READY') returning id`, exercise, ruleVersion(exercise), modelVersion).Scan(&matchID); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `insert into public.match_participants(match_id, user_id, slot, display_name_snapshot, avatar_id_snapshot, session_nonce_hash)
			values ($1, $2, 1, $3, $4, $5)`, matchID, userID, profile["display_name"], profile["avatar_id"], sha256Hex(sessionNonce)); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, "insert into public.active_sessions(user_id, match_id) values ($1, $2)", userID, matchID); err != nil {
			return fail(409, "ALREADY_ACTIVE", "You already have an active lobby or queue.", false)
		}
		if _, err := tx.Exec(ctx, "insert into public.invites(code_hash, host_id, idempotency_key, match_id, expires_at) values ($1, $2, $3, $4, now() + interval '10 minutes')", sha256Hex(code), userID, idempotencyKey, matchID); err != nil {
			return err
		}
		result = map[string]any{"matchId": matchID, "inviteCode": code, "expiresInSeconds": 600, "sessionNonce": sessionNonce, "exercise": exercise, "mode": Friend}
		return nil
	})
	return result, err
}

func (a *App) redeemInvite(ctx context.Context, userID, rawCode string) (map[string]any, error) {
	code := strings.ToUpper(strings.Map(func(r rune) rune {
		if r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' {
			return r
		}
		return -1
	}, rawCode))
	if len(code) != 8 {
		return nil, fail(400, "INVALID_REQUEST", "Enter the 8-character invite code.", false)
	}
	var result map[string]any
	var hostID string
	err := a.transaction(ctx, false, func(tx pgx.Tx) error {
		profile, err := a.profileForUpdate(ctx, tx, userID)
		if err != nil {
			return err
		}
		invite, err := queryOne(ctx, tx, "select id, host_id, match_id, state, expires_at, redeemed_by from public.invites where code_hash = $1 for update", sha256Hex(code))
		if errors.Is(err, pgx.ErrNoRows) {
			return fail(404, "NOT_FOUND", "That invite is unavailable or has already been used.", false)
		}
		if err != nil {
			return err
		}
		match, err := queryOne(ctx, tx, "select exercise, state from public.matches where id = $1 for update", invite["match_id"])
		if errors.Is(err, pgx.ErrNoRows) {
			match = nil
		} else if err != nil {
			return err
		}
		if invite["state"] == "REDEEMED" && invite["redeemed_by"] == userID && match != nil {
			_, err := queryOne(ctx, tx, "select slot from public.match_participants where match_id = $1 and user_id = $2 for update", invite["match_id"], userID)
			if errors.Is(err, pgx.ErrNoRows) {
				return fail(404, "NOT_FOUND", "This invite has already been used.", false)
			}
			if err != nil {
				return err
			}
			sessionNonce, err := nonce()
			if err != nil {
				return err
			}
			if _, err := tx.Exec(ctx, "update public.match_participants set session_nonce_hash = $3 where match_id = $1 and user_id = $2", invite["match_id"], userID, sha256Hex(sessionNonce)); err != nil {
				return err
			}
			hostID = fmt.Sprint(invite["host_id"])
			result = map[string]any{"matchId": invite["match_id"], "sessionNonce": sessionNonce, "exercise": match["exercise"], "mode": Friend}
			return nil
		}
		if invite["state"] != "OPEN" {
			return fail(404, "NOT_FOUND", "That invite is unavailable or has already been used.", false)
		}
		if expires, ok := invite["expires_at"].(time.Time); ok && !expires.After(time.Now()) {
			return fail(410, "INVITE_EXPIRED", "That invite has expired. Ask for a new code.", false)
		}
		if invite["host_id"] == userID {
			return fail(409, "INVALID_REQUEST", "You cannot join your own invite.", false)
		}
		var active, blocked bool
		if err := tx.QueryRow(ctx, "select exists(select 1 from public.active_sessions where user_id = $1)", userID).Scan(&active); err != nil {
			return err
		}
		if active {
			return fail(409, "ALREADY_ACTIVE", "You already have an active lobby or queue.", false)
		}
		if err := tx.QueryRow(ctx, "select exists(select 1 from public.blocks where (blocker_id = $1 and blocked_id = $2) or (blocker_id = $2 and blocked_id = $1))", userID, invite["host_id"]).Scan(&blocked); err != nil {
			return err
		}
		if blocked {
			return fail(403, "FORBIDDEN", "This invite cannot be joined.", false)
		}
		if match == nil || match["state"] != "WAITING_READY" {
			return fail(409, "NOT_FOUND", "The lobby is no longer waiting for a player.", false)
		}
		sessionNonce, err := nonce()
		if err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `insert into public.match_participants(match_id, user_id, slot, display_name_snapshot, avatar_id_snapshot, session_nonce_hash)
			values ($1, $2, 2, $3, $4, $5)`, invite["match_id"], userID, profile["display_name"], profile["avatar_id"], sha256Hex(sessionNonce)); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, "insert into public.active_sessions(user_id, match_id) values ($1, $2)", userID, invite["match_id"]); err != nil {
			return fail(409, "ALREADY_ACTIVE", "You already have an active lobby or queue.", false)
		}
		if _, err := tx.Exec(ctx, "update public.invites set state = 'REDEEMED', redeemed_by = $2 where id = $1", invite["id"], userID); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, "update public.matches set ready_deadline_at = null where id = $1", invite["match_id"]); err != nil {
			return err
		}
		hostID = fmt.Sprint(invite["host_id"])
		result = map[string]any{"matchId": invite["match_id"], "sessionNonce": sessionNonce, "exercise": match["exercise"], "mode": Friend}
		return nil
	})
	if err != nil {
		return nil, err
	}
	message, _ := json.Marshal(map[string]any{"type": "match.found", "matchId": result["matchId"], "users": []string{userID, hostID}})
	_ = a.Redis.Publish(ctx, "match-events", message).Err()
	return result, nil
}

func (a *App) enqueue(ctx context.Context, userID string, exercise Exercise) (map[string]any, error) {
	if err := a.checkEnabled(ctx, exercise, Ranked); err != nil {
		return nil, err
	}
	var result map[string]any
	err := a.transaction(ctx, true, func(tx pgx.Tx) error {
		profile, err := a.profileForUpdate(ctx, tx, userID)
		if err != nil {
			return err
		}
		var seasonID string
		if err := tx.QueryRow(ctx, "select id from public.seasons where now() >= start_at and now() < end_at limit 1").Scan(&seasonID); errors.Is(err, pgx.ErrNoRows) {
			return fail(503, "FEATURE_UNAVAILABLE", "Ranked play is between seasons. Try again when the next season opens.", true)
		} else if err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, "select pg_advisory_xact_lock(hashtextextended('queue:' || $1, 0))", exercise); err != nil {
			return err
		}
		var active bool
		if err := tx.QueryRow(ctx, "select exists(select 1 from public.active_sessions where user_id = $1)", userID).Scan(&active); err != nil {
			return err
		}
		if active {
			return fail(409, "ALREADY_ACTIVE", "You already have an active lobby or queue.", false)
		}
		var rating, games int
		_ = tx.QueryRow(ctx, "select rating, games from public.exercise_ratings where user_id = $1 and exercise = $2 and season_id = $3", userID, exercise, seasonID).Scan(&rating, &games)
		if rating == 0 {
			rating = 1000
		}
		candidate, err := queryOne(ctx, tx, `select q.id, q.user_id, q.rating, p.display_name, p.avatar_id from public.queue_entries q
			join public.profiles p on p.id = q.user_id and p.status = 'active' and p.adult_confirmed_at is not null
			left join public.exercise_ratings candidate_rating on candidate_rating.user_id = q.user_id
			  and candidate_rating.exercise = q.exercise and candidate_rating.season_id = $4
			where q.exercise = $1 and q.rule_version = $6 and q.app_protocol = $7 and q.state = 'WAITING' and q.user_id <> $2
			  and q.heartbeat_at > now() - interval '15 seconds'
			  and abs(q.rating - $3) <= case when now() - q.created_at < interval '15 seconds' then 150
			    when now() - q.created_at < interval '30 seconds' then 300 else 500 end
			  and not exists(select 1 from public.blocks b where (b.blocker_id = $2 and b.blocked_id = q.user_id) or (b.blocker_id = q.user_id and b.blocked_id = $2))
			  and not exists(select 1 from public.active_sessions a where a.user_id = q.user_id and (a.match_id is not null or a.queue_id <> q.id))
			  and (select count(*) from public.matches m join public.match_participants me on me.match_id = m.id
			    join public.match_participants them on them.match_id = m.id and them.user_id = q.user_id
			    where me.user_id = $2 and m.mode = 'ranked' and m.exercise = $1 and m.state = 'COMPLETED'
			      and m.created_at >= date_trunc('day', now() at time zone 'utc') at time zone 'utc') < 3
			order by case when $5::boolean and coalesce(candidate_rating.games, 0) < 5 then 0 else 1 end, q.created_at asc
			for update of q skip locked limit 1`, exercise, userID, rating, seasonID, games < 5, ruleVersion(exercise), 1)
		if err != nil && !errors.Is(err, pgx.ErrNoRows) {
			return err
		}
		var queueID string
		if err := tx.QueryRow(ctx, "insert into public.queue_entries(user_id, exercise, rule_version, rating) values ($1, $2, $3, $4) returning id", userID, exercise, ruleVersion(exercise), rating).Scan(&queueID); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, "insert into public.active_sessions(user_id, queue_id) values ($1, $2)", userID, queueID); err != nil {
			return err
		}
		if errors.Is(err, pgx.ErrNoRows) {
			result = map[string]any{"status": "queued", "queueId": queueID, "waitStartedAt": time.Now().UTC().Format(time.RFC3339Nano)}
			return nil
		}
		var opponentAvatar, opponentName string
		_ = tx.QueryRow(ctx, "select avatar_id, display_name from public.profiles where id = $1", candidate["user_id"]).Scan(&opponentAvatar, &opponentName)
		if opponentName == "" {
			opponentName = "Player"
			opponentAvatar = "move-01"
		}
		opponentNonce, err := nonce()
		if err != nil {
			return err
		}
		ownNonce, err := nonce()
		if err != nil {
			return err
		}
		var matchID string
		if err := tx.QueryRow(ctx, `insert into public.matches(mode, exercise, rule_version, model_version, state, season_id, ready_deadline_at)
			values ('ranked', $1, $2, $3, 'WAITING_READY', $4, now() + interval '20 seconds') returning id`, exercise, ruleVersion(exercise), modelVersion, seasonID).Scan(&matchID); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `insert into public.match_participants(match_id, user_id, slot, display_name_snapshot, avatar_id_snapshot, session_nonce_hash)
			values ($1, $2, 1, $3, $4, $5), ($1, $6, 2, $7, $8, $9)`, matchID, candidate["user_id"], opponentName, opponentAvatar, sha256Hex(opponentNonce), userID, profile["display_name"], profile["avatar_id"], sha256Hex(ownNonce)); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, "update public.queue_entries set state = 'MATCHED' where id = any($1::uuid[])", []string{fmt.Sprint(candidate["id"]), queueID}); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, "update public.active_sessions set match_id = $2, queue_id = null where user_id = any($1::uuid[])", []string{fmt.Sprint(candidate["user_id"]), userID}, matchID); err != nil {
			return err
		}
		result = map[string]any{"status": "matched", "matchId": matchID, "sessionNonce": ownNonce, "exercise": exercise, "mode": Ranked,
			"usersToNotify": []string{userID, fmt.Sprint(candidate["user_id"])}}
		return nil
	})
	if err != nil {
		return nil, err
	}
	if result["status"] == "matched" {
		message, _ := json.Marshal(map[string]any{"type": "match.found", "matchId": result["matchId"], "users": result["usersToNotify"]})
		_ = a.Redis.Publish(ctx, "match-events", message).Err()
		delete(result, "usersToNotify")
	}
	return result, nil
}
