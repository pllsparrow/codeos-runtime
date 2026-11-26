import ProductNavigation from '@codeos/platform-core/ProductNavigation'
import { apiErrorMessage, NotebookRequestError } from './httpErrors'
import { lazy, Suspense, memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ArrowRight, Check, ChevronRight, NotebookPen, RefreshCw, X, ZoomIn, ZoomOut } from 'lucide-react'
import type { LabNotebook, NotebookCell } from './labTypes'
import { notebookFilename } from './notebookSafety'
import { initialNotebook, lastNotebook, rememberNotebook } from './notebookResume'
import { filterCodingProblems } from './codingState'
import { useRoadmapCamera } from './useRoadmapCamera'
import { TOPIC_STORAGE_KEY } from './roadmapCamera'
import { buildRoadmapNodes, type PracticeProblem, type RoadmapNode } from './practiceRoadmap'

const ExperimentLab = lazy(() => import('./ExperimentLab'))
const LabWorkspace = lazy(() => import('./LabWorkspace'))
const ACMCampWorkspace = lazy(() => import('./ACMCampWorkspace'))
const preloadOJ = () => { void import('./ACMCampWorkspace').catch(() => undefined) }

type CatalogResource = {
  path: string
  title: string
  kind: 'markdown' | 'notebook'
}

type NotebookResource = CatalogResource & {
  notebook?: {
    path: string
    title: string
    language: string | null
    cells: NotebookCell[]
  }
}

type ActiveArea = 'entry' | 'jupyter' | 'acm' | 'experiments'

const API_URL = (import.meta.env.VITE_CODELAB_API_URL || '/api/codelab').replace(/\/$/, '')

function productHref(path: string): string {
  const configuredOrigin = import.meta.env.VITE_CODEOS_ORIGIN?.trim().replace(/\/$/, '')
  const directDevPort = ['8002', '8110', '8111'].includes(window.location.port)
  const origin = configuredOrigin || (directDevPort ? 'http://127.0.0.1:8088' : '')
  return `${origin}${path}`
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const headers = new Headers(options.headers)
  if (options.body) headers.set('Content-Type', 'application/json')
  let response: Response
  try {
    response = await fetch(`${API_URL}${path}`, { ...options, signal: options.signal || AbortSignal.timeout(30_000), headers })
  } catch {
    throw new Error('Codelab API is unavailable. Check the configured Codelab service and try again.')
  }
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { detail?: string }
    throw new NotebookRequestError(apiErrorMessage(body, response.status), response.status)
  }
  return response.json() as Promise<T>
}

function workspaceUrl(path: string): string {
  return `/lab/workspaces/${path.split('/').map(encodeURIComponent).join('/')}`
}

function idempotencyKey(operation: string): string {
  return globalThis.crypto?.randomUUID?.() || `${operation}-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

function resourceUrl(path: string): string {
  return `/resources/${path.split('/').map(encodeURIComponent).join('/')}`
}

function activeAreaFromLocation(): ActiveArea {
  const params = new URLSearchParams(window.location.search)
  if (window.location.pathname === '/codelab/lab' || window.location.pathname === '/codelab/lab/') return 'experiments'
  if (window.location.pathname.includes('/jupy')) return 'jupyter'
  if (window.location.pathname.includes('/oj')) return 'acm'
  if (params.get('area') === 'acm') return 'acm'
  return params.get('area') === 'jupyter' || params.get('area') === 'lab' || params.has('notebook')
    ? 'jupyter'
    : 'entry'
}

function RouteIndexPopover({ route, onClose, onOpenDirectory, onSize, style }: { route: RoadmapNode; onClose: () => void; onOpenDirectory: (categories: string[]) => void; onSize: (size: { width: number; height: number }) => void; style: { left: number; top: number } }) {
  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [onClose])

  const [query, setQuery] = useState('')
  const [difficulty, setDifficulty] = useState('')
  const [progress, setProgress] = useState('')
  const filtered = useMemo(() => filterCodingProblems(route.problems, query, difficulty, [], progress), [route.problems, query, difficulty, progress])
  useEffect(() => { setQuery(''); setDifficulty(''); setProgress('') }, [route.id])
  const panelRef = useRef<HTMLElement>(null)
  useEffect(() => {
    if (!panelRef.current) return
    const observer = new ResizeObserver(([entry]) => onSize({ width: entry.borderBoxSize[0]?.inlineSize || entry.contentRect.width, height: entry.borderBoxSize[0]?.blockSize || entry.contentRect.height }))
    observer.observe(panelRef.current)
    return () => observer.disconnect()
  }, [onSize])

  const startHref = route.firstProblemIndex === undefined ? '/codelab/oj' : `/codelab/oj/problem/${route.firstProblemIndex}`
  return (
    <section ref={panelRef} className="route-index-popover" style={style} role="dialog" aria-modal="false" aria-labelledby="route-index-title" onPointerDown={(event) => event.stopPropagation()} onClick={(event) => event.stopPropagation()}>
        <div className="route-index-heading">
          <div><span className="practice-eyebrow">PROBLEM INDEX</span><h2 id="route-index-title">{route.title}</h2><p>{route.subtitle}</p></div>
          <button className="route-index-close" type="button" onClick={onClose} aria-label="Close problem index"><X size={14} /></button>
        </div>
        <p className="route-prerequisites">Suggested prerequisites: {route.prerequisites.join(", ") || "None"}</p>
      <div className="route-topic-tools"><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search this topic" aria-label="Search topic problems" /><div><select value={difficulty} onChange={(event) => setDifficulty(event.target.value)} aria-label="Topic difficulty"><option value="">All levels</option><option>Easy</option><option>Medium</option><option>Hard</option></select><select value={progress} onChange={(event) => setProgress(event.target.value)} aria-label="Topic progress"><option value="">All progress</option><option value="unresolved">Not accepted</option><option value="accepted">Accepted</option><option value="todo">Not started</option></select></div><span className="route-topic-count">{filtered.length} problems · {route.accepted}/{route.total} accepted</span></div>
      <div className="route-topic-list">
          {filtered.length ? filtered.map((problem) => (
            <a href={`/codelab/oj/problem/${problem.index}`} key={problem.index} onPointerEnter={preloadOJ} onFocus={preloadOJ}>
              <span className="route-problem-index">{String(problem.index).padStart(3, '0')}</span>
              <span className="route-problem-copy"><strong>{problem.title}</strong><small>{problem.difficulty} · {problem.progress === 'accepted' ? 'Accepted' : problem.progress === 'todo' ? 'Not started' : 'Attempted'}</small></span>
              <ChevronRight size={14} />
            </a>
          )) : <div className="route-topic-empty">{route.problems.length ? 'No matching problems. Adjust your filters.' : 'No problems are assigned to this route yet.'}</div>}
        </div>
        <div className="route-index-actions">
          <a className="route-index-action" href={startHref} onPointerEnter={preloadOJ} onFocus={preloadOJ}>{route.firstProblemIndex === undefined ? 'Open OJ' : 'Start next problem'} <ArrowRight size={14} /></a>
          <button className="route-index-secondary" type="button" onClick={() => onOpenDirectory(route.categories)}>Open topic directory <ArrowRight size={14} /></button>
        </div>
    </section>
  )
}

const ROADMAP_NODE_WIDTH = 248
const ROADMAP_NODE_HEIGHT = 164
const ROADMAP_CANVAS = { width: 1560, height: 2460 }
const ROADMAP_POSITIONS = [
  { x: 570, y: 92 },
  { x: 250, y: 322 },
  { x: 570, y: 322 },
  { x: 890, y: 322 },
  { x: 180, y: 562 },
  { x: 735, y: 562 },
  { x: 465, y: 802 },
  { x: 155, y: 1042 },
  { x: 465, y: 1042 },
  { x: 775, y: 1042 },
  { x: 325, y: 1282 },
  { x: 705, y: 1282 },
] as const

const ROADMAP_EDGES: Array<[number, number]> = [
  [0, 1], [0, 2], [0, 3],
  [1, 4], [2, 4], [2, 5], [3, 5],
  [4, 6], [5, 6],
  [6, 7], [6, 8], [6, 9],
  [7, 10], [8, 10], [9, 11],
]

const ROADMAP_STAGES = [
  { label: '01 · Exam basics', y: 54 },
  { label: '02 · Data handling', y: 284 },
  { label: '03 · Core structures', y: 524 },
  { label: '04 · Search and graphs', y: 764 },
  { label: '05–07 · Range, greedy and DP', y: 1004 },
  { label: '08–09 · Supporting and advanced tools', y: 1244 },
  { label: 'Catalog extensions', y: 1510 },
]

const RoadmapGraph = memo(function RoadmapGraph({ roadmapNodes, canvasHeight, loading, error, activeTopic, onSelect }: { roadmapNodes: RoadmapNode[]; canvasHeight: number; loading: boolean; error: string; activeTopic: string; onSelect: (id: string) => void }) {
  return (
    <div className="practice-map-graph" style={{ width: ROADMAP_CANVAS.width, height: canvasHeight }}>
      <div className="practice-canvas-world-grid" aria-hidden="true" />
      {ROADMAP_STAGES.map((stage) => <span className="roadmap-stage-label" style={{ top: stage.y }} key={stage.label}>{stage.label}</span>)}
      <svg className="practice-connectors" viewBox={`0 0 ${ROADMAP_CANVAS.width} ${canvasHeight}`} aria-hidden="true">
        {ROADMAP_EDGES.map(([from, to]) => { const start = ROADMAP_POSITIONS[from]; const end = ROADMAP_POSITIONS[to]; const startX = start.x + ROADMAP_NODE_WIDTH / 2; const startY = start.y + ROADMAP_NODE_HEIGHT; const endX = end.x + ROADMAP_NODE_WIDTH / 2; const endY = end.y; const bendY = startY + (endY - startY) / 2; return <path d={`M ${startX} ${startY} C ${startX} ${bendY}, ${endX} ${bendY}, ${endX} ${endY}`} key={`${from}-${to}`} /> })}
      </svg>
      {roadmapNodes.map((node, index) => { const point = ROADMAP_POSITIONS[index] || { x: 110 + ((index - ROADMAP_POSITIONS.length) % 5) * 270, y: 1580 + Math.floor((index - ROADMAP_POSITIONS.length) / 5) * 220 }; return <button className={`roadmap-node roadmap-node-${node.status} ${activeTopic === node.id ? 'is-selected' : ''}`} style={{ left: point.x, top: point.y }} type="button" disabled={loading || !!error} key={node.id} aria-expanded={activeTopic === node.id} onClick={() => onSelect(node.id)}><span className="roadmap-node-top"><span className="roadmap-node-icon">{node.status === 'complete' ? <Check size={15} /> : <span>{String(index + 1).padStart(2, '0')}</span>}</span><span className="roadmap-node-state">{error ? 'UNAVAILABLE' : loading ? 'LOADING' : !node.total ? 'UNASSIGNED' : node.status === 'complete' ? 'COMPLETE' : node.problems.some((problem) => problem.progress && problem.progress !== 'todo') ? 'ATTEMPTED' : 'AVAILABLE'}</span></span><strong>{node.title}</strong><span className="roadmap-node-progress" aria-label={error ? 'Progress unavailable' : loading ? 'Progress loading' : `${node.accepted} of ${node.total} problems accepted`}><span style={{ width: `${node.progress}%` }} /></span><em>{node.total ? `${node.accepted}/${node.total} accepted` : error ? 'Catalog unavailable' : loading ? 'Catalog loading' : 'No problems assigned'}</em></button> })}
    </div>
  )
})

function PracticeDirectoryView({ onOpen }: { onOpen: (area: 'jupyter' | 'acm', categories?: string[]) => void }) {
  const [problems, setProblems] = useState<PracticeProblem[]>([])
  const [activeTopic, setActiveTopic] = useState<string>(() => { try { return sessionStorage.getItem(TOPIC_STORAGE_KEY) || '' } catch { return '' } })
  const [panelSize, setPanelSize] = useState({ width: 440, height: 480 })
  const closeTopic = useCallback(() => setActiveTopic(''), [])
  const selectTopic = useCallback((id: string) => setActiveTopic((previous) => previous === id ? '' : id), [])
  useEffect(() => { try { sessionStorage.setItem(TOPIC_STORAGE_KEY, activeTopic) } catch { /* View restoration is optional. */ } }, [activeTopic])
  const [loading, setLoading] = useState(true)
  const [slowLoading, setSlowLoading] = useState(false)
  const [error, setError] = useState('')
  const [revision, setRevision] = useState(0)

  useEffect(() => {
    const controller = new AbortController()
    const slowTimer = window.setTimeout(() => setSlowLoading(true), 1500)
    setSlowLoading(false)
    setLoading(true)
    setError('')
    setProblems([])
    void fetch('/api/codelab/coding/problems', { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(30_000)]) })
      .then(async (response) => {
        if (!response.ok) throw new Error(`Practice catalog is unavailable (${response.status})`)
        const payload: unknown = await response.json()
        if (!Array.isArray(payload)) throw new Error('Practice catalog returned an unexpected response')
        return payload as PracticeProblem[]
      })
      .then((items) => {
        if (controller.signal.aborted) return
        setProblems(Array.isArray(items) ? items : [])
        setError('')
      })
      .catch((loadError) => {
        if (!controller.signal.aborted) {
          setProblems([])
          setError(loadError instanceof Error ? loadError.message : 'Practice catalog is unavailable')
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) {
          window.clearTimeout(slowTimer)
          setSlowLoading(false)
          setLoading(false)
        }
      })
    return () => {
      window.clearTimeout(slowTimer)
      controller.abort()
    }
  }, [revision])

  const roadmapNodes = useMemo(() => buildRoadmapNodes(problems), [problems])
  const roadmapCenter = useMemo(() => {
    const points = roadmapNodes.map((_, index) => ROADMAP_POSITIONS[index] || { x: 110 + ((index - ROADMAP_POSITIONS.length) % 5) * 270 })
    return points.length ? (Math.min(...points.map((point) => point.x)) + Math.max(...points.map((point) => point.x)) + ROADMAP_NODE_WIDTH) / 2 : ROADMAP_CANVAS.width / 2
  }, [roadmapNodes])

  const canvasHeight = Math.max(ROADMAP_CANVAS.height, 1580 + Math.ceil(Math.max(0, roadmapNodes.length - ROADMAP_POSITIONS.length) / 5) * 220)
  const acceptedCount = useMemo(() => problems.filter((problem) => problem.progress === 'accepted').length, [problems])
  const { viewportRef, size, camera, isPanning, beginPan, movePan, endPan, suppressClick, adjustZoom, resetCanvas } = useRoadmapCamera(roadmapCenter, ROADMAP_CANVAS.width, canvasHeight)
  const activeRoute = roadmapNodes.find((node) => node.id === activeTopic)
  const worldOffset = { x: camera.x - roadmapCenter * camera.zoom, y: camera.y + (size.width <= 860 ? 130 : 0) }
  const retryCatalog = () => setRevision((value) => value + 1)
  const handleCanvasClick = (event: React.MouseEvent<HTMLDivElement>) => {
    if ((event.target as HTMLElement).closest('.roadmap-node, .route-index-popover, .practice-floating-rail, .practice-canvas-controls')) return
    closeTopic()
  }
  const activeRoutePosition = useMemo(() => {
    if (!activeRoute) return undefined
    const index = roadmapNodes.findIndex((node) => node.id === activeRoute.id)
    const point = ROADMAP_POSITIONS[index] || { x: 110 + ((index - ROADMAP_POSITIONS.length) % 5) * 270, y: 1580 + Math.floor((index - ROADMAP_POSITIONS.length) / 5) * 220 }
    const nodeLeft = point.x * camera.zoom + worldOffset.x + size.width / 2
    const nodeRight = nodeLeft + ROADMAP_NODE_WIDTH * camera.zoom
    const width = Math.min(panelSize.width, Math.max(0, size.width - 32))
    const preferredLeft = nodeRight + 18 + width <= size.width - 16 ? nodeRight + 18 : nodeLeft - width - 18
    return {
      left: Math.max(16, Math.min(size.width - width - 16, preferredLeft)),
      top: Math.max(16, Math.min(size.height - panelSize.height - 16, point.y * camera.zoom + worldOffset.y)),
    }
  }, [activeRoute, worldOffset.x, worldOffset.y, size.width, size.height, camera.zoom, roadmapNodes, panelSize])

  return (
    <div className="practice-home">
      <div className="practice-map-layout">
        <section className="practice-canvas-panel" aria-labelledby="roadmap-title">
          <div ref={viewportRef} className={`practice-canvas-viewport ${isPanning ? 'is-panning' : ''}`} onPointerDownCapture={() => { suppressClick.current = false }} onPointerDown={beginPan} onPointerMove={movePan} onPointerUp={endPan} onPointerCancel={endPan} onClickCapture={(event) => { if (suppressClick.current) { event.preventDefault(); event.stopPropagation(); suppressClick.current = false } }} onClick={handleCanvasClick} aria-label="Draggable practice roadmap canvas">
            <header className="practice-map-heading"><h1 id="roadmap-title">Practice</h1><p>OJ topic map <span>· Suggested connections, no unlocking required</span></p></header>
            <div className="practice-canvas-world" style={{ transform: `translate3d(${worldOffset.x}px, ${worldOffset.y}px, 0) scale(${camera.zoom})` }}>
              <RoadmapGraph roadmapNodes={roadmapNodes} canvasHeight={canvasHeight} loading={loading} error={error} activeTopic={activeTopic} onSelect={selectTopic} />
            </div>
            <div className="practice-canvas-controls" aria-label="Canvas controls"><button type="button" onClick={() => adjustZoom(0.08)} aria-label="Zoom in"><ZoomIn size={15} /></button><button type="button" onClick={() => adjustZoom(-0.08)} aria-label="Zoom out"><ZoomOut size={15} /></button><button type="button" onClick={resetCanvas}>Reset</button></div>
            <span className="practice-canvas-hint">Drag or scroll to explore · Pinch or Ctrl/Cmd + scroll to zoom</span>
            <aside className="practice-floating-rail" aria-label="Practice tools" onPointerDown={(event) => event.stopPropagation()}>
              <button className="practice-floating-card practice-jupy-card" type="button" onClick={() => onOpen('jupyter')}><span className="floating-card-icon"><NotebookPen size={17} /></span><span><small>JUPY</small><strong>Notebook workspace</strong><em>Write and run Python</em></span><ArrowRight size={15} /></button>
              <section className="practice-progress-card" aria-label="Practice catalog progress">
                <span className="practice-progress-icon" aria-hidden="true"><Check size={17} /></span>
                <span className="practice-progress-copy"><small>OJ PROGRESS</small><strong>{error ? 'Catalog unavailable' : loading ? slowLoading ? 'Catalog is taking longer…' : 'Loading catalog…' : `${acceptedCount} accepted`}</strong><em>{error || (loading ? 'Reading your practice data' : problems.length ? `${problems.length} problems in the catalog` : 'No problems in the catalog')}</em></span>
                {error && <button className="practice-progress-retry" type="button" onClick={retryCatalog} disabled={loading} aria-label="Retry loading practice catalog"><RefreshCw size={14} className={loading ? 'is-spinning' : ''} /></button>}
              </section>
            </aside>
            {activeRoute && activeRoutePosition && <RouteIndexPopover route={activeRoute} style={activeRoutePosition} onClose={closeTopic} onSize={setPanelSize} onOpenDirectory={(categories) => { onOpen('acm', categories) }} />}
          </div>
        </section>
      </div>

    </div>
  )
}

function App() {
  const learningContext = new URLSearchParams(window.location.search).get('learning_context') || ''
  const [requestedNotebookPath] = useState(() => initialNotebook(window.location.search, activeAreaFromLocation() === 'jupyter'))
  const [activeArea, setActiveArea] = useState<ActiveArea>(activeAreaFromLocation)
  const [labNotebook, setLabNotebook] = useState<LabNotebook>()
  useEffect(() => {
    if (labNotebook?.path) rememberNotebook(labNotebook.path, undefined, learningContext)
  }, [labNotebook?.path, learningContext])
  const [directoryRevision, setDirectoryRevision] = useState(0)
  const [notebookError, setNotebookError] = useState('')
  const [failedNotebookPath, setFailedNotebookPath] = useState('')
  const [acmQuery, setAcmQuery] = useState('')
  const pendingMutations = useRef(new Map<string, { body: string; key: string }>())
  const writeNotebook = useCallback(async <T,>(path: string, body: unknown, method = 'PUT'): Promise<T> => {
    const encoded = JSON.stringify(body)
    const identity = `${method}:${path}`
    const pending = pendingMutations.current.get(identity)
    const key = pending?.body === encoded ? pending.key : idempotencyKey('notebook')
    pendingMutations.current.set(identity, { body: encoded, key })
    const saved = await request<T>(path, { method, headers: { 'Idempotency-Key': key }, body: encoded })
    pendingMutations.current.delete(identity)
    return saved
  }, [])
  const navigationGuardRef = useRef<() => boolean>(() => true)
  useEffect(() => {
    const guardNavigation = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
      const link = (event.target as Element | null)?.closest('a[href]')
      if (!link || !link.closest('.codeos-navigation') || (link.getAttribute('target') && link.getAttribute('target') !== '_self')) return
      if (!navigationGuardRef.current()) event.preventDefault()
    }
    document.addEventListener('click', guardNavigation, true)
    return () => document.removeEventListener('click', guardNavigation, true)
  }, [])
  const notebookOpenGeneration = useRef(0)
  const [notebookOpening, setNotebookOpening] = useState(false)
  const registerNavigationGuard = useCallback((guard: () => boolean) => {
    navigationGuardRef.current = guard
  }, [])
  const notebookSaved = useCallback((_path: string, _updatedAt: string) => {
    setDirectoryRevision((value) => value + 1)
  }, [])

  const pendingCreation = useRef<{ title: string; path: string } | undefined>(undefined)
  const createNotebook = useCallback(async (requestedTitle = '') => {
    const title = requestedTitle.trim()
    if (!title) throw new Error('Enter a Notebook title')
    if (pendingCreation.current?.title !== title) pendingCreation.current = { title, path: `workspace/${idempotencyKey('notebook')}.ipynb` }
    const path = pendingCreation.current.path
    const notebook: LabNotebook = { path, title, language: 'python', cells: [{ cell_type: 'code', source: '', execution_count: null, output_count: 0 }] }
    try {
      const saved = await writeNotebook<{ updated_at: string }>(workspaceUrl(path), { notebook, create_only: true })
      pendingCreation.current = undefined
      setDirectoryRevision((value) => value + 1)
      setLabNotebook({ ...notebook, updated_at: saved.updated_at })
      setActiveArea('jupyter')
      const url = new URL(window.location.href)
      url.pathname = '/codelab/jupy'
      url.searchParams.set('area', 'jupyter')
      url.searchParams.set('notebook', path)
      window.history.replaceState({}, '', url)
    } catch (error) {
      throw error
    }
  }, [writeNotebook])

  const renameNotebook = useCallback(async (path: string, requestedFilename: string, expectedVersion: string) => {
    const filename = notebookFilename(requestedFilename)
    const directory = path.slice(0, path.lastIndexOf('/') + 1)
    const newPath = `${directory}${filename}`
    const displayTitle = newPath.split('/').pop()?.replace(/\.ipynb$/i, '') || requestedFilename
    if (newPath === path) return
    const renamed = await writeNotebook<{ resource_path: string; title: string; notebook: LabNotebook; updated_at: string }>(workspaceUrl(path), { new_path: newPath, title: displayTitle, expected_version: expectedVersion }, 'PATCH')
    setDirectoryRevision((value) => value + 1)
    if (lastNotebook() === path) rememberNotebook(renamed.resource_path)
    if (labNotebook?.path === path) {
      setLabNotebook({ ...renamed.notebook, updated_at: renamed.updated_at })
      const url = new URL(window.location.href)
      url.searchParams.set('notebook', renamed.resource_path)
      window.history.replaceState({}, '', url)
    }
  }, [labNotebook, writeNotebook])

  const saveNotebookAs = useCallback(async (sourceNotebook: LabNotebook, requestedFilename: string) => {
    const filename = notebookFilename(requestedFilename)
    const path = `workspace/${filename}`
    const { updated_at: _updatedAt, ...source } = sourceNotebook
    const notebook = { ...source, path, title: filename.replace(/\.ipynb$/i, '') }
    const saved = await writeNotebook<{ resource_path: string; title: string; notebook: LabNotebook; updated_at: string }>(workspaceUrl(path), { notebook, create_only: true })
    setDirectoryRevision((value) => value + 1)
    setLabNotebook({ ...saved.notebook, updated_at: saved.updated_at })
    const url = new URL(window.location.href)
    url.pathname = '/codelab/jupy'
    url.searchParams.set('area', 'jupyter')
    url.searchParams.set('notebook', saved.resource_path)
    window.history.replaceState({}, '', url)
  }, [writeNotebook])

  const openNotebook = useCallback(async (path: string, navigationConfirmed = false) => {
    if (notebookOpening || (!navigationConfirmed && !navigationGuardRef.current())) return
    const generation = ++notebookOpenGeneration.current
    setNotebookOpening(true)
    setNotebookError('')
    setFailedNotebookPath('')
    try {
      const owners = await request<{ id: string }[]>(`/learning/paths/experiment-context?reference=${encodeURIComponent(path)}`)
      if (learningContext && !owners.some(item => item.id === learningContext)) throw new Error('This Notebook is not the linked course experiment. Return to the lesson to open or repair it.')
      if (!learningContext && (owners.length || path.startsWith('workspace/course--'))) {
        rememberNotebook('')
        throw new Error('Open this course experiment from its lesson. Independent Lab experiments stay separate.')
      }
      const saved = await request<{ notebook?: NotebookResource['notebook']; updated_at: string } | null>(workspaceUrl(path))
      const loaded = saved?.notebook ? { kind: 'notebook' as const, notebook: saved.notebook } : await request<NotebookResource>(resourceUrl(path))
      if (loaded.kind !== 'notebook' || !loaded.notebook) {
        throw new Error('Requested resource is not a Notebook')
      }
      if (generation !== notebookOpenGeneration.current) return
      setLabNotebook({
        updated_at: saved?.updated_at,
        path: loaded.notebook.path,
        title: loaded.notebook.title,
        language: loaded.notebook.language,
        cells: loaded.notebook.cells,
      })
      setActiveArea('jupyter')
      const url = new URL(window.location.href)
      url.pathname = '/codelab/jupy'
      url.searchParams.set('area', 'jupyter')
      url.searchParams.set('notebook', loaded.notebook.path)
      window.history.replaceState({}, '', url)
    } catch (loadError) {
      if (generation !== notebookOpenGeneration.current) return
      setFailedNotebookPath(path)
      setNotebookError(loadError instanceof Error ? loadError.message : 'Unable to open Notebook')
    } finally {
      if (generation === notebookOpenGeneration.current) setNotebookOpening(false)
    }
  }, [notebookOpening, learningContext])

  const initialNotebookOpened = useRef(false)
  useEffect(() => {
    if (!initialNotebookOpened.current && requestedNotebookPath) {
      initialNotebookOpened.current = true
      void openNotebook(requestedNotebookPath)
    }
  }, [openNotebook, requestedNotebookPath])

  const navigateArea = useCallback((area: ActiveArea, categories: string[] = [], restorePrevious = true) => {
    if (notebookOpening || !navigationGuardRef.current()) return
    notebookOpenGeneration.current += 1
    setActiveArea(area)
    setAcmQuery('')
    const url = new URL(window.location.href)
    if (area === 'entry') {
      url.pathname = '/codelab/'
      url.searchParams.delete('area')
      url.searchParams.delete('notebook')
      url.searchParams.delete('categories')
    } else {
      url.pathname = area === 'jupyter' ? '/codelab/jupy' : '/codelab/oj'
      url.searchParams.set('area', area)
      if (area === 'acm' && categories.length) url.searchParams.set('categories', JSON.stringify(categories))
      else url.searchParams.delete('categories')
      url.searchParams.delete('notebook')
      if (area === 'jupyter') setLabNotebook(undefined)
    }
    window.history.replaceState({}, '', url)
    if (area === 'jupyter' && restorePrevious) {
      const previous = lastNotebook(undefined, learningContext)
      if (previous) void openNotebook(previous, true)
    }
  }, [notebookOpening, openNotebook])

  const retryNotebookCatalog = useCallback(() => {
    if (failedNotebookPath) {
      void openNotebook(failedNotebookPath)
      return
    }
    setDirectoryRevision((value) => value + 1)
  }, [failedNotebookPath, openNotebook])

  return (
    <div className={`codelab-shell ${activeArea !== 'entry' && activeArea !== 'experiments' ? 'immersive-codelab' : ''}`}>
      <ProductNavigation active={activeArea === 'jupyter' || activeArea === 'experiments' ? 'lab' : 'oj'} href={productHref} />
      <main className={`codelab-workspace ${activeArea === 'experiments' ? 'experiment-lab-shell' : activeArea === 'entry' ? 'codelab-entry-shell' : 'lab-workspace-shell'}`}>
        {activeArea === 'experiments' ? (
          <Suspense fallback={<div className="content-status">Loading Lab…</div>}><ExperimentLab onNavigationGuardChange={registerNavigationGuard} /></Suspense>
        ) : activeArea === 'entry' ? (
          <PracticeDirectoryView onOpen={navigateArea} />
        ) : activeArea === 'jupyter' ? (
          <Suspense fallback={<div className="content-status">Loading Jupy...</div>}>
            <LabWorkspace
              notebook={labNotebook}
              directoryRevision={directoryRevision}
              notebookOpening={notebookOpening}
              onNavigationGuardChange={registerNavigationGuard}
              onSaved={notebookSaved}
              notebooksError={notebookError}
              onRetryNotebooks={retryNotebookCatalog}
              onSelectNotebook={(path) => void openNotebook(path)}
              onCreateNotebook={learningContext ? undefined : createNotebook}
              onRenameNotebook={learningContext ? undefined : renameNotebook}
              onSaveNotebookAs={learningContext ? undefined : saveNotebookAs}
              onBackToCatalog={() => navigateArea('jupyter', [], false)}
            />
          </Suspense>
        ) : (
          <Suspense fallback={<div className="content-status">Loading OJ...</div>}>
            <ACMCampWorkspace query={acmQuery} onQueryChange={setAcmQuery} onBackToMap={() => navigateArea('entry')} onNavigationGuardChange={registerNavigationGuard} />
          </Suspense>
        )}
      </main>
    </div>
  )
}

export default App
