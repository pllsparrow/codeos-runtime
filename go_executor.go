package runner

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"
)

const goProfile = "go-1.26"

type LanguageProfile struct {
	Language  string `json:"language"`
	Profile   string `json:"profile"`
	Available bool   `json:"available"`
}

func (e *SandboxExecutor) Profiles() []LanguageProfile {
	return []LanguageProfile{{"python", pythonProfile, true}, {"go", goProfile, e.goPath != ""}}
}

func (e *SandboxExecutor) goWorkspace() (string, error) {
	path, err := os.MkdirTemp(e.workRoot, "go-")
	if err != nil {
		return "", err
	}
	err = os.Chmod(path, 0700)
	if err != nil {
		os.RemoveAll(path)
		return "", err
	}
	return path, nil
}
func goEnvironment(path string) []string {
	return []string{"PATH=/usr/local/go/bin:/usr/local/bin:/usr/bin:/bin", "LANG=C.UTF-8", "GOENV=off", "GOWORK=off", "GO111MODULE=off", "GOPROXY=off", "GOSUMDB=off", "CGO_ENABLED=0", "GOMAXPROCS=1", "GOMEMLIMIT=128MiB", "HOME=" + path, "TMPDIR=" + path, "GOCACHE=" + filepath.Join(path, "cache")}
}

// Go needs a large virtual address reservation; the worker cgroup bounds real memory instead.
// Fixed exec arguments keep learner source out of shells and deny dependency downloads.
func goLauncher(cpu, fileBytes int) string {
	return fmt.Sprintf("import resource,os,sys\nresource.setrlimit(resource.RLIMIT_CPU,(%d,%d))\nresource.setrlimit(resource.RLIMIT_FSIZE,(%d,%d))\nresource.setrlimit(resource.RLIMIT_CORE,(0,0))\nresource.setrlimit(resource.RLIMIT_NOFILE,(64,64))\nresource.setrlimit(resource.RLIMIT_NPROC,(64,64))\nos.execv(sys.argv[1],sys.argv[1:])", cpu, cpu+1, fileBytes, fileBytes)
}
func (e *SandboxExecutor) compileGo(ctx context.Context, source string) ([]byte, RunResult, error) {
	if e.goPath == "" {
		return nil, RunResult{}, errors.New("Go compiler unavailable")
	}
	workspace, err := e.goWorkspace()
	if err != nil {
		return nil, RunResult{}, err
	}
	defer e.cleanupGo(workspace)
	file := filepath.Join(workspace, "main.go")
	if err = os.WriteFile(file, []byte(source), 0444); err != nil {
		return nil, RunResult{}, err
	}
	binary := filepath.Join(workspace, "program")
	result, err := e.runCommand(ctx, workspace, e.pythonPath, []string{"-I", "-B", "-c", goLauncher(25, 32*1024*1024), e.goPath, "build", "-p=1", "-trimpath", "-o", binary, file}, "", goEnvironment(workspace), 35*time.Second)
	if err != nil {
		return nil, result, err
	}
	if !result.OK {
		if !result.TimedOut {
			result.Error = map[string]any{"type": "CompileError", "message": strings.ReplaceAll(result.Stderr, workspace+"/", "")}
		}
		return nil, result, nil
	}
	if err = os.Chown(workspace, 0, 0); err != nil {
		return nil, result, err
	}
	data, err := os.ReadFile(binary)
	return data, result, err
}
func (e *SandboxExecutor) executeGo(ctx context.Context, binary []byte, stdin string) (RunResult, error) {
	workspace, err := e.goWorkspace()
	if err != nil {
		return RunResult{}, err
	}
	defer e.cleanupGo(workspace)
	file := filepath.Join(workspace, "program")
	if err = os.WriteFile(file, binary, 0555); err != nil {
		return RunResult{}, err
	}
	return e.runCommand(ctx, workspace, e.pythonPath, []string{"-I", "-B", "-c", goLauncher(5, 65536), file}, stdin, goEnvironment(workspace), executionTimeout)
}
func (e *SandboxExecutor) runGo(ctx context.Context, request RunRequest) (RunResult, error) {
	binary, compiled, err := e.compileGo(ctx, request.Source)
	if err != nil || !compiled.OK {
		return compiled, err
	}
	return e.executeGo(ctx, binary, request.Stdin)
}
func (e *SandboxExecutor) submitGo(ctx context.Context, request SubmissionRequest) (SubmissionResult, error) {
	binary, compiled, err := e.compileGo(ctx, request.Source)
	if err != nil {
		return SubmissionResult{}, err
	}
	if !compiled.OK {
		return SubmissionResult{OK: false, Total: len(request.Cases), Error: compiled.Error}, nil
	}
	passed := 0
	for index, item := range request.Cases {
		result, err := e.executeGo(ctx, binary, item.Stdin)
		if err != nil {
			return SubmissionResult{}, err
		}
		if result.OK && outputMatches(request.Validator, item.Stdin, result.Stdout, item.Stdout) {
			passed++
			continue
		}
		return SubmissionResult{OK: false, Passed: passed, Total: len(request.Cases), Error: result.Error, FirstFailure: map[string]any{"case": index + 1, "stdin": item.Stdin, "expected": item.Stdout, "actual": result.Stdout, "error": result.Error}}, nil
	}
	return SubmissionResult{OK: true, Passed: passed, Total: len(request.Cases)}, nil
}

// The supervisor lacks DAC override; cleanup runs as the sandbox owner, never learner code.
func (e *SandboxExecutor) cleanupGo(workspace string) {
	script := `import os,sys
p=sys.argv[1]
def erase(path):
    if os.path.islink(path) or not os.path.isdir(path):
        os.unlink(path)
        return
    os.chmod(path,0o700)
    for entry in os.scandir(path): erase(entry.path)
    os.rmdir(path)
os.chmod(p,0o700)
for item in os.scandir(p): erase(item.path)
`
	_, _ = e.runCommand(context.Background(), workspace, e.pythonPath, []string{"-I", "-B", "-c", script, workspace}, "", goEnvironment(workspace), 3*time.Second)
	_ = os.Chown(workspace, 0, 0)
	_ = os.Remove(workspace)
}
