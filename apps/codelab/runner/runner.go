// Package runner implements the private Go admission boundary for Codelab execution.
package runner

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/gin-gonic/gin"
)

const (
	maxTextBytes    = 256_000
	maxOutputBytes  = 65_536
	maxRequestBytes = 66 * 1024 * 1024
	maxCases        = 128
)

var allowedValidators = map[string]struct{}{
	"top_k_frequent":          {},
	"k_closest":               {},
	"heap_k_pairs":            {},
	"heap_reorganization":     {},
	"bucket_frequency_string": {},
}

type RunRequest struct {
	Source          string `json:"source"`
	Stdin           string `json:"stdin"`
	LanguageProfile string `json:"language_profile"`
}

type JudgeCase struct {
	Stdin  string `json:"stdin"`
	Stdout string `json:"stdout"`
}

type SubmissionRequest struct {
	ProblemIndex    int         `json:"problem_index"`
	ProblemSlug     string      `json:"problem_slug"`
	Source          string      `json:"source"`
	LanguageProfile string      `json:"language_profile"`
	Cases           []JudgeCase `json:"cases"`
	Validator       *string     `json:"validator"`
}

type RunResult struct {
	OK         bool   `json:"ok"`
	Stdout     string `json:"stdout"`
	Stderr     string `json:"stderr"`
	ReturnCode *int   `json:"returncode"`
	TimedOut   bool   `json:"timed_out"`
	Error      any    `json:"error"`
}

type SubmissionResult struct {
	Error        any  `json:"error,omitempty"`
	OK           bool `json:"ok"`
	Passed       int  `json:"passed"`
	Total        int  `json:"total"`
	FirstFailure any  `json:"first_failure"`
}

// Executor must stop all descendants and release resources before returning on cancellation.
// Implementations require independent sandbox acceptance.
type Executor interface {
	Run(context.Context, RunRequest) (RunResult, error)
}

// SubmissionExecutor evaluates server-supplied cases without owning business persistence.
type SubmissionExecutor interface {
	Submit(context.Context, SubmissionRequest) (SubmissionResult, error)
}

type Server struct {
	token    string
	executor Executor
	slots    chan struct{}
	deadline time.Duration
	router   *gin.Engine
}

func New(token string, executor Executor, capacity int, deadline time.Duration) (*Server, error) {
	if capacity < 1 || capacity > 16 || deadline <= 0 || deadline > 60*time.Second {
		return nil, errors.New("invalid runner limits")
	}
	gin.SetMode(gin.ReleaseMode)
	server := &Server{token: token, executor: executor, slots: make(chan struct{}, capacity), deadline: deadline}
	server.router = server.routes()
	return server, nil
}

func (s *Server) routes() *gin.Engine {
	router := gin.New()
	router.HandleMethodNotAllowed = true
	router.Use(gin.Recovery())
	router.GET("/internal/judge/health", func(c *gin.Context) { c.JSON(http.StatusOK, gin.H{"status": "ok"}) })
	router.GET("/internal/judge/ready", s.ready)
	router.GET("/internal/judge/languages", s.languages)
	router.POST("/internal/judge/runs", s.run)
	router.POST("/internal/judge/terminal", s.terminal)
	router.POST("/internal/judge/submissions", s.submit)
	router.NoRoute(func(c *gin.Context) { fail(c, http.StatusNotFound, "not_found") })
	router.NoMethod(func(c *gin.Context) {
		allow := http.MethodPost
		if c.Request.URL.Path == "/internal/judge/health" || c.Request.URL.Path == "/internal/judge/ready" {
			allow = http.MethodGet
		}
		c.Header("Allow", allow)
		fail(c, http.StatusMethodNotAllowed, "method_not_allowed")
	})
	return router
}

func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	s.router.ServeHTTP(w, r)
}

func fail(c *gin.Context, status int, code string) {
	c.JSON(status, gin.H{"detail": code})
}

func validProfile(profile string) bool { return profile == pythonProfile || profile == goProfile }
func (s *Server) languages(c *gin.Context) {
	if !s.authorize(c) {
		return
	}
	reader, ok := s.executor.(interface {
		Profiles(context.Context) ([]LanguageProfile, error)
	})
	if !ok {
		fail(c, http.StatusServiceUnavailable, "capabilities_unavailable")
		return
	}
	ctx, cancel := context.WithTimeout(c.Request.Context(), time.Second)
	defer cancel()
	profiles, err := reader.Profiles(ctx)
	if err != nil {
		fail(c, http.StatusServiceUnavailable, "capabilities_unavailable")
		return
	}
	c.JSON(http.StatusOK, profiles)
}

func (s *Server) ready(c *gin.Context) {
	_, submissionsReady := s.executor.(SubmissionExecutor)
	if s.token == "" || s.executor == nil || !submissionsReady {
		fail(c, http.StatusServiceUnavailable, "execution_unavailable")
		return
	}
	if checker, ok := s.executor.(interface{ Ready(context.Context) error }); ok {
		checkContext, cancel := context.WithTimeout(c.Request.Context(), time.Second)
		defer cancel()
		if err := checker.Ready(checkContext); err != nil {
			fail(c, http.StatusServiceUnavailable, "execution_unavailable")
			return
		}
	}
	c.JSON(http.StatusOK, gin.H{"status": "ready"})
}

func (s *Server) authorize(c *gin.Context) bool {
	if s.token == "" || s.executor == nil {
		fail(c, http.StatusServiceUnavailable, "execution_unavailable")
		return false
	}
	scheme, token, found := strings.Cut(c.GetHeader("Authorization"), " ")
	if !found || !strings.EqualFold(scheme, "Bearer") ||
		subtle.ConstantTimeCompare([]byte(token), []byte(s.token)) != 1 {
		fail(c, http.StatusUnauthorized, "authorization_required")
		return false
	}
	return true
}

func requestID(c *gin.Context) (string, bool) {
	id := c.GetHeader("Idempotency-Key")
	if strings.TrimSpace(id) == "" || len(id) > 200 {
		fail(c, http.StatusBadRequest, "request_id_required")
		return "", false
	}
	return id, true
}

func decode(c *gin.Context, target any) bool {
	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, maxRequestBytes)
	decoder := json.NewDecoder(c.Request.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			fail(c, http.StatusRequestEntityTooLarge, "request_too_large")
		} else {
			fail(c, http.StatusUnprocessableEntity, "invalid_request")
		}
		return false
	}
	if err := decoder.Decode(new(any)); err != io.EOF {
		fail(c, http.StatusUnprocessableEntity, "invalid_request")
		return false
	}
	return true
}

func validText(value string) bool {
	return len(value) <= maxTextBytes && utf8.ValidString(value)
}

func validRun(request RunRequest) bool {
	return validProfile(request.LanguageProfile) && validText(request.Source) && validText(request.Stdin)
}

func validSubmission(request SubmissionRequest) bool {
	if request.ProblemIndex <= 0 || strings.TrimSpace(request.ProblemSlug) == "" ||
		len(request.ProblemSlug) > 200 || !validProfile(request.LanguageProfile) ||
		!validText(request.Source) || len(request.Cases) < 1 || len(request.Cases) > maxCases {
		return false
	}
	if request.Validator != nil {
		if _, allowed := allowedValidators[*request.Validator]; !allowed {
			return false
		}
	}
	for _, item := range request.Cases {
		if !validText(item.Stdin) || !validText(item.Stdout) {
			return false
		}
	}
	return true
}

func (s *Server) acquire(c *gin.Context) (context.Context, context.CancelFunc, bool) {
	if c.Request.Context().Err() != nil {
		fail(c, http.StatusRequestTimeout, "cancelled")
		return nil, nil, false
	}
	select {
	case s.slots <- struct{}{}:
	case <-c.Request.Context().Done():
		fail(c, http.StatusRequestTimeout, "cancelled")
		return nil, nil, false
	default:
		fail(c, http.StatusServiceUnavailable, "capacity_exceeded")
		return nil, nil, false
	}
	ctx, cancel := context.WithTimeout(c.Request.Context(), s.deadline)
	return ctx, func() {
		cancel()
		<-s.slots
	}, true
}

func executionFailure(c *gin.Context, ctx context.Context, err error) bool {
	if ctx.Err() != nil {
		fail(c, http.StatusGatewayTimeout, "execution_cancelled_or_timed_out")
		return true
	}
	if err != nil {
		fail(c, http.StatusServiceUnavailable, "executor_failure")
		return true
	}
	return false
}

func (s *Server) run(c *gin.Context) {
	if !s.authorize(c) {
		return
	}
	id, ok := requestID(c)
	if !ok {
		return
	}
	var request RunRequest
	if !decode(c, &request) || !validRun(request) {
		if !c.IsAborted() && c.Writer.Status() == http.StatusOK {
			fail(c, http.StatusUnprocessableEntity, "invalid_request")
		}
		return
	}
	ctx, release, ok := s.acquire(c)
	if !ok {
		return
	}
	defer release()
	result, err := s.executor.Run(ctx, request)
	if executionFailure(c, ctx, err) {
		return
	}
	if len(result.Stdout)+len(result.Stderr) > maxOutputBytes ||
		!utf8.ValidString(result.Stdout) || !utf8.ValidString(result.Stderr) {
		fail(c, http.StatusBadGateway, "invalid_executor_output")
		return
	}
	c.JSON(http.StatusOK, gin.H{"request_id": id, "result": result})
}

func (s *Server) submit(c *gin.Context) {
	if !s.authorize(c) {
		return
	}
	evaluator, ok := s.executor.(SubmissionExecutor)
	if !ok {
		fail(c, http.StatusServiceUnavailable, "execution_unavailable")
		return
	}
	id, ok := requestID(c)
	if !ok {
		return
	}
	var request SubmissionRequest
	if !decode(c, &request) || !validSubmission(request) {
		if !c.IsAborted() && c.Writer.Status() == http.StatusOK {
			fail(c, http.StatusUnprocessableEntity, "invalid_request")
		}
		return
	}
	ctx, release, ok := s.acquire(c)
	if !ok {
		return
	}
	defer release()
	result, err := evaluator.Submit(ctx, request)
	if executionFailure(c, ctx, err) {
		return
	}
	if result.Total != len(request.Cases) || result.Passed < 0 || result.Passed > result.Total ||
		result.OK != (result.Passed == result.Total) || (result.OK && result.FirstFailure != nil) {
		fail(c, http.StatusBadGateway, "invalid_executor_output")
		return
	}
	verdict := "failed"
	if result.OK {
		verdict = "accepted"
	}
	c.JSON(http.StatusOK, gin.H{
		"request_id":    id,
		"verdict":       verdict,
		"passed":        result.Passed,
		"total":         result.Total,
		"first_failure": result.FirstFailure,
		"result":        result,
	})
}
