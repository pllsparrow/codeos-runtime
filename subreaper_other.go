//go:build !linux

package runner

import (
	"os"
	"time"
)

func EnableChildSubreaper() error { return nil }

func reapProcessGroup(*os.Process, time.Duration) {}

func terminateSandboxDescendants() {}
