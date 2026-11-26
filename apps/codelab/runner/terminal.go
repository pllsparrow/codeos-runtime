package runner

import (
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/creack/pty"
	"github.com/gin-gonic/gin"
)

const terminalUID = 10003
const terminalBufferLimit = 256 * 1024

// Session state is disposable and exists only inside the networkless worker.
type TerminalRequest struct {
	Operation string `json:"operation"`
	ID        string `json:"id"`
	Data      string `json:"data"`
	Sequence  int64  `json:"sequence"`
	Cursor    int64  `json:"cursor"`
	Columns   uint16 `json:"columns"`
	Rows      uint16 `json:"rows"`
}

type TerminalResult struct {
	Data     string `json:"data"`
	Cursor   int64  `json:"cursor"`
	Closed   bool   `json:"closed"`
	Sequence int64  `json:"sequence"`
}

type terminalManager struct {
	mu      sync.Mutex
	session *terminalSession
}

type terminalSession struct {
	mu        sync.Mutex
	id        string
	file      *os.File
	input     chan []byte
	command   *exec.Cmd
	buffer    []byte
	offset    int64
	sequence  int64
	closed    bool
	done      chan struct{}
	lastPoll  time.Time
	createdAt time.Time
}

func validTerminalRequest(r TerminalRequest) bool {
	if len(r.ID) != 36 || strings.Trim(r.ID, "0123456789abcdef-") != "" ||
		len(r.Data) > 16384 || r.Cursor < 0 || r.Sequence < 0 {
		return false
	}
	switch r.Operation {
	case "start", "poll", "input", "close":
	default:
		return false
	}
	return (r.Columns == 0 && r.Rows == 0) ||
		(r.Columns >= 20 && r.Columns <= 500 && r.Rows >= 5 && r.Rows <= 200)
}

func (e UnixWorkerExecutor) Terminal(ctx context.Context, request TerminalRequest) (TerminalResult, error) {
	response, err := e.call(ctx, workerEnvelope{Kind: "terminal", Terminal: &request})
	if err != nil {
		return TerminalResult{}, err
	}
	if response.Terminal == nil {
		return TerminalResult{}, errors.New("terminal response is missing")
	}
	return *response.Terminal, nil
}

func (s *Server) terminal(c *gin.Context) {
	if !s.authorize(c) {
		return
	}
	var request TerminalRequest
	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, 32768)
	if !decode(c, &request) || !validTerminalRequest(request) {
		if !c.Writer.Written() {
			fail(c, 422, "invalid_terminal_request")
		}
		return
	}
	executor, ok := s.executor.(interface {
		Terminal(context.Context, TerminalRequest) (TerminalResult, error)
	})
	if !ok {
		fail(c, 503, "terminal_unavailable")
		return
	}
	ctx, cancel := context.WithTimeout(c.Request.Context(), 5*time.Second)
	defer cancel()
	result, err := executor.Terminal(ctx, request)
	if err != nil {
		fail(c, 503, err.Error())
		return
	}
	c.JSON(200, result)
}

func (e *SandboxExecutor) Terminal(request TerminalRequest) (TerminalResult, error) {
	if !validTerminalRequest(request) {
		return TerminalResult{}, errors.New("invalid terminal request")
	}
	m := &e.terminals
	m.mu.Lock()
	defer m.mu.Unlock()
	session := m.session
	if request.Operation == "start" && (session == nil || session.id != request.ID) {
		if session != nil {
			session.mu.Lock()
			closed := session.closed
			session.mu.Unlock()
			if !closed {
				return TerminalResult{}, errors.New("Another terminal is open. Close it before starting a new session.")
			}
		}
		var err error
		session, err = e.startTerminal(request)
		if err != nil {
			return TerminalResult{}, err
		}
		m.session = session
	}
	if session == nil || session.id != request.ID {
		return TerminalResult{}, errors.New("Terminal session has ended. Start a new session.")
	}
	session.mu.Lock()
	defer session.mu.Unlock()
	session.lastPoll = time.Now()
	if request.Operation == "close" && !session.closed {
		killProcessGroup(session.command.Process)
		session.mu.Unlock()
		select {
		case <-session.done:
		case <-time.After(4 * time.Second):
		}
		session.mu.Lock()
	}
	if request.Operation == "input" && !session.closed && request.Sequence > session.sequence {
		if request.Sequence != session.sequence+1 {
			return TerminalResult{}, errors.New("terminal input sequence differs")
		}
		if request.Columns != 0 {
			if err := pty.Setsize(session.file, &pty.Winsize{Cols: request.Columns, Rows: request.Rows}); err != nil {
				return TerminalResult{}, err
			}
		}
		if request.Data != "" {
			data, err := base64.StdEncoding.DecodeString(request.Data)
			if err != nil {
				return TerminalResult{}, errors.New("invalid terminal input")
			}
			select {
			case session.input <- data:
			default:
				return TerminalResult{}, errors.New("terminal input queue is full")
			}
		}
		session.sequence = request.Sequence
	}
	cursor := request.Cursor
	if cursor < session.offset {
		cursor = session.offset
	}
	end := session.offset + int64(len(session.buffer))
	if cursor > end {
		return TerminalResult{}, errors.New("terminal cursor exceeds output")
	}
	data := session.buffer[cursor-session.offset:]
	return TerminalResult{
		Data: base64.StdEncoding.EncodeToString(data), Cursor: end,
		Closed: session.closed, Sequence: session.sequence,
	}, nil
}

func (e *SandboxExecutor) startTerminal(request TerminalRequest) (*terminalSession, error) {
	if err := e.Ready(context.Background()); err != nil {
		return nil, err
	}
	workspace, err := os.MkdirTemp(e.workRoot, "terminal-")
	if err != nil {
		return nil, err
	}
	cleanup := func() { _ = os.RemoveAll(workspace) }
	if err := os.Chown(workspace, terminalUID, terminalUID); err != nil {
		cleanup()
		return nil, err
	}
	// Limits survive exec into Bash and apply to commands launched from it.
	wrapper := fmt.Sprintf(`import os, resource
os.umask(0o077)
for key, value in [(resource.RLIMIT_CPU, 60), (resource.RLIMIT_AS, %d), (resource.RLIMIT_NPROC, 16), (resource.RLIMIT_NOFILE, 64), (resource.RLIMIT_FSIZE, 8388608), (resource.RLIMIT_CORE, 0)]:
    resource.setrlimit(key, (value, value))
os.execv("/bin/bash", ["bash", "--noprofile", "--norc", "-i"])
`, maxMemoryBytes)
	command := exec.Command(e.pythonPath, "-I", "-B", "-c", wrapper)
	command.Dir = workspace
	command.Env = []string{
		"PATH=/usr/local/bin:/usr/bin:/bin", "LANG=C.UTF-8", "TERM=xterm-256color",
		"USER=lab", "LOGNAME=lab", "HOME=" + workspace, "TMPDIR=" + workspace, "HISTFILE=/dev/null",
		"PS1=\\[\\e[32m\\]lab\\[\\e[0m\\]:\\w$ ", "PROMPT_COMMAND=",
	}
	command.SysProcAttr = &syscall.SysProcAttr{
		Credential: &syscall.Credential{Uid: terminalUID, Gid: terminalUID, NoSetGroups: true},
	}
	columns, rows := request.Columns, request.Rows
	if columns == 0 {
		columns, rows = 100, 24
	}
	file, err := pty.StartWithSize(command, &pty.Winsize{Cols: columns, Rows: rows})
	if err != nil {
		cleanup()
		return nil, err
	}
	session := &terminalSession{done: make(chan struct{}), input: make(chan []byte, 64), id: request.ID, file: file, command: command, lastPoll: time.Now(), createdAt: time.Now()}
	go func() {
		for data := range session.input {
			if _, err := file.Write(data); err != nil {
				return
			}
		}
	}()
	drained := make(chan struct{})
	go func() {
		defer close(drained)
		chunk := make([]byte, 8192)
		for {
			n, err := file.Read(chunk)
			if n > 0 {
				session.mu.Lock()
				session.buffer = append(session.buffer, chunk[:n]...)
				if extra := len(session.buffer) - terminalBufferLimit; extra > 0 {
					session.buffer = append([]byte(nil), session.buffer[extra:]...)
					session.offset += int64(extra)
				}
				session.mu.Unlock()
			}
			if err != nil {
				return
			}
		}
	}()
	go func() {
		_ = command.Wait()
		terminateUIDDescendants(terminalUID)
		select {
		case <-drained:
		case <-time.After(100 * time.Millisecond):
		}
		_ = file.Close()
		<-drained
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		erase := exec.CommandContext(ctx, e.pythonPath, "-I", "-B", "-c", workspaceCleanupScript, workspace)
		erase.SysProcAttr = &syscall.SysProcAttr{Credential: &syscall.Credential{Uid: terminalUID, Gid: terminalUID, NoSetGroups: true}}
		_ = erase.Run()
		_ = os.Chown(workspace, 0, 0)
		_ = os.Chmod(workspace, 0o700)
		cleanup()
		session.mu.Lock()
		session.closed = true
		close(session.input)
		close(session.done)
		session.mu.Unlock()
	}()
	go func() {
		ticker := time.NewTicker(time.Second)
		defer ticker.Stop()
		for range ticker.C {
			session.mu.Lock()
			closed := session.closed
			expired := time.Since(session.lastPoll) > 30*time.Second || time.Since(session.createdAt) > 30*time.Minute
			session.mu.Unlock()
			if closed {
				return
			}
			if expired {
				killProcessGroup(command.Process)
			}
		}
	}()
	return session, nil
}
