package api

import (
	"errors"
	"fmt"
	"net/http"

	"github.com/jackc/pgx/v5"
)

func (a *App) isAdmin(userID string) bool { _, ok := a.Config.OpsAdmins[userID]; return ok }

func (a *App) adminOnly(w http.ResponseWriter, r *http.Request) bool {
	if !a.isAdmin(userFrom(r).ID) {
		a.writeError(w, r, fail(404, "NOT_FOUND", "Not found.", false))
		return false
	}
	return true
}

func (a *App) adminReportsHandler(w http.ResponseWriter, r *http.Request) {
	if !a.adminOnly(w, r) {
		return
	}
	items, err := queryRows(r.Context(), a.DB, `select r.id, r.category, r.description, r.state, r.created_at as "createdAt",
		p.display_name as "reporterName", t.display_name as "targetName"
		from public.reports r join public.profiles p on p.id = r.reporter_id left join public.profiles t on t.id = r.target_id
		where r.state in ('open','reviewing') order by r.created_at asc limit 200`)
	if err != nil {
		a.writeError(w, r, err)
		return
	}
	a.writeJSON(w, http.StatusOK, map[string]any{"items": items})
}

func (a *App) updateReportHandler(w http.ResponseWriter, r *http.Request) {
	if !a.adminOnly(w, r) {
		return
	}
	id := r.PathValue("id")
	var input struct {
		State  string `json:"state"`
		Reason string `json:"reason"`
	}
	if !uuidPattern.MatchString(id) || a.decodeBody(w, r, &input) != nil || !oneOf(input.State, "open", "reviewing", "resolved", "dismissed") || len([]rune(input.Reason)) < 3 || len([]rune(input.Reason)) > 300 {
		a.writeError(w, r, fail(400, "INVALID_REQUEST", "Request data is invalid.", false))
		return
	}
	var result map[string]any
	err := a.transaction(r.Context(), false, func(tx pgx.Tx) error {
		var err error
		result, err = queryOne(r.Context(), tx, "update public.reports set state = $2 where id = $1 returning id, state", id, input.State)
		if errors.Is(err, pgx.ErrNoRows) {
			return fail(404, "NOT_FOUND", "Report not found.", false)
		}
		if err != nil {
			return err
		}
		_, err = tx.Exec(r.Context(), "insert into public.moderation_actions(actor_admin_id, reason, action) values ($1, $2, $3)", userFrom(r).ID, input.Reason, "report:"+id+":"+input.State)
		return err
	})
	if err != nil {
		a.writeError(w, r, err)
		return
	}
	a.writeJSON(w, http.StatusOK, result)
}

func (a *App) updateFeatureFlagHandler(w http.ResponseWriter, r *http.Request) {
	if !a.adminOnly(w, r) {
		return
	}
	key := r.PathValue("key")
	if !oneOf(key, "friend_matches_enabled", "quick_match_enabled", "ranked_push_up_enabled", "ranked_pull_up_enabled") {
		a.writeError(w, r, fail(400, "INVALID_REQUEST", "Request data is invalid.", false))
		return
	}
	var input struct {
		Enabled bool   `json:"enabled"`
		Reason  string `json:"reason"`
	}
	if a.decodeBody(w, r, &input) != nil || len([]rune(input.Reason)) < 3 || len([]rune(input.Reason)) > 300 {
		a.writeError(w, r, fail(400, "INVALID_REQUEST", "Request data is invalid.", false))
		return
	}
	var result map[string]any
	err := a.transaction(r.Context(), false, func(tx pgx.Tx) error {
		var err error
		result, err = queryOne(r.Context(), tx, `update public.feature_flags set enabled = $2, updated_by = $3, updated_at = now()
			where key = $1 returning key, enabled, updated_at as "updatedAt"`, key, input.Enabled, userFrom(r).ID)
		if errors.Is(err, pgx.ErrNoRows) {
			return fail(404, "NOT_FOUND", "Feature flag not found.", false)
		}
		if err != nil {
			return err
		}
		_, err = tx.Exec(r.Context(), "insert into public.moderation_actions(actor_admin_id, reason, action) values ($1, $2, $3)", userFrom(r).ID, input.Reason, "feature_flag:"+key+map[bool]string{true: ":enabled", false: ":disabled"}[input.Enabled])
		return err
	})
	if err != nil {
		a.writeError(w, r, err)
		return
	}
	a.writeJSON(w, http.StatusOK, result)
}

func (a *App) updateAdminProfileHandler(w http.ResponseWriter, r *http.Request) {
	if !a.adminOnly(w, r) {
		return
	}
	id := r.PathValue("id")
	var input struct {
		Status string `json:"status"`
		Reason string `json:"reason"`
	}
	if !uuidPattern.MatchString(id) || a.decodeBody(w, r, &input) != nil || !oneOf(input.Status, "active", "suspended") || len([]rune(input.Reason)) < 3 || len([]rune(input.Reason)) > 300 {
		a.writeError(w, r, fail(400, "INVALID_REQUEST", "Request data is invalid.", false))
		return
	}
	err := a.transaction(r.Context(), false, func(tx pgx.Tx) error {
		_, err := queryOne(r.Context(), tx, "update public.profiles set status = $2, updated_at = now() where id = $1 returning id", id, input.Status)
		if errors.Is(err, pgx.ErrNoRows) {
			return fail(404, "NOT_FOUND", "Profile not found.", false)
		}
		if err != nil {
			return err
		}
		_, err = tx.Exec(r.Context(), "insert into public.moderation_actions(actor_admin_id, target_id, reason, action) values ($1, $2, $3, $4)", userFrom(r).ID, id, input.Reason, "profile_status:"+input.Status)
		return err
	})
	if err != nil {
		a.writeError(w, r, err)
		return
	}
	if input.Status == "suspended" {
		queues, err := queryRows(r.Context(), a.DB, "update public.queue_entries set state = 'CANCELLED' where user_id = $1 and state = 'WAITING' returning id", id)
		if err != nil {
			a.writeError(w, r, err)
			return
		}
		if len(queues) > 0 {
			ids := make([]string, 0, len(queues))
			for _, item := range queues {
				ids = append(ids, fmt.Sprint(item["id"]))
			}
			if _, err := a.DB.Exec(r.Context(), "delete from public.active_sessions where user_id = $1 and queue_id = any($2::uuid[])", id, ids); err != nil {
				a.writeError(w, r, err)
				return
			}
		}
		matches, err := queryRows(r.Context(), a.DB, "select match_id as \"matchId\" from public.active_sessions where user_id = $1 and match_id is not null", id)
		if err != nil {
			a.writeError(w, r, err)
			return
		}
		a.disconnectUser(id)
		for _, match := range matches {
			matchID := fmt.Sprint(match["matchId"])
			result, leaveErr := a.leaveMatch(r.Context(), id, matchID)
			if leaveErr == nil {
				a.notifyMatchEnded(r.Context(), matchID, result)
			}
		}
	}
	a.writeJSON(w, http.StatusOK, map[string]string{"id": id, "status": input.Status})
}
