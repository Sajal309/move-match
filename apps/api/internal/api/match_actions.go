package api

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"sort"
	"time"

	"github.com/jackc/pgx/v5"
)

func (a *App) cancelQueue(ctx context.Context, userID string) (map[string]any, error) {
	var result map[string]any
	err := a.transaction(ctx, false, func(tx pgx.Tx) error {
		active, err := queryOne(ctx, tx, "select queue_id as \"queueId\", match_id as \"matchId\" from public.active_sessions where user_id = $1 for update", userID)
		if errors.Is(err, pgx.ErrNoRows) {
			result = map[string]any{"status": "cancelled"}
			return nil
		}
		if err != nil {
			return err
		}
		if active["matchId"] != nil {
			result = map[string]any{"status": "reserved", "matchId": active["matchId"]}
			return nil
		}
		if active["queueId"] == nil {
			result = map[string]any{"status": "cancelled"}
			return nil
		}
		if _, err := tx.Exec(ctx, "update public.queue_entries set state = 'CANCELLED' where id = $1 and state in ('WAITING','RESERVED')", active["queueId"]); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, "delete from public.active_sessions where user_id = $1 and queue_id = $2", userID, active["queueId"]); err != nil {
			return err
		}
		result = map[string]any{"status": "cancelled"}
		return nil
	})
	return result, err
}

func (a *App) heartbeatMatch(ctx context.Context, userID, matchID string) (map[string]any, error) {
	tag, err := a.DB.Exec(ctx, "update public.match_participants set last_seen_at = now(), connection_state = 'connected' where match_id = $1 and user_id = $2", matchID, userID)
	if err != nil {
		return nil, err
	}
	if tag.RowsAffected() == 0 {
		return nil, fail(404, "NOT_FOUND", "Match not found.", false)
	}
	return map[string]any{"ok": true, "serverTime": time.Now().UTC()}, nil
}

func (a *App) heartbeatQueue(ctx context.Context, userID string) (map[string]any, error) {
	tag, err := a.DB.Exec(ctx, `update public.queue_entries q set heartbeat_at = now() from public.active_sessions a
		where a.user_id = $1 and a.queue_id = q.id and q.state = 'WAITING'`, userID)
	if err != nil {
		return nil, err
	}
	return map[string]any{"ok": tag.RowsAffected() > 0, "serverTime": time.Now().UTC()}, nil
}

func (a *App) leaveMatch(ctx context.Context, userID, matchID string) (map[string]any, error) {
	match, err := queryOne(ctx, a.DB, `select m.state from public.matches m join public.match_participants p on p.match_id = m.id
		where m.id = $1 and p.user_id = $2`, matchID, userID)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, fail(404, "NOT_FOUND", "Match not found.", false)
	}
	if err != nil {
		return nil, err
	}
	if match["state"] == "WAITING_READY" || match["state"] == "COUNTDOWN" {
		err := a.transaction(ctx, false, func(tx pgx.Tx) error {
			if _, err := tx.Exec(ctx, "update public.matches set state = 'CANCELLED', reason = 'player_left_before_start', updated_at = now() where id = $1", matchID); err != nil {
				return err
			}
			_, err := tx.Exec(ctx, "delete from public.active_sessions where match_id = $1", matchID)
			return err
		})
		return map[string]any{"status": "cancelled", "reason": "player_left_before_start"}, err
	}
	tag, err := a.DB.Exec(ctx, "update public.match_participants set connection_state = 'forfeit' where match_id = $1 and user_id = $2", matchID, userID)
	if err != nil {
		return nil, err
	}
	if tag.RowsAffected() == 0 {
		return nil, fail(404, "NOT_FOUND", "Match not found.", false)
	}
	return a.settle(ctx, matchID, userID, "")
}

func (a *App) leaderboard(ctx context.Context, exercise Exercise, seasonID, userID string) (map[string]any, error) {
	season, err := queryOne(ctx, a.DB, `select id, name from public.seasons where ($1::uuid is not null and id = $1)
		or ($1::uuid is null and now() >= start_at and now() < end_at) limit 1`, nullable(seasonID))
	if errors.Is(err, pgx.ErrNoRows) {
		return map[string]any{"season": nil, "rows": []any{}, "ownRank": nil, "cachedAt": time.Now().UTC()}, nil
	}
	if err != nil {
		return nil, err
	}
	rows, err := queryRows(ctx, a.DB, `with ranked as (
		select rank() over(order by r.rating desc) as rank, p.display_name as "displayName", p.avatar_id as "avatarId",
			r.rating, r.games as played, r.user_id, r.updated_at as "updatedAt"
		from public.exercise_ratings r join public.profiles p on p.id = r.user_id
		where r.exercise = $1 and r.season_id = $2 and r.eligible = true and p.status = 'active'
	) select rank, "displayName", "avatarId", rating, played, (user_id = $3::uuid) as "isSelf", "updatedAt", user_id
	from ranked where rank <= 100 or user_id = $3::uuid order by rank, user_id`, exercise, season["id"], nullable(userID))
	if err != nil {
		return nil, err
	}
	ownRank := any(nil)
	for _, item := range rows {
		if item["isSelf"] == true {
			ownRank = item["rank"]
		}
		delete(item, "user_id")
	}
	return map[string]any{"season": season, "rows": rows, "ownRank": ownRank, "cachedAt": time.Now().UTC()}, nil
}

func nullable(value string) any {
	if value == "" {
		return nil
	}
	return value
}

func (a *App) settle(ctx context.Context, matchID, forfeitUserID, voidReason string) (map[string]any, error) {
	var result map[string]any
	err := a.transaction(ctx, false, func(tx pgx.Tx) error {
		match, err := queryOne(ctx, tx, `select mode, exercise, state, start_at as "startAt", end_at as "endAt", season_id as "seasonId"
			from public.matches where id = $1 for update`, matchID)
		if errors.Is(err, pgx.ErrNoRows) {
			return fail(404, "NOT_FOUND", "Match not found.", false)
		}
		if err != nil {
			return err
		}
		existing, err := queryOne(ctx, tx, "select match_id, outcome, winner_user_id, score_player_1, score_player_2, reason from public.match_results where match_id = $1", matchID)
		if err == nil {
			result = existing
			return nil
		}
		if !errors.Is(err, pgx.ErrNoRows) {
			return err
		}
		endAt, hasEnd := match["endAt"].(time.Time)
		if forfeitUserID == "" && voidReason == "" && (!hasEnd || time.Now().Before(endAt.Add(3*time.Second))) {
			return fail(409, "RESULT_PENDING", "This round is still in progress.", true)
		}
		if _, err := tx.Exec(ctx, "update public.matches set state = 'SETTLING', updated_at = now() where id = $1", matchID); err != nil {
			return err
		}
		participants, err := queryRows(ctx, tx, "select user_id, slot, accepted_count as score, connection_state from public.match_participants where match_id = $1 order by slot for update", matchID)
		if err != nil {
			return err
		}
		var left, right map[string]any
		for _, participant := range participants {
			if participant["slot"] == int16(1) || participant["slot"] == int32(1) {
				left = participant
			} else if participant["slot"] == int16(2) || participant["slot"] == int32(2) {
				right = participant
			}
		}
		score1, score2 := integer(left, "score"), integer(right, "score")
		isVoid := voidReason != "" || right == nil
		var winner any
		outcome := "draw"
		reason := any(nil)
		if isVoid {
			outcome = "void"
		} else if forfeitUserID != "" {
			outcome = "forfeit"
			for _, participant := range participants {
				if participant["user_id"] != nil && participant["user_id"] != forfeitUserID {
					winner = participant["user_id"]
				}
			}
			reason = "player_forfeit"
		} else if score1 > score2 {
			outcome, winner = "player_1_win", left["user_id"]
		} else if score2 > score1 {
			outcome, winner = "player_2_win", right["user_id"]
		}
		if voidReason != "" {
			reason = voidReason
		}
		mode := MatchMode(fmt.Sprint(match["mode"]))
		exercise := Exercise(fmt.Sprint(match["exercise"]))
		seasonID, _ := match["seasonId"].(string)
		if !isVoid && mode == Ranked && left != nil && right != nil && left["user_id"] != nil && right["user_id"] != nil && seasonID != "" {
			if err := a.applyRating(ctx, tx, matchID, exercise, seasonID, fmt.Sprint(left["user_id"]), fmt.Sprint(right["user_id"]), winner); err != nil {
				return err
			}
		}
		startAt, _ := match["startAt"].(time.Time)
		if !isVoid {
			if err := a.applyProgress(ctx, tx, matchID, mode, exercise, participants, winner, forfeitUserID, int(time.Since(startAt).Milliseconds())); err != nil {
				return err
			}
		}
		resultPayload := map[string]any{"matchId": matchID, "outcome": outcome, "score1": score1, "score2": score2, "reason": reason}
		resultBytes, _ := json.Marshal(resultPayload)
		digest := sha256.Sum256(resultBytes)
		if _, err := tx.Exec(ctx, `insert into public.match_results(match_id, outcome, winner_user_id, score_player_1, score_player_2, reason, result_hash)
			values ($1, $2, $3, $4, $5, $6, $7) on conflict (match_id) do nothing`, matchID, outcome, winner, score1, score2, reason, hex.EncodeToString(digest[:])); err != nil {
			return err
		}
		state := "COMPLETED"
		if isVoid {
			state = "VOIDED"
		}
		if _, err := tx.Exec(ctx, "update public.matches set state = $2, reason = $3, updated_at = now() where id = $1", matchID, state, reason); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, "delete from public.active_sessions where match_id = $1", matchID); err != nil {
			return err
		}
		outbox, _ := json.Marshal(map[string]any{"matchId": matchID, "outcome": outcome, "winnerUserId": winner, "scorePlayer1": score1, "scorePlayer2": score2, "reason": reason})
		if _, err := tx.Exec(ctx, "insert into public.outbox(aggregate_id, event_type, payload) values ($1, 'match.settled', $2::jsonb)", matchID, outbox); err != nil {
			return err
		}
		result = map[string]any{"match_id": matchID, "outcome": outcome, "winner_user_id": winner, "score_player_1": score1, "score_player_2": score2, "reason": reason}
		return nil
	})
	return result, err
}

func integer(row map[string]any, key string) int {
	if row == nil || row[key] == nil {
		return 0
	}
	switch value := row[key].(type) {
	case int:
		return value
	case int16:
		return int(value)
	case int32:
		return int(value)
	case int64:
		return int(value)
	}
	return 0
}

func (a *App) applyRating(ctx context.Context, tx pgx.Tx, matchID string, exercise Exercise, seasonID, user1, user2 string, winner any) error {
	if _, err := tx.Exec(ctx, "select id from public.seasons where id = $1 for update", seasonID); err != nil {
		return err
	}
	userIDs := []string{user1, user2}
	sort.Strings(userIDs)
	for _, userID := range userIDs {
		if _, err := tx.Exec(ctx, "insert into public.exercise_ratings(user_id, exercise, season_id) values ($1, $2, $3) on conflict do nothing", userID, exercise, seasonID); err != nil {
			return err
		}
	}
	ratings := make(map[string]int, 2)
	for _, userID := range userIDs {
		var rating int
		if err := tx.QueryRow(ctx, "select rating from public.exercise_ratings where user_id = $1 and exercise = $2 and season_id = $3 for update", userID, exercise, seasonID).Scan(&rating); err != nil {
			return err
		}
		ratings[userID] = rating
	}
	r1, r2 := ratings[user1], ratings[user2]
	actual := 0.5
	if winner == user1 {
		actual = 1
	} else if winner == user2 {
		actual = 0
	}
	delta := int(math.Round(32 * (actual - 1/(1+math.Pow(10, float64(r2-r1)/400)))))
	for _, row := range []struct {
		user, opponent string
		before, change int
	}{{user1, user2, r1, delta}, {user2, user1, r2, -delta}} {
		after := row.before + row.change
		if _, err := tx.Exec(ctx, `update public.exercise_ratings set rating = $4, games = games + 1,
			distinct_opponents = case when not ($5::uuid = any(distinct_opponents)) then array_append(distinct_opponents, $5::uuid) else distinct_opponents end,
			placement_opponents_count = greatest(placement_opponents_count, cardinality(distinct_opponents) + case when $5::uuid = any(distinct_opponents) then 0 else 1 end),
			eligible = games + 1 >= 5 and cardinality(distinct_opponents) + case when $5::uuid = any(distinct_opponents) then 0 else 1 end >= 3,
			updated_at = now() where user_id = $1 and exercise = $2 and season_id = $3`, row.user, exercise, seasonID, after, row.opponent); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `insert into public.rating_ledger(match_id, user_id, before_rating, delta, after_rating, reason)
			values ($1, $2, $3, $4, $5, 'ranked_settlement') on conflict do nothing`, matchID, row.user, row.before, row.change, after); err != nil {
			return err
		}
	}
	return nil
}

func (a *App) applyProgress(ctx context.Context, tx pgx.Tx, matchID string, mode MatchMode, exercise Exercise, participants []map[string]any, winner any, forfeiter string, activeMS int) error {
	for _, participant := range participants {
		userID, _ := participant["user_id"].(string)
		if userID == "" || userID == forfeiter || forfeiter != "" && (activeMS < 15_000 || integer(participant, "score") < 1) {
			continue
		}
		var daily int
		if err := tx.QueryRow(ctx, "select count(*)::int from public.xp_ledger where user_id = $1 and source_type = 'match' and utc_day = (now() at time zone 'utc')::date", userID).Scan(&daily); err != nil {
			return err
		}
		bonus := 0
		if mode != Friend && forfeiter == "" {
			if winner == userID {
				bonus = 10
			} else if winner == nil {
				bonus = 5
			}
		}
		amount := 0
		if daily < 5 {
			amount = 20 + bonus
		}
		if amount > 0 {
			if _, err := tx.Exec(ctx, `insert into public.xp_ledger(user_id, source_type, source_id, reward_type, amount, utc_day)
				values ($1, 'match', $2, 'completion', $3, (now() at time zone 'utc')::date) on conflict do nothing`, userID, matchID, amount); err != nil {
				return err
			}
			if _, err := tx.Exec(ctx, `insert into public.user_progress(user_id, total_xp) values ($1, $2)
				on conflict (user_id) do update set total_xp = public.user_progress.total_xp + $2, updated_at = now()`, userID, amount); err != nil {
				return err
			}
		}
		if _, err := tx.Exec(ctx, "insert into public.activity_days(user_id, utc_date, source_id) values ($1, (now() at time zone 'utc')::date, $2) on conflict do nothing", userID, matchID); err != nil {
			return err
		}
		var completed int
		if err := tx.QueryRow(ctx, "select count(*)::int from public.match_results r join public.match_participants p on p.match_id = r.match_id where p.user_id = $1 and r.outcome <> 'void'", userID).Scan(&completed); err != nil {
			return err
		}
		if completed == 0 {
			_, err := tx.Exec(ctx, "insert into public.badges(user_id, badge_key, source_id) values ($1, 'first_match', $2) on conflict do nothing", userID, matchID)
			if err != nil {
				return err
			}
		}
		if completed >= 9 {
			if _, err := tx.Exec(ctx, "insert into public.badges(user_id, badge_key, source_id) values ($1, 'ten_completed_matches', $2) on conflict do nothing", userID, matchID); err != nil {
				return err
			}
		}
		var rivals int
		if err := tx.QueryRow(ctx, `select count(distinct other.user_id)::int from public.match_participants mine
			join public.match_participants other on other.match_id = mine.match_id and other.user_id is not null and other.user_id <> mine.user_id
			join public.match_results r on r.match_id = mine.match_id and r.outcome <> 'void' where mine.user_id = $1`, userID).Scan(&rivals); err != nil {
			return err
		}
		var opponent any
		for _, other := range participants {
			if other["user_id"] != nil && other["user_id"] != userID {
				opponent = other["user_id"]
			}
		}
		if opponent != nil && rivals >= 4 {
			var met bool
			if err := tx.QueryRow(ctx, `select exists(select 1 from public.match_participants mine
				join public.match_participants other on other.match_id = mine.match_id and other.user_id = $2
				join public.match_results r on r.match_id = mine.match_id and r.outcome <> 'void'
				where mine.user_id = $1 and mine.match_id <> $3)`, userID, opponent, matchID).Scan(&met); err != nil {
				return err
			}
			if !met {
				if _, err := tx.Exec(ctx, "insert into public.badges(user_id, badge_key, source_id) values ($1, 'five_distinct_rivals', $2) on conflict do nothing", userID, matchID); err != nil {
					return err
				}
			}
		}
		var activeDays int
		if err := tx.QueryRow(ctx, "select count(*)::int from public.activity_days where user_id = $1 and utc_date >= date_trunc('week', (now() at time zone 'utc'))::date", userID).Scan(&activeDays); err != nil {
			return err
		}
		if activeDays >= 3 {
			if _, err := tx.Exec(ctx, "insert into public.badges(user_id, badge_key, source_id) values ($1, 'three_active_days_week', $2) on conflict do nothing", userID, matchID); err != nil {
				return err
			}
		}
		if exercise == PullUp && integer(participant, "score") > 0 {
			if _, err := tx.Exec(ctx, "insert into public.badges(user_id, badge_key, source_id) values ($1, 'first_pull_up_session', $2) on conflict do nothing", userID, matchID); err != nil {
				return err
			}
		}
	}
	return nil
}

func (a *App) settleDueMatches(ctx context.Context) error {
	statements := []string{
		"update public.matches set state = 'CANCELLED', reason = 'ready_timeout', updated_at = now() where state = 'WAITING_READY' and mode = 'ranked' and ready_deadline_at <= now()",
		"delete from public.active_sessions a using public.matches m where a.match_id = m.id and m.state = 'CANCELLED'",
		"update public.matches m set state = 'ACTIVE', updated_at = now() where m.state = 'COUNTDOWN' and m.start_at <= now() and m.end_at > now() and not exists (select 1 from public.match_participants p where p.match_id = m.id and (p.ready_expires_at is null or p.ready_expires_at <= now()))",
		"update public.matches m set state = 'CANCELLED', reason = 'readiness_expired', updated_at = now() where m.state = 'COUNTDOWN' and m.start_at <= now() and exists (select 1 from public.match_participants p where p.match_id = m.id and (p.ready_expires_at is null or p.ready_expires_at <= now()))",
		"delete from public.active_sessions a using public.matches m where a.match_id = m.id and m.state = 'CANCELLED'",
	}
	for _, query := range statements {
		if _, err := a.DB.Exec(ctx, query); err != nil {
			return err
		}
	}
	matches, err := queryRows(ctx, a.DB, "select id from public.matches where state in ('COUNTDOWN','ACTIVE','SETTLING') and end_at < now() - interval '3 seconds' order by end_at limit 100")
	if err != nil {
		return err
	}
	for _, match := range matches {
		_, _ = a.settle(ctx, fmt.Sprint(match["id"]), "", "")
	}
	statements = []string{
		"update public.queue_entries set state = 'EXPIRED' where state = 'WAITING' and heartbeat_at < now() - interval '15 seconds'",
		"delete from public.active_sessions a using public.queue_entries q where a.queue_id = q.id and q.state in ('EXPIRED','CANCELLED','MATCHED')",
		"update public.invites set state = 'EXPIRED' where state = 'OPEN' and expires_at <= now()",
		"update public.matches m set state = 'CANCELLED', reason = 'lobby_expired', updated_at = now() where m.state = 'WAITING_READY' and m.created_at < now() - interval '10 minutes' and m.mode = 'friend'",
		"delete from public.active_sessions a using public.matches m where a.match_id = m.id and m.state = 'CANCELLED'",
	}
	for _, query := range statements {
		if _, err := a.DB.Exec(ctx, query); err != nil {
			return err
		}
	}
	return nil
}

func (a *App) processDisconnectedMatches(ctx context.Context) error {
	matches, err := queryRows(ctx, a.DB, `select m.id as "matchId",
		array_agg(p.user_id::text order by p.slot) filter(where p.user_id is not null and (p.last_seen_at is null or p.last_seen_at < now() - interval '10 seconds')) as stale_users,
		array_agg(p.user_id::text order by p.slot) filter(where p.user_id is not null and p.last_seen_at >= now() - interval '10 seconds') as active_users
		from public.matches m join public.match_participants p on p.match_id = m.id
		where m.state = 'ACTIVE' and m.start_at <= now() - interval '10 seconds' group by m.id
		having count(*) = 2 and count(*) filter(where p.last_seen_at is null or p.last_seen_at < now() - interval '10 seconds') > 0`)
	if err != nil {
		return err
	}
	for _, match := range matches {
		stale := stringArray(match["stale_users"])
		active := stringArray(match["active_users"])
		if len(active) > 0 && len(stale) > 0 {
			_, _ = a.leaveMatch(ctx, stale[0], fmt.Sprint(match["matchId"]))
		} else if len(stale) == 2 {
			_, _ = a.settle(ctx, fmt.Sprint(match["matchId"]), "", "both_players_disconnected")
		}
	}
	return nil
}

func stringArray(value any) []string {
	switch values := value.(type) {
	case []string:
		return values
	case []any:
		result := make([]string, 0, len(values))
		for _, item := range values {
			result = append(result, fmt.Sprint(item))
		}
		return result
	default:
		return nil
	}
}
