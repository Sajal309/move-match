package api

import (
	"errors"
	"html/template"
	"net/http"
	"net/mail"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode"

	"github.com/jackc/pgx/v5"
	"golang.org/x/text/unicode/norm"
)

func (a *App) protected(requireProfile bool, next http.HandlerFunc) http.HandlerFunc {
	return a.authenticate(func(w http.ResponseWriter, r *http.Request) {
		if requireProfile {
			if err := a.requireProfile(r.Context(), userFrom(r).ID); err != nil {
				a.writeError(w, r, err)
				return
			}
		}
		next(w, r)
	})
}

func (a *App) registerRoutes(mux *http.ServeMux) {
	mux.HandleFunc("POST /v1/me", a.protected(false, a.createProfile))
	mux.HandleFunc("GET /v1/me", a.protected(false, a.getProfile))
	mux.HandleFunc("GET /v1/me/progress", a.protected(true, a.getProgress))
	mux.HandleFunc("PATCH /v1/me", a.protected(true, a.patchProfile))
	mux.HandleFunc("GET /v1/me/history", a.protected(true, a.getHistory))
	mux.HandleFunc("POST /v1/invites", a.protected(true, a.createInviteHandler))
	mux.HandleFunc("POST /v1/invites/redeem", a.protected(true, a.redeemInviteHandler))
	mux.HandleFunc("POST /v1/queue", a.protected(true, a.enqueueHandler))
	mux.HandleFunc("DELETE /v1/queue/current", a.protected(true, a.cancelQueueHandler))
	mux.HandleFunc("POST /v1/queue/heartbeat", a.protected(true, a.heartbeatQueueHandler))
	mux.HandleFunc("GET /v1/matches/{id}", a.protected(true, a.getMatchHandler))
	mux.HandleFunc("POST /v1/matches/{id}/ready", a.protected(true, a.readyMatchHandler))
	mux.HandleFunc("POST /v1/matches/{id}/heartbeat", a.protected(true, a.heartbeatMatchHandler))
	mux.HandleFunc("POST /v1/matches/{id}/leave", a.protected(true, a.leaveMatchHandler))
	mux.HandleFunc("GET /v1/leaderboards", a.protected(true, a.leaderboardHandler))
	mux.HandleFunc("POST /v1/practice-sessions", a.protected(true, a.practiceSessionHandler))
	mux.HandleFunc("POST /v1/reports", a.protected(true, a.createReportHandler))
	mux.HandleFunc("POST /v1/blocks/{userId}", a.protected(true, a.createBlockHandler))
	mux.HandleFunc("GET /v1/blocks", a.protected(true, a.getBlocksHandler))
	mux.HandleFunc("DELETE /v1/blocks/{userId}", a.protected(true, a.deleteBlockHandler))
	mux.HandleFunc("POST /v1/matches/{id}/block-opponent", a.protected(true, a.blockOpponentHandler))
	mux.HandleFunc("POST /v1/me/export", a.protected(true, a.exportAccountHandler))
	mux.HandleFunc("DELETE /v1/me", a.protected(false, a.deleteAccountHandler))
	mux.HandleFunc("GET /v1/admin/reports", a.protected(false, a.adminReportsHandler))
	mux.HandleFunc("PATCH /v1/admin/reports/{id}", a.protected(false, a.updateReportHandler))
	mux.HandleFunc("PATCH /v1/admin/feature-flags/{key}", a.protected(false, a.updateFeatureFlagHandler))
	mux.HandleFunc("PATCH /v1/admin/profiles/{id}", a.protected(false, a.updateAdminProfileHandler))
	mux.Handle("/socket.io/", a.socketHandler())
}

func (a *App) accountDeletion(w http.ResponseWriter, r *http.Request) {
	email := a.Config.PublicSupportEmail
	if _, err := mail.ParseAddress(email); err != nil {
		email = ""
	}
	const page = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>MOVE / MATCH account deletion</title><style>body{font:17px/1.6 system-ui,sans-serif;max-width:720px;margin:10vh auto;padding:0 22px;color:#102839}h1{line-height:1.15}a{color:#087e82}</style><main><h1>MOVE / MATCH account deletion</h1><p>You can request deletion of your MOVE / MATCH account and associated personal data from this page. If you can sign in, use <strong>You → Settings → Delete account</strong> to start the authenticated deletion flow.</p><p>If you cannot sign in, contact {{if .Email}}<a href="mailto:{{.Email}}?subject=MOVE%20%2F%20MATCH%20account%20deletion">{{.Email}}</a>{{else}}<strong>The publisher has not configured a support email for deletion requests yet.</strong>{{end}} from the email address on your account and include “Account deletion request”. The support team must verify account ownership before processing it. Do not include a password or one-time code.</p><p>When deletion is processed, the account is signed out and its profile, contact link, personal movement events and ranking identity are removed. Match scores needed to preserve another player’s result may be retained with the deleted player anonymized. Backups expire under the service provider’s documented backup cycle.</p><p>The publisher will confirm the processing timeline after verifying the request. For help, contact {{if .Email}}{{.Email}}{{else}}the publisher{{end}}.</p></main></html>`
	tmpl := template.Must(template.New("deletion").Parse(page))
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	if err := tmpl.Execute(w, map[string]string{"Email": email}); err != nil {
		a.Log.Error("render account deletion page", "error", err)
	}
}

func (a *App) createProfile(w http.ResponseWriter, r *http.Request) {
	var input struct {
		AdultConfirmed bool   `json:"adultConfirmed"`
		ConsentVersion string `json:"consentVersion"`
	}
	if err := a.decodeBody(w, r, &input); err != nil {
		a.writeError(w, r, err)
		return
	}
	user := userFrom(r)
	if !input.AdultConfirmed || len(input.ConsentVersion) < 3 || len(input.ConsentVersion) > 80 {
		a.writeError(w, r, fail(400, "INVALID_REQUEST", "Request data is invalid.", false))
		return
	}
	if user.Email == "" {
		a.writeError(w, r, fail(403, "FORBIDDEN", "Verify an email address before account setup.", false))
		return
	}
	profile, err := queryOne(r.Context(), a.DB, `insert into public.profiles(id, adult_confirmed_at, consent_version)
		values ($1, now(), $2) on conflict (id) do update set adult_confirmed_at = coalesce(public.profiles.adult_confirmed_at, now()),
		consent_version = excluded.consent_version, updated_at = now() where public.profiles.status = 'active'
		returning id, display_name, avatar_id, status, adult_confirmed_at`, user.ID, input.ConsentVersion)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			err = fail(403, "FORBIDDEN", "This account cannot be activated.", false)
		}
		a.writeError(w, r, err)
		return
	}
	if _, err := a.DB.Exec(r.Context(), "insert into public.user_preferences(user_id) values ($1) on conflict do nothing", user.ID); err != nil {
		a.writeError(w, r, err)
		return
	}
	if _, err := a.DB.Exec(r.Context(), "insert into public.user_progress(user_id) values ($1) on conflict do nothing", user.ID); err != nil {
		a.writeError(w, r, err)
		return
	}
	a.writeJSON(w, http.StatusCreated, profile)
}

func (a *App) getProfile(w http.ResponseWriter, r *http.Request) {
	user := userFrom(r)
	profile, err := queryOne(r.Context(), a.DB, `select p.id, p.display_name as "displayName", p.avatar_id as "avatarId", p.status,
		p.created_at as "createdAt", coalesce(pr.total_xp, 0) as "totalXp", (1 + floor(coalesce(pr.total_xp, 0) / 100.0))::int as level,
		prefs.audio, prefs.haptics, prefs.spoken_count as "spokenCount", prefs.theme, prefs.locale, prefs.analytics_opt_in as "analyticsOptIn"
		from public.profiles p left join public.user_progress pr on pr.user_id = p.id left join public.user_preferences prefs on prefs.user_id = p.id
		where p.id = $1 and p.status = 'active'`, user.ID)
	if errors.Is(err, pgx.ErrNoRows) {
		err = fail(404, "NOT_FOUND", "Account profile not found.", false)
	}
	if err != nil {
		a.writeError(w, r, err)
		return
	}
	a.writeJSON(w, http.StatusOK, profile)
}

func (a *App) getProgress(w http.ResponseWriter, r *http.Request) {
	user := userFrom(r)
	profile, err := queryOne(r.Context(), a.DB, `select p.display_name as "displayName", p.avatar_id as "avatarId", pr.total_xp as "totalXp",
		(1 + floor(pr.total_xp / 100.0))::int as level from public.profiles p join public.user_progress pr on pr.user_id = p.id where p.id = $1`, user.ID)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		a.writeError(w, r, err)
		return
	}
	ratings, err := queryRows(r.Context(), a.DB, `select r.exercise, r.rating, r.games as played, r.eligible, s.name as season
		from public.exercise_ratings r join public.seasons s on s.id = r.season_id where r.user_id = $1
		and now() >= s.start_at and now() < s.end_at order by r.exercise`, user.ID)
	if err != nil {
		a.writeError(w, r, err)
		return
	}
	badges, err := queryRows(r.Context(), a.DB, "select badge_key as \"badgeKey\", awarded_at as \"awardedAt\" from public.badges where user_id = $1 order by awarded_at desc", user.ID)
	if err != nil {
		a.writeError(w, r, err)
		return
	}
	var days int
	if err := a.DB.QueryRow(r.Context(), "select count(*)::int from public.activity_days where user_id = $1 and utc_date >= date_trunc('week', (now() at time zone 'utc'))::date", user.ID).Scan(&days); err != nil {
		a.writeError(w, r, err)
		return
	}
	if days > 3 {
		days = 3
	}
	a.writeJSON(w, http.StatusOK, map[string]any{"profile": profile, "ratings": ratings, "badges": badges, "weeklyActiveDays": days})
}

type profilePatch struct {
	DisplayName    *string `json:"displayName"`
	AvatarID       *string `json:"avatarId"`
	Audio          *bool   `json:"audio"`
	Haptics        *bool   `json:"haptics"`
	SpokenCount    *bool   `json:"spokenCount"`
	Theme          *string `json:"theme"`
	Locale         *string `json:"locale"`
	AnalyticsOptIn *bool   `json:"analyticsOptIn"`
}

func (a *App) patchProfile(w http.ResponseWriter, r *http.Request) {
	var input profilePatch
	if err := a.decodeBody(w, r, &input); err != nil {
		a.writeError(w, r, err)
		return
	}
	user := userFrom(r)
	if input.DisplayName == nil && input.AvatarID == nil && input.Audio == nil && input.Haptics == nil && input.SpokenCount == nil && input.Theme == nil && input.Locale == nil && input.AnalyticsOptIn == nil {
		a.writeError(w, r, fail(400, "INVALID_REQUEST", "Request data is invalid.", false))
		return
	}
	var normalizedName, normalizedHandle string
	if input.DisplayName != nil {
		normalizedName = strings.Join(strings.Fields(norm.NFKC.String(*input.DisplayName)), " ")
		runes := []rune(normalizedName)
		if len(runes) < 3 || len(runes) > 20 || containsControl(runes) || reservedName.MatchString(normalizedName) {
			a.writeError(w, r, fail(400, "INVALID_REQUEST", "Choose a 3–20 character display name without control text or official account terms.", false))
			return
		}
		normalizedHandle = strings.ToLower(normalizedName)
		var duplicate bool
		if err := a.DB.QueryRow(r.Context(), "select exists(select 1 from public.profiles where normalized_handle = $1 and id <> $2)", normalizedHandle, user.ID).Scan(&duplicate); err != nil {
			a.writeError(w, r, err)
			return
		}
		if duplicate {
			a.writeError(w, r, fail(409, "INVALID_REQUEST", "That display name is already in use. Choose another.", false))
			return
		}
	}
	allowedAvatars := map[string]bool{"move-01": true, "move-02": true, "move-03": true, "move-04": true, "move-05": true, "move-06": true}
	if input.AvatarID != nil && !allowedAvatars[*input.AvatarID] || input.Theme != nil && *input.Theme != "system" && *input.Theme != "light" && *input.Theme != "dark" || input.Locale != nil && (len([]rune(*input.Locale)) < 2 || len([]rune(*input.Locale)) > 12) {
		a.writeError(w, r, fail(400, "INVALID_REQUEST", "Request data is invalid.", false))
		return
	}
	err := a.transaction(r.Context(), false, func(tx pgx.Tx) error {
		if input.DisplayName != nil {
			if _, err := tx.Exec(r.Context(), "update public.profiles set display_name = $2, normalized_handle = $3, updated_at = now() where id = $1", user.ID, normalizedName, normalizedHandle); err != nil {
				return err
			}
		}
		if input.AvatarID != nil {
			if _, err := tx.Exec(r.Context(), "update public.profiles set avatar_id = $2, updated_at = now() where id = $1", user.ID, *input.AvatarID); err != nil {
				return err
			}
		}
		prefs := []struct {
			column string
			value  any
		}{
			{"audio", input.Audio}, {"haptics", input.Haptics}, {"spoken_count", input.SpokenCount}, {"theme", input.Theme}, {"locale", input.Locale}, {"analytics_opt_in", input.AnalyticsOptIn},
		}
		for _, item := range prefs {
			if value := deref(item.value); value != nil {
				if _, err := tx.Exec(r.Context(), "update public.user_preferences set "+item.column+" = $2, updated_at = now() where user_id = $1", user.ID, value); err != nil {
					return err
				}
			}
		}
		return nil
	})
	if err != nil {
		a.writeError(w, r, err)
		return
	}
	a.writeJSON(w, http.StatusOK, map[string]string{"status": "updated"})
}

func deref(value any) any {
	switch pointer := value.(type) {
	case *bool:
		if pointer != nil {
			return *pointer
		}
	case *string:
		if pointer != nil {
			return *pointer
		}
	}
	return nil
}

func containsControl(value []rune) bool {
	for _, char := range value {
		if unicode.IsControl(char) {
			return true
		}
	}
	return false
}

var reservedName = regexp.MustCompile(`(?i)\b(admin|moderator|movematch|move match|support)\b`)

func (a *App) getHistory(w http.ResponseWriter, r *http.Request) {
	user := userFrom(r)
	limit := 20
	if raw := r.URL.Query().Get("limit"); raw != "" {
		value, err := strconv.Atoi(raw)
		if err != nil || value < 1 || value > 50 {
			a.writeError(w, r, fail(400, "INVALID_REQUEST", "Request data is invalid.", false))
			return
		}
		limit = value
	}
	cursor := r.URL.Query().Get("cursor")
	var before any
	if cursor != "" {
		parsed, err := time.Parse(time.RFC3339Nano, cursor)
		if err != nil {
			a.writeError(w, r, fail(400, "INVALID_REQUEST", "Request data is invalid.", false))
			return
		}
		before = parsed
	}
	items, err := queryRows(r.Context(), a.DB, `select m.id as "matchId", m.mode, m.exercise, m.rule_version as "ruleVersion", m.created_at as "createdAt",
		r.outcome, r.score_player_1 as "scorePlayer1", r.score_player_2 as "scorePlayer2", r.reason,
		mine.slot as "mySlot", other.display_name_snapshot as "opponentName", other.avatar_id_snapshot as "opponentAvatar"
		from public.match_participants mine join public.matches m on m.id = mine.match_id left join public.match_results r on r.match_id = m.id
		left join public.match_participants other on other.match_id = m.id and other.slot <> mine.slot
		where mine.user_id = $1 and ($2::timestamptz is null or m.created_at < $2) order by m.created_at desc limit $3`, user.ID, before, limit)
	if err != nil {
		a.writeError(w, r, err)
		return
	}
	var next any
	if len(items) == limit {
		next = items[len(items)-1]["createdAt"]
	}
	a.writeJSON(w, http.StatusOK, map[string]any{"items": items, "nextCursor": next})
}

func (a *App) createInviteHandler(w http.ResponseWriter, r *http.Request) {
	var input struct {
		Exercise       Exercise `json:"exercise"`
		IdempotencyKey string   `json:"idempotencyKey"`
	}
	if err := a.decodeBody(w, r, &input); err != nil || !validExercise(input.Exercise) || !uuidPattern.MatchString(input.IdempotencyKey) {
		a.writeError(w, r, fail(400, "INVALID_REQUEST", "Request data is invalid.", false))
		return
	}
	if err := a.rateLimit(r.Context(), userFrom(r).ID, "invite-create", 10, 60); err != nil {
		a.writeError(w, r, err)
		return
	}
	value, err := a.createInvite(r.Context(), userFrom(r).ID, input.Exercise, input.IdempotencyKey)
	if err != nil {
		a.writeError(w, r, err)
		return
	}
	a.writeJSON(w, http.StatusOK, value)
}

func (a *App) redeemInviteHandler(w http.ResponseWriter, r *http.Request) {
	var input struct {
		Code string `json:"code"`
	}
	if err := a.decodeBody(w, r, &input); err != nil || len(input.Code) < 6 || len(input.Code) > 16 {
		a.writeError(w, r, fail(400, "INVALID_REQUEST", "Request data is invalid.", false))
		return
	}
	if err := a.rateLimit(r.Context(), userFrom(r).ID, "invite-redeem", 10, 60); err != nil {
		a.writeError(w, r, err)
		return
	}
	value, err := a.redeemInvite(r.Context(), userFrom(r).ID, input.Code)
	if err != nil {
		a.writeError(w, r, err)
		return
	}
	a.writeJSON(w, http.StatusOK, value)
}

func (a *App) enqueueHandler(w http.ResponseWriter, r *http.Request) {
	var input struct {
		Exercise Exercise `json:"exercise"`
	}
	if err := a.decodeBody(w, r, &input); err != nil || !validExercise(input.Exercise) {
		a.writeError(w, r, fail(400, "INVALID_REQUEST", "Request data is invalid.", false))
		return
	}
	if err := a.rateLimit(r.Context(), userFrom(r).ID, "queue", 10, 60); err != nil {
		a.writeError(w, r, err)
		return
	}
	value, err := a.enqueue(r.Context(), userFrom(r).ID, input.Exercise)
	if err != nil {
		a.writeError(w, r, err)
		return
	}
	a.writeJSON(w, http.StatusOK, value)
}

func (a *App) cancelQueueHandler(w http.ResponseWriter, r *http.Request) {
	value, err := a.cancelQueue(r.Context(), userFrom(r).ID)
	a.runResult(w, r, value, err)
}

func (a *App) heartbeatQueueHandler(w http.ResponseWriter, r *http.Request) {
	value, err := a.heartbeatQueue(r.Context(), userFrom(r).ID)
	a.runResult(w, r, value, err)
}

func (a *App) getMatchHandler(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if !uuidPattern.MatchString(id) {
		a.writeError(w, r, fail(400, "INVALID_REQUEST", "Request data is invalid.", false))
		return
	}
	value, err := a.matchSnapshot(r.Context(), userFrom(r).ID, id, false)
	if err != nil {
		a.writeError(w, r, err)
		return
	}
	a.writeJSON(w, http.StatusOK, value)
}

func (a *App) readyMatchHandler(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	var input struct {
		SessionNonce string `json:"sessionNonce"`
		ModelVersion string `json:"modelVersion"`
	}
	if !uuidPattern.MatchString(id) || a.decodeBody(w, r, &input) != nil || len(input.SessionNonce) < 24 || len(input.SessionNonce) > 160 || len(input.ModelVersion) > 120 {
		a.writeError(w, r, fail(400, "INVALID_REQUEST", "Request data is invalid.", false))
		return
	}
	if input.ModelVersion != modelVersion {
		a.writeError(w, r, fail(409, "RULE_UNSUPPORTED", "Update the app before joining this match.", false))
		return
	}
	value, err := a.readyMatch(r.Context(), userFrom(r).ID, id, input.SessionNonce)
	if err != nil {
		a.writeError(w, r, err)
		return
	}
	a.writeJSON(w, http.StatusOK, value)
}

func (a *App) heartbeatMatchHandler(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if !uuidPattern.MatchString(id) {
		a.writeError(w, r, fail(400, "INVALID_REQUEST", "Request data is invalid.", false))
		return
	}
	value, err := a.heartbeatMatch(r.Context(), userFrom(r).ID, id)
	if err != nil {
		a.writeError(w, r, err)
		return
	}
	a.writeJSON(w, http.StatusOK, value)
}

func (a *App) leaveMatchHandler(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if !uuidPattern.MatchString(id) {
		a.writeError(w, r, fail(400, "INVALID_REQUEST", "Request data is invalid.", false))
		return
	}
	value, err := a.leaveMatch(r.Context(), userFrom(r).ID, id)
	if err != nil {
		a.writeError(w, r, err)
		return
	}
	a.notifyMatchEnded(r.Context(), id, value)
	a.writeJSON(w, http.StatusOK, value)
}

func (a *App) leaderboardHandler(w http.ResponseWriter, r *http.Request) {
	exercise := Exercise(r.URL.Query().Get("exercise"))
	season := r.URL.Query().Get("season")
	if !validExercise(exercise) || season != "" && !uuidPattern.MatchString(season) {
		a.writeError(w, r, fail(400, "INVALID_REQUEST", "Request data is invalid.", false))
		return
	}
	value, err := a.leaderboard(r.Context(), exercise, season, userFrom(r).ID)
	if err != nil {
		a.writeError(w, r, err)
		return
	}
	a.writeJSON(w, http.StatusOK, value)
}

func (a *App) runResult(w http.ResponseWriter, r *http.Request, value map[string]any, err error) {
	if err != nil {
		a.writeError(w, r, err)
		return
	}
	a.writeJSON(w, http.StatusOK, value)
}
