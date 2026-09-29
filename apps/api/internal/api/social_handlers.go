package api

import (
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

func (a *App) practiceSessionHandler(w http.ResponseWriter, r *http.Request) {
	var input struct {
		ID           string   `json:"id"`
		Exercise     Exercise `json:"exercise"`
		DurationMS   int      `json:"durationMs"`
		AcceptedReps int      `json:"acceptedReps"`
		RuleVersion  string   `json:"ruleVersion"`
		ModelVersion string   `json:"modelVersion"`
	}
	if err := a.decodeBody(w, r, &input); err != nil || !uuidPattern.MatchString(input.ID) || !validExercise(input.Exercise) || input.DurationMS < 45_000 || input.DurationMS > 50_000 || input.AcceptedReps < 1 || input.AcceptedReps > 200 || len(input.RuleVersion) < 1 || len(input.RuleVersion) > 40 || len(input.ModelVersion) < 1 || len(input.ModelVersion) > 120 {
		a.writeError(w, r, fail(400, "INVALID_REQUEST", "Request data is invalid.", false))
		return
	}
	if input.RuleVersion != ruleVersion(input.Exercise) || input.ModelVersion != modelVersion {
		a.writeError(w, r, fail(409, "RULE_UNSUPPORTED", "Practice session uses an unsupported rule or model.", false))
		return
	}
	var result map[string]any
	err := a.transaction(r.Context(), false, func(tx pgx.Tx) error {
		if _, err := tx.Exec(r.Context(), "select pg_advisory_xact_lock(hashtextextended('practice-xp:' || $1::text || ':' || (now() at time zone 'utc')::date::text, 0))", userFrom(r).ID); err != nil {
			return err
		}
		tag, err := tx.Exec(r.Context(), `insert into public.practice_syncs(id, user_id, exercise, duration_ms, accepted_reps, rule_version)
			values ($1, $2, $3, $4, $5, $6) on conflict do nothing`, input.ID, userFrom(r).ID, input.Exercise, input.DurationMS, input.AcceptedReps, input.RuleVersion)
		if err != nil {
			return err
		}
		if tag.RowsAffected() == 0 {
			result = map[string]any{"status": "duplicate", "xpAwarded": 0}
			return nil
		}
		var daily bool
		if err := tx.QueryRow(r.Context(), "select exists(select 1 from public.xp_ledger where user_id = $1 and source_type = 'practice' and utc_day = (now() at time zone 'utc')::date)", userFrom(r).ID).Scan(&daily); err != nil {
			return err
		}
		xp := 0
		if !daily {
			xp = 10
			if _, err := tx.Exec(r.Context(), `insert into public.xp_ledger(user_id, source_type, source_id, reward_type, amount, utc_day)
				values ($1, 'practice', $2, 'daily_qualifying_practice', 10, (now() at time zone 'utc')::date) on conflict do nothing`, userFrom(r).ID, input.ID); err != nil {
				return err
			}
			if _, err := tx.Exec(r.Context(), `insert into public.user_progress(user_id, total_xp) values ($1, 10)
				on conflict (user_id) do update set total_xp = public.user_progress.total_xp + 10, updated_at = now()`, userFrom(r).ID); err != nil {
				return err
			}
		}
		if _, err := tx.Exec(r.Context(), "insert into public.activity_days(user_id, utc_date, source_id) values ($1, (now() at time zone 'utc')::date, $2) on conflict do nothing", userFrom(r).ID, input.ID); err != nil {
			return err
		}
		var activeDays int
		if err := tx.QueryRow(r.Context(), "select count(*)::int from public.activity_days where user_id = $1 and utc_date >= date_trunc('week', (now() at time zone 'utc'))::date", userFrom(r).ID).Scan(&activeDays); err != nil {
			return err
		}
		if activeDays >= 3 {
			if _, err := tx.Exec(r.Context(), "insert into public.badges(user_id, badge_key, source_id) values ($1, 'three_active_days_week', $2) on conflict do nothing", userFrom(r).ID, input.ID); err != nil {
				return err
			}
		}
		result = map[string]any{"status": "recorded", "xpAwarded": xp}
		return nil
	})
	if err != nil {
		a.writeError(w, r, err)
		return
	}
	a.writeJSON(w, http.StatusOK, result)
}

func (a *App) createReportHandler(w http.ResponseWriter, r *http.Request) {
	var input struct {
		TargetID    string `json:"targetId"`
		MatchID     string `json:"matchId"`
		Category    string `json:"category"`
		Description string `json:"description"`
	}
	if err := a.decodeBody(w, r, &input); err != nil || input.TargetID == "" && input.MatchID == "" || input.TargetID != "" && !uuidPattern.MatchString(input.TargetID) || input.MatchID != "" && !uuidPattern.MatchString(input.MatchID) || len([]rune(input.Description)) > 500 || !oneOf(input.Category, "offensive_name", "suspected_cheating", "harassment", "tracking_result") {
		a.writeError(w, r, fail(400, "INVALID_REQUEST", "Request data is invalid.", false))
		return
	}
	userID := userFrom(r).ID
	if input.TargetID == userID {
		a.writeError(w, r, fail(400, "INVALID_REQUEST", "You cannot report yourself.", false))
		return
	}
	if err := a.rateLimit(r.Context(), userID, "report", 5, 3600); err != nil {
		a.writeError(w, r, err)
		return
	}
	var target any = nullable(input.TargetID)
	if input.MatchID != "" {
		match, err := queryOne(r.Context(), a.DB, `select other.user_id as "opponentId" from public.match_participants mine
			join public.match_participants other on other.match_id = mine.match_id and other.slot <> mine.slot
			where mine.match_id = $1 and mine.user_id = $2`, input.MatchID, userID)
		if errors.Is(err, pgx.ErrNoRows) {
			a.writeError(w, r, fail(404, "NOT_FOUND", "Match not found.", false))
			return
		}
		if err != nil {
			a.writeError(w, r, err)
			return
		}
		target = match["opponentId"]
	}
	if target == userID {
		a.writeError(w, r, fail(400, "INVALID_REQUEST", "You cannot report yourself.", false))
		return
	}
	row, err := queryOne(r.Context(), a.DB, `insert into public.reports(reporter_id, target_id, match_id, category, description)
		values ($1, $2, $3, $4, $5) returning id, state, created_at as "createdAt"`, userID, target, nullable(input.MatchID), input.Category, nullable(strings.TrimSpace(input.Description)))
	if err != nil {
		a.writeError(w, r, err)
		return
	}
	a.writeJSON(w, http.StatusOK, row)
}

func (a *App) createBlockHandler(w http.ResponseWriter, r *http.Request) {
	userID, targetID := userFrom(r).ID, r.PathValue("userId")
	if !uuidPattern.MatchString(targetID) {
		a.writeError(w, r, fail(400, "INVALID_REQUEST", "Request data is invalid.", false))
		return
	}
	if targetID == userID {
		a.writeError(w, r, fail(400, "INVALID_REQUEST", "You cannot block yourself.", false))
		return
	}
	if _, err := a.DB.Exec(r.Context(), "insert into public.blocks(blocker_id, blocked_id) values ($1, $2) on conflict do nothing", userID, targetID); err != nil {
		a.writeError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (a *App) getBlocksHandler(w http.ResponseWriter, r *http.Request) {
	items, err := queryRows(r.Context(), a.DB, `select b.blocked_id as "userId", p.display_name as "displayName", p.avatar_id as "avatarId", b.created_at as "createdAt"
		from public.blocks b join public.profiles p on p.id = b.blocked_id where b.blocker_id = $1 order by b.created_at desc`, userFrom(r).ID)
	if err != nil {
		a.writeError(w, r, err)
		return
	}
	a.writeJSON(w, http.StatusOK, map[string]any{"items": items})
}

func (a *App) deleteBlockHandler(w http.ResponseWriter, r *http.Request) {
	userID, targetID := userFrom(r).ID, r.PathValue("userId")
	if !uuidPattern.MatchString(targetID) {
		a.writeError(w, r, fail(400, "INVALID_REQUEST", "Request data is invalid.", false))
		return
	}
	if _, err := a.DB.Exec(r.Context(), "delete from public.blocks where blocker_id = $1 and blocked_id = $2", userID, targetID); err != nil {
		a.writeError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (a *App) blockOpponentHandler(w http.ResponseWriter, r *http.Request) {
	userID, matchID := userFrom(r).ID, r.PathValue("id")
	if !uuidPattern.MatchString(matchID) {
		a.writeError(w, r, fail(400, "INVALID_REQUEST", "Request data is invalid.", false))
		return
	}
	row, err := queryOne(r.Context(), a.DB, `select other.user_id as "opponentId" from public.match_participants mine
		join public.match_participants other on other.match_id = mine.match_id and other.slot <> mine.slot where mine.match_id = $1 and mine.user_id = $2`, matchID, userID)
	if errors.Is(err, pgx.ErrNoRows) || err == nil && row["opponentId"] == nil {
		a.writeError(w, r, fail(404, "NOT_FOUND", "Match or opponent not found.", false))
		return
	}
	if err != nil {
		a.writeError(w, r, err)
		return
	}
	if _, err := a.DB.Exec(r.Context(), "insert into public.blocks(blocker_id, blocked_id) values ($1, $2) on conflict do nothing", userID, row["opponentId"]); err != nil {
		a.writeError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (a *App) exportAccountHandler(w http.ResponseWriter, r *http.Request) {
	user := userFrom(r)
	queries := map[string]string{
		"profile":      `select id, display_name, avatar_id, created_at, adult_confirmed_at, consent_version from public.profiles where id = $1`,
		"preferences":  `select audio, haptics, spoken_count, theme, locale, analytics_opt_in from public.user_preferences where user_id = $1`,
		"matches":      `select m.id, m.mode, m.exercise, m.rule_version, m.created_at, r.outcome, r.score_player_1, r.score_player_2, r.reason from public.match_participants p join public.matches m on m.id = p.match_id left join public.match_results r on r.match_id = m.id where p.user_id = $1 order by m.created_at desc`,
		"ratings":      `select exercise, season_id, rating, games, eligible from public.exercise_ratings where user_id = $1`,
		"badges":       `select badge_key, awarded_at from public.badges where user_id = $1`,
		"reports":      `select id, category, description, state, created_at from public.reports where reporter_id = $1`,
		"blocks":       `select blocked_id, created_at from public.blocks where blocker_id = $1`,
		"practice":     `select id, exercise, duration_ms, accepted_reps, rule_version, created_at from public.practice_syncs where user_id = $1 order by created_at desc`,
		"xpLedger":     `select source_type, source_id, reward_type, amount, utc_day, created_at from public.xp_ledger where user_id = $1 order by created_at desc`,
		"activityDays": `select utc_date, source_id from public.activity_days where user_id = $1 order by utc_date desc`,
	}
	data := make(map[string]any, len(queries))
	for key, query := range queries {
		rows, err := queryRows(r.Context(), a.DB, query, user.ID)
		if err != nil {
			a.writeError(w, r, err)
			return
		}
		if key == "profile" || key == "preferences" {
			if len(rows) == 0 {
				data[key] = nil
			} else {
				data[key] = rows[0]
			}
		} else {
			data[key] = rows
		}
	}
	a.writeJSON(w, http.StatusOK, map[string]any{"status": "ready", "exportedAt": time.Now().UTC(), "data": map[string]any{"email": nullable(user.Email), "profile": data["profile"], "preferences": data["preferences"], "matches": data["matches"], "ratings": data["ratings"], "badges": data["badges"], "reports": data["reports"], "blocks": data["blocks"], "practice": data["practice"], "xpLedger": data["xpLedger"], "activityDays": data["activityDays"]}})
}

func (a *App) deleteAccountHandler(w http.ResponseWriter, r *http.Request) {
	var input struct {
		Confirmation string `json:"confirmation"`
	}
	if err := a.decodeBody(w, r, &input); err != nil || input.Confirmation != "DELETE" {
		a.writeError(w, r, fail(400, "INVALID_REQUEST", "Request data is invalid.", false))
		return
	}
	user := userFrom(r)
	if a.Config.SupabaseServiceKey == "" || a.Config.SupabaseURL == "" {
		a.writeError(w, r, fail(503, "SERVICE_UNAVAILABLE", "Account deletion is not configured on this service yet.", true))
		return
	}
	if user.IAT == 0 || time.Since(time.Unix(user.IAT, 0)) > 5*time.Minute {
		a.writeError(w, r, fail(401, "AUTH_EXPIRED", "Sign in again before requesting account deletion.", false))
		return
	}
	active, err := queryOne(r.Context(), a.DB, "select match_id as \"matchId\" from public.active_sessions where user_id = $1", user.ID)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		a.writeError(w, r, err)
		return
	}
	if err == nil && active["matchId"] != nil {
		matchID := fmt.Sprint(active["matchId"])
		result, leaveErr := a.leaveMatch(r.Context(), user.ID, matchID)
		if leaveErr != nil {
			a.writeError(w, r, leaveErr)
			return
		}
		a.notifyMatchEnded(r.Context(), matchID, result)
	}
	var jobID string
	err = a.transaction(r.Context(), false, func(tx pgx.Tx) error {
		profile, err := queryOne(r.Context(), tx, "select status from public.profiles where id = $1 for update", user.ID)
		if errors.Is(err, pgx.ErrNoRows) {
			return fail(404, "NOT_FOUND", "Account profile not found.", false)
		}
		if err != nil {
			return err
		}
		if profile["status"] == "deleting" {
			job, err := queryOne(r.Context(), tx, "select id from public.deletion_jobs where user_id = $1 and status in ('queued','processing','failed') order by requested_at desc limit 1", user.ID)
			if err == nil {
				jobID = fmt.Sprint(job["id"])
				return nil
			}
			if !errors.Is(err, pgx.ErrNoRows) {
				return err
			}
		}
		var stillActive bool
		if err := tx.QueryRow(r.Context(), "select exists(select 1 from public.active_sessions where user_id = $1 and match_id is not null)", user.ID).Scan(&stillActive); err != nil {
			return err
		}
		if stillActive {
			return fail(409, "ALREADY_ACTIVE", "A match is still active. Try the deletion request again in a moment.", true)
		}
		queues, err := queryRows(r.Context(), tx, "update public.queue_entries set state = 'CANCELLED' where user_id = $1 and state in ('WAITING','RESERVED') returning id", user.ID)
		if err != nil {
			return err
		}
		if len(queues) > 0 {
			ids := make([]string, 0, len(queues))
			for _, row := range queues {
				ids = append(ids, fmt.Sprint(row["id"]))
			}
			if _, err := tx.Exec(r.Context(), "delete from public.active_sessions where user_id = $1 and queue_id = any($2::uuid[])", user.ID, ids); err != nil {
				return err
			}
		}
		queries := []struct {
			sql  string
			args []any
		}{
			{"update public.invites set state = 'CANCELLED' where host_id = $1 and state = 'OPEN'", []any{user.ID}},
			{"update public.match_participants set user_id = null, display_name_snapshot = 'Deleted player', avatar_id_snapshot = 'move-01', session_nonce_hash = '' where user_id = $1", []any{user.ID}},
			{"delete from public.rep_events where user_id = $1", []any{user.ID}},
		}
		for _, query := range queries {
			if _, err := tx.Exec(r.Context(), query.sql, query.args...); err != nil {
				return err
			}
		}
		if err := tx.QueryRow(r.Context(), "insert into public.deletion_jobs(user_id) values ($1) returning id", user.ID).Scan(&jobID); err != nil {
			return err
		}
		_, err = tx.Exec(r.Context(), "update public.profiles set display_name = 'Deleted player', normalized_handle = null, status = 'deleting', updated_at = now() where id = $1", user.ID)
		return err
	})
	if err != nil {
		a.writeError(w, r, err)
		return
	}
	a.writeJSON(w, http.StatusAccepted, map[string]any{"status": "queued", "requestId": jobID})
}

func oneOf(value string, options ...string) bool {
	for _, option := range options {
		if value == option {
			return true
		}
	}
	return false
}
