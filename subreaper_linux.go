//go:build linux

package runner

import (
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"

	"golang.org/x/sys/unix"
)

func EnableChildSubreaper() error {
	return unix.Prctl(unix.PR_SET_CHILD_SUBREAPER, 1, 0, 0, 0)
}

func reapProcessGroup(process *os.Process, timeout time.Duration) {
	if process == nil {
		return
	}
	deadline := time.Now().Add(timeout)
	for {
		var status unix.WaitStatus
		// A negative pid limits reaping to this execution's process group and
		// avoids stealing exits from concurrent submissions.
		pid, err := unix.Wait4(-process.Pid, &status, unix.WNOHANG, nil)
		if pid > 0 {
			continue
		}
		if err == unix.ECHILD || time.Now().After(deadline) {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
}

// Worker executions are serialized. Kill escaped sessions under the dedicated sandbox UID too.
func terminateSandboxDescendants() {
	deadline := time.Now().Add(500 * time.Millisecond)
	for {
		entries, _ := os.ReadDir("/proc")
		found := false
		for _, entry := range entries {
			pid, err := strconv.Atoi(entry.Name())
			if err != nil {
				continue
			}
			content, err := os.ReadFile(fmt.Sprintf("/proc/%d/status", pid))
			if err != nil {
				continue
			}
			for _, line := range strings.Split(string(content), "\n") {
				fields := strings.Fields(line)
				if len(fields) > 1 && fields[0] == "Uid:" && fields[1] == strconv.Itoa(sandboxUID) {
					_ = unix.Kill(pid, unix.SIGKILL)
					found = true
					break
				}
			}
		}
		for {
			var status unix.WaitStatus
			pid, _ := unix.Wait4(-1, &status, unix.WNOHANG, nil)
			if pid <= 0 {
				break
			}
		}
		if !found || time.Now().After(deadline) {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
}
