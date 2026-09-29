package api

import (
	"context"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

func (a *App) StartWorkers(ctx context.Context) {
	go a.runEvery(ctx, time.Second, "match sweeper", func(ctx context.Context) error { return a.settleDueMatches(ctx) })
	go a.runEvery(ctx, time.Second, "disconnect sweeper", func(ctx context.Context) error { return a.processDisconnectedMatches(ctx) })
	go a.runEvery(ctx, time.Second, "outbox publisher", func(ctx context.Context) error { return a.publishOutbox(ctx) })
	go a.runEvery(ctx, 30*time.Second, "deletion worker", func(ctx context.Context) error { return a.processDeletionJobs(ctx) })
	go a.runEvery(ctx, 6*time.Hour, "retention worker", func(ctx context.Context) error { return a.applyRetention(ctx) })
}

func (a *App) runEvery(ctx context.Context, interval time.Duration, name string, work func(context.Context) error) {
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			timeout := interval
			if timeout < 10*time.Second {
				timeout = 10 * time.Second
			}
			workCtx, cancel := context.WithTimeout(ctx, timeout)
			if err := work(workCtx); err != nil && ctx.Err() == nil {
				a.Log.Error(name+" failed", "error", err)
			}
			cancel()
		}
	}
}

func (a *App) applyRetention(ctx context.Context) error {
	queries := []string{
		"delete from public.rep_events where id in (select id from public.rep_events where received_at < now() - interval '7 days' order by received_at limit 5000)",
		"delete from public.reports where state in ('resolved','dismissed') and created_at < now() - interval '90 days'",
	}
	for _, query := range queries {
		if _, err := a.DB.Exec(ctx, query); err != nil {
			return err
		}
	}
	return nil
}

func (a *App) processDeletionJobs(ctx context.Context) error {
	if a.Config.SupabaseServiceKey == "" || a.Config.SupabaseURL == "" {
		return nil
	}
	var jobs []map[string]any
	err := a.transaction(ctx, false, func(tx pgx.Tx) error {
		var err error
		jobs, err = queryRows(ctx, tx, `select id, user_id as "userId" from public.deletion_jobs
			where (status in ('queued','failed') or (status = 'processing' and updated_at < now() - interval '5 minutes'))
			and attempts < 5 and user_id is not null order by requested_at for update skip locked limit 10`)
		if err != nil {
			return err
		}
		for _, job := range jobs {
			if _, err := tx.Exec(ctx, "update public.deletion_jobs set status = 'processing', attempts = attempts + 1, updated_at = now() where id = $1", job["id"]); err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		return err
	}
	client := &http.Client{Timeout: 5 * time.Second}
	for _, job := range jobs {
		userID := fmt.Sprint(job["userId"])
		request, err := http.NewRequestWithContext(ctx, http.MethodDelete, strings.TrimRight(a.Config.SupabaseURL, "/")+"/auth/v1/admin/users/"+userID, nil)
		var status int
		if err == nil {
			request.Header.Set("apikey", a.Config.SupabaseServiceKey)
			request.Header.Set("Authorization", "Bearer "+a.Config.SupabaseServiceKey)
			response, callErr := client.Do(request)
			if callErr == nil {
				status = response.StatusCode
				response.Body.Close()
			}
		}
		if status >= 200 && status < 300 || status == http.StatusNotFound {
			_, err = a.DB.Exec(ctx, "update public.deletion_jobs set status = 'complete', user_id = null, completion_at = now(), updated_at = now(), error_code = null where id = $1", job["id"])
		} else {
			_, err = a.DB.Exec(ctx, "update public.deletion_jobs set status = 'failed', updated_at = now(), error_code = 'AUTH_DELETE_FAILED' where id = $1", job["id"])
		}
		if err != nil {
			return err
		}
	}
	return nil
}
