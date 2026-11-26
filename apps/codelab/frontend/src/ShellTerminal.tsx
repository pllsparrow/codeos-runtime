import { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import './shellTerminal.css'

type Reply = { data: string; cursor: number; closed: boolean; sequence: number }
type Input = { data: string; columns: number; rows: number; sequence: number }
const endpoint = '/api/codelab/lab/terminal'

function encode(value: string) {
  return btoa(String.fromCharCode(...new TextEncoder().encode(value)))
}

async function send(body: object, keepalive = false): Promise<Reply> {
  const response = await fetch(endpoint, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body), signal: AbortSignal.timeout(10_000), keepalive,
  })
  const result = await response.json()
  if (!response.ok) throw new Error(result.detail || 'Terminal connection failed')
  return result
}

export default function ShellTerminal({ createSessionId, script }: { createSessionId: () => string; script: string }) {
  const host = useRef<HTMLDivElement>(null)
  const [generation, setGeneration] = useState(0)
  const [status, setStatus] = useState('Connecting…')
  const [problem, setProblem] = useState('')
  const [closed, setClosed] = useState(false)
  const resume = useRef<() => void>(() => {})
  const endSession = useRef<() => void>(() => {})
  const executeScript = useRef<() => void>(() => {})
  useEffect(() => {
    const id = createSessionId()
    const terminal = new Terminal({
      cursorBlink: true, fontFamily: 'Menlo, Consolas, monospace', fontSize: 14,
      lineHeight: 1.35, scrollback: 2000, screenReaderMode: true,
      theme: { background: '#171b1e', foreground: '#e3e9e5', cursor: '#b0d9bf', selectionBackground: '#40534b' },
    })
    const fit = new FitAddon()
    terminal.loadAddon(fit)
    terminal.open(host.current!)
    let disposed = false
    let started = false
    let starting = false
    let active = false
    let ended = false
    let closing = false
    let cursor = 0
    let sequence = 0
    let pending: Input | undefined
    let timer: ReturnType<typeof setTimeout>
    const queue: string[] = []
    let dimensions = ''
    const enqueue = (text: string) => {
      // Bound unacknowledged input and split large pastes into small retryable frames.
      if (ended) return
      const characters = Array.from(text)
      if (Math.ceil(characters.length / 512) + queue.length > 128) {
        terminal.writeln('\r\n[Input is too large. Paste a smaller block.]')
        return
      }
      for (let offset = 0; offset < characters.length; offset += 512) {
        queue.push(encode(characters.slice(offset, offset + 512).join('')))
      }
    }
    const display = (reply: Reply) => {
      if (disposed || closing && !reply.closed) return
      if (reply.cursor < cursor) throw new Error('Terminal output cursor moved backwards')
      const bytes = Uint8Array.from(atob(reply.data), char => char.charCodeAt(0))
      if (reply.cursor - cursor > bytes.length) terminal.writeln('\r\n[Earlier output exceeded the buffer limit]')
      terminal.write(bytes)
      cursor = reply.cursor
      ended = reply.closed
      setClosed(ended)
      setStatus(ended ? 'Session ended' : 'Connected')
      terminal.options.disableStdin = ended
    }
    async function pump() {
      if (disposed || active || !started || ended || closing) return
      active = true
      try {
        const size = `${terminal.cols}x${terminal.rows}`
        if (!pending && (queue.length || size !== dimensions)) {
          pending = { data: queue.shift() || '', sequence: sequence + 1, columns: terminal.cols, rows: terminal.rows }
        }
        const reply = await send({
          operation: pending ? 'input' : 'poll', id, cursor,
          ...(pending || {}),
        })
        if (pending) {
          sequence = pending.sequence
          dimensions = `${pending.columns}x${pending.rows}`
          pending = undefined
        }
        display(reply)
        if (!disposed && !ended && !closing) timer = setTimeout(() => void pump(), queue.length ? 0 : 150)
      } catch (error) {
        if (!disposed) {
          terminal.options.disableStdin = true
          setStatus('Disconnected')
          setProblem(String(error))
        }
      } finally { active = false }
    }
    async function start() {
      if (disposed || starting) return
      starting = true
      setProblem('')
      setClosed(false)
      setStatus('Connecting…')
      try {
        fit.fit()
        const reply = await send({ operation: 'start', id, columns: terminal.cols, rows: terminal.rows })
        started = true
        if (disposed) {
          void send({ operation: 'close', id }).catch(() => {})
          return
        }
        display(reply)
        terminal.focus()
        void pump()
      } catch (error) {
        if (!disposed) { setProblem(String(error)); setStatus('Disconnected') }
      } finally { starting = false }
    }
    resume.current = () => {
      setProblem('')
      terminal.options.disableStdin = false
      if (started) void pump()
      else void start()
    }
    executeScript.current = () => { enqueue(scriptRef.current + '\n'); terminal.focus() }
    const input = terminal.onData(enqueue)
    const observer = new ResizeObserver(() => { if (!disposed) fit.fit() })
    observer.observe(host.current!)
    timer = setTimeout(() => void start(), 0)
    const close = () => { void send({ operation: 'close', id }, true).catch(() => {}) }
    endSession.current = () => {
      closing = true
      clearTimeout(timer)
      terminal.options.disableStdin = true
      setStatus('Closing…')
      void send({ operation: 'close', id, cursor }).then(display).catch(error => {
        if (!disposed) { closing = false; setProblem(String(error)); setStatus('Disconnected') }
      })
    }
    window.addEventListener('pagehide', close)
    return () => {
      disposed = true
      clearTimeout(timer)
      window.removeEventListener('pagehide', close)
      input.dispose()
      observer.disconnect()
      close()
      terminal.dispose()
    }
  // Script edits do not replace a running session.
  }, [createSessionId, generation])

  // Keep the action current without reconnecting when the saved script changes.
  const scriptRef = useRef(script)
  scriptRef.current = script
  return <section className="shell-terminal" aria-label="Linux terminal">
    <header>
      <span>Bash <small>{status}</small></span>
      <div>
        {!!script && !closed && !problem && <button type="button" onClick={() => executeScript.current()}>Run script</button>}
        {closed || problem
          ? <button type="button" onClick={() => setGeneration(value => value + 1)}>New session</button>
          : <button type="button" onClick={() => endSession.current()}>Close session</button>}
      </div>
    </header>
    {problem && <div className="shell-terminal-error" role="alert">
      {problem} <button type="button" onClick={() => resume.current()}>Reconnect</button>
    </div>}
    <div className="shell-terminal-screen" ref={host} />
    <footer>Session files are temporary · Closes after 30 minutes · Ctrl+C interrupts</footer>
  </section>
}
