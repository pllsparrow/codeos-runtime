import type { Kernel } from '@jupyterlab/services'
import type { CellExecution, CellOutput } from './labTypes'
import { boundedOutputs } from './notebookSafety.ts'

export async function runNotebookExecution(kernel: Pick<Kernel.IKernelConnection, 'requestExecute'>, source: string, signal: AbortSignal, onOutput: (outputs: CellOutput[]) => void, timeoutMs = 60_000, onStarted: () => void = () => {}, prediction = ''): Promise<{ execution: CellExecution; outputs: CellOutput[]; count: number | null }> {
  signal.throwIfAborted()
  const started = Date.now()
  const tick = performance.now()
  let outputs: CellOutput[] = []
  let count: number | null = null
  let status: CellExecution['status'] = 'interrupted'
  let message = ''
  let finished = false
  let pendingClear = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const future = kernel.requestExecute({ code: source, stop_on_error: false })
  onStarted()
  const text = (value: unknown): string => typeof value === 'string' ? value : Array.isArray(value) ? value.join('') : ''
  future.onIOPub = (event) => {
    if (finished || signal.aborted) return
    const content = event.content as Record<string, unknown>
    const kind = event.header.msg_type
    if (pendingClear && ['stream', 'execute_result', 'display_data', 'error'].includes(kind)) {
      outputs = []
      pendingClear = false
    }
    if (kind === 'stream') outputs = boundedOutputs(outputs, { kind: 'stream', text: text(content.text) })
    if (kind === 'execute_result' || kind === 'display_data') {
      const data = content.data as Record<string, unknown> | undefined
      outputs = boundedOutputs(outputs, { kind: 'result', text: text(data?.['text/plain']) })
    }
    if (kind === 'error') outputs = boundedOutputs(outputs, { kind: 'error', text: `${content.ename || 'Error'}: ${content.evalue || ''}\n${text(Array.isArray(content.traceback) ? content.traceback.join('\n') : '')}` })
    if (kind === 'clear_output') {
      // Jupyter wait=true defers clearing until the next output message.
      if (content.wait) pendingClear = true
      else { outputs = []; pendingClear = false }
    }
    onOutput(outputs)
  }
  future.onReply = (event) => {
    if (finished || signal.aborted) return
    if (typeof event.content.execution_count === 'number') count = event.content.execution_count
    status = event.content.status === 'ok' ? 'success' : event.content.status === 'error' ? 'error' : 'interrupted'
  }
  let cancel: () => void = () => {}
  try {
    await Promise.race([
      future.done,
      new Promise<void>((resolve) => {
        cancel = () => { status = 'interrupted'; message = 'Execution interrupted. Run again with a fresh kernel.'; resolve() }
        signal.addEventListener('abort', cancel, { once: true })
        if (signal.aborted) cancel()
        timer = setTimeout(() => { status = 'timeout'; message = 'Execution exceeded the time limit. Restart the kernel before running again.'; resolve() }, timeoutMs)
      }),
    ])
  } catch {
    status = 'interrupted'
    message = 'Kernel connection ended before execution completed. Run again.'
  } finally {
    finished = true
    if (timer !== undefined) clearTimeout(timer)
    signal.removeEventListener('abort', cancel)
    future.dispose()
  }
  if (status === 'interrupted' && !message) message = 'Execution did not complete successfully.'
  return {
    outputs, count,
    execution: { status, source, ...(prediction ? { prediction } : {}), started_at: new Date(started).toISOString(), finished_at: new Date(Math.max(started, Date.now())).toISOString(), duration_ms: Math.min(86_400_000, Math.max(0, Math.round(performance.now() - tick))), message },
  }
}
