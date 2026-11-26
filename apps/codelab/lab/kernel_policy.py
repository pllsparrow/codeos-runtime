"""Lab-owned execution limits using the authenticated kernel activity channel."""
from jupyter_client.session import Session
from jupyter_core.utils import ensure_async
from jupyter_server.services.kernels.kernelmanager import MappingKernelManager
from tornado.ioloop import IOLoop
from traitlets import Float

from execution_budget import Deadline, ExecutionBudget


class ExecutionKernelManager(MappingKernelManager):
    execution_timeout = Float(60, min=1, max=60, config=True)

    def __init__(self, **kwargs):
        super().__init__(**kwargs)
        self._execution_budget = ExecutionBudget(self.execution_timeout)
        self._execution_streams = {}
        self._execution_timers = {}

    def start_watching_activity(self, kernel_id):
        super().start_watching_activity(kernel_id)
        self._release_execution_monitor(kernel_id)
        kernel = self.get_kernel(kernel_id)
        stream = kernel.connect_iopub()
        session = Session(config=kernel.session.config, key=kernel.session.key)
        self._execution_streams[kernel_id] = stream

        def record_status(parts):
            try:
                _, frames = session.feed_identities(parts)
                message = session.deserialize(frames, content=False)
            except (ValueError, TypeError, KeyError):
                self.log.warning("Rejected invalid kernel activity for %s", kernel_id)
                return
            if message["header"].get("msg_type") != "status":
                return
            message = session.deserialize(frames)
            parent = message.get("parent_header", {})
            previous = self._execution_budget.deadlines.get(kernel_id)
            self._execution_budget.observe(kernel_id, message["content"].get("execution_state"), parent.get("msg_type"), parent.get("msg_id"))
            deadline = self._execution_budget.deadlines.get(kernel_id)
            if deadline is None:
                self._cancel_execution_timer(kernel_id)
            elif previous is None:
                self._execution_timers[kernel_id] = IOLoop.current().call_later(
                    self.execution_timeout, self._expire_execution, kernel_id, deadline
                )

        stream.on_recv(record_status)

    async def _expire_execution(self, kernel_id: str, deadline: Deadline):
        if self._execution_budget.deadlines.get(kernel_id) != deadline:
            return
        if not self._execution_budget.expired(kernel_id, deadline):
            self._execution_timers[kernel_id] = IOLoop.current().call_later(
                0.1, self._expire_execution, kernel_id, deadline
            )
            return
        if kernel_id not in self:
            self._release_execution_monitor(kernel_id)
            return
        self.log.warning("Execution deadline exceeded; stopping kernel %s", kernel_id)
        try:
            await ensure_async(self.shutdown_kernel(kernel_id, now=True))
        except Exception:
            self.log.exception("Failed to stop expired kernel %s", kernel_id)
            # Retain the budget so a transient shutdown failure cannot remove the limit.
            self._execution_budget.deadlines[kernel_id] = deadline
            self._execution_timers[kernel_id] = IOLoop.current().call_later(
                1, self._expire_execution, kernel_id, deadline
            )

    def _cancel_execution_timer(self, kernel_id):
        timer = self._execution_timers.pop(kernel_id, None)
        if timer is not None:
            IOLoop.current().remove_timeout(timer)

    def _release_execution_monitor(self, kernel_id):
        self._cancel_execution_timer(kernel_id)
        self._execution_budget.forget(kernel_id)
        stream = self._execution_streams.pop(kernel_id, None)
        if stream is not None and not stream.socket.closed:
            stream.close()

    def stop_watching_activity(self, kernel_id):
        self._release_execution_monitor(kernel_id)
        super().stop_watching_activity(kernel_id)
