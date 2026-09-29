package api

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	redis "github.com/redis/go-redis/v9"
	"github.com/zishang520/socket.io/servers/socket/v3"
)

type App struct {
	Config Config
	DB     *pgxpool.Pool
	Redis  *redis.Client
	Socket *socket.Server
	Log    *slog.Logger
	JWKs   *JWKSet
}

func New(ctx context.Context, cfg Config, logger *slog.Logger) (*App, error) {
	if logger == nil {
		logger = slog.Default()
	}
	if cfg.DatabaseURL == "" || cfg.RedisURL == "" || cfg.SupabaseURL == "" {
		return nil, errors.New("DATABASE_URL, REDIS_URL and SUPABASE_URL are required")
	}
	db, err := connectDatabase(ctx, cfg)
	if err != nil {
		return nil, err
	}
	redisOptions, err := redis.ParseURL(cfg.RedisURL)
	if err != nil {
		db.Close()
		return nil, err
	}
	redisOptions.MaxRetries = 2
	redisClient := redis.NewClient(redisOptions)
	app := &App{Config: cfg, DB: db, Redis: redisClient, Log: logger, JWKs: NewJWKSet(cfg)}
	if err := db.Ping(ctx); err != nil {
		redisClient.Close()
		db.Close()
		return nil, err
	}
	if err := redisClient.Ping(ctx).Err(); err != nil {
		redisClient.Close()
		db.Close()
		return nil, err
	}
	return app, nil
}

func (a *App) Close() {
	if a.Socket != nil {
		a.Socket.Close(nil)
	}
	a.Redis.Close()
	a.DB.Close()
}

func (a *App) socketHandler() http.Handler {
	if a.Socket == nil {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			http.Error(w, "realtime service is unavailable", http.StatusServiceUnavailable)
		})
	}
	return a.Socket.ServeHandler(nil)
}

func (a *App) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /health/live", a.live)
	mux.HandleFunc("GET /health/ready", a.ready)
	mux.HandleFunc("GET /account-deletion", a.accountDeletion)
	mux.HandleFunc("GET /v1/config", a.configSnapshotHandler)

	// Authenticated endpoints are registered as they are migrated to Go.
	a.registerRoutes(mux)
	return requestIDs(a.recoverer(mux))
}

func (a *App) configSnapshotHandler(w http.ResponseWriter, r *http.Request) {
	a.handle(w, r, func() (any, int, error) {
		value, err := a.configSnapshot(r.Context())
		if err != nil {
			return nil, http.StatusOK, err
		}
		value["apiVersion"] = 1
		return value, http.StatusOK, nil
	})
}

type contextKey string

const userContextKey contextKey = "move-match-user"

type User struct {
	ID    string
	Email string
	IAT   int64
}

type HTTPError struct {
	Status    int
	Code      string
	Message   string
	Retryable bool
}

func (e *HTTPError) Error() string { return e.Message }

func fail(status int, code, message string, retryable bool) *HTTPError {
	return &HTTPError{Status: status, Code: code, Message: message, Retryable: retryable}
}

func (a *App) authenticate(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		header := r.Header.Get("Authorization")
		if !strings.HasPrefix(header, "Bearer ") || len(header) < 8 {
			a.writeError(w, r, fail(http.StatusUnauthorized, "AUTH_EXPIRED", "Sign in to continue.", false))
			return
		}
		user, err := a.JWKs.Verify(r.Context(), strings.TrimSpace(header[7:]))
		if err != nil {
			a.writeError(w, r, fail(http.StatusUnauthorized, "AUTH_EXPIRED", "Your sign-in expired. Sign in again to continue.", false))
			return
		}
		ctx := context.WithValue(r.Context(), userContextKey, user)
		next(w, r.WithContext(ctx))
	}
}

func userFrom(r *http.Request) User {
	user, _ := r.Context().Value(userContextKey).(User)
	return user
}

func (a *App) requireProfile(ctx context.Context, userID string) error {
	var status string
	var adultAt *time.Time
	err := a.DB.QueryRow(ctx, "select status, adult_confirmed_at from public.profiles where id = $1", userID).Scan(&status, &adultAt)
	if errors.Is(err, pgx.ErrNoRows) || err == nil && (status != "active" || adultAt == nil) {
		return fail(http.StatusForbidden, "FORBIDDEN", "Finish account setup before using online features.", false)
	}
	return err
}

func (a *App) decodeBody(w http.ResponseWriter, r *http.Request, target any) error {
	r.Body = http.MaxBytesReader(w, r.Body, 8*1024)
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		return fail(http.StatusBadRequest, "INVALID_REQUEST", "Request data is invalid.", false)
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		return fail(http.StatusBadRequest, "INVALID_REQUEST", "Request data is invalid.", false)
	}
	return nil
}

func (a *App) writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	if value != nil {
		_ = json.NewEncoder(w).Encode(value)
	}
}

func (a *App) writeError(w http.ResponseWriter, r *http.Request, err error) {
	appErr, ok := err.(*HTTPError)
	if !ok {
		appErr = fail(http.StatusInternalServerError, "SERVICE_UNAVAILABLE", "The service could not complete this request.", true)
		a.Log.Error("request failed", "requestId", requestID(r), "error", err)
	}
	a.writeJSON(w, appErr.Status, map[string]any{
		"code": appErr.Code, "message": appErr.Message, "retryable": appErr.Retryable, "requestId": requestID(r),
	})
}

func (a *App) handle(w http.ResponseWriter, r *http.Request, fn func() (any, int, error)) {
	value, status, err := fn()
	if err != nil {
		a.writeError(w, r, err)
		return
	}
	if status == 0 {
		status = http.StatusOK
	}
	a.writeJSON(w, status, value)
}

func (a *App) live(w http.ResponseWriter, r *http.Request) {
	a.writeJSON(w, http.StatusOK, map[string]any{"status": "live", "time": time.Now().UTC().Format(time.RFC3339Nano)})
}

func (a *App) ready(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 2*time.Second)
	defer cancel()
	if err := a.DB.Ping(ctx); err != nil || a.Redis.Ping(ctx).Err() != nil {
		a.writeJSON(w, http.StatusServiceUnavailable, map[string]string{"status": "not_ready"})
		return
	}
	a.writeJSON(w, http.StatusOK, map[string]string{"status": "ready"})
}

func requestID(r *http.Request) string {
	if value := r.Header.Get("X-Request-ID"); value != "" {
		return value
	}
	if value, ok := r.Context().Value(requestIDKey).(string); ok {
		return value
	}
	return "unknown"
}

type requestIDContextKey struct{}

var requestIDKey requestIDContextKey

func requestIDs(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var raw [16]byte
		if _, err := rand.Read(raw[:]); err == nil {
			id := hex.EncodeToString(raw[:])
			w.Header().Set("X-Request-ID", id)
			r = r.WithContext(context.WithValue(r.Context(), requestIDKey, id))
		}
		next.ServeHTTP(w, r)
	})
}

func (a *App) recoverer(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer func() {
			if recovered := recover(); recovered != nil {
				a.Log.Error("panic in request handler", "requestId", requestID(r), "panic", recovered)
				a.writeError(w, r, fail(500, "SERVICE_UNAVAILABLE", "The service could not complete this request.", true))
			}
		}()
		next.ServeHTTP(w, r)
	})
}
