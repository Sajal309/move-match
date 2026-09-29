package api

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

func Migrate(ctx context.Context, cfg Config) error {
	db, err := connectDatabase(ctx, cfg)
	if err != nil {
		return err
	}
	defer db.Close()
	return migrateDatabase(ctx, db)
}

func migrateDatabase(ctx context.Context, db *pgxpool.Pool) error {
	root := os.Getenv("MIGRATIONS_DIR")
	if root == "" {
		for _, candidate := range []string{"supabase/migrations", filepath.Join("..", "..", "supabase", "migrations")} {
			if info, err := os.Stat(candidate); err == nil && info.IsDir() {
				root = candidate
				break
			}
		}
		if root == "" {
			root = "supabase/migrations"
		}
	}
	entries, err := os.ReadDir(root)
	if err != nil {
		return fmt.Errorf("read migration directory: %w", err)
	}
	files := make([]string, 0)
	for _, entry := range entries {
		if !entry.IsDir() && strings.HasSuffix(entry.Name(), ".sql") {
			files = append(files, entry.Name())
		}
	}
	sort.Strings(files)
	if _, err := db.Exec(ctx, `create schema if not exists app_meta;
		create table if not exists app_meta.schema_migrations (
			version text primary key, applied_at timestamptz not null default now()
		)`); err != nil {
		return err
	}
	for _, filename := range files {
		var exists bool
		err := db.QueryRow(ctx, "select exists(select 1 from app_meta.schema_migrations where version = $1)", filename).Scan(&exists)
		if err != nil {
			return err
		}
		if exists {
			continue
		}
		sql, err := os.ReadFile(filepath.Join(root, filename))
		if err != nil {
			return err
		}
		tx, err := db.BeginTx(ctx, pgx.TxOptions{})
		if err != nil {
			return err
		}
		if _, err = tx.Exec(ctx, string(sql)); err == nil {
			_, err = tx.Exec(ctx, "insert into app_meta.schema_migrations(version) values ($1)", filename)
		}
		if err == nil {
			err = tx.Commit(ctx)
		} else {
			_ = tx.Rollback(ctx)
		}
		if err != nil {
			return fmt.Errorf("apply %s: %w", filename, err)
		}
		fmt.Printf("Applied %s\n", filename)
	}
	return nil
}
