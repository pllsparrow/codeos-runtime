package runner

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestOutputValidatorsMatchPythonJudgeSemantics(t *testing.T) {
	if !outputMatches(nil, "1 2\n", "3\n", " 3  ") {
		t.Fatal("plain output should ignore whitespace")
	}
	if !outputMatches(stringPtr("top_k_frequent"), "6 1 1 1 2 2 3 2", "1 2\n", "") {
		t.Fatal("top-k validator rejected a valid answer")
	}
	if outputMatches(stringPtr("top_k_frequent"), "6 1 1 1 2 2 3 2", "1 3\n", "") {
		t.Fatal("top-k validator accepted a low-frequency value")
	}
	if !outputMatches(stringPtr("heap_reorganization"), "aabb", "abab", "") {
		t.Fatal("reorganization validator rejected a valid answer")
	}
	if outputMatches(stringPtr("heap_reorganization"), "aab", "IMPOSSIBLE", "") {
		t.Fatal("reorganization validator accepted an impossible marker")
	}
}

func stringPtr(value string) *string { return &value }

func TestSandboxWrapperCarriesResourceLimits(t *testing.T) {
	wrapper := pythonWrapper("cHJpbnQoMSk=")
	for _, fragment := range []string{
		"resource.RLIMIT_CPU",
		"resource.RLIMIT_AS",
		"resource.RLIMIT_NOFILE",
		"resource.RLIMIT_FSIZE",
		"resource.RLIMIT_NPROC",
	} {
		if !strings.Contains(wrapper, fragment) {
			t.Fatalf("wrapper is missing %s", fragment)
		}
	}
}

type fakeExecutor func(context.Context, RunRequest) (RunResult, error)

func (f fakeExecutor) Run(ctx context.Context, request RunRequest) (RunResult, error) {
	return f(ctx, request)
}

type fakeEngine struct {
	run    func(context.Context, RunRequest) (RunResult, error)
	submit func(context.Context, SubmissionRequest) (SubmissionResult, error)
}

func (f fakeEngine) Run(ctx context.Context, request RunRequest) (RunResult, error) {
	return f.run(ctx, request)
}

func (f fakeEngine) Submit(ctx context.Context, request SubmissionRequest) (SubmissionResult, error) {
	return f.submit(ctx, request)
}

func request() *http.Request {
	r := httptest.NewRequest("POST", "/internal/judge/runs", strings.NewReader(`{"source":"print(1)","stdin":"","language_profile":"python-3.12"}`))
	r.Header.Set("Authorization", "Bearer fixture")
	r.Header.Set("Idempotency-Key", "fixture-request")
	return r
}

func TestRunAndFailClosed(t *testing.T) {
	exec := fakeExecutor(func(ctx context.Context, r RunRequest) (RunResult, error) {
		return RunResult{OK: true, Stdout: "1\n"}, nil
	})
	server, err := New("fixture", exec, 1, time.Second)
	if err != nil {
		t.Fatal(err)
	}
	w := httptest.NewRecorder()
	server.ServeHTTP(w, request())
	if w.Code != 200 || !strings.Contains(w.Body.String(), "fixture-request") {
		t.Fatal(w.Code, w.Body)
	}
	server.executor = nil
	w = httptest.NewRecorder()
	server.ServeHTTP(w, request())
	if w.Code != 503 {
		t.Fatal(w.Code)
	}
}

func TestHealthMatchesExistingJudgeAndReadinessRequiresFullEngine(t *testing.T) {
	server, err := New("fixture", fakeExecutor(func(context.Context, RunRequest) (RunResult, error) {
		return RunResult{}, nil
	}), 1, time.Second)
	if err != nil {
		t.Fatal(err)
	}
	health := httptest.NewRecorder()
	server.ServeHTTP(health, httptest.NewRequest(http.MethodGet, "/internal/judge/health", nil))
	if health.Code != http.StatusOK || strings.TrimSpace(health.Body.String()) != `{"status":"ok"}` {
		t.Fatal(health.Code, health.Body.String())
	}
	ready := httptest.NewRecorder()
	server.ServeHTTP(ready, httptest.NewRequest(http.MethodGet, "/internal/judge/ready", nil))
	if ready.Code != http.StatusServiceUnavailable {
		t.Fatal(ready.Code, ready.Body.String())
	}
}

func TestSubmissionReturnsServerComputedVerdict(t *testing.T) {
	engine := fakeEngine{
		run: func(context.Context, RunRequest) (RunResult, error) { return RunResult{}, nil },
		submit: func(_ context.Context, request SubmissionRequest) (SubmissionResult, error) {
			return SubmissionResult{OK: true, Passed: len(request.Cases), Total: len(request.Cases)}, nil
		},
	}
	server, err := New("fixture", engine, 2, time.Second)
	if err != nil {
		t.Fatal(err)
	}
	body := `{"problem_index":1,"problem_slug":"sum","source":"print(3)","language_profile":"python-3.12","cases":[{"stdin":"1 2\n","stdout":"3\n"}],"validator":null}`
	req := httptest.NewRequest(http.MethodPost, "/internal/judge/submissions", strings.NewReader(body))
	req.Header.Set("Authorization", "Bearer fixture")
	req.Header.Set("Idempotency-Key", "submit-1")
	w := httptest.NewRecorder()
	server.ServeHTTP(w, req)
	if w.Code != http.StatusOK || !strings.Contains(w.Body.String(), `"verdict":"accepted"`) ||
		!strings.Contains(w.Body.String(), `"request_id":"submit-1"`) {
		t.Fatal(w.Code, w.Body.String())
	}
	ready := httptest.NewRecorder()
	server.ServeHTTP(ready, httptest.NewRequest(http.MethodGet, "/internal/judge/ready", nil))
	if ready.Code != http.StatusOK {
		t.Fatal(ready.Code, ready.Body.String())
	}
}

func TestSubmissionRejectsUnknownValidatorAndInconsistentResult(t *testing.T) {
	engine := fakeEngine{
		run: func(context.Context, RunRequest) (RunResult, error) { return RunResult{}, nil },
		submit: func(_ context.Context, request SubmissionRequest) (SubmissionResult, error) {
			return SubmissionResult{OK: true, Passed: 0, Total: len(request.Cases)}, nil
		},
	}
	server, _ := New("fixture", engine, 1, time.Second)
	body := `{"problem_index":1,"problem_slug":"sum","source":"print(3)","language_profile":"python-3.12","cases":[{"stdin":"","stdout":"3\n"}],"validator":"unknown"}`
	req := httptest.NewRequest(http.MethodPost, "/internal/judge/submissions", strings.NewReader(body))
	req.Header.Set("Authorization", "Bearer fixture")
	req.Header.Set("Idempotency-Key", "submit-invalid")
	w := httptest.NewRecorder()
	server.ServeHTTP(w, req)
	if w.Code != http.StatusUnprocessableEntity {
		t.Fatal(w.Code, w.Body.String())
	}

	body = strings.Replace(body, `"unknown"`, "null", 1)
	req = httptest.NewRequest(http.MethodPost, "/internal/judge/submissions", strings.NewReader(body))
	req.Header.Set("Authorization", "Bearer fixture")
	req.Header.Set("Idempotency-Key", "submit-invalid-result")
	w = httptest.NewRecorder()
	server.ServeHTTP(w, req)
	if w.Code != http.StatusBadGateway {
		t.Fatal(w.Code, w.Body.String())
	}
}

func TestAuthenticationAndValidationBeforeExecution(t *testing.T) {
	exec := fakeExecutor(func(ctx context.Context, r RunRequest) (RunResult, error) {
		t.Fatal("unexpected execution")
		return RunResult{}, nil
	})
	server, _ := New("fixture", exec, 1, time.Second)
	for _, body := range []string{`{}`, `{"source":"x","stdin":"","language_profile":"go"}`, `{"shell":"rm"}`, `{} {}`} {
		r := request()
		r.Body = http.NoBody
		if body != "{}" {
			r = httptest.NewRequest("POST", "/internal/judge/runs", strings.NewReader(body))
			r.Header.Set("Authorization", "Bearer fixture")
			r.Header.Set("Idempotency-Key", "fixture")
		}
		w := httptest.NewRecorder()
		server.ServeHTTP(w, r)
		if w.Code != 422 {
			t.Fatal(w.Code)
		}
	}
	r := request()
	r.Header.Set("Authorization", "Bearer wrong")
	w := httptest.NewRecorder()
	server.ServeHTTP(w, r)
	if w.Code != 401 {
		t.Fatal(w.Code)
	}
}

func TestCapacityDeadlineAndSlotRecovery(t *testing.T) {
	entered := make(chan struct{}, 2)
	exec := fakeExecutor(func(ctx context.Context, r RunRequest) (RunResult, error) {
		entered <- struct{}{}
		<-ctx.Done()
		return RunResult{}, ctx.Err()
	})
	server, _ := New("fixture", exec, 1, 100*time.Millisecond)
	finished := make(chan int)
	go func() { w := httptest.NewRecorder(); server.ServeHTTP(w, request()); finished <- w.Code }()
	<-entered
	w := httptest.NewRecorder()
	server.ServeHTTP(w, request())
	if w.Code != 503 {
		t.Fatal(w.Code)
	}
	if code := <-finished; code != 504 {
		t.Fatal(code)
	}
	w = httptest.NewRecorder()
	server.ServeHTTP(w, request())
	if w.Code != 504 {
		t.Fatal("slot not recovered", w.Code)
	}
}

func TestCancellationAndOutputOverflow(t *testing.T) {
	server, _ := New("fixture", fakeExecutor(func(ctx context.Context, r RunRequest) (RunResult, error) {
		return RunResult{Stdout: strings.Repeat("x", maxOutputBytes+1)}, nil
	}), 1, time.Second)
	w := httptest.NewRecorder()
	server.ServeHTTP(w, request())
	if w.Code != 502 {
		t.Fatal(w.Code)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	w = httptest.NewRecorder()
	server.ServeHTTP(w, request().WithContext(ctx))
	if w.Code != 408 {
		t.Fatal(w.Code)
	}
}
