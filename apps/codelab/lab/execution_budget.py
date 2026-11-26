"""Wall-clock execution budgets independent of output or browser activity."""
from dataclasses import dataclass
from math import isfinite
from time import monotonic
from typing import Callable


@dataclass(frozen=True)
class Deadline:
    request_id: str
    started_at: float


class ExecutionBudget:
    def __init__(self, seconds: float, clock: Callable[[], float] = monotonic):
        if not isfinite(seconds) or seconds <= 0:
            raise ValueError("Execution timeout must be finite and positive")
        self.seconds = seconds
        self.clock = clock
        self.deadlines: dict[str, Deadline] = {}

    def observe(self, kernel_id: str, state: str, request_type: str, request_id: str) -> None:
        if request_type != "execute_request" or not request_id:
            return
        current = self.deadlines.get(kernel_id)
        if state == "busy" and current is None:
            self.deadlines[kernel_id] = Deadline(request_id, self.clock())
        elif state == "idle" and current and current.request_id == request_id:
            self.forget(kernel_id)

    def expired(self, kernel_id: str, deadline: Deadline) -> bool:
        return self.deadlines.get(kernel_id) == deadline and self.clock() - deadline.started_at >= self.seconds

    def forget(self, kernel_id: str) -> None:
        self.deadlines.pop(kernel_id, None)
