import LessonContext from './LessonContext'
import { apiErrorMessage } from './httpErrors'
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent } from 'react'
import OJCodeEditor from './OJCodeEditor'
import OJLanguageMenu from './OJLanguageMenu'
import SubmissionReview from './SubmissionReview'
import OJFeedback, { resultLabel, type ExecutionResult, type ExecutionSnapshot } from './OJFeedback'
import { categorySelection, filterCodingProblems, sameDraft } from './codingState'
import { Check, ChevronLeft, ChevronRight, CircleAlert, ChevronDown, ChevronUp, ArrowLeft, ListFilter, LoaderCircle, PanelLeftClose, PanelLeftOpen, Play, RotateCcw, Save } from 'lucide-react'

type ProblemSummary = {
  index: number
  slug: string
  title: string
  difficulty: string
  category: string
  collection_name: string
  progress: string
}

type Example = { name: string; stdin: string; stdout: string; reason: string }

type ProblemDetail = ProblemSummary & {
  summary: string
  practice_url?: string
  source: string
  draft_source?: string | null
  draft_updated_at?: string | null
  format: string
  examples: Example[]
}

type SubmissionSummary = {
  id: number
  language?: 'python' | 'go'
  verdict: 'accepted' | 'failed'
  passed: number
  total: number
  first_failure?: { case?: number } | null
  created_at: string
}

const CODING_API_URL = `${(import.meta.env.VITE_CODELAB_API_URL || '/api/codelab').replace(/\/$/, '')}/coding`
const PROBLEMS_PER_PAGE = 25

function idempotencyKey(operation: string): string {
  return globalThis.crypto?.randomUUID?.() || `${operation}-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const headers = new Headers(options.headers)
  if (options.body) headers.set('Content-Type', 'application/json')
  let response: Response
  try {
    response = await fetch(`${CODING_API_URL}${path}`, { ...options, signal: options.signal || AbortSignal.timeout(60_000), headers })
  } catch {
    throw new Error('OJ service is unavailable. Check the configured Codelab API and try again.')
  }
  const body = (await response.json().catch(() => ({}))) as { detail?: string; error?: string }
  if (!response.ok) throw new Error(apiErrorMessage({ detail: body.detail ?? body.error }, response.status))
  return body as T
}

export default function ACMCampWorkspace({ query: externalQuery, onQueryChange, onBackToMap, onNavigationGuardChange }: { query?: string; onQueryChange?: (query: string) => void; onBackToMap?: () => void; onNavigationGuardChange?: (guard: () => boolean) => void }) {
  const [problems, setProblems] = useState<ProblemSummary[]>([])
  const [requestedIndex] = useState(() => {
    const match = window.location.pathname.match(/\/oj\/problem\/(\d+)\/?$/)
    return match ? Number(match[1]) : undefined
  })
  const [selectedIndex, setSelectedIndex] = useState<number>(-1)
  const [problem, setProblem] = useState<ProblemDetail>()
  const [source, setSource] = useState('')
  const [language, setLanguage] = useState<'python' | 'go'>(() => new URLSearchParams(window.location.search).get('language') === 'go' ? 'go' : 'python')
  const [goAvailable, setGoAvailable] = useState(false)
  const [languageError, setLanguageError] = useState('')
  const [switchError, setSwitchError] = useState('')
  const [stdin, setStdin] = useState('')
  const [localQuery, setLocalQuery] = useState('')
  const [difficulty, setDifficulty] = useState('')
  const [categories, setCategories] = useState(() => categorySelection(new URLSearchParams(window.location.search).get('categories')))
  const [progressFilter, setProgressFilter] = useState('')
  const [catalogRevision, setCatalogRevision] = useState(0)
  const [problemRevision, setProblemRevision] = useState(0)
  const [draftSaving, setDraftSaving] = useState(false)
  const [draftSaveError, setDraftSaveError] = useState('')
  const [historyBefore, setHistoryBefore] = useState<number>()
  const [historyNext, setHistoryNext] = useState<number | null>(null)
  const [loading, setLoading] = useState(true)
  const [problemLoading, setProblemLoading] = useState(false)
  const [busy, setBusy] = useState<'run' | 'submit' | ''>('')
  const [draftDirty, setDraftDirty] = useState(false)
  const [draftState, setDraftState] = useState('')
  const [message, setMessage] = useState('Select a problem to start.')
  const [result, setResult] = useState<ExecutionResult>()
  const [submissions, setSubmissions] = useState<SubmissionSummary[]>([])
  const [historyLoading, setHistoryLoading] = useState(false)
  const [historyError, setHistoryError] = useState('')
  const [historyRevision, setHistoryRevision] = useState(0)
  const [reviewSubmissionId, setReviewSubmissionId] = useState<number>()
  const [error, setError] = useState('')
  const [retryTarget, setRetryTarget] = useState<'catalog' | 'problem' | 'run' | 'submit'>('catalog')
  const [problemListCollapsed, setProblemListCollapsed] = useState(true)
  const [detailsWidth, setDetailsWidth] = useState<number>()
  const [resizing, setResizing] = useState(false)
  const [feedbackTab, setFeedbackTab] = useState<'input' | 'result' | 'history'>('input')
  const [resultSnapshot, setResultSnapshot] = useState<ExecutionSnapshot>()
  const [actionError, setActionError] = useState('')
  const [phase, setPhase] = useState('')
  const [feedbackHeight, setFeedbackHeight] = useState(280)
  const [feedbackOpen, setFeedbackOpen] = useState(false)
  const feedbackDrag = useRef<{ y: number; height: number } | undefined>(undefined)
  const [currentPage, setCurrentPage] = useState(0)
  const [cursorPosition, setCursorPosition] = useState({ line: 1, column: 1 })
  const workspaceRef = useRef<HTMLElement>(null)
  const actionGenerationRef = useRef(0)
  const saveInFlight = useRef(false)
  const executionInFlight = useRef(false)
  const languageSwitchInFlight = useRef(false)
  const currentDraft = useRef({ index: selectedIndex, source, language })
  currentDraft.current = { index: selectedIndex, source, language }
  const failedDraft = useRef<{ index: number; source: string; language: 'python' | 'go' } | undefined>(undefined)
  const pendingDraft = useRef<{ index: number; source: string; language: 'python' | 'go'; key: string } | undefined>(undefined)
  const pendingAction = useRef<{ body: string; key: string; submit: boolean } | undefined>(undefined)
  useEffect(() => {
    let active = true
    setGoAvailable(false)
    void request<{language:string;profile:string;available:boolean}[]>('/languages').then(profiles => { if (active) { setGoAvailable(profiles.some(p => p.language === 'go' && p.available)); setLanguageError('') } }).catch(() => { if (active) setLanguageError('Language availability could not be read. Go execution is disabled; retry the catalog.') })
    return () => { active = false }
  }, [catalogRevision])
  useEffect(() => () => { actionGenerationRef.current += 1 }, [])
  const query = externalQuery ?? localQuery
  const setQuery = onQueryChange ?? setLocalQuery

  const filteredProblems = useMemo(() => filterCodingProblems(problems, query, difficulty, categories, progressFilter), [categories, difficulty, problems, progressFilter, query])

  const pageCount = Math.max(1, Math.ceil(filteredProblems.length / PROBLEMS_PER_PAGE))
  const visibleProblems = filteredProblems.slice(currentPage * PROBLEMS_PER_PAGE, (currentPage + 1) * PROBLEMS_PER_PAGE)
  const selectedPosition = filteredProblems.findIndex((item) => item.index === selectedIndex)

  useEffect(() => { setCurrentPage((page) => Math.min(page, pageCount - 1)) }, [pageCount])
  useEffect(() => {
    const position = filteredProblems.findIndex((item) => item.index === selectedIndex)
    if (position >= 0) setCurrentPage(Math.floor(position / PROBLEMS_PER_PAGE))
  }, [selectedIndex])

  const selectProblem = (index: number) => {
    if (index === selectedIndex || problemLoading) return
    if (languageSwitchInFlight.current || saveInFlight.current || executionInFlight.current) { setMessage('Wait for the current save or execution to finish.'); return }
    if (draftDirty && !window.confirm('This draft is not saved yet. Discard it and switch problems?')) return
    const filteredIndex = filteredProblems.findIndex((item) => item.index === index)
    if (filteredIndex >= 0) setCurrentPage(Math.floor(filteredIndex / PROBLEMS_PER_PAGE))
    setSelectedIndex(index)
    setProblemListCollapsed(true)
    const url = new URL(window.location.href)
    url.pathname = `/codelab/oj/problem/${index}`
    window.history.replaceState({}, '', url)
  }

  const moveProblem = (offset: number) => {
    if (selectedIndex < 0) return
    const index = filteredProblems.findIndex((item) => item.index === selectedIndex)
    const next = filteredProblems[index + offset]
    if (next) selectProblem(next.index)
  }

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError('')
    void request<ProblemSummary[]>('/problems')
      .then((items) => {
        if (cancelled) return
        setProblems(items)
        if (requestedIndex !== undefined && !items.some((item) => item.index === requestedIndex)) {
          setSelectedIndex(-1)
          setError('This problem is not in the current catalog. Choose a problem from the list.')
          return
        }
        const scoped = filterCodingProblems(items, '', '', categories, '')
        setSelectedIndex((current) => items.some((item) => item.index === current) ? current : requestedIndex ?? scoped[0]?.index ?? -1)
      })
      .catch((loadError) => { if (!cancelled) { setRetryTarget('catalog'); setError(loadError instanceof Error ? loadError.message : 'Unable to load OJ') } })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [catalogRevision])

  useEffect(() => {
    if (selectedIndex < 0) return
    actionGenerationRef.current += 1
    setBusy('')
    let cancelled = false
    setProblemLoading(true)
    setProblem(undefined)
    setSource('')
    setDraftDirty(false)
    setDraftSaveError('')
    failedDraft.current = undefined
    setError('')
    setSwitchError('')
    setResult(undefined)
    setResultSnapshot(undefined)
    setActionError('')
    pendingAction.current = undefined
    setFeedbackTab('input')
    void request<ProblemDetail>(`/problems/${selectedIndex}${language === 'go' ? '?language=go' : ''}`)
      .then((loaded) => {
        if (cancelled) return
        setProblem(loaded)
        setSource(loaded.draft_source ?? loaded.source)
        setCursorPosition({ line: 1, column: 1 })
        setStdin(loaded.examples[0]?.stdin || '')
        setDraftDirty(false)
        setDraftState(loaded.draft_source !== null && loaded.draft_source !== undefined ? 'Saved draft restored' : 'Catalog code')
        setMessage('Ready')
      })
      .catch((loadError) => { if (!cancelled) { setRetryTarget('problem'); setError(loadError instanceof Error ? loadError.message : 'Unable to load problem') } })
      .finally(() => { if (!cancelled) setProblemLoading(false) })
    return () => { cancelled = true }
  }, [problemRevision, selectedIndex])

  useEffect(() => { setHistoryBefore(undefined); setHistoryNext(null); setReviewSubmissionId(undefined) }, [selectedIndex])

  useEffect(() => {
    if (selectedIndex < 0) {
      setSubmissions([])
      return
    }
    let cancelled = false
    setHistoryLoading(true)
    setHistoryError('')
    void request<{ items: SubmissionSummary[]; next_before_id: number | null }>(`/problems/${selectedIndex}/submissions${historyBefore ? `?before_id=${historyBefore}` : ""}`)
      .then(({ items, next_before_id }) => {
        if (!cancelled) { setSubmissions(items); setHistoryNext(next_before_id) }
      })
      .catch((loadError) => {
        if (!cancelled) {
          setSubmissions([])
          setHistoryError(loadError instanceof Error ? loadError.message : 'Unable to load submission history')
        }
      })
      .finally(() => { if (!cancelled) setHistoryLoading(false) })
    return () => { cancelled = true }
  }, [historyBefore, historyRevision, selectedIndex])

  useEffect(() => {
    if (!draftDirty && !draftSaving && !busy && !problemLoading) return
    const protectDraft = (event: BeforeUnloadEvent) => {
      event.preventDefault()
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', protectDraft)
    return () => window.removeEventListener('beforeunload', protectDraft)
  }, [busy, draftDirty, draftSaving, problemLoading])

  const saveDraft = useCallback(async (snapshotSource = source): Promise<boolean> => {
    if (!problem || problemLoading || saveInFlight.current) return false
    const generation = actionGenerationRef.current
    const snapshot = { index: problem.index, source: snapshotSource, language }
    if (!pendingDraft.current || !sameDraft(pendingDraft.current, snapshot)) pendingDraft.current = { ...snapshot, key: idempotencyKey('draft') }
    saveInFlight.current = true
    setDraftSaving(true)
    setDraftSaveError('')
    setDraftState('Saving draft...')
    try {
      const { updated_at } = await request<{ updated_at: string }>(`/drafts/${snapshot.index}${snapshot.language === 'go' ? '?language=go' : ''}`, {
        method: 'PUT', headers: { 'Idempotency-Key': pendingDraft.current.key }, body: JSON.stringify({ source: snapshot.source, language: snapshot.language }),
      })
      if (generation !== actionGenerationRef.current) return false
      const readBack = await request<{ source: string; updated_at: string; language?: string } | null>(`/drafts/${snapshot.index}${snapshot.language === 'go' ? '?language=go' : ''}`)
      if (generation !== actionGenerationRef.current) return false
      if (!readBack || readBack.source !== snapshot.source || readBack.updated_at !== updated_at || (readBack.language || 'python') !== snapshot.language) throw new Error('Draft read-back did not match. Your edits are retained; retry saving.')
      failedDraft.current = undefined
      pendingDraft.current = undefined
      const unchanged = sameDraft(snapshot, currentDraft.current)
      setDraftDirty(!unchanged)
      setDraftState(unchanged ? 'All changes saved' : 'Newer edits pending')
      return true
    } catch (saveError) {
      if (generation !== actionGenerationRef.current) return false
      failedDraft.current = snapshot
      const detail = saveError instanceof Error ? saveError.message : 'Unable to save draft'
      setDraftSaveError(detail)
      setDraftState('Draft save failed; edits are kept')
      return false
    } finally {
      saveInFlight.current = false
      setDraftSaving(false)
    }
  }, [problem, problemLoading, source, language])

  useEffect(() => {
    if (!problem || problemLoading || !draftDirty || draftSaving || busy || (failedDraft.current && sameDraft(failedDraft.current, { index: problem.index, source, language }))) return
    const timer = window.setTimeout(() => { void saveDraft() }, 600)
    return () => window.clearTimeout(timer)
  }, [busy, draftDirty, draftSaving, problem, problemLoading, saveDraft, source, language])

  const execute = async (submit: boolean, retry = false) => {
    if (!problem || problemLoading || languageSwitchInFlight.current || saveInFlight.current || executionInFlight.current) return
    setFeedbackOpen(true)
    if (language === 'go' && !goAvailable) { setActionError('Go compiler is unavailable; your code is retained.'); return }
    const actionGeneration = actionGenerationRef.current
    const selectedProblem = problem
    const previous = pendingAction.current
    const retrying = retry && previous?.submit === submit
    const body = retrying ? previous.body : JSON.stringify({ problem_index: selectedProblem.index, problem_slug: selectedProblem.slug, source, language, ...(submit ? {} : { stdin }) })
    const captured = JSON.parse(body) as { source: string; stdin?: string; language: 'python' | 'go' }
    const action = retrying ? previous : { body, submit, key: idempotencyKey(submit ? 'submission' : 'run') }
    pendingAction.current = action
    executionInFlight.current = true
    setBusy(submit ? 'submit' : 'run')
    setFeedbackTab('result')
    setResult(undefined)
    setResultSnapshot(undefined)
    setActionError('')
    setPhase(submit ? 'Saving submission snapshot…' : 'Running your input…')
    setMessage(submit ? 'Preparing submission' : 'Running')
    setError('')
    const started = performance.now()
    try {
      if (submit && !await saveDraft(captured.source)) throw new Error('Save the submission snapshot successfully before judging. Your local edits are retained.')
      if (actionGeneration !== actionGenerationRef.current) return
      setPhase(language === 'go' ? submit ? 'Compiling Go and judging fixed cases…' : 'Compiling Go and running your input…' : submit ? 'Judging fixed test cases…' : 'Running your input…')
      const response = await request<{ result: ExecutionResult; submission_id?: number }>(submit ? '/submissions' : '/runs', {
        method: 'POST', headers: { 'Idempotency-Key': action.key }, body: action.body,
      })
      if (actionGeneration !== actionGenerationRef.current) return
      pendingAction.current = undefined
      setResult(response.result)
      setResultSnapshot({ source: captured.source, stdin: captured.stdin || '', submit, elapsed: performance.now() - started, language: captured.language, submissionId: submit && Number.isSafeInteger(response.submission_id) && response.submission_id! > 0 ? response.submission_id : undefined })
      setMessage(resultLabel(response.result))
      if (submit) {
        setHistoryBefore(undefined)
        setHistoryRevision((value) => value + 1)
        try {
          const refreshed = await request<ProblemSummary[]>('/problems')
          if (actionGeneration === actionGenerationRef.current) setProblems(refreshed)
        } catch {
          setRetryTarget('catalog')
          setError('Submission was recorded. Reload the catalog to refresh progress.')
        }
      }
    } catch (runError) {
      if (actionGeneration !== actionGenerationRef.current) return
      setRetryTarget(submit ? 'submit' : 'run')
      setActionError(runError instanceof Error ? runError.message : 'OJ action failed')
      setMessage('Action failed · snapshot retained for retry')
    } finally {
      executionInFlight.current = false
      if (actionGeneration === actionGenerationRef.current) setBusy('')
    }
  }

  const switchLanguage = async (next: 'python' | 'go') => {
    if (!problem || next === language || problemLoading || languageSwitchInFlight.current || saveInFlight.current || executionInFlight.current) return
    if (pendingAction.current && !window.confirm('Switch language and discard the unfinished execution retry? Your saved code is retained.')) return
    const captured = { ...currentDraft.current }
    const generation = actionGenerationRef.current
    languageSwitchInFlight.current = true
    setProblemLoading(true)
    setSwitchError('')
    try {
      if (draftDirty && !await saveDraft()) return
      if (generation !== actionGenerationRef.current) return
      if (!sameDraft(captured, currentDraft.current)) { setMessage('Newer edits retained; save before switching languages.'); return }
      const loaded = await request<ProblemDetail>(`/problems/${problem.index}${next === 'go' ? '?language=go' : ''}`)
      if (generation !== actionGenerationRef.current) return
      if (!sameDraft(captured, currentDraft.current)) { setMessage('Newer edits retained; save before switching languages.'); return }
      // Commit the target draft atomically; keep the reader and custom input mounted.
      setLanguage(next)
      setProblem(loaded)
      setSource(loaded.draft_source ?? loaded.source)
      setCursorPosition({ line: 1, column: 1 })
      setDraftDirty(false)
      setDraftSaveError('')
      failedDraft.current = undefined
      pendingDraft.current = undefined
      setDraftState(loaded.draft_source != null ? 'Saved draft restored' : 'Catalog code')
      setResult(undefined)
      setResultSnapshot(undefined)
      setActionError('')
      pendingAction.current = undefined
      setFeedbackTab('input')
      setMessage('Ready')
      const url = new URL(window.location.href)
      url.searchParams.set('language', next)
      window.history.replaceState({}, '', url)
    } catch (loadError) {
      if (generation === actionGenerationRef.current) setSwitchError(`Could not switch to ${next === 'go' ? 'Go' : 'Python'}. ${loadError instanceof Error ? loadError.message : 'Unable to load draft'}. Your current language and code are retained. Choose the language again to retry.`)
    } finally {
      languageSwitchInFlight.current = false
      if (generation === actionGenerationRef.current) setProblemLoading(false)
    }
  }

  const editorActions = useRef({ save: () => { void saveDraft() }, run: () => { void execute(false) }, submit: () => { void execute(true) } })
  editorActions.current = { save: () => { if (!languageSwitchInFlight.current && !executionInFlight.current) void saveDraft() }, run: () => { void execute(false) }, submit: () => { void execute(true) } }
  const editorSave = useCallback(() => editorActions.current.save(), [])
  const editorRun = useCallback(() => editorActions.current.run(), [])
  const editorSubmit = useCallback(() => editorActions.current.submit(), [])
  const editSource = useCallback((value: string) => { setSource(value); setDraftDirty(true); setDraftState('Unsaved changes') }, [])
  const canLeave = useCallback(() => {
    if (languageSwitchInFlight.current || saveInFlight.current || executionInFlight.current) { setMessage('Wait for the current save or execution to finish.'); return false }
    return !draftDirty || window.confirm('This draft is not saved yet. Discard it and leave the problem?')
  }, [draftDirty])
  useEffect(() => {
    onNavigationGuardChange?.(canLeave)
    return () => onNavigationGuardChange?.(() => true)
  }, [canLeave, onNavigationGuardChange])

  const descriptionMaximum = () => {
    const width = workspaceRef.current?.clientWidth || 1200
    return Math.max(280, width - 360)
  }
  useEffect(() => {
    const workspace = workspaceRef.current
    if (!workspace) return
    const observer = new ResizeObserver(() => setDetailsWidth((width) => width === undefined ? width : Math.min(width, Math.max(280, workspace.clientWidth - 360))))
    observer.observe(workspace)
    return () => observer.disconnect()
  }, [problemListCollapsed])

  const resizeDetails = (event: PointerEvent<HTMLDivElement>) => {
    if (!resizing || !workspaceRef.current) return
    const bounds = workspaceRef.current.getBoundingClientRect()
    const nextWidth = Math.min(Math.max(event.clientX - bounds.left - 8, 280), Math.max(280, bounds.width - 360))
    setDetailsWidth(nextWidth)
  }

  const workspaceStyle = {
    '--acm-details-width': detailsWidth ? `${detailsWidth}px` : 'minmax(280px, 38%)',
    '--acm-sidebar-width': '0px',
    '--oj-feedback-height': `${feedbackHeight}px`,
  } as CSSProperties

  useEffect(() => {
    if (problemListCollapsed) return
    const directory = document.getElementById('oj-problem-directory')
    directory?.querySelector<HTMLInputElement>('input')?.focus()
    const close = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); setProblemListCollapsed(true); document.getElementById('oj-directory-toggle')?.focus() }
      if (event.key === 'Tab') {
        const controls = [...(directory?.querySelectorAll<HTMLElement>('button:not(:disabled), input, select') || [])]
        const first = controls[0], last = controls.at(-1)
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
      }
    }
    window.addEventListener('keydown', close)
    return () => window.removeEventListener('keydown', close)
  }, [problemListCollapsed])

  return (
    <section ref={workspaceRef} className={`acm-workspace oj-workspace ${resizing ? 'is-resizing' : ''}`} style={workspaceStyle} aria-label="OJ workspace">
      <header className="oj-workspace-header">
        <a className="typing-brand" href="/" onClick={event => { if (!event.metaKey && !event.ctrlKey && !canLeave()) event.preventDefault() }}>CodeOS</a>
        <button id="oj-directory-toggle" className="typing-directory-toggle" aria-label="Toggle problem list" aria-expanded={!problemListCollapsed} aria-controls="oj-problem-directory" onClick={() => setProblemListCollapsed(value => !value)}><PanelLeftOpen size={16} /><span>Problems</span></button>
        <a className="oj-map-link" href="/codelab/" onClick={(event) => { if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return; if (onBackToMap) { event.preventDefault(); onBackToMap() } else if (!canLeave()) event.preventDefault() }}><ArrowLeft size={16} />Practice map</a>
        <div className="oj-current-problem"><strong>{problem ? `${String(problem.index).padStart(3, '0')} · ${problem.title}` : problemLoading ? 'Loading problem…' : 'OJ workspace'}</strong>{problem && <span className={`oj-difficulty ${problem.difficulty.toLowerCase()}`}>{problem.difficulty}</span>}</div>
        <LessonContext canLeave={canLeave} /><div className="acm-header-actions"><button className="acm-icon-button" type="button" title="Previous problem" aria-label="Previous problem" disabled={!problem || problemLoading || selectedPosition <= 0 || !!busy || draftSaving} onClick={() => moveProblem(-1)}><ChevronLeft size={18} /></button><button className="acm-icon-button" type="button" title="Next problem" aria-label="Next problem" disabled={!problem || problemLoading || selectedPosition < 0 || selectedPosition >= filteredProblems.length - 1 || !!busy || draftSaving} onClick={() => moveProblem(1)}><ChevronRight size={18} /></button></div>
      </header>
      {!problemListCollapsed && <button className="oj-directory-backdrop" aria-label="Close problem list" onClick={() => { setProblemListCollapsed(true); document.getElementById('oj-directory-toggle')?.focus() }} />}
      <aside role="dialog" aria-modal="true" aria-label="Problem list" hidden={problemListCollapsed} id="oj-problem-directory" className={`acm-problem-sidebar ${problemListCollapsed ? 'collapsed' : ''}`}>
        <div className="acm-sidebar-header"><div><strong>Problem list</strong><span>{filteredProblems.length} of {problems.length} problems</span></div><button className="acm-sidebar-toggle" type="button" title={problemListCollapsed ? 'Expand problem list' : 'Collapse problem list'} aria-label={problemListCollapsed ? 'Expand problem list' : 'Collapse problem list'} aria-expanded={!problemListCollapsed} onClick={() => { setProblemListCollapsed(true); document.getElementById('oj-directory-toggle')?.focus() }}>{problemListCollapsed ? <PanelLeftOpen size={18} /> : <PanelLeftClose size={18} />}</button></div>
        <div className="acm-filters">
          <input value={query} onChange={(event) => { setCurrentPage(0); setQuery(event.target.value) }} placeholder="Search title or topic" aria-label="Search OJ problems" />
          <select value={categories.length === 1 ? categories[0] : categories.length ? '__topic' : ''} onChange={(event) => { if (event.target.value === '__topic') return; setCurrentPage(0); setCategories(event.target.value ? [event.target.value] : []); const url = new URL(window.location.href); if (event.target.value) url.searchParams.set('categories', JSON.stringify([event.target.value])); else url.searchParams.delete('categories'); window.history.replaceState({}, '', url) }} aria-label="Filter by category"><option value="">All topics</option>{categories.length > 1 && <option value="__topic">Selected roadmap topic</option>}{[...new Set(problems.map((item) => item.category))].sort().map((category) => <option key={category}>{category}</option>)}</select>
          <div className="oj-filter-pair"><select value={difficulty} onChange={(event) => { setCurrentPage(0); setDifficulty(event.target.value) }} aria-label="Filter by difficulty"><option value="">All levels</option><option value="Easy">Easy</option><option value="Medium">Medium</option><option value="Hard">Hard</option></select><select value={progressFilter} onChange={(event) => { setCurrentPage(0); setProgressFilter(event.target.value) }} aria-label="Filter by progress"><option value="">All progress</option><option value="unresolved">Not accepted</option><option value="accepted">Accepted</option><option value="todo">Not started</option><option value="failed">Attempted</option></select></div>
        </div>
        <div className="acm-problem-list">
          {loading && <div className="acm-empty">Loading problems…</div>}
          {!loading && visibleProblems.map((item) => <button className={`acm-problem-item ${item.index === selectedIndex ? 'active' : ''}`} type="button" key={item.index} onClick={() => selectProblem(item.index)} aria-current={item.index === selectedIndex ? 'page' : undefined}><span className="acm-problem-number">{String(item.index).padStart(3, '0')}</span><span className="oj-problem-row-copy"><span className="acm-problem-title">{item.title}</span><small><span className={`oj-difficulty ${item.difficulty.toLowerCase()}`}>{item.difficulty}</span> · {item.progress === 'accepted' ? 'Accepted' : item.progress === 'todo' ? 'Not started' : 'Attempted'}</small></span>{item.progress === 'accepted' ? <Check size={15} /> : <span className={`acm-progress-dot ${item.progress}`} />}</button>)}
          {!loading && !error && filteredProblems.length === 0 && <div className="acm-empty"><ListFilter size={22} /><span>{problems.length ? 'No matching problems. Adjust your filters.' : 'The problem catalog is empty.'}</span></div>}
        </div>
        {!loading && filteredProblems.length > 0 && <div className="acm-pagination"><button className="acm-icon-button" type="button" aria-label="Previous problem page" onClick={() => setCurrentPage((page) => Math.max(0, page - 1))} disabled={currentPage === 0}><ChevronLeft size={14} /></button><span>{currentPage + 1} / {pageCount}</span><button className="acm-icon-button" type="button" aria-label="Next problem page" onClick={() => setCurrentPage((page) => Math.min(pageCount - 1, page + 1))} disabled={currentPage >= pageCount - 1}><ChevronRight size={14} /></button></div>}
      </aside>
      <section className="oj-description-column" aria-label="Problem description">
        <header className="oj-section-header"><strong>Description</strong>{problem && <span>{problem.category}</span>}</header>
        <div className="oj-description-scroll">
          {error && <div className="acm-error" role="alert"><CircleAlert size={16} /><span>{error}</span><button type="button" disabled={!!busy || draftSaving} onClick={() => { if (retryTarget === 'problem') setProblemRevision((value) => value + 1); else setCatalogRevision((value) => value + 1) }}>Retry</button></div>}
          {problemLoading && !problem ? <div className="acm-empty"><LoaderCircle className="oj-spinner" size={24} />Loading description…</div> : problem ? <>
            <div className="oj-problem-intro"><p>{problem.collection_name}</p><h1>{problem.title}</h1><div><span className={`oj-difficulty ${problem.difficulty.toLowerCase()}`}>{problem.difficulty}</span><span>{problems.find((item) => item.index === selectedIndex)?.progress === 'accepted' ? 'Accepted' : 'ACM · standard input / output'}</span></div></div>
            <section className="acm-detail-section"><h2>Problem</h2><p>{problem.summary}</p>{problem.practice_url && <a href={problem.practice_url} target="_blank" rel="noreferrer">Reference problem <ChevronRight size={13} /></a>}</section>
            <section className="acm-detail-section"><h2>Input / Output</h2><pre>{problem.format}</pre></section>
            {problem.examples.map((example, index) => <section className="acm-detail-section oj-example" key={example.name}><h2>Example {index + 1}</h2><div><strong>Input</strong><pre>{example.stdin}</pre><strong>Output</strong><pre>{example.stdout}</pre></div>{example.reason && <p>{example.reason}</p>}<button type="button" disabled={!!busy} onClick={() => { setStdin(example.stdin); setFeedbackOpen(true); setFeedbackTab('input') }}>Use this input</button></section>)}
          </> : <div className="acm-empty">Choose a problem from the list to start.</div>}
        </div>
      </section>
      <div className="acm-resize-handle" role="separator" tabIndex={0} aria-label="Resize problem description and editor" aria-orientation="vertical" aria-valuemin={280} aria-valuemax={descriptionMaximum()} aria-valuenow={Math.round(detailsWidth || 400)} onKeyDown={(event) => { if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); const maximum = descriptionMaximum(); setDetailsWidth((current) => Math.min(maximum, Math.max(280, (current || 400) + (event.key === 'ArrowLeft' ? -20 : 20)))) } }} onPointerDown={(event) => { event.currentTarget.setPointerCapture(event.pointerId); setResizing(true) }} onPointerMove={resizeDetails} onPointerUp={(event) => { event.currentTarget.releasePointerCapture(event.pointerId); setResizing(false) }} onPointerCancel={() => setResizing(false)} />
      <section className="acm-editor-column" aria-label="Code and execution">
        <div className="oj-code-surface"><header className="oj-code-header"><OJLanguageMenu value={language} disabled={problemLoading || draftSaving || !!busy} onChange={next => void switchLanguage(next)} /><div><button type="button" title="Save draft · Ctrl/Cmd+S" onClick={editorSave} disabled={!problem || problemLoading || draftSaving || !!busy}><Save size={15} />{draftSaving ? 'Saving…' : 'Save'}</button><button className="oj-run" type="button" title="Run · Ctrl/Cmd+Enter" onClick={editorRun} disabled={!problem || problemLoading || draftSaving || !!busy || language === 'go' && !goAvailable}>{busy === 'run' ? <LoaderCircle className="oj-spinner" size={15} /> : <Play size={15} />}Run</button><button className="oj-submit" type="button" title="Submit · Shift+Ctrl/Cmd+Enter" onClick={editorSubmit} disabled={!problem || problemLoading || draftSaving || !!busy || language === 'go' && !goAvailable}>{busy === 'submit' ? <LoaderCircle className="oj-spinner" size={15} /> : <Check size={15} />}Submit</button></div></header>
        {draftSaveError && <div className="acm-error" role="alert"><span>{draftSaveError}</span><button type="button" onClick={() => void saveDraft()} disabled={draftSaving || !!busy}>Retry draft save</button></div>}
        {switchError && <div className="acm-error" role="alert"><span>{switchError}</span></div>}{languageError && <p role="alert">{languageError}</p>}{language === 'go' && <p className="oj-language-note">{goAvailable ? 'Go 1.26 · standard library only · compiled before running' : 'Go compiler unavailable · draft editing and saving remain available'}</p>}<div className="acm-code-editor"><div className="acm-code-editor-frame"><OJCodeEditor language={language} source={source} disabled={!problem || problemLoading} onChange={editSource} onCursor={setCursorPosition} onSave={editorSave} onRun={editorRun} onSubmit={editorSubmit} /><div className="acm-code-statusbar"><span>Ln {cursorPosition.line}, Col {cursorPosition.column}</span><span>{language === 'go' ? 'Tabs: 4' : 'Spaces: 4'}</span><span className={draftDirty || draftSaveError ? 'oj-unsaved' : ''} role="status">{problemLoading && problem ? 'Switching language…' : draftState || 'No draft loaded'}</span><button type="button" title="Restore catalog code" onClick={() => { if (problem && source !== problem.source && window.confirm('Replace your current code with the catalog version? This change is not saved until you save it.')) editSource(problem.source) }} disabled={!problem || problemLoading || !!busy || draftSaving}><RotateCcw size={13} />Reset code</button></div></div></div>
        </div>
        {feedbackOpen && <div className="oj-feedback-resizer" role="separator" tabIndex={0} aria-label="Resize code and feedback" aria-orientation="horizontal" aria-valuemin={180} aria-valuemax={Math.max(180, (workspaceRef.current?.clientHeight || 800) * 0.6)} aria-valuenow={feedbackHeight} onKeyDown={(event) => { if (event.key === 'ArrowUp' || event.key === 'ArrowDown') { event.preventDefault(); setFeedbackHeight((height) => Math.max(180, Math.min((workspaceRef.current?.clientHeight || 800) * 0.6, height + (event.key === 'ArrowUp' ? 20 : -20)))) } }} onPointerDown={(event) => { event.currentTarget.setPointerCapture(event.pointerId); feedbackDrag.current = { y: event.clientY, height: feedbackHeight } }} onPointerMove={(event) => { if (feedbackDrag.current) setFeedbackHeight(Math.max(180, Math.min((workspaceRef.current?.clientHeight || 800) * 0.6, feedbackDrag.current.height + feedbackDrag.current.y - event.clientY))) }} onPointerUp={(event) => { event.currentTarget.releasePointerCapture(event.pointerId); feedbackDrag.current = undefined }} onPointerCancel={() => { feedbackDrag.current = undefined }} />}
        <section className={`oj-feedback-panel ${feedbackOpen ? 'is-open' : 'is-collapsed'}`} aria-label="Execution feedback">
          <div className="oj-feedback-tabs" role="tablist" aria-label="Execution panels">{(['input', 'result', 'history'] as const).map((tab) => <button type="button" id={`oj-${tab}-tab`} role="tab" aria-selected={feedbackOpen && feedbackTab === tab} aria-controls="oj-console-content" tabIndex={feedbackTab === tab ? 0 : -1} key={tab} onKeyDown={(event) => { const tabs = ['input', 'result', 'history'] as const; const index = tabs.indexOf(tab); if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); const next = tabs[(index + (event.key === 'ArrowRight' ? 1 : 2)) % 3]; setFeedbackOpen(true); setFeedbackTab(next); document.getElementById(`oj-${next}-tab`)?.focus() } }} onClick={() => { setFeedbackTab(tab); setFeedbackOpen(true) }}>{tab === 'input' ? 'Test input' : tab === 'result' ? busy ? 'Running…' : 'Result' : 'Submissions'}</button>)}<span className="oj-action-status" role="status">{message}</span><button className="oj-console-toggle" aria-label={feedbackOpen ? 'Collapse console' : 'Expand console'} aria-expanded={feedbackOpen} aria-controls="oj-console-content" onClick={() => setFeedbackOpen(value => !value)}>{feedbackOpen ? <ChevronDown size={15} /> : <ChevronUp size={15} />}</button></div>
          <div hidden={!feedbackOpen} className="oj-feedback-content" role="tabpanel" id="oj-console-content" aria-labelledby={`oj-${feedbackTab}-tab`}>
            {feedbackTab === 'input' ? <div className="oj-input-panel"><div><strong>Standard input</strong><span>Run checks this input. Submit uses fixed judge cases.</span></div><textarea value={stdin} onChange={(event) => setStdin(event.target.value)} spellCheck={false} aria-label="Standard input" placeholder="Enter custom test input" /><div className="oj-example-buttons">{problem?.examples.map((example, index) => <button type="button" key={example.name} onClick={() => setStdin(example.stdin)}>Example {index + 1}</button>)}</div></div> : feedbackTab === 'result' ? <><OJFeedback busy={!!busy} phase={phase} result={result} snapshot={resultSnapshot} changed={!!resultSnapshot && (language !== resultSnapshot.language || source !== resultSnapshot.source || (!resultSnapshot.submit && stdin !== resultSnapshot.stdin))} actionError={actionError} onRetry={() => void execute(retryTarget === 'submit', true)} />{resultSnapshot?.submit && resultSnapshot.submissionId && resultSnapshot.language !== 'go' && <button type="button" className="oj-review-entry" onClick={() => setReviewSubmissionId(resultSnapshot.submissionId)}>Review submission #{resultSnapshot.submissionId}</button>}</> : <div className="oj-history-panel"><header><strong>Recent submissions</strong><button type="button" onClick={() => setHistoryRevision((value) => value + 1)} disabled={historyLoading}>Refresh</button></header>{historyLoading ? <div className="acm-empty">Loading history…</div> : historyError ? <div className="acm-error" role="alert">{historyError}<button type="button" onClick={() => setHistoryRevision((value) => value + 1)}>Retry history</button></div> : submissions.length === 0 ? <div className="acm-empty">No submissions yet.</div> : submissions.map((submission) => <div className={`oj-history-row ${submission.verdict}`} key={submission.id}><strong>{submission.verdict === 'accepted' ? 'Accepted' : 'Failed'}</strong><span>{submission.language === 'go' ? 'Go' : 'Python'} · #{submission.id} · {submission.passed}/{submission.total} cases</span><time dateTime={submission.created_at}>{new Date(submission.created_at).toLocaleString()}</time>{submission.language !== 'go' && <button type="button" onClick={() => setReviewSubmissionId(submission.id)}>AI review</button>}</div>)}<div className="acm-history-pagination"><button type="button" onClick={() => setHistoryBefore(undefined)} disabled={!historyBefore || historyLoading}>Newest</button><button type="button" onClick={() => setHistoryBefore(historyNext ?? undefined)} disabled={!historyNext || historyLoading}>Older submissions</button></div></div>}
            {reviewSubmissionId && <SubmissionReview key={reviewSubmissionId} submissionId={reviewSubmissionId} onClose={() => setReviewSubmissionId(undefined)} />}
          </div>
        </section>
      </section>
    </section>
  )
}
