package runner

import (
	"bufio"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)

const (
	defaultWorkerSocket = "/run/codeos-runner/worker.sock"
	defaultWorkRoot     = "/tmp/codeos-runner"
	pythonProfile       = "python-3.12"
	maxCPUSeconds       = 5
	maxMemoryBytes      = 256 * 1024 * 1024
	maxProcesses        = 16
	maxOpenFiles        = 32
	executionTimeout    = 5 * time.Second
	controlUID          = 10001
	controlGID          = 10000
	sandboxUID          = 10002
	sandboxGID          = 10002
)

// SandboxExecutor runs Python and Go submissions inside a networkless Linux worker.
// The process itself adds resource limits and kills the complete process group on exit.
type SandboxExecutor struct {
	terminals     terminalManager
	executionOnce sync.Once
	executionSlot chan struct{}
	pythonPath    string
	goPath        string
	workRoot      string
}

// Ready reports whether the executor can run in this Linux worker.
func (e *SandboxExecutor) Ready(context.Context) error {
	if runtime.GOOS != "linux" {
		return errors.New("sandbox executor requires a Linux worker container")
	}
	if _, err := os.Stat(e.pythonPath); err != nil {
		return err
	}
	return nil
}

func NewSandboxExecutor(pythonPath, workRoot string) (*SandboxExecutor, error) {
	if runtime.GOOS != "linux" {
		return nil, errors.New("sandbox executor requires a Linux worker container")
	}
	if strings.TrimSpace(pythonPath) == "" {
		pythonPath = "/usr/local/bin/python3.12"
	}
	if _, err := os.Stat(pythonPath); err != nil {
		return nil, fmt.Errorf("python runtime is unavailable: %w", err)
	}
	if strings.TrimSpace(workRoot) == "" {
		workRoot = defaultWorkRoot
	}
	if err := os.MkdirAll(workRoot, 0o711); err != nil {
		return nil, fmt.Errorf("create worker root: %w", err)
	}
	if err := os.Chmod(workRoot, 0o711); err != nil {
		return nil, fmt.Errorf("secure worker root: %w", err)
	}
	executor := &SandboxExecutor{pythonPath: pythonPath, workRoot: workRoot}
	if _, err := os.Stat("/usr/local/go/bin/go"); err == nil {
		executor.goPath = "/usr/local/go/bin/go"
	}
	return executor, nil
}

func (e *SandboxExecutor) Run(ctx context.Context, request RunRequest) (RunResult, error) {
	if err := e.acquireExecution(ctx); err != nil {
		return RunResult{}, err
	}
	defer e.releaseExecution()
	if request.LanguageProfile == goProfile {
		return e.runGo(ctx, request)
	}
	if request.LanguageProfile != pythonProfile {
		return RunResult{}, errors.New("unsupported language profile")
	}
	return e.runProgram(ctx, request.Source, request.Stdin)
}

func (e *SandboxExecutor) Submit(ctx context.Context, request SubmissionRequest) (SubmissionResult, error) {
	if err := e.acquireExecution(ctx); err != nil {
		return SubmissionResult{}, err
	}
	defer e.releaseExecution()
	if request.LanguageProfile == goProfile {
		return e.submitGo(ctx, request)
	}
	if request.LanguageProfile != pythonProfile {
		return SubmissionResult{}, errors.New("unsupported language profile")
	}
	passed := 0
	for index, testCase := range request.Cases {
		result, err := e.runProgram(ctx, request.Source, testCase.Stdin)
		if err != nil {
			return SubmissionResult{}, err
		}
		accepted := result.OK && outputMatches(request.Validator, testCase.Stdin, result.Stdout, testCase.Stdout)
		if accepted {
			passed++
			continue
		}
		return SubmissionResult{
			OK:     false,
			Passed: passed,
			Total:  len(request.Cases),
			FirstFailure: map[string]any{
				"case":     index + 1,
				"stdin":    testCase.Stdin,
				"expected": testCase.Stdout,
				"actual":   result.Stdout,
				"error":    result.Error,
			},
		}, nil
	}
	return SubmissionResult{OK: true, Passed: passed, Total: len(request.Cases)}, nil
}

// Keep execution serial until descendant cleanup completes, but let waiters cancel.
func (e *SandboxExecutor) acquireExecution(ctx context.Context) error {
	e.executionOnce.Do(func() { e.executionSlot = make(chan struct{}, 1) })
	if err := ctx.Err(); err != nil {
		return err
	}
	select {
	case e.executionSlot <- struct{}{}:
		// Cancellation and a free slot may become ready together.
		if err := ctx.Err(); err != nil {
			e.releaseExecution()
			return err
		}
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (e *SandboxExecutor) releaseExecution() { <-e.executionSlot }

func (e *SandboxExecutor) runProgram(ctx context.Context, source, stdin string) (RunResult, error) {
	workspace, err := os.MkdirTemp(e.workRoot, "codeos-run-")
	if err != nil {
		return RunResult{}, fmt.Errorf("create execution workspace: %w", err)
	}
	defer e.cleanupGo(workspace)
	if err := os.Chmod(workspace, 0o700); err != nil {
		return RunResult{}, fmt.Errorf("secure execution workspace: %w", err)
	}
	if err := os.Chown(workspace, sandboxUID, sandboxGID); err != nil {
		return RunResult{}, fmt.Errorf("own execution workspace: %w", err)
	}
	encoded := base64.StdEncoding.EncodeToString([]byte(source))
	wrapper := pythonWrapper(encoded)
	env := []string{
		"PATH=/usr/local/bin:/usr/bin:/bin",
		"LANG=C.UTF-8",
		"PYTHONIOENCODING=utf-8",
		"PYTHONUNBUFFERED=1",
		"PYTHONDONTWRITEBYTECODE=1",
		"TMPDIR=" + workspace,
	}
	return e.runCommand(ctx, workspace, e.pythonPath, []string{"-I", "-B", "-c", wrapper}, stdin, env, executionTimeout)
}

// runCommand bounds both compilation and execution, then synchronously cleans descendants.
func (e *SandboxExecutor) runCommand(ctx context.Context, workspace, program string, args []string, stdin string, env []string, timeout time.Duration) (RunResult, error) {
	executionContext, cancelExecution := context.WithTimeout(ctx, timeout)
	defer cancelExecution()
	if err := os.Chown(workspace, sandboxUID, sandboxGID); err != nil {
		return RunResult{}, err
	}
	command := exec.Command(program, args...)
	command.Dir = workspace
	command.Stdin = strings.NewReader(stdin)
	command.Env = env
	command.SysProcAttr = &syscall.SysProcAttr{
		Setpgid:    true,
		Credential: &syscall.Credential{Uid: sandboxUID, Gid: sandboxGID, NoSetGroups: true},
	}
	stdout, stdoutWriter, err := os.Pipe()
	if err != nil {
		return RunResult{}, fmt.Errorf("create stdout pipe: %w", err)
	}
	defer stdout.Close()
	defer stdoutWriter.Close()
	stderr, stderrWriter, err := os.Pipe()
	if err != nil {
		return RunResult{}, fmt.Errorf("create stderr pipe: %w", err)
	}
	defer stderr.Close()
	defer stderrWriter.Close()
	command.Stdout = stdoutWriter
	command.Stderr = stderrWriter
	if err := command.Start(); err != nil {
		return RunResult{}, fmt.Errorf("start isolated process: %w", err)
	}
	// Wait must not close readers while collectors are draining a fast process.
	stdoutWriter.Close()
	stderrWriter.Close()

	stdoutDone := make(chan boundedOutput, 1)
	stderrDone := make(chan boundedOutput, 1)
	outputLimit := make(chan struct{}, 1)
	go collectOutput(stdout, stdoutDone, outputLimit)
	go collectOutput(stderr, stderrDone, outputLimit)
	waitDone := make(chan error, 1)
	go func() { waitDone <- command.Wait() }()

	var waitErr error
	outputLimited := false
	executionStopped := false
	select {
	case waitErr = <-waitDone:
	case <-executionContext.Done():
		executionStopped = true
		killProcessGroup(command.Process)
		waitErr = <-waitDone
	case <-outputLimit:
		outputLimited = true
		killProcessGroup(command.Process)
		waitErr = <-waitDone
	}
	killProcessGroup(command.Process)
	// The worker is a Linux child subreaper, so reap descendants orphaned by the
	// submitted process group before returning the result.
	reapProcessGroup(command.Process, 250*time.Millisecond)
	terminateSandboxDescendants()
	out := <-stdoutDone
	errOut := <-stderrDone
	if executionStopped {
		timedOut := ctx.Err() == nil && errors.Is(executionContext.Err(), context.DeadlineExceeded)
		errorType := "ExecutionCancelled"
		message := executionContext.Err().Error()
		if timedOut {
			errorType = "TimeoutError"
			message = fmt.Sprintf("execution exceeded %s", timeout)
		}
		return RunResult{OK: false, Stdout: out.text, Stderr: errOut.text, TimedOut: timedOut, Error: map[string]any{
			"type":    errorType,
			"message": message,
		}}, nil
	}
	if outputLimited || out.limited || errOut.limited {
		return RunResult{OK: false, Stdout: out.text, Stderr: errOut.text, Error: map[string]any{
			"type":    "OutputLimitError",
			"message": "execution output exceeded 65536 bytes",
		}}, nil
	}
	result := RunResult{
		OK:       waitErr == nil,
		Stdout:   out.text,
		Stderr:   errOut.text,
		TimedOut: false,
		Error:    nil,
	}
	if command.ProcessState != nil {
		code := command.ProcessState.ExitCode()
		result.ReturnCode = &code
	}
	if waitErr != nil {
		result.Error = map[string]any{"type": "RuntimeError", "message": strings.TrimSpace(errOut.text)}
	}
	return result, nil
}

type boundedOutput struct {
	text    string
	limited bool
}

func collectOutput(reader io.Reader, result chan<- boundedOutput, limitReached chan<- struct{}) {
	data, limited := readBounded(reader, maxOutputBytes, limitReached)
	result <- boundedOutput{text: string(data), limited: limited}
}

func readBounded(reader io.Reader, limit int, limitReached chan<- struct{}) ([]byte, bool) {
	data := make([]byte, 0, limit)
	chunk := make([]byte, 32*1024)
	limited := false
	for {
		count, err := reader.Read(chunk)
		if count > 0 {
			remaining := limit - len(data)
			if remaining > 0 {
				kept := count
				if kept > remaining {
					kept = remaining
				}
				data = append(data, chunk[:kept]...)
			}
			if count > remaining && !limited {
				limited = true
				select {
				case limitReached <- struct{}{}:
				default:
				}
			}
		}
		if err != nil {
			return data, limited
		}
	}
}

func killProcessGroup(process *os.Process) {
	if process == nil {
		return
	}
	if err := syscall.Kill(-process.Pid, syscall.SIGKILL); err != nil {
		_ = process.Kill()
	}
}

func pythonWrapper(encoded string) string {
	return fmt.Sprintf(`import base64, resource
resource.setrlimit(resource.RLIMIT_CPU, (%d, %d))
resource.setrlimit(resource.RLIMIT_AS, (%d, %d))
resource.setrlimit(resource.RLIMIT_NOFILE, (%d, %d))
resource.setrlimit(resource.RLIMIT_FSIZE, (%d, %d))
resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
try:
    resource.setrlimit(resource.RLIMIT_NPROC, (%d, %d))
except (AttributeError, ValueError):
    pass
source = base64.b64decode(%q).decode("utf-8")
exec(compile(source, "<solution>", "exec"), {"__name__": "__main__", "__file__": "<solution>"})
`, maxCPUSeconds, maxCPUSeconds+1, maxMemoryBytes, maxMemoryBytes, maxOpenFiles, maxOpenFiles, maxOutputBytes, maxOutputBytes, maxProcesses, maxProcesses, encoded)
}

type workerEnvelope struct {
	Terminal         *TerminalRequest   `json:"terminal,omitempty"`
	Kind             string             `json:"kind"`
	DeadlineUnixNano int64              `json:"deadline_unix_nano,omitempty"`
	Run              *RunRequest        `json:"run,omitempty"`
	Submission       *SubmissionRequest `json:"submission,omitempty"`
}

type workerResponse struct {
	Terminal         *TerminalResult   `json:"terminal,omitempty"`
	Profiles         []LanguageProfile `json:"profiles,omitempty"`
	RunResult        *RunResult        `json:"run_result,omitempty"`
	SubmissionResult *SubmissionResult `json:"submission_result,omitempty"`
	Error            string            `json:"error,omitempty"`
}

// UnixWorkerExecutor keeps the HTTP process separate from the no-network worker process.
type UnixWorkerExecutor struct {
	SocketPath string
}

func (e UnixWorkerExecutor) Run(ctx context.Context, request RunRequest) (RunResult, error) {
	response, err := e.call(ctx, workerEnvelope{Kind: "run", Run: &request})
	if err != nil {
		return RunResult{}, err
	}
	if response.RunResult == nil {
		return RunResult{}, errors.New(response.Error)
	}
	return *response.RunResult, nil
}

func (e UnixWorkerExecutor) Submit(ctx context.Context, request SubmissionRequest) (SubmissionResult, error) {
	response, err := e.call(ctx, workerEnvelope{Kind: "submit", Submission: &request})
	if err != nil {
		return SubmissionResult{}, err
	}
	if response.SubmissionResult == nil {
		return SubmissionResult{}, errors.New(response.Error)
	}
	return *response.SubmissionResult, nil
}

// Ready verifies that the private worker socket is reachable without executing code.
func (e UnixWorkerExecutor) Ready(ctx context.Context) error {
	response, err := e.call(ctx, workerEnvelope{Kind: "ready"})
	if err != nil {
		return err
	}
	if response.Error != "" {
		return errors.New(response.Error)
	}
	return nil
}

func (e UnixWorkerExecutor) Profiles(ctx context.Context) ([]LanguageProfile, error) {
	response, err := e.call(ctx, workerEnvelope{Kind: "capabilities"})
	return response.Profiles, err
}

func (e UnixWorkerExecutor) call(ctx context.Context, envelope workerEnvelope) (workerResponse, error) {
	path := e.SocketPath
	if path == "" {
		path = defaultWorkerSocket
	}
	if deadline, ok := ctx.Deadline(); ok {
		envelope.DeadlineUnixNano = deadline.UnixNano()
	}
	dialer := net.Dialer{}
	connection, err := dialer.DialContext(ctx, "unix", path)
	if err != nil {
		return workerResponse{}, fmt.Errorf("runner worker unavailable: %w", err)
	}
	defer connection.Close()
	if deadline, ok := ctx.Deadline(); ok {
		_ = connection.SetDeadline(deadline)
	}
	if err := json.NewEncoder(connection).Encode(envelope); err != nil {
		return workerResponse{}, fmt.Errorf("send worker request: %w", err)
	}
	responseChannel := make(chan workerResponse, 1)
	errorChannel := make(chan error, 1)
	go func() {
		var response workerResponse
		if err := json.NewDecoder(connection).Decode(&response); err != nil {
			errorChannel <- err
			return
		}
		responseChannel <- response
	}()
	select {
	case response := <-responseChannel:
		if response.Error != "" {
			return response, errors.New(response.Error)
		}
		return response, nil
	case err := <-errorChannel:
		if ctx.Err() != nil {
			return workerResponse{}, ctx.Err()
		}
		return workerResponse{}, fmt.Errorf("read worker response: %w", err)
	case <-ctx.Done():
		_ = connection.Close()
		return workerResponse{}, ctx.Err()
	}
}

// ServeWorker exposes the executor only through a Unix socket in a networkless container.
func ServeWorker(ctx context.Context, socketPath string, executor *SandboxExecutor) error {
	if executor == nil {
		return errors.New("worker executor is required")
	}
	if socketPath == "" {
		socketPath = defaultWorkerSocket
	}
	if err := os.MkdirAll(filepath.Dir(socketPath), 0o700); err != nil {
		return fmt.Errorf("create worker socket directory: %w", err)
	}
	// The sandbox must neither connect to nor unlink the shared control socket.
	if err := os.Chown(filepath.Dir(socketPath), 0, controlGID); err != nil {
		return fmt.Errorf("own worker socket directory: %w", err)
	}
	if err := os.Chmod(filepath.Dir(socketPath), 0o750); err != nil {
		return fmt.Errorf("secure worker socket directory: %w", err)
	}
	_ = os.Remove(socketPath)
	listener, err := net.Listen("unix", socketPath)
	if err != nil {
		return fmt.Errorf("listen on worker socket: %w", err)
	}
	defer listener.Close()
	defer os.Remove(socketPath)
	if err := os.Chmod(socketPath, 0o660); err != nil {
		return fmt.Errorf("secure worker socket: %w", err)
	}
	if err := os.Chown(socketPath, controlUID, controlGID); err != nil {
		return fmt.Errorf("own worker socket: %w", err)
	}
	go func() {
		<-ctx.Done()
		_ = listener.Close()
	}()
	for {
		connection, err := listener.Accept()
		if err != nil {
			if ctx.Err() != nil {
				return nil
			}
			return err
		}
		go handleWorkerConnection(connection, executor)
	}
}

func handleWorkerConnection(connection net.Conn, executor *SandboxExecutor) {
	defer connection.Close()
	decoder := json.NewDecoder(bufio.NewReader(connection))
	var envelope workerEnvelope
	if err := decoder.Decode(&envelope); err != nil {
		return
	}
	requestContext, cancel := context.WithCancel(context.Background())
	defer cancel()
	go watchWorkerDisconnect(connection, cancel)
	if envelope.DeadlineUnixNano > 0 {
		deadline := time.Unix(0, envelope.DeadlineUnixNano)
		requestContext, cancel = context.WithDeadline(requestContext, deadline)
		defer cancel()
	}
	response := workerResponse{}
	switch envelope.Kind {
	case "terminal":
		if envelope.Terminal == nil {
			response.Error = "terminal request is missing"
			break
		}
		result, err := executor.Terminal(*envelope.Terminal)
		if err != nil {
			response.Error = err.Error()
		} else {
			response.Terminal = &result
		}
	case "capabilities":
		response.Profiles = executor.Profiles()
	case "ready":
		if err := executor.Ready(requestContext); err != nil {
			response.Error = err.Error()
		}
	case "run":
		if envelope.Run == nil {
			response.Error = "run request is missing"
			break
		}
		result, err := executor.Run(requestContext, *envelope.Run)
		if err != nil {
			response.Error = err.Error()
		} else {
			response.RunResult = &result
		}
	case "submit":
		if envelope.Submission == nil {
			response.Error = "submission request is missing"
			break
		}
		result, err := executor.Submit(requestContext, *envelope.Submission)
		if err != nil {
			response.Error = err.Error()
		} else {
			response.SubmissionResult = &result
		}
	default:
		response.Error = "unknown worker request"
	}
	_ = json.NewEncoder(connection).Encode(response)
}

func watchWorkerDisconnect(connection net.Conn, cancel context.CancelFunc) {
	buffer := make([]byte, 1)
	_, _ = connection.Read(buffer)
	cancel()
}

func outputMatches(validator *string, stdin, actual, expected string) bool {
	if validator == nil {
		return comparableText(actual) == comparableText(expected)
	}
	switch *validator {
	case "top_k_frequent":
		return validTopKFrequent(stdin, actual)
	case "k_closest":
		return validKClosest(stdin, actual)
	case "heap_k_pairs":
		return validKPairs(stdin, actual)
	case "heap_reorganization":
		return validReorganization(stdin, actual)
	case "bucket_frequency_string":
		return validFrequencyString(stdin, actual)
	default:
		return false
	}
}

func comparableText(value string) string { return strings.Join(strings.Fields(value), " ") }

func parseInts(value string) ([]int, bool) {
	fields := strings.Fields(value)
	values := make([]int, len(fields))
	for index, field := range fields {
		parsed, err := strconv.Atoi(field)
		if err != nil {
			return nil, false
		}
		values[index] = parsed
	}
	return values, true
}

func validTopKFrequent(stdin, actual string) bool {
	values, ok := parseInts(stdin)
	if !ok || len(values) == 0 {
		return false
	}
	count := values[0]
	if count < 0 || len(values) < count+2 {
		return false
	}
	requested := values[count+1]
	frequencies := map[int]int{}
	for _, value := range values[1 : count+1] {
		frequencies[value]++
	}
	answer, ok := parseInts(actual)
	if !ok || requested < 1 || requested > len(frequencies) || len(answer) != requested {
		return false
	}
	if !sort.IntsAreSorted(answer) {
		return false
	}
	seen := map[int]bool{}
	for _, value := range answer {
		if seen[value] {
			return false
		}
		seen[value] = true
	}
	scores := make([]int, 0, len(frequencies))
	for _, frequency := range frequencies {
		scores = append(scores, frequency)
	}
	sort.Sort(sort.Reverse(sort.IntSlice(scores)))
	cutoff := scores[requested-1]
	for value, frequency := range frequencies {
		if frequency > cutoff && !seen[value] {
			return false
		}
		if frequency < cutoff && seen[value] {
			return false
		}
	}
	return true
}

type point struct{ x, y int }

func validKClosest(stdin, actual string) bool {
	values, ok := parseInts(stdin)
	if !ok || len(values) == 0 {
		return false
	}
	count := values[0]
	end := 1 + 2*count
	if count < 0 || len(values) <= end {
		return false
	}
	requested := values[end]
	answer, ok := parseInts(actual)
	if !ok || requested < 0 || len(answer) != 2*requested {
		return false
	}
	points := make([]point, 0, count)
	for index := 1; index < end; index += 2 {
		points = append(points, point{values[index], values[index+1]})
	}
	if requested < 1 || requested > len(points) {
		return false
	}
	distances := make([]int, len(points))
	available := map[point]int{}
	for index, item := range points {
		distances[index] = item.x*item.x + item.y*item.y
		available[item]++
	}
	sort.Ints(distances)
	cutoff := distances[requested-1]
	selected := map[point]int{}
	for index := 0; index < len(answer); index += 2 {
		item := point{answer[index], answer[index+1]}
		selected[item]++
		if selected[item] > available[item] || item.x*item.x+item.y*item.y > cutoff {
			return false
		}
	}
	for item, amount := range available {
		if item.x*item.x+item.y*item.y < cutoff && selected[item] < amount {
			return false
		}
	}
	return true
}

type pair struct{ left, right int }

func validKPairs(stdin, actual string) bool {
	values, ok := parseInts(stdin)
	if !ok || len(values) < 3 {
		return false
	}
	leftSize, rightSize, requested := values[0], values[1], values[2]
	if leftSize < 0 || rightSize < 0 || len(values) < 3+leftSize+rightSize {
		return false
	}
	left := values[3 : 3+leftSize]
	right := values[3+leftSize : 3+leftSize+rightSize]
	if requested < 0 {
		return false
	}
	if requested > leftSize*rightSize {
		requested = leftSize * rightSize
	}
	answer, ok := parseInts(actual)
	if !ok || len(answer) != requested*2 || requested == 0 {
		return requested == 0 && len(answer) == 0
	}
	available := map[pair]int{}
	distances := make([]int, 0, leftSize*rightSize)
	for _, first := range left {
		for _, second := range right {
			available[pair{first, second}]++
			distances = append(distances, first+second)
		}
	}
	sort.Ints(distances)
	cutoff := distances[requested-1]
	selected := map[pair]int{}
	for index := 0; index < len(answer); index += 2 {
		item := pair{answer[index], answer[index+1]}
		selected[item]++
		if selected[item] > available[item] || item.left+item.right > cutoff {
			return false
		}
	}
	for item, amount := range available {
		if item.left+item.right < cutoff && selected[item] < amount {
			return false
		}
	}
	return true
}

func validReorganization(stdin, actual string) bool {
	source := strings.TrimSpace(stdin)
	result := strings.TrimSpace(actual)
	if result == "IMPOSSIBLE" {
		return !canReorganize(source)
	}
	if !canReorganize(source) || len(result) != len(source) {
		return false
	}
	sourceCounts := map[rune]int{}
	resultCounts := map[rune]int{}
	for _, character := range source {
		sourceCounts[character]++
	}
	for index, character := range []rune(result) {
		resultCounts[character]++
		if index > 0 {
			previous := []rune(result)[index-1]
			if character == previous {
				return false
			}
		}
	}
	return mapsEqual(sourceCounts, resultCounts)
}

func canReorganize(value string) bool {
	counts := map[rune]int{}
	for _, character := range value {
		counts[character]++
	}
	maximum := 0
	for _, count := range counts {
		if count > maximum {
			maximum = count
		}
	}
	return maximum <= (len([]rune(value))+1)/2
}

func validFrequencyString(stdin, actual string) bool {
	source := strings.TrimRight(stdin, "\n")
	result := strings.TrimSpace(actual)
	sourceCounts := map[rune]int{}
	resultCounts := map[rune]int{}
	for _, character := range source {
		sourceCounts[character]++
	}
	for _, character := range result {
		resultCounts[character]++
	}
	if !mapsEqual(sourceCounts, resultCounts) {
		return false
	}
	seen := map[rune]bool{}
	sizes := []int{}
	runes := []rune(result)
	for index := 0; index < len(runes); {
		character := runes[index]
		if seen[character] {
			return false
		}
		seen[character] = true
		end := index + 1
		for end < len(runes) && runes[end] == character {
			end++
		}
		sizes = append(sizes, end-index)
		index = end
	}
	for index := 1; index < len(sizes); index++ {
		if sizes[index] > sizes[index-1] {
			return false
		}
	}
	return true
}

func mapsEqual[K comparable](left, right map[K]int) bool {
	if len(left) != len(right) {
		return false
	}
	for key, value := range left {
		if right[key] != value {
			return false
		}
	}
	return true
}
