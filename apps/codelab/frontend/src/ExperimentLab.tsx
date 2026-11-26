import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import CodeMirror from '@uiw/react-codemirror'
import { go } from '@codemirror/lang-go'
import { sql, SQLite } from '@codemirror/lang-sql'
import { syntaxHighlighting } from '@codemirror/language'
import { EditorView, keymap } from '@codemirror/view'
import { ChevronDown, FileCode2, FlaskConical, Play, Plus, RefreshCw, Save, Search } from 'lucide-react'
import { notebookHighlightStyle } from './codeHighlightStyle'
import ShellTerminal from './ShellTerminal'
import './experimentLab.css'

type Kind = 'go' | 'sql' | 'shell'
type Output = { ok: boolean; stdout: string; stderr: string; timed_out?: boolean; error?: { type?: string; message?: string }; tables?: { columns: string[]; rows: unknown[][]; truncated: boolean }[] }
type Snapshot = Pick<Experiment, 'type' | 'source' | 'stdin' | 'setup'>
type Run = { snapshot: Snapshot; output: Output; finished_at: string }
type Experiment = { id: string; type: Kind; title: string; source: string; stdin: string; setup: string; explanation: string; updated_at?: string; result?: Run | null }
type Entry = Pick<Experiment, 'id' | 'type' | 'title' | 'updated_at'>
const root = '/api/codelab/lab/experiments'
const kinds: { id: Kind; title: string; initial: string }[] = [
  { id: 'go', title: 'Go', initial: 'package main\n\nimport "fmt"\n\nfunc main() {\n\tfmt.Println("Hello, Lab")\n}\n' },
  { id: 'sql', title: 'SQL', initial: 'SELECT name, score\nFROM students\nWHERE score >= 80\nORDER BY id;\n' },
  { id: 'shell', title: 'Linux Shell', initial: '' },
]
const sqlExtensions = [sql({ dialect: SQLite }), syntaxHighlighting(notebookHighlightStyle)]
const setupExtensions = [...sqlExtensions, EditorView.contentAttributes.of({ 'aria-label': 'Setup SQL' })]

function experimentId() {
  if (crypto.randomUUID) return crypto.randomUUID()
  // Tailnet HTTP supports getRandomValues even when randomUUID requires a secure context.
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  bytes[6] = (bytes[6] & 0x0f) | 0x40
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join('-')
}

const recoveryKey = (id: string) => `codeos.lab.experiment.${id}`
const snapshot = (value: Experiment): Snapshot => ({ type: value.type, source: value.source, stdin: value.stdin, setup: value.setup })
const draft = (value: Experiment) => ({ type: value.type, title: value.title.trim(), source: value.source, stdin: value.stdin, setup: value.setup, explanation: value.explanation })
class ExperimentRequestError extends Error {
  constructor(message: string, readonly status: number) { super(message) }
}
async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(root + path, { ...options, signal: options.signal || AbortSignal.timeout(60_000), headers: { 'Content-Type': 'application/json', ...options.headers } })
  const body = await response.json().catch(() => ({}))
  if (!response.ok) throw new ExperimentRequestError(body.detail || `Lab request failed (${response.status})`, response.status)
  return body as T
}
function recovery(id: string): Experiment | undefined {
  try { const value = JSON.parse(localStorage.getItem(recoveryKey(id)) || 'null'); return value?.id === id && kinds.some(kind => kind.id === value.type) && ['title','source','stdin','setup','explanation'].every(field => typeof value[field] === 'string') ? value : undefined } catch { return undefined }
}
function remember(value: Experiment): boolean { try { localStorage.setItem(recoveryKey(value.id), JSON.stringify(value)); return true } catch { return false } }
function recoveryEntries(): Experiment[] {
  try { return Object.keys(localStorage).filter(key => key.startsWith('codeos.lab.experiment.')).map(key => recovery(key.slice('codeos.lab.experiment.'.length))).filter((value): value is Experiment => !!value) } catch { return [] }
}
function forget(id: string) { try { localStorage.removeItem(recoveryKey(id)) } catch { /* Storage is optional. */ } }

export default function ExperimentLab({ onNavigationGuardChange }: { onNavigationGuardChange: (guard: () => boolean) => void }) {
  const [entries, setEntries] = useState<Entry[]>([])
  const [pickerOpen, setPickerOpen] = useState(false)
  const pickerRef = useRef<HTMLDivElement>(null)
  const pickerButtonRef = useRef<HTMLButtonElement>(null)
  const [setup, setSetup] = useState('')
  const [current, setCurrent] = useState<Experiment>()
  const currentRef = useRef(current); currentRef.current = current
  const [dirty, setDirty] = useState(false)
  const dirtyRef = useRef(dirty); dirtyRef.current = dirty
  const [busy, setBusy] = useState('')
  const busyRef = useRef(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [query, setQuery] = useState('')
  const [page, setPage] = useState(0)
  const [pageCount, setPageCount] = useState(1)
  const [recoveries, setRecoveries] = useState(recoveryEntries)
  const [loading, setLoading] = useState(true)
  const [catalogError, setCatalogError] = useState('')
  const [localDraft, setLocalDraft] = useState<Experiment>()
  const [goAvailable, setGoAvailable] = useState(false)
  const pendingSave = useRef<{ body: string; key: string } | undefined>(undefined)
  const pendingRun = useRef<{ identity: string; key: string } | undefined>(undefined)
  const catalogRequest = useRef(0)
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  useEffect(() => {
    if (!pickerOpen) return
    const dismiss = (event: PointerEvent) => {
      if (event.target instanceof Node && !pickerRef.current?.contains(event.target)) setPickerOpen(false)
    }
    document.addEventListener('pointerdown', dismiss)
    return () => document.removeEventListener('pointerdown', dismiss)
  }, [pickerOpen])
  const canLeave = useCallback(() => {
    if (busyRef.current) return false
    const value = currentRef.current
    if (!dirtyRef.current || !value) return true
    const local = recovery(value.id)
    const hasRecovery = local && JSON.stringify(draft(local)) === JSON.stringify(draft(value))
    return window.confirm(hasRecovery
      ? 'Leave this unsaved experiment? A local recovery copy is retained.'
      : 'Leave this unsaved experiment? Your latest changes could be lost.')
  }, [])
  useEffect(() => { onNavigationGuardChange(canLeave); return () => onNavigationGuardChange(() => true) }, [canLeave, onNavigationGuardChange])
  useEffect(() => {
    const protect = (event: BeforeUnloadEvent) => { if (dirtyRef.current || busyRef.current) { event.preventDefault(); event.returnValue = '' } }
    window.addEventListener('beforeunload', protect); return () => window.removeEventListener('beforeunload', protect)
  }, [])
  const loadCatalog = useCallback(async () => {
    const generation = ++catalogRequest.current
    setLoading(true); setCatalogError('')
    try { const result = await request<{ items: Entry[]; sql_setup: string; page: number; page_count: number }>(`?q=${encodeURIComponent(query)}&page=${page}`); if (mounted.current && generation === catalogRequest.current) { setEntries(result.items); setSetup(result.sql_setup); setPage(result.page || 0); setPageCount(result.page_count || 1); setRecoveries(recoveryEntries()) } }
    catch (failure) { if (mounted.current && generation === catalogRequest.current) setCatalogError(String(failure)) }
    finally { if (mounted.current && generation === catalogRequest.current) setLoading(false) }
  }, [query, page])
  const open = useCallback(async (id: string, guarded = true) => {
    if (guarded && !canLeave()) return
    busyRef.current = true; setBusy('Opening experiment…'); setError('')
    try {
      const value = await request<Experiment>(`/${id}`)
      if (!mounted.current) return
      setCurrent(value); setDirty(false); setNotice('Saved experiment opened')
      const local = recovery(id); setLocalDraft(local && JSON.stringify(draft(local)) !== JSON.stringify(draft(value)) ? local : undefined)
      const url = new URL(window.location.href); url.searchParams.set('experiment', id); window.history.replaceState({}, '', url)
    } catch (failure) {
      if (!mounted.current) return
      setError(String(failure)); setLocalDraft(recovery(id))
    } finally { busyRef.current = false; if (mounted.current) setBusy('') }
  }, [canLeave])
  const refreshAvailability = useCallback(async () => {
    try {
      const response = await fetch('/api/codelab/coding/languages')
      const profiles = response.ok ? await response.json() : []
      if (mounted.current) setGoAvailable(profiles.some((profile: { language: string; available: boolean }) => profile.language === 'go' && profile.available))
    } catch { if (mounted.current) setGoAvailable(false) }
  }, [])
  useEffect(() => { void loadCatalog() }, [loadCatalog])
  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get('experiment')
    if (id) { const local = recovery(id); if (local && !local.updated_at) { setLocalDraft(local) } else void open(id, false) }
    void refreshAvailability()
  }, [open, refreshAvailability])
  function edit(update: Partial<Experiment>) {
    if (!current || busyRef.current) return
    const next = { ...current, ...update }; setCurrent(next); currentRef.current = next; setDirty(true); dirtyRef.current = true; setNotice(remember(next) ? 'Unsaved changes' : 'Unsaved changes · local recovery unavailable')
  }
  function create(kind: Kind) {
    if (!canLeave()) return
    const item = kinds.find(item => item.id === kind)!
    const value: Experiment = { id: experimentId(), type: kind, title: `Untitled ${item.title} experiment`, source: item.initial, stdin: '', setup: kind === 'sql' ? setup : '', explanation: '' }
    setCurrent(value); currentRef.current = value; setDirty(true); dirtyRef.current = true; setError(''); setNotice('New experiment · save to keep it'); setLocalDraft(undefined); remember(value)
    const url = new URL(window.location.href); url.searchParams.set('experiment', value.id); window.history.replaceState({}, '', url)
  }
  async function persist(): Promise<Experiment> {
    const value = currentRef.current!
    if (!dirtyRef.current && value.updated_at) return value
    const payload = { ...draft(value), expected_version: value.updated_at || 'new' }
    const body = JSON.stringify(payload)
    if (pendingSave.current?.body !== value.id + body) pendingSave.current = { body: value.id + body, key: experimentId() }
    const saved = await request<Experiment>(`/${value.id}`, { method: 'PUT', headers: { 'Idempotency-Key': pendingSave.current!.key }, body })
    const loaded = await request<Experiment>(`/${value.id}`)
    if (!loaded.updated_at || loaded.updated_at !== saved.updated_at || JSON.stringify(draft(loaded)) !== JSON.stringify(draft(value))) throw new Error('Save read-back differs from the submitted experiment.')
    pendingSave.current = undefined
    if (mounted.current) { setCurrent(loaded); currentRef.current = loaded; setDirty(false); dirtyRef.current = false; setNotice('All changes saved'); forget(value.id); setLocalDraft(undefined); void loadCatalog() }
    return loaded
  }
  async function act(run: boolean) {
    if (!currentRef.current || busyRef.current) return
    if (run && currentRef.current.type === 'go' && !goAvailable) { setError('Go execution is unavailable. Your code is retained.'); return }
    if (!currentRef.current.title.trim()) { setError('Enter an experiment title'); return }
    busyRef.current = true; setBusy(run ? 'Saving and running…' : 'Saving…'); setError('')
    try {
      const saved = await persist()
      if (run) {
        const identity = `${saved.id}:${saved.updated_at}`
        if (pendingRun.current?.identity !== identity) pendingRun.current = { identity, key: experimentId() }
        const response = await request<{ result: Run }>(`/${saved.id}/runs`, { method: 'POST', headers: { 'Idempotency-Key': pendingRun.current!.key }, body: JSON.stringify({ expected_version: saved.updated_at }) })
        pendingRun.current = undefined
        if (mounted.current) { setCurrent({ ...saved, result: response.result }); setNotice(response.result.output.ok ? 'Execution finished' : 'Execution failed') }
      }
    } catch (failure) {
      if (failure instanceof ExperimentRequestError && failure.status === 410) pendingRun.current = undefined
      if (mounted.current) {
        if (failure instanceof ExperimentRequestError && failure.status === 409 && currentRef.current) {
          // A rejected run may refer to a saved revision another tab has already replaced.
          const recovered = remember(currentRef.current)
          setRecoveries(recoveryEntries()); setDirty(true); dirtyRef.current = true
          setNotice(recovered ? 'Version conflict · local recovery copy retained' : 'Version conflict · local recovery unavailable. Copy your edits before leaving.')
        }
        setError(`${String(failure)}. Your edits are still in the editor.`)
      }
    }
    finally { busyRef.current = false; if (mounted.current) setBusy('') }
  }
  const actions = useRef({ save: () => void act(false), run: () => void act(true) }); actions.current = { save: () => void act(false), run: () => void act(true) }
  const isSql = current?.type === 'sql'
  const extensions = useMemo(() => [
    ...(current?.type === 'go' ? [go(), syntaxHighlighting(notebookHighlightStyle)] : []),
    ...(isSql ? sqlExtensions : []),
    EditorView.contentAttributes.of({ 'aria-label': isSql ? 'SQL query' : 'Experiment source' }),
    keymap.of([
      { key: 'Mod-s', run: () => { actions.current.save(); return true } },
      ...(current?.type === 'shell' ? [] : [{ key: 'Mod-Enter', run: () => { actions.current.run(); return true } }]),
    ]),
  ], [current?.type, isSql])
  const isShell = current?.type === 'shell'
  const listedEntries = current && dirty && current.title.toLowerCase().includes(query.toLowerCase())
    ? [{ ...current, unsaved: true }, ...entries.filter(entry => entry.id !== current.id).map(entry => ({ ...entry, unsaved: false }))]
    : entries.map(entry => ({ ...entry, unsaved: false }))
  const result = current?.result
  const stale = !!current && !!result && JSON.stringify(snapshot(current)) !== JSON.stringify(result.snapshot)
  const mentorHref = current && result
    ? `/learning/mentor/?${new URLSearchParams({ experiment: current.id, version: result.finished_at })}`
    : null
  function restore() {
    if (!localDraft || !canLeave()) return
    const value = { ...localDraft, updated_at: current?.id === localDraft.id ? current.updated_at : localDraft.updated_at }
    setCurrent(value); currentRef.current = value; setDirty(true); dirtyRef.current = true; setLocalDraft(undefined); setNotice('Local recovery restored · save to keep it')
    const url = new URL(window.location.href); url.searchParams.set('experiment', value.id); window.history.replaceState({}, '', url)
  }
  return <section className="experiment-lab" aria-label="Lab experiments">
    <header className="experiment-launcher">
      <h1><FlaskConical size={16} aria-hidden="true" /> Lab</h1>
      <a className="experiment-type" href="/codelab/jupy" onClick={event => { if (!canLeave()) event.preventDefault() }}>
        <FileCode2 size={15} aria-hidden="true" /> Python Notebook
      </a>
      <div className="experiment-picker" ref={pickerRef}
        onBlur={event => { if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget)) setPickerOpen(false) }}
        onKeyDown={event => {
          if (event.key !== 'Escape' || !pickerOpen) return
          event.preventDefault()
          setPickerOpen(false)
          pickerButtonRef.current?.focus()
        }}>
        <button type="button" className="experiment-type experiment-new" ref={pickerButtonRef}
          aria-expanded={pickerOpen} aria-controls="experiment-types" disabled={!!busy}
          onClick={() => setPickerOpen(open => !open)}>
          <Plus size={16} aria-hidden="true" /> New experiment <ChevronDown size={14} aria-hidden="true" />
        </button>
        <div id="experiment-types" className="experiment-types" role="group" aria-label="Experiment type" hidden={!pickerOpen}>
          {kinds.map(kind => <button type="button" className="experiment-type" key={kind.id}
            aria-label={`New ${kind.title} experiment`} disabled={!!busy || kind.id === 'sql' && !setup}
            onClick={() => {
              create(kind.id)
              setPickerOpen(false)
              pickerButtonRef.current?.focus()
            }}>{kind.title}</button>)}
        </div>
      </div>
    </header>
    {localDraft && <div className="experiment-notice" role="status">A local recovery copy is available.<button onClick={restore} disabled={!!busy}>Restore local copy</button><button onClick={() => { forget(localDraft.id); setRecoveries(recoveryEntries()); setLocalDraft(undefined) }}>Dismiss recovery</button></div>}
    {!current && error && <div className="experiment-error" role="alert">{error}<button disabled={!!busy} onClick={() => { const id = new URLSearchParams(window.location.search).get('experiment'); if (id) void open(id) }}>Retry opening</button></div>}
    <div className="experiment-grid"><aside className="experiment-directory"><header><h2>Your experiments</h2><button aria-label="Refresh experiments" onClick={() => void loadCatalog()} disabled={loading}><RefreshCw size={16} /></button></header><label className="experiment-search"><Search size={16} /><input aria-label="Search experiments" placeholder="Find an experiment…" value={query} onChange={event => { setPage(0); setQuery(event.target.value) }} /></label>{loading ? <p role="status">Loading experiments…</p> : catalogError ? <div role="alert">{catalogError}<button onClick={() => void loadCatalog()}>Retry catalog</button></div> : !listedEntries.length ? <p>{query ? 'No matching experiments.' : 'No saved experiments.'}</p> : listedEntries.map(item => <button className={`experiment-entry${current?.id === item.id ? ' active' : ''}`} key={item.id} disabled={!!busy} onClick={() => { if (!item.unsaved || item.updated_at) void open(item.id) }}><span>{item.type === 'shell' ? 'SHELL' : item.type.toUpperCase()}</span><strong>{item.title}</strong><small>{item.unsaved ? 'Unsaved' : item.updated_at && new Date(item.updated_at).toLocaleString()}</small></button>)}{pageCount > 1 && <div className="experiment-pagination"><button disabled={loading || page === 0} onClick={() => setPage(value => value - 1)}>Previous</button><span>{page + 1} / {pageCount}</span><button disabled={loading || page + 1 >= pageCount} onClick={() => setPage(value => value + 1)}>Next</button></div>}{recoveries.length > 0 && <details className="experiment-recoveries"><summary>Local recovery copies ({recoveries.length})</summary>{recoveries.map(value => <button className="experiment-entry" key={value.id} disabled={!!busy} onClick={() => setLocalDraft(value)}><strong>{value.title}</strong><small>Review local copy</small></button>)}</details>}</aside>
    <section aria-label="Experiment workspace" className={`experiment-workspace${isSql ? ' experiment-workspace-sql' : isShell ? ' experiment-workspace-shell' : ''}`}>{!current ? <div className="experiment-empty"><p>Select <strong>New experiment</strong> or open a saved experiment.</p></div> : <>
      <header className="experiment-toolbar">
        <label className="experiment-title">
          <span>Experiment title</span>
          <textarea rows={isShell ? 1 : 2} value={current.title} disabled={!!busy} maxLength={300}
            onChange={event => edit({ title: event.target.value.replace(/\r?\n/g, ' ') })}
            onKeyDown={event => { if (event.key === 'Enter' && !event.nativeEvent.isComposing) event.preventDefault() }} />
        </label>
        <div className="experiment-workbar">
          <div className="experiment-state" role="status">
            <span>{busy || notice}</span>
            <span>{isSql ? 'SQLite · fresh database each run' : current.type === 'shell' ? 'Linux · Bash' : 'Go 1.26 · standard library'}</span>
          </div>
          <div className="experiment-actions">
            <button disabled={!!busy} onClick={() => void act(false)}><Save size={16} />Save</button>
            {!isSql && !isShell && <button className="experiment-run" disabled={!!busy || current.type === 'go' && !goAvailable} onClick={() => void act(true)}><Play size={16} />Run</button>}
          </div>
        </div>
      </header>
      {error && <div className="experiment-error" role="alert">{error}<button disabled={!!busy} onClick={() => void open(current.id)}>Reopen saved</button></div>}
      {current.type === 'go' && !goAvailable && <div className="experiment-notice">Go execution is unavailable. Editing and saving remain available.<button onClick={() => void refreshAvailability()} disabled={!!busy}>Recheck availability</button></div>}
      {isSql && <details className="experiment-setup" key={current.id}>
        <summary>Setup SQL</summary>
        <div className="experiment-source">
          <CodeMirror className="experiment-editor" value={current.setup} editable={!busy} extensions={setupExtensions}
            minHeight="96px" maxHeight="260px" onChange={value => edit({ setup: value })} />
        </div>
      </details>}
      {isShell ? <>
        <ShellTerminal key={current.id} createSessionId={experimentId} script={current.source} />
        <details className="experiment-shell-script">
          <summary>Script</summary>
          <div className="experiment-source">
            <CodeMirror value={current.source} editable={!busy} extensions={extensions}
              minHeight="96px" maxHeight="240px" onChange={source => edit({ source })} />
          </div>
        </details>
      </> : <>
      <div className="experiment-source">
        {isSql && <h2>SQL query</h2>}
        <CodeMirror className="experiment-editor" key={current.id} value={current.source} editable={!busy} extensions={extensions}
          height={isSql ? undefined : '320px'} minHeight={isSql ? '144px' : undefined} maxHeight={isSql ? '360px' : undefined} onChange={source => edit({ source })} />
      </div>
      {isSql ? <div className="experiment-query-actions">
        <button className="experiment-run" disabled={!!busy} onClick={() => void act(true)}><Play size={16} />Run query</button>
        <span>Ctrl / Cmd + Enter</span>
      </div> : <label className="experiment-field">Standard input<textarea aria-label="Experiment standard input" disabled={!!busy} value={current.stdin} onChange={event => edit({ stdin: event.target.value })} /></label>}
      <section className="experiment-output" aria-label={isSql ? 'Query results' : 'Experiment output'}><header><h2>{isSql ? 'Query results' : 'Output'}</h2>{result && <span className={result.output.ok ? 'success' : 'failure'}>{result.output.ok ? 'Finished' : result.output.timed_out ? 'Timed out' : 'Failed'} · {new Date(result.finished_at).toLocaleTimeString()}</span>}</header>{mentorHref && <p><a href={mentorHref} target="_blank" rel="noopener noreferrer">Ask Mentor about this saved run</a></p>}{stale && <p className="experiment-notice">These results belong to an earlier code or input snapshot. Run again to update.</p>}{!result ? <p>{isSql ? 'Run the query to see its results here.' : 'Run to inspect the result.'}</p> : <>{result.output.stdout && <pre>{result.output.stdout}</pre>}{result.output.stderr && <pre className="failure">{result.output.stderr}</pre>}{result.output.error && <p className="failure">{result.output.error.type}: {result.output.error.message}</p>}{result.output.tables?.map((table, index) => <div className="experiment-table" key={index}><table><thead><tr>{table.columns.map((name, column) => <th key={column}>{name}</th>)}</tr></thead><tbody>{table.rows.map((row, index) => <tr key={index}>{row.map((value, column) => <td key={column}>{value === null ? <em>NULL</em> : String(value)}</td>)}</tr>)}</tbody></table><p>{table.rows.length} {table.rows.length === 1 ? 'row' : 'rows'}{table.truncated ? ' · limited to first 200 rows' : ''}</p></div>)}{result.output.ok && !result.output.stdout && !result.output.tables?.length && <p>{isSql ? 'Query finished without returning a result table.' : 'Finished with no output.'}</p>}</>}</section>
      </>}
      <label className="experiment-field">Experiment observations<textarea aria-label="Experiment observations" disabled={!!busy} placeholder="What did you change, predict, or observe?" value={current.explanation} onChange={event => edit({ explanation: event.target.value })} /></label><footer className="experiment-footer"><a href="/writing/notes/" target="_blank" rel="noopener noreferrer">Open Notes separately ↗</a><span>{isShell ? 'Ctrl+C interrupts · ↑ recalls commands' : 'Ctrl / Cmd + S saves · Ctrl / Cmd + Enter runs'}</span></footer>
    </>}</section></div>
  </section>
}
