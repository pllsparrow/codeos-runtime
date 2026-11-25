package main

import (
	"context"
	"errors"
	"log"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"syscall"
	"time"

	"codeos-codelab-runner"
)

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	mode := os.Getenv("CODEOS_RUNNER_MODE")
	if mode == "worker" {
		runWorker(ctx)
		return
	}
	runHTTP(ctx)
}

func runHTTP(ctx context.Context) {
	token := os.Getenv("CODELAB_JUDGE_TOKEN")
	if token == "" {
		log.Fatal("CODELAB_JUDGE_TOKEN is required")
	}
	capacity := envInt("CODEOS_RUNNER_CAPACITY", 1)
	deadline := envDuration("CODEOS_RUNNER_DEADLINE", 50*time.Second)
	executor := runner.UnixWorkerExecutor{SocketPath: os.Getenv("CODEOS_RUNNER_WORKER_SOCKET")}
	server, err := runner.New(token, executor, capacity, deadline)
	if err != nil {
		log.Fatalf("create runner: %v", err)
	}
	address := os.Getenv("CODEOS_RUNNER_ADDR")
	if address == "" {
		address = ":8003"
	}
	httpServer := &http.Server{Addr: address, Handler: server}
	go func() {
		<-ctx.Done()
		shutdownContext, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = httpServer.Shutdown(shutdownContext)
	}()
	log.Printf("runner listening on %s", address)
	if err := httpServer.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Fatalf("runner server: %v", err)
	}
}

func runWorker(ctx context.Context) {
	if err := runner.EnableChildSubreaper(); err != nil {
		log.Fatalf("enable child subreaper: %v", err)
	}
	executor, err := runner.NewSandboxExecutor(
		os.Getenv("CODEOS_RUNNER_PYTHON"),
		os.Getenv("CODEOS_RUNNER_WORK_ROOT"),
	)
	if err != nil {
		log.Fatalf("create sandbox executor: %v", err)
	}
	if err := runner.ServeWorker(ctx, os.Getenv("CODEOS_RUNNER_WORKER_SOCKET"), executor); err != nil {
		log.Fatalf("worker server: %v", err)
	}
}

func envInt(name string, fallback int) int {
	value := os.Getenv(name)
	if value == "" {
		return fallback
	}
	parsed, err := strconv.Atoi(value)
	if err != nil {
		log.Fatalf("%s must be an integer: %v", name, err)
	}
	return parsed
}

func envDuration(name string, fallback time.Duration) time.Duration {
	value := os.Getenv(name)
	if value == "" {
		return fallback
	}
	parsed, err := time.ParseDuration(value)
	if err != nil {
		log.Fatalf("%s must be a duration: %v", name, err)
	}
	return parsed
}
