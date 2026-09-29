package main

import (
	"context"
	"errors"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"syscall"
	"time"

	"github.com/joho/godotenv"
	"github.com/sajal309/move-match/apps/api/internal/api"
)

func main() {
	_ = godotenv.Load(".env")
	level := new(slog.LevelVar)
	if os.Getenv("LOG_LEVEL") == "debug" {
		level.Set(slog.LevelDebug)
	}
	logger := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: level}))
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	app, err := api.New(ctx, api.LoadConfig(), logger)
	if err != nil {
		logger.Error("API startup failed", "error", err)
		os.Exit(1)
	}
	defer app.Close()
	if err := app.StartRealtime(ctx); err != nil {
		logger.Error("Socket.IO startup failed", "error", err)
		os.Exit(1)
	}
	app.StartWorkers(ctx)

	server := &http.Server{
		Addr:              net.JoinHostPort(app.Config.Host, strconv.Itoa(app.Config.Port)),
		Handler:           app.Handler(),
		ReadHeaderTimeout: 5 * time.Second,
		IdleTimeout:       60 * time.Second,
	}
	go func() {
		<-ctx.Done()
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_ = server.Shutdown(shutdownCtx)
	}()
	logger.Info("Go API listening", "address", server.Addr)
	if err := server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		logger.Error("HTTP server stopped", "error", err)
		os.Exit(1)
	}
}
