package api

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

type Config struct {
	Port               int
	Host               string
	DatabaseURL        string
	DatabaseSSL        string
	DatabaseCAFile     string
	RedisURL           string
	SupabaseURL        string
	SupabaseJWKSURL    string
	SupabaseIssuer     string
	SupabaseAudience   string
	SupabaseServiceKey string
	InviteCodeSecret   string
	PublicSupportEmail string
	OpsAdmins          map[string]struct{}
}

func LoadConfig() Config {
	port, err := strconv.Atoi(env("PORT", "8080"))
	if err != nil || port < 1 || port > 65535 {
		port = 8080
	}
	supabaseURL := strings.TrimRight(env("SUPABASE_URL", os.Getenv("EXPO_PUBLIC_SUPABASE_URL")), "/")
	admins := make(map[string]struct{})
	for _, id := range strings.Split(os.Getenv("OPS_ADMIN_USER_IDS"), ",") {
		if id = strings.TrimSpace(id); id != "" {
			admins[id] = struct{}{}
		}
	}
	return Config{
		Port: port, Host: env("HOST", "0.0.0.0"),
		DatabaseURL: os.Getenv("DATABASE_URL"), DatabaseSSL: os.Getenv("DATABASE_SSL"),
		DatabaseCAFile: os.Getenv("DATABASE_SSL_CA_FILE"), RedisURL: os.Getenv("REDIS_URL"),
		SupabaseURL: supabaseURL, SupabaseJWKSURL: os.Getenv("SUPABASE_JWKS_URL"),
		SupabaseIssuer: os.Getenv("SUPABASE_ISSUER"), SupabaseAudience: env("SUPABASE_AUDIENCE", "authenticated"),
		SupabaseServiceKey: os.Getenv("SUPABASE_SERVICE_ROLE_KEY"), InviteCodeSecret: os.Getenv("INVITE_CODE_SECRET"),
		PublicSupportEmail: strings.TrimSpace(os.Getenv("PUBLIC_SUPPORT_EMAIL")), OpsAdmins: admins,
	}
}

func env(key, fallback string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return fallback
}

func connectDatabase(ctx context.Context, cfg Config) (*pgxpool.Pool, error) {
	parsed, err := pgxpool.ParseConfig(cfg.DatabaseURL)
	if err != nil {
		return nil, fmt.Errorf("parse DATABASE_URL: %w", err)
	}
	parsed.MaxConns = 16
	parsed.MaxConnIdleTime = 30 * time.Second
	parsed.ConnConfig.ConnectTimeout = 5 * time.Second
	parsed.ConnConfig.RuntimeParams["application_name"] = "move-match-api"
	parsed.ConnConfig.RuntimeParams["statement_timeout"] = "8000"
	if strings.EqualFold(cfg.DatabaseSSL, "require") {
		tlsConfig := &tls.Config{MinVersion: tls.VersionTLS12}
		if caFile := strings.TrimSpace(cfg.DatabaseCAFile); caFile != "" {
			path := caFile
			if !filepath.IsAbs(path) {
				path = filepath.Clean(path)
				if _, statErr := os.Stat(path); statErr != nil {
					apiRelative := filepath.Join("apps", "api", path)
					if _, apiStatErr := os.Stat(apiRelative); apiStatErr == nil {
						path = apiRelative
					}
				}
			}
			pem, readErr := os.ReadFile(path)
			if readErr != nil {
				return nil, fmt.Errorf("read DATABASE_SSL_CA_FILE: %w", readErr)
			}
			roots := x509.NewCertPool()
			if !roots.AppendCertsFromPEM(pem) {
				return nil, fmt.Errorf("DATABASE_SSL_CA_FILE contains no valid certificates")
			}
			tlsConfig.RootCAs = roots
		}
		parsed.ConnConfig.TLSConfig = tlsConfig
	}
	return pgxpool.NewWithConfig(ctx, parsed)
}
