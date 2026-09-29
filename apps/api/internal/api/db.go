package api

import (
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
)

func queryRows(ctx context.Context, queryer interface {
	Query(context.Context, string, ...any) (pgx.Rows, error)
}, query string, args ...any) ([]map[string]any, error) {
	rows, err := queryer.Query(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	fields := rows.FieldDescriptions()
	result := make([]map[string]any, 0)
	for rows.Next() {
		values, destinations := make([]any, len(fields)), make([]any, len(fields))
		for i := range values {
			destinations[i] = &values[i]
		}
		if err := rows.Scan(destinations...); err != nil {
			return nil, err
		}
		item := make(map[string]any, len(fields))
		for i, field := range fields {
			value := values[i]
			switch typed := value.(type) {
			case []byte:
				value = string(typed)
			case [16]byte:
				value = fmt.Sprintf("%x-%x-%x-%x-%x", typed[0:4], typed[4:6], typed[6:8], typed[8:10], typed[10:16])
			}
			item[string(field.Name)] = value
		}
		result = append(result, item)
	}
	return result, rows.Err()
}

func queryOne(ctx context.Context, queryer interface {
	Query(context.Context, string, ...any) (pgx.Rows, error)
}, query string, args ...any) (map[string]any, error) {
	rows, err := queryRows(ctx, queryer, query, args...)
	if err != nil {
		return nil, err
	}
	if len(rows) == 0 {
		return nil, pgx.ErrNoRows
	}
	return rows[0], nil
}

func (a *App) transaction(ctx context.Context, serializable bool, work func(pgx.Tx) error) error {
	level := pgx.ReadCommitted
	if serializable {
		level = pgx.Serializable
	}
	tx, err := a.DB.BeginTx(ctx, pgx.TxOptions{IsoLevel: level})
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := work(tx); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (a *App) rateLimit(ctx context.Context, userID, key string, maximum int, seconds int) error {
	window := time.Now().Unix() / int64(seconds)
	redisKey := fmt.Sprintf("limit:%s:%s:%d", key, userID, window)
	count, err := a.Redis.Incr(ctx, redisKey).Result()
	if err != nil {
		return fail(503, "SERVICE_UNAVAILABLE", "The online service is temporarily unavailable.", true)
	}
	if count == 1 {
		if err := a.Redis.Expire(ctx, redisKey, time.Duration(seconds+1)*time.Second).Err(); err != nil {
			return fail(503, "SERVICE_UNAVAILABLE", "The online service is temporarily unavailable.", true)
		}
	}
	if count > int64(maximum) {
		return fail(429, "RATE_LIMITED", "Too many requests. Wait a little and try again.", true)
	}
	return nil
}

func sha256Hex(value string) string {
	digest := sha256.Sum256([]byte(value))
	return hex.EncodeToString(digest[:])
}

func nonce() (string, error) {
	raw := make([]byte, 32)
	if _, err := rand.Read(raw); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(raw), nil
}

const inviteAlphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"

func (a *App) inviteCode(userID, idempotencyKey string) (string, string, error) {
	if len(a.Config.InviteCodeSecret) < 32 {
		return "", "", fail(503, "SERVICE_UNAVAILABLE", "Friend invites are not configured on this service.", true)
	}
	mac := hmac.New(sha256.New, []byte(a.Config.InviteCodeSecret))
	_, _ = mac.Write([]byte("invite:" + userID + ":" + idempotencyKey))
	digest := mac.Sum(nil)
	mac = hmac.New(sha256.New, []byte(a.Config.InviteCodeSecret))
	_, _ = mac.Write([]byte("nonce:" + userID + ":" + idempotencyKey))
	sessionNonce := base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
	code := make([]byte, 8)
	for i := range code {
		code[i] = inviteAlphabet[digest[i]&31]
	}
	return string(code), sessionNonce, nil
}

func jsonMap(value any) ([]byte, error) {
	encoded, err := json.Marshal(value)
	if err != nil {
		return nil, errors.New("could not encode request data")
	}
	return encoded, nil
}
