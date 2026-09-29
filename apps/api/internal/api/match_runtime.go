package api

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
)

type RepObservation struct {
	ProtocolVersion           int      `json:"protocolVersion"`
	EventID                   string   `json:"eventId"`
	MatchID                   string   `json:"matchId"`
	SessionNonce              string   `json:"sessionNonce"`
	Seq                       int      `json:"seq"`
	Exercise                  Exercise `json:"exercise"`
	RuleVersion               string   `json:"ruleVersion"`
	ModelVersion              string   `json:"modelVersion"`
	CycleStartMS              int      `json:"cycleStartMs"`
	CycleEndMS                int      `json:"cycleEndMs"`
	MinElbowDeg               float64  `json:"minElbowDeg"`
	MaxElbowDeg               float64  `json:"maxElbowDeg"`
	MinimumRequiredVisibility float64  `json:"minimumRequiredVisibility"`
	TrackingGapMS             int      `json:"trackingGapMs"`
	QualityFlags              []string `json:"qualityFlags"`
}

func validateRep(event RepObservation) bool {
	if event.ProtocolVersion != 1 || event.EventID == "" || event.MatchID == "" || len(event.SessionNonce) < 24 || len(event.SessionNonce) > 160 ||
		event.Seq < 1 || event.Seq > 200 || !validExercise(event.Exercise) || len(event.RuleVersion) < 1 || len(event.RuleVersion) > 40 ||
		len(event.ModelVersion) < 1 || len(event.ModelVersion) > 120 || event.CycleStartMS < 0 || event.CycleStartMS > 48_000 ||
		event.CycleEndMS < 1 || event.CycleEndMS > 48_000 || event.MinElbowDeg < 0 || event.MinElbowDeg > 180 ||
		event.MaxElbowDeg < 0 || event.MaxElbowDeg > 180 || event.MinimumRequiredVisibility < 0 || event.MinimumRequiredVisibility > 1 ||
		event.TrackingGapMS < 0 || event.TrackingGapMS > 2_000 || len(event.QualityFlags) > 12 || event.CycleEndMS <= event.CycleStartMS || event.MaxElbowDeg < event.MinElbowDeg {
		return false
	}
	for _, flag := range event.QualityFlags {
		if len(flag) < 1 || len(flag) > 40 {
			return false
		}
	}
	return uuidPattern.MatchString(event.EventID) && uuidPattern.MatchString(event.MatchID)
}

func (a *App) readyMatch(ctx context.Context, userID, matchID, sessionNonce string) (map[string]any, error) {
	var result map[string]any
	err := a.transaction(ctx, false, func(tx pgx.Tx) error {
		match, err := queryOne(ctx, tx, "select state, exercise, duration_ms, mode, ready_deadline_at as deadline from public.matches where id = $1 for update", matchID)
		if errors.Is(err, pgx.ErrNoRows) {
			return fail(404, "NOT_FOUND", "Match not found.", false)
		}
		if err != nil {
			return err
		}
		state := match["state"]
		mode := match["mode"]
		if state != "WAITING_READY" && state != "COUNTDOWN" {
			return fail(409, "INVALID_REQUEST", "This match is no longer accepting readiness.", false)
		}
		if deadline, ok := match["deadline"].(time.Time); ok && state == "WAITING_READY" && mode == string(Ranked) && !deadline.After(time.Now()) {
			if _, err := tx.Exec(ctx, "update public.matches set state = 'CANCELLED', reason = 'ready_timeout', updated_at = now() where id = $1", matchID); err != nil {
				return err
			}
			if _, err := tx.Exec(ctx, "delete from public.active_sessions where match_id = $1", matchID); err != nil {
				return err
			}
			result = map[string]any{"state": "CANCELLED", "reason": "ready_timeout"}
			return nil
		}
		tag, err := tx.Exec(ctx, `update public.match_participants set ready_at = now(), ready_expires_at = now() + interval '20 seconds', last_seen_at = now()
			where match_id = $1 and user_id = $2 and session_nonce_hash = $3`, matchID, userID, sha256Hex(sessionNonce))
		if err != nil {
			return err
		}
		if tag.RowsAffected() == 0 {
			return fail(401, "AUTH_EXPIRED", "Match session expired. Reopen the match to reconnect.", false)
		}
		participants, err := queryRows(ctx, tx, "select user_id, ready_at as \"readyAt\", ready_expires_at as \"readyExpiresAt\" from public.match_participants where match_id = $1 order by slot", matchID)
		if err != nil {
			return err
		}
		if len(participants) != 2 {
			count := 0
			for _, participant := range participants {
				if participant["readyAt"] != nil {
					count++
				}
			}
			result = map[string]any{"state": "WAITING_READY", "readyCount": count}
			return nil
		}
		if state == "COUNTDOWN" {
			current, err := queryOne(ctx, tx, "select start_at as \"startAt\", end_at as \"endAt\" from public.matches where id = $1", matchID)
			if err != nil {
				return err
			}
			result = map[string]any{"state": "COUNTDOWN", "startAt": current["startAt"], "endAt": current["endAt"]}
			return nil
		}
		readyCount := 0
		ready := true
		for _, participant := range participants {
			at, hasTime := participant["readyExpiresAt"].(time.Time)
			if !hasTime || !at.After(time.Now()) {
				ready = false
			}
			if participant["readyAt"] != nil {
				readyCount++
			}
		}
		if !ready {
			result = map[string]any{"state": "WAITING_READY", "readyCount": readyCount}
			return nil
		}
		startAt := time.Now().Add(5 * time.Second).UTC()
		endAt := startAt.Add(45 * time.Second)
		var seasonID any
		if mode == string(Ranked) {
			if err := tx.QueryRow(ctx, "select id from public.seasons where start_at <= $1 and end_at > $1 for update", startAt).Scan(&seasonID); errors.Is(err, pgx.ErrNoRows) {
				return fail(503, "FEATURE_UNAVAILABLE", "The current season ended. Rejoin the queue when the next season opens.", true)
			} else if err != nil {
				return err
			}
		}
		if _, err := tx.Exec(ctx, "update public.matches set state = 'COUNTDOWN', start_at = $2, end_at = $3, season_id = $4, updated_at = now() where id = $1", matchID, startAt, endAt, seasonID); err != nil {
			return err
		}
		result = map[string]any{"state": "COUNTDOWN", "startAt": startAt, "endAt": endAt}
		return nil
	})
	return result, err
}

func (a *App) matchSnapshot(ctx context.Context, userID, matchID string, renewNonce bool) (map[string]any, error) {
	var result map[string]any
	err := a.transaction(ctx, false, func(tx pgx.Tx) error {
		own, err := queryOne(ctx, tx, "select slot from public.match_participants where match_id = $1 and user_id = $2 for update", matchID, userID)
		if errors.Is(err, pgx.ErrNoRows) {
			return fail(404, "NOT_FOUND", "Match not found.", false)
		}
		if err != nil {
			return err
		}
		var sessionNonce any
		if renewNonce {
			nonceValue, err := nonce()
			if err != nil {
				return err
			}
			sessionNonce = nonceValue
			if _, err := tx.Exec(ctx, "update public.match_participants set session_nonce_hash = $3 where match_id = $1 and user_id = $2", matchID, userID, sha256Hex(nonceValue)); err != nil {
				return err
			}
		}
		participants, err := queryRows(ctx, tx, `select m.id, m.mode, m.exercise, m.rule_version, m.model_version, m.state, m.start_at, m.end_at,
			p.slot, (p.user_id = $2::uuid) as is_self, p.display_name_snapshot, p.avatar_id_snapshot, p.accepted_count, p.connection_state,
			(r.winner_user_id = p.user_id) as is_winner, r.outcome, r.score_player_1, r.score_player_2, r.settled_at, r.reason,
			rl.before_rating as rating_before, rl.delta as rating_delta, rl.after_rating as rating_after,
			coalesce((select sum(x.amount) from public.xp_ledger x where x.source_type = 'match' and x.source_id = m.id and x.user_id = p.user_id), 0) as xp_awarded
			from public.matches m join public.match_participants p on p.match_id = m.id left join public.match_results r on r.match_id = m.id
			left join public.rating_ledger rl on rl.match_id = m.id and rl.user_id = p.user_id where m.id = $1 order by p.slot`, matchID, userID)
		if err != nil {
			return err
		}
		var nextSeq int
		if err := tx.QueryRow(ctx, "select coalesce(max(seq), 0) + 1 from public.rep_events where match_id = $1 and user_id = $2", matchID, userID).Scan(&nextSeq); err != nil {
			return err
		}
		result = map[string]any{"matchId": matchID, "nextSeq": nextSeq, "participants": participants, "serverTime": time.Now().UTC()}
		if sessionNonce != nil {
			result["sessionNonce"] = sessionNonce
		}
		_ = own
		return nil
	})
	return result, err
}

func (a *App) acceptRep(ctx context.Context, userID string, raw json.RawMessage) (map[string]any, error) {
	var event RepObservation
	if json.Unmarshal(raw, &event) != nil || !validateRep(event) {
		return nil, fail(400, "INVALID_REQUEST", "Rep event data is incomplete or outside protocol bounds.", false)
	}
	var result map[string]any
	err := a.transaction(ctx, false, func(tx pgx.Tx) error {
		match, err := queryOne(ctx, tx, "select state, exercise, rule_version as \"ruleVersion\", model_version as \"modelVersion\", start_at as \"startAt\", end_at as \"endAt\", duration_ms as \"durationMs\" from public.matches where id = $1 for update", event.MatchID)
		if errors.Is(err, pgx.ErrNoRows) {
			return fail(404, "NOT_FOUND", "Match not found.", false)
		}
		if err != nil {
			return err
		}
		participant, err := queryOne(ctx, tx, "select session_nonce_hash as \"nonceHash\", accepted_count as score, slot from public.match_participants where match_id = $1 and user_id = $2 for update", event.MatchID, userID)
		if errors.Is(err, pgx.ErrNoRows) || err == nil && participant["nonceHash"] != sha256Hex(event.SessionNonce) {
			return fail(401, "AUTH_EXPIRED", "Match session is not valid.", false)
		}
		if err != nil {
			return err
		}
		sameEvent, err := queryOne(ctx, tx, "select match_id, user_id, seq, status, reason from public.rep_events where event_id = $1", event.EventID)
		if err == nil {
			if sameEvent["match_id"] != event.MatchID || sameEvent["user_id"] != userID || integer(sameEvent, "seq") != event.Seq {
				return fail(409, "INVALID_REQUEST", "This event identifier was already used.", false)
			}
			result = map[string]any{"eventId": event.EventID, "status": sameEvent["status"], "reason": sameEvent["reason"], "duplicate": true}
			return nil
		}
		if !errors.Is(err, pgx.ErrNoRows) {
			return err
		}
		key := "rep-rate:" + event.MatchID + ":" + userID + ":" + fmt.Sprint(time.Now().Unix())
		rate, err := a.Redis.Incr(ctx, key).Result()
		if err != nil {
			return fail(503, "SERVICE_UNAVAILABLE", "The match service is temporarily unavailable.", true)
		}
		if rate == 1 {
			_ = a.Redis.Expire(ctx, key, 2*time.Second).Err()
		}
		if rate > 5 {
			return fail(429, "RATE_LIMITED", "Rep events are arriving too quickly.", true)
		}
		previous, err := queryOne(ctx, tx, "select cycle_end_ms as \"cycleEndMs\" from public.rep_events where match_id = $1 and user_id = $2 and status = 'accepted' order by seq desc limit 1", event.MatchID, userID)
		if err != nil && !errors.Is(err, pgx.ErrNoRows) {
			return err
		}
		var reason any
		startAt, startOK := match["startAt"].(time.Time)
		endAt, endOK := match["endAt"].(time.Time)
		now := time.Now()
		switch {
		case string(event.Exercise) != fmt.Sprint(match["exercise"]) || event.RuleVersion != fmt.Sprint(match["ruleVersion"]):
			reason = "wrong_rule"
		case event.ModelVersion != match["modelVersion"]:
			reason = "wrong_model"
		case match["state"] != "ACTIVE" || !startOK || !endOK || now.After(endAt.Add(3*time.Second)):
			reason = "outside_active_interval"
		case event.CycleEndMS > 45_000 || event.CycleEndMS > integer(match, "durationMs"):
			reason = "outside_active_interval"
		case event.CycleEndMS-event.CycleStartMS < map[bool]int{true: 600, false: 900}[event.Exercise == PushUp]:
			reason = "incomplete_cycle"
		case event.MinimumRequiredVisibility < 0.7 || event.TrackingGapMS > 250:
			reason = "invalid_measurement"
		case previous != nil && event.CycleStartMS < integer(previous, "cycleEndMs"):
			reason = "impossible_sequence"
		case event.Exercise == PushUp && (event.MinElbowDeg > 95 || event.MaxElbowDeg < 155):
			reason = "incomplete_cycle"
		case event.Exercise == PullUp && (event.MinElbowDeg > 80 || event.MaxElbowDeg < 155):
			reason = "incomplete_cycle"
		}
		sameSeq, err := queryOne(ctx, tx, "select event_id, status, reason from public.rep_events where match_id = $1 and user_id = $2 and seq = $3", event.MatchID, userID, event.Seq)
		if err == nil {
			if sameSeq["event_id"] == event.EventID {
				result = map[string]any{"eventId": event.EventID, "status": sameSeq["status"], "reason": sameSeq["reason"], "duplicate": true}
				return nil
			}
			return fail(409, "INVALID_REQUEST", "This event sequence was already used.", false)
		}
		if !errors.Is(err, pgx.ErrNoRows) {
			return err
		}
		status := "accepted"
		if reason != nil {
			status = "rejected"
		}
		summary, _ := json.Marshal(event)
		var id string
		if err := tx.QueryRow(ctx, `insert into public.rep_events(event_id, match_id, user_id, seq, cycle_start_ms, cycle_end_ms, status, reason, summary)
			values ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb) on conflict (event_id) do nothing returning id`, event.EventID, event.MatchID, userID, event.Seq, event.CycleStartMS, event.CycleEndMS, status, reason, summary).Scan(&id); errors.Is(err, pgx.ErrNoRows) {
			duplicate, err := queryOne(ctx, tx, "select status, reason from public.rep_events where event_id = $1", event.EventID)
			if err != nil {
				return err
			}
			result = map[string]any{"eventId": event.EventID, "status": duplicate["status"], "reason": duplicate["reason"], "duplicate": true}
			return nil
		} else if err != nil {
			return err
		}
		if reason == nil {
			if _, err := tx.Exec(ctx, "update public.match_participants set accepted_count = accepted_count + 1 where match_id = $1 and user_id = $2", event.MatchID, userID); err != nil {
				return err
			}
		}
		score := integer(participant, "score")
		if reason == nil {
			score++
		}
		result = map[string]any{"eventId": event.EventID, "status": status, "reason": reason, "score": score, "duplicate": false, "slot": participant["slot"]}
		_ = startAt
		return nil
	})
	return result, err
}
