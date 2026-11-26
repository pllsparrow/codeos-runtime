import WorkbenchMenu from '../../../../frontend/src/platform_core/WorkbenchMenu'
import LessonContext from './LessonContext'
import { apiErrorMessage, NotebookRequestError } from './httpErrors'
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { AlertCircle, ArrowLeft, PanelLeft, MoreHorizontal, ClipboardPaste, Copy, Scissors, Square, ChevronsRight, Download, Layers, ChevronLeft, ChevronRight, LoaderCircle, NotebookText, ChevronDown, Play, Plus, RotateCcw, Search, Save, Trash2 } from 'lucide-react'
import type { Kernel, KernelManager } from '@jupyterlab/services'
import type { CellOutput, LabNotebook, NotebookCell } from './labTypes'
import { notebookSnapshot } from './notebookSafety'
import MarkdownCell from './MarkdownCell'
import NotebookCellEditor from './NotebookCellEditor'
import { executeNotebookCells, kernelHttpRequest } from './notebookExecution'
import { NotebookCheckpoint } from './notebookCheckpoint'
import { runNotebookExecution } from './notebookRun'
import CellResult from './CellResult'
import NotebookFolderTree from './NotebookFolderTree'
import NotebookEditedAt from './NotebookEditedAt'
import { downloadNotebook } from './notebookExport'
import { captureDeletedCell, cellHasContent, changeCellType, restoreDeletedCell, type DeletedCell } from './notebookCellActions'

export type LabNotebookEntry = Pick<LabNotebook, 'path' | 'title'> & { updatedAt?: string | null }
type NotebookDirectory = { items: Array<{ path: string; title: string; updated_at: string | null }>; total: number; notebook_count: number; page: number; page_count: number; limit: number; folders: Array<{ path: string; count: number }> }
type NotebookSort = 'updated' | 'title'

type LabCell = NotebookCell & {
  id: string
  outputs: CellOutput[]
}

type RuntimeState = 'idle' | 'starting' | 'ready' | 'running' | 'error'
type PersistenceState = 'idle' | 'loading' | 'saved' | 'unsaved' | 'saving' | 'error'

const JUPYTER_URL = (import.meta.env.VITE_CODELAB_JUPYTER_URL || `${window.location.origin}/jupyter`).replace(/\/$/, '')
const JUPYTER_KERNEL = import.meta.env.VITE_CODELAB_JUPYTER_KERNEL || 'codelab-python'
const API_URL = (import.meta.env.VITE_CODELAB_API_URL || '/api/codelab').replace(/\/$/, '')

function makeCellId(): string {
  return `cell-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

function notebookCells(notebook: LabNotebook): LabCell[] {
  return notebook.cells.map((cell) => ({ ...cell, id: makeCellId(), outputs: cell.outputs || [] }))
}

async function requestWorkspace<T>(path: string, options: RequestInit = {}): Promise<T> {
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

function idempotencyKey(): string {
  return globalThis.crypto?.randomUUID?.() || `workspace-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

function LabWorkspace({ notebook, directoryRevision = 0, notebooksError = '', onRetryNotebooks, onSelectNotebook, onCreateNotebook, onRenameNotebook, onSaveNotebookAs, onBackToCatalog, notebookOpening = false, onNavigationGuardChange, onSaved }: { notebook?: LabNotebook; directoryRevision?: number; notebooksError?: string; onRetryNotebooks?: () => void; onSelectNotebook?: (path: string) => void; onCreateNotebook?: (title: string) => Promise<void>; onRenameNotebook?: (path: string, title: string, expectedVersion: string) => Promise<void>; onSaveNotebookAs?: (notebook: LabNotebook, filename: string) => Promise<void>; onBackToCatalog?: () => void; notebookOpening?: boolean; onNavigationGuardChange?: (guard: () => boolean) => void; onSaved?: (path: string, updatedAt: string) => void }) {
  const initialCells = useMemo(() => notebook ? notebookCells(notebook) : [], [notebook])
  const [cells, setCellsState] = useState<LabCell[]>(initialCells)
  const cellsRef = useRef(initialCells)
  const setCells = useCallback((update: LabCell[] | ((current: LabCell[]) => LabCell[])) => {
    const next = typeof update === 'function' ? update(cellsRef.current) : update
    cellsRef.current = next
    setCellsState(next)
  }, [])
  const [directoryOpen, setDirectoryOpen] = useState(!notebook)
  useEffect(() => { setDirectoryOpen(!notebook) }, [notebook?.path])
  useEffect(() => {
    if (!directoryOpen) return
    const close = (event: KeyboardEvent) => { if (event.key === 'Escape') { setDirectoryOpen(false); document.getElementById('lab-directory-toggle')?.focus() } }
    window.addEventListener('keydown', close)
    return () => window.removeEventListener('keydown', close)
  }, [directoryOpen])
  const [runtimeState, setRuntimeState] = useState<RuntimeState>('idle')
  const [runtimeError, setRuntimeError] = useState('')
  const [persistenceState, setPersistenceState] = useState<PersistenceState>('idle')
  const [persistenceError, setPersistenceError] = useState('')
  const [saveConflict, setSaveConflict] = useState(false)
  const [saveAsOpen, setSaveAsOpen] = useState(false)
  const [saveAsFilename, setSaveAsFilename] = useState('')
  const [activeCellId, setActiveCellId] = useState('')
  const [copiedCell, setCopiedCell] = useState<LabCell>()
  const [deletedCells, setDeletedCells] = useState<DeletedCell<LabCell>[]>([])
  const [markdownEditRequest, setMarkdownEditRequest] = useState({ cellId: '', sequence: 0 })
  const [downloadNotice, setDownloadNotice] = useState('')
  const [downloadError, setDownloadError] = useState('')
  const kernelRef = useRef<Kernel.IKernelConnection | undefined>(undefined)
  const managerRef = useRef<KernelManager | undefined>(undefined)
  const executionGenerationRef = useRef(0)
  const executionInProgressRef = useRef(false)
  const executionAbortRef = useRef<AbortController | undefined>(undefined)
  const [runningCellId, setRunningCellId] = useState('')
  const dirtyVersionRef = useRef(0)
  const workspaceGenerationRef = useRef(0)
  const [directoryQuery, setDirectoryQuery] = useState('')
  const [selectedFolder, setSelectedFolder] = useState('')
  const [directorySort, setDirectorySort] = useState<NotebookSort>('updated')
  const [directoryPage, setDirectoryPage] = useState(0)
  const [newNotebookTitle, setNewNotebookTitle] = useState('')
  const [newNotebookOpen, setNewNotebookOpen] = useState(false)
  const [newNotebookError, setNewNotebookError] = useState('')
  const [mutationBusy, setMutationBusy] = useState(false)
  const mutationBusyRef = useRef(false)
  const saveBusyRef = useRef(false)
  const checkpointRef = useRef(new NotebookCheckpoint())
  const [renamingPath, setRenamingPath] = useState('')
  const [renameTitle, setRenameTitle] = useState('')
  const [renameVersion, setRenameVersion] = useState('unpersisted')
  const [renameError, setRenameError] = useState('')
  const DIRECTORY_PAGE_SIZE = 25

  const [directory, setDirectory] = useState<NotebookDirectory>()
  const [notebooksLoading, setNotebooksLoading] = useState(true)
  const [directoryError, setDirectoryError] = useState('')
  const [directoryRetry, setDirectoryRetry] = useState(0)
  const [directorySlow, setDirectorySlow] = useState(false)
  const folders = directory?.folders || []
  const directoryPageCount = directory?.page_count || 1
  const visibleDirectoryEntries = directory?.items || []

  useEffect(() => {
    const controller = new AbortController()
    setNotebooksLoading(true)
    setDirectorySlow(false)
    setDirectoryError('')
    const timer = window.setTimeout(() => setDirectorySlow(true), 1500)
    const context = new URLSearchParams(window.location.search).get('learning_context')
    const params = new URLSearchParams({ scope: context ? 'course' : 'independent', ...(context ? { lesson: context } : {}), q: directoryQuery, folder: selectedFolder, sort: directorySort, page: String(directoryPage), limit: String(DIRECTORY_PAGE_SIZE) })
    void requestWorkspace<NotebookDirectory>(`/lab/notebooks?${params}`, { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(30_000)]) })
      .then((loaded) => {
        if (controller.signal.aborted) return
        setDirectory(loaded)
        setDirectoryPage(loaded.page)
      })
      .catch((error) => {
        if (!controller.signal.aborted) setDirectoryError(error instanceof Error ? error.message : 'Notebook directory is unavailable')
      })
      .finally(() => {
        if (!controller.signal.aborted) {
          window.clearTimeout(timer)
          setDirectorySlow(false)
          setNotebooksLoading(false)
        }
      })
    return () => { window.clearTimeout(timer); controller.abort() }
  }, [directoryPage, directoryQuery, directoryRetry, directoryRevision, directorySort, selectedFolder])

  useEffect(() => {
    setDirectoryPage(0)
  }, [directoryQuery, directorySort, selectedFolder])

  useEffect(() => {
    setDownloadNotice('')
    setDownloadError('')
    setDeletedCells([])
    setMarkdownEditRequest({ cellId: '', sequence: 0 })
    workspaceGenerationRef.current += 1
    setCells(initialCells)
    setActiveCellId(initialCells[0]?.id || '')
    setPersistenceError('')
    setSaveAsOpen(false)
    setSaveAsFilename(notebook?.path.split('/').pop() || '')
    dirtyVersionRef.current = 0
    checkpointRef.current = new NotebookCheckpoint(notebook?.updated_at)
    setSaveConflict(false)
    setPersistenceState(notebook ? notebook.updated_at ? 'saved' : 'unsaved' : 'idle')
  }, [initialCells, notebook])

  const editingBlocked = notebookOpening || mutationBusy || persistenceState === 'saving'
  const runtimeBusy = runtimeState === 'starting' || runtimeState === 'running'
  const unsaved = !!notebook && persistenceState !== 'saved' && persistenceState !== 'idle'
  const canLeave = useCallback(() => {
    if (editingBlocked || runtimeBusy || executionInProgressRef.current || mutationBusyRef.current || saveBusyRef.current) {
      window.alert('Wait for the current Notebook operation to finish, or stop the kernel.')
      return false
    }
    return !unsaved || window.confirm('This Notebook has unsaved changes. Discard them and leave?')
  }, [editingBlocked, runtimeBusy, unsaved])

  useEffect(() => {
    onNavigationGuardChange?.(canLeave)
    return () => onNavigationGuardChange?.(() => true)
  }, [canLeave, onNavigationGuardChange])

  useEffect(() => {
    if (!unsaved && !editingBlocked && !runtimeBusy) return
    const protectNotebook = (event: BeforeUnloadEvent) => {
      event.preventDefault()
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', protectNotebook)
    return () => window.removeEventListener('beforeunload', protectNotebook)
  }, [editingBlocked, runtimeBusy, unsaved])

  const startKernel = useCallback(async () => {
    if (kernelRef.current) return kernelRef.current
    const kernelGeneration = executionGenerationRef.current
    setRuntimeState('starting')
    setRuntimeError('')
    let startedManager: KernelManager | undefined
    try {
      const { KernelManager, ServerConnection } = await import('@jupyterlab/services')
      const settings = ServerConnection.makeSettings({ baseUrl: `${JUPYTER_URL}/`, fetch: kernelHttpRequest })
      const manager = new KernelManager({ serverSettings: settings })
      startedManager = manager
      managerRef.current = manager
      const kernel = await manager.startNew({ name: JUPYTER_KERNEL })
      if (kernelGeneration !== executionGenerationRef.current) {
        await kernel.shutdown()
        await manager.dispose()
        throw new Error('Notebook changed while the kernel was starting')
      }
      kernelRef.current = kernel
      const serverStoppedKernel = () => {
        if (kernelRef.current !== kernel) return
        executionGenerationRef.current += 1
        executionAbortRef.current?.abort()
        kernelRef.current = undefined
        if (managerRef.current === manager) managerRef.current = undefined
        manager.dispose()
        setRuntimeState('error')
        setRuntimeError('The server stopped this kernel, possibly because execution exceeded 60 seconds or it was idle. Your cells and output are kept. Run a cell or restart the kernel to continue.')
      }
      kernel.statusChanged.connect((_sender, status) => { if (status === 'dead') serverStoppedKernel() })
      kernel.disposed.connect(serverStoppedKernel)
      setRuntimeState('ready')
      return kernel
    } catch (error) {
      startedManager?.dispose()
      if (managerRef.current === startedManager) managerRef.current = undefined
      if (kernelGeneration !== executionGenerationRef.current) throw error
      const message = error instanceof Error ? error.message : 'Unable to start the Notebook kernel'
      setRuntimeState('error')
      setRuntimeError(`${message}. Start the local Jupyter runtime and try again.`)
      throw error
    }
  }, [])

  const stopKernel = useCallback(async () => {
    executionGenerationRef.current += 1
    executionAbortRef.current?.abort()
    const kernel = kernelRef.current
    kernelRef.current = undefined
    const manager = managerRef.current
    managerRef.current = undefined
    try {
      if (kernel) await kernel.shutdown()
      setRuntimeState('idle')
      return true
    } catch (error) {
      setRuntimeState('error')
      setRuntimeError(error instanceof Error ? error.message : 'Unable to stop the Notebook kernel')
      return false
    } finally {
      manager?.dispose()
    }
  }, [])

  useEffect(() => {
    void stopKernel()
  }, [notebook?.path, stopKernel])

  const restartKernel = useCallback(async () => {
    if (!await stopKernel()) return
    try {
      await startKernel()
    } catch {
      // startKernel already exposes the failure in the runtime status.
    }
  }, [startKernel, stopKernel])

  useEffect(() => () => { void stopKernel() }, [stopKernel])

  const markUnsaved = useCallback(() => {
    dirtyVersionRef.current += 1
    setPersistenceState('unsaved')
    if (!saveConflict) setPersistenceError('')
  }, [saveConflict])

  const updateCell = useCallback((id: string, source: string) => {
    setCells((current) => current.map((cell) => cell.id === id ? { ...cell, source } : cell))
    markUnsaved()
  }, [markUnsaved])

  const updatePrediction = (id: string, prediction: string) => {
    setCells((current) => current.map((cell) => cell.id === id ? { ...cell, prediction } : cell))
    markUnsaved()
  }

  const appendCell = useCallback((cellType: 'code' | 'markdown', insertAfterSelected = false) => {
    const cell: LabCell = {
      cell_type: cellType,
      source: '',
      execution_count: null,
      output_count: 0,
      id: makeCellId(),
      outputs: [],
    }
    setCells((current) => {
      const index = insertAfterSelected ? current.findIndex((item) => item.id === activeCellId) : -1
      return index < 0 ? [...current, cell] : [...current.slice(0, index + 1), cell, ...current.slice(index + 1)]
    })
    setActiveCellId(cell.id)
    markUnsaved()
  }, [markUnsaved, activeCellId])

  const removeCell = useCallback((id: string, cutting = false) => {
    if (editingBlocked || runtimeBusy || executionInProgressRef.current || saveBusyRef.current) return
    const deleted = captureDeletedCell(cellsRef.current, id)
    if (!deleted) return
    if (cellHasContent(deleted.cell)) {
      const operation = cutting ? 'Cut' : 'Delete'
      const confirmed = window.prompt(`${operation} ${deleted.cell.cell_type} cell ${deleted.index + 1} containing source or results?\n\n${deleted.cell.source.slice(0, 120)}\n\nThis removes the entire cell. Type DELETE to confirm. Undo is available only while this Notebook stays open.`)
      if (confirmed !== 'DELETE') return
    } else if (!cutting && !window.confirm(`Delete empty cell ${deleted.index + 1}?`)) return
    setDeletedCells((current) => [...current, deleted])
    setCells((current) => current.filter((cell) => cell.id !== id))
    if (activeCellId === id) setActiveCellId(cellsRef.current[Math.min(deleted.index, cellsRef.current.length - 1)].id)
    markUnsaved()
  }, [markUnsaved, activeCellId, editingBlocked, runtimeBusy])

  const undoCellDeletion = () => {
    if (editingBlocked || runtimeBusy || executionInProgressRef.current || saveBusyRef.current) return
    const deleted = deletedCells.at(-1)
    if (!deleted) return
    setCells((current) => restoreDeletedCell(current, deleted))
    setDeletedCells((current) => current.slice(0, -1))
    setActiveCellId(deleted.cell.id)
    markUnsaved()
  }


  const saveWorkspace = useCallback(async (automatic = false): Promise<boolean> => {
    if (saveConflict || !notebook || saveBusyRef.current || (!automatic && (editingBlocked || runtimeBusy || executionInProgressRef.current))) return false
    saveBusyRef.current = true
    setPersistenceState('saving')
    setPersistenceError('')
    const workspaceGeneration = workspaceGenerationRef.current
    const savedVersion = dirtyVersionRef.current
    const savedNotebook = notebookSnapshot(notebook, cellsRef.current)
    try {
      const updatedAt = await checkpointRef.current.save(savedNotebook, idempotencyKey,
        (body, key) => requestWorkspace<{ updated_at: string }>(workspaceUrl(notebook.path), { method: 'PUT', headers: { 'Idempotency-Key': key }, body }),
        () => requestWorkspace<{ notebook: LabNotebook; updated_at: string } | null>(workspaceUrl(notebook.path)),
      )
      if (workspaceGeneration !== workspaceGenerationRef.current) return false
      onSaved?.(notebook.path, updatedAt)
      setPersistenceState(dirtyVersionRef.current === savedVersion ? 'saved' : 'unsaved')
      return dirtyVersionRef.current === savedVersion
    } catch (error) {
      if (workspaceGeneration !== workspaceGenerationRef.current) return false
      setPersistenceState('error')
      setSaveConflict(error instanceof Error && 'status' in error && error.status === 409)
      setPersistenceError(error instanceof Error ? error.message : 'Unable to save workspace')
      return false
    } finally {
      saveBusyRef.current = false
    }
  }, [editingBlocked, notebook, onSaved, runtimeBusy, saveConflict])

  useEffect(() => {
    if (!notebook) return
    const saveShortcut = (event: KeyboardEvent) => {
      if (!event.defaultPrevented && (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
        event.preventDefault()
        void saveWorkspace()
      }
    }
    window.addEventListener('keydown', saveShortcut)
    return () => window.removeEventListener('keydown', saveShortcut)
  }, [notebook, saveWorkspace])

  const saveNotebookAs = useCallback(async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!notebook || !onSaveNotebookAs || !saveAsFilename.trim() || editingBlocked || runtimeBusy || executionInProgressRef.current || saveBusyRef.current) return
    saveBusyRef.current = true
    setPersistenceState('saving')
    setPersistenceError('')
    try {
      await onSaveNotebookAs(notebookSnapshot(notebook, cells), saveAsFilename.trim())
      setSaveAsOpen(false)
      setPersistenceState('saved')
    } catch (error) {
      setPersistenceState('error')
      setPersistenceError(error instanceof Error ? error.message : 'Unable to save Notebook')
    } finally {
      saveBusyRef.current = false
    }
  }, [cells, editingBlocked, notebook, onSaveNotebookAs, runtimeBusy, saveAsFilename])

  const runCell = useCallback(async (id: string): Promise<boolean> => {
    if (saveConflict || executionInProgressRef.current || saveBusyRef.current || editingBlocked || runtimeBusy) return false
    const cell = cellsRef.current.find((item) => item.id === id)
    if (!cell || cell.cell_type !== 'code' || !cell.source.trim()) return false
    executionInProgressRef.current = true
    const generation = executionGenerationRef.current
    const workspaceGeneration = workspaceGenerationRef.current
    setActiveCellId(id)
    setRunningCellId(id)
    setRuntimeError('')
    try {
      // Preserve the last completed result if kernel startup fails.
      const kernel = await startKernel()
      if (generation !== executionGenerationRef.current) return false
      const controller = new AbortController()
      executionAbortRef.current = controller
      setRuntimeState('running')
      const result = await runNotebookExecution(kernel, cell.source, controller.signal, (outputs) => {
        if (workspaceGeneration !== workspaceGenerationRef.current) return
        setCells((current) => current.map((item) => item.id === id ? { ...item, outputs, output_count: outputs.length } : item))
      }, 60_000, () => {
        setCells((current) => current.map((item) => item.id === id ? { ...item, outputs: [], output_count: 0, execution_count: null, execution: undefined } : item))
        markUnsaved()
      }, cell.prediction)
      if (workspaceGeneration !== workspaceGenerationRef.current) return false
      executionAbortRef.current = undefined
      if (result.execution.status === 'timeout' || (result.execution.status === 'interrupted' && kernelRef.current === kernel)) await stopKernel()
      const execution = result.execution
      setCells((current) => current.map((item) => item.id === id ? { ...item, outputs: result.outputs, output_count: result.outputs.length, execution_count: result.count, execution } : item))
      markUnsaved()
      if (kernelRef.current === kernel) setRuntimeState('ready')
      setRuntimeError(result.execution.status === 'success' ? '' : result.execution.message || 'Cell execution failed. See the result below.')
      setRunningCellId('')
      const saved = await saveWorkspace(true)
      return result.execution.status === 'success' && saved
    } catch (error) {
      if (workspaceGeneration !== workspaceGenerationRef.current) return false
      setRuntimeState('error')
      setRuntimeError(error instanceof Error ? error.message : 'Notebook cell execution failed')
      return false
    } finally {
      executionAbortRef.current = undefined
      executionInProgressRef.current = false
      setRunningCellId('')
    }
  }, [editingBlocked, markUnsaved, runtimeBusy, saveWorkspace, setCells, startKernel, stopKernel, saveConflict])

  const runAll = useCallback(async () => {
    const generation = executionGenerationRef.current
    await executeNotebookCells(cellsRef.current, (cell) => runCell(cell.id), () => generation !== executionGenerationRef.current)
  }, [cells, runCell])

  const activeCell = cells.find((cell) => cell.id === activeCellId)
  const changeActiveType = (type: NotebookCell['cell_type']) => {
    if (!activeCell || editingBlocked || runtimeBusy || type === activeCell.cell_type) return
    setCells((current) => current.map((cell) => cell.id === activeCell.id ? changeCellType(cell, type) : cell))
    markUnsaved()
  }
  const copyActiveCell = (cut = false) => {
    if (!activeCell || editingBlocked || runtimeBusy) return
    setCopiedCell(structuredClone(activeCell))
    if (cut) removeCell(activeCell.id, true)
  }
  const pasteCell = () => {
    if (!copiedCell || editingBlocked || runtimeBusy) return
    const cell = { ...structuredClone(copiedCell), id: makeCellId() }
    setCells((current) => {
      const index = current.findIndex((item) => item.id === activeCellId)
      const insertion = index < 0 ? current.length : index + 1
      return [...current.slice(0, insertion), cell, ...current.slice(insertion)]
    })
    setActiveCellId(cell.id)
    markUnsaved()
  }

  return (
    <section className={`lab-jupy-layout immersive-lab ${directoryOpen ? 'directory-open' : ''}`} aria-label="Jupy workspace">
      <header className="lab-workbar">
        <a className="typing-brand" href="/" onClick={event => { if (!event.metaKey && !event.ctrlKey && !canLeave()) event.preventDefault() }}>CodeOS</a>
        <button id="lab-directory-toggle" className="typing-directory-toggle" aria-expanded={directoryOpen} aria-controls="lab-notebook-directory lab-folder-directory" onClick={() => setDirectoryOpen(value => !value)}><PanelLeft size={16} /><span>Notebooks</span></button>
        <span className="lab-workbar-title">{notebook?.title || 'Lab'}</span>
        <LessonContext canLeave={canLeave} />
      </header>
      <aside hidden={!directoryOpen} id="lab-folder-directory" className="lab-folder-pane" aria-label="Notebook folders">
        <div className="lab-folder-heading"><span className="lab-folder-brand"><NotebookText size={20} /></span><div><strong>Jupy</strong><small>{new URLSearchParams(window.location.search).has('learning_context') ? 'Course experiment' : 'Independent experiments'}</small></div></div><div className="lab-folder-section-label">Folders</div>
        <button type="button" className={`lab-folder-item ${!selectedFolder ? 'active' : ''}`} aria-pressed={!selectedFolder} onClick={() => setSelectedFolder('')}><span className="lab-folder-name"><Layers size={15} />All notebooks</span><span className="lab-folder-count">{directory?.notebook_count ?? '—'}</span></button>
        <NotebookFolderTree folders={folders} selected={selectedFolder} onSelect={setSelectedFolder} />
      </aside>
      <section className="lab-workspace" aria-label="Notebook editor">
      {notebooksError && <div className="lab-runtime-error" role="alert"><span>{notebooksError}</span><button type="button" onClick={onRetryNotebooks}>Retry opening Notebook</button></div>}
      {notebook ? <>
      <div className="lab-toolbar notebook-toolbar">
        <div className="lab-toolbar-leading"><div className="lab-file"><NotebookText size={15} /><span>{notebook.title}</span><span className="lab-title-save-state" role="status">{persistenceState === 'saving' ? 'Saving…' : persistenceState === 'saved' ? 'Saved' : 'Unsaved'}</span></div></div>
        <div className="lab-toolbar-actions" role="toolbar" aria-label="Notebook actions">
          <button
            className={`lab-icon-button ${persistenceState === 'unsaved' || persistenceState === 'error' ? 'lab-save-pending' : ''}`}
            type="button"
            title={persistenceState === 'saving' ? 'Saving workspace' : 'Save workspace draft'}
            aria-label={persistenceState === 'saving' ? 'Saving workspace' : 'Save workspace draft'}
            onClick={() => void saveWorkspace()}
            disabled={saveConflict || editingBlocked || runtimeBusy}
          ><Save size={15} /></button>
          <button className="lab-icon-button" type="button" title="Insert code cell below" aria-label="Insert code cell below" disabled={editingBlocked || runtimeBusy} onClick={() => appendCell('code', true)}><Plus size={16} /></button>
          <button className="lab-icon-button" type="button" title="Run selected code cell" aria-label="Run selected code cell" disabled={saveConflict || !activeCell || activeCell.cell_type !== 'code' || !activeCell.source.trim() || editingBlocked || runtimeBusy} onClick={() => activeCell && void runCell(activeCell.id)}><Play size={16} /></button>
          <div className="lab-type-picker"><WorkbenchMenu label="Selected cell type" icon={<><span>{activeCell?.cell_type || 'Cell'}</span><ChevronDown size={12} /></>}>{(['code', 'markdown', 'raw'] as const).map(type => <button type="button" key={type} aria-pressed={activeCell?.cell_type === type} disabled={!activeCell || editingBlocked || runtimeBusy} onClick={() => changeActiveType(type)}>{type === 'code' ? 'Code' : type === 'markdown' ? 'Markdown' : 'Raw'}</button>)}</WorkbenchMenu></div>
          <span className={`runtime-indicator runtime-${runtimeState}`} role="status"><span />{runtimeState === 'running' ? 'Python · Running' : runtimeState === 'ready' ? 'Python · Idle' : runtimeState === 'starting' ? 'Starting…' : 'Kernel offline'}</span>
          <WorkbenchMenu label="More Notebook actions" icon={<MoreHorizontal size={18} />}>
          <button className="lab-icon-button" type="button" title="Cut cell" aria-label="Cut cell" disabled={!activeCell || cells.length === 1 || editingBlocked || runtimeBusy} onClick={() => copyActiveCell(true)}><Scissors size={16} /></button>
          <button className="lab-icon-button" type="button" title="Copy cell" aria-label="Copy cell" disabled={!activeCell || editingBlocked || runtimeBusy} onClick={() => copyActiveCell()}><Copy size={16} /></button>
          <button className="lab-icon-button" type="button" title="Paste cell below" aria-label="Paste cell below" disabled={!copiedCell || editingBlocked || runtimeBusy} onClick={pasteCell}><ClipboardPaste size={16} /></button>
          <span className="lab-toolbar-divider" aria-hidden="true" />

          <button className="lab-icon-button" type="button" title="Stop kernel" aria-label="Stop kernel" disabled={!kernelRef.current || persistenceState === 'saving'} onClick={() => void stopKernel()}><Square size={15} /></button>
          <button className="lab-icon-button" type="button" title="Restart kernel" aria-label="Restart kernel" disabled={editingBlocked || runtimeBusy} onClick={() => void restartKernel()}><RotateCcw size={16} /></button>
          <button className="lab-icon-button" type="button" title="Run all code cells" aria-label="Run all code cells" disabled={saveConflict || editingBlocked || runtimeBusy || cells.every((cell) => cell.cell_type !== 'code')} onClick={() => void runAll()}><ChevronsRight size={18} /></button>
          <button type="button" className="lab-icon-button lab-text-action lab-download-action" title={persistenceState === 'saved' ? 'Download this Notebook as .ipynb' : 'Download current content, including unsaved changes'} onClick={() => {
            setDownloadError('')
            setDownloadNotice('')
            try {
              const includesUnsavedChanges = persistenceState !== 'saved'
              const filename = downloadNotebook(notebookSnapshot(notebook, cellsRef.current), includesUnsavedChanges)
              setDownloadNotice(`Download requested: ${filename}.${includesUnsavedChanges ? ' Includes unsaved changes; the database has not been changed.' : ' Saved content; the database has not been changed.'}`)
            } catch (error) {
              setDownloadError(error instanceof Error ? error.message : 'Unable to download Notebook. Try Download again.')
            }
          }} disabled={notebookOpening || runtimeBusy || persistenceState === 'loading' || persistenceState === 'saving' || mutationBusy}><Download size={14} /> Download</button>
          <button type="button" className="lab-icon-button lab-text-action" onClick={() => setSaveAsOpen(true)} disabled={editingBlocked || runtimeBusy}>Save as</button>
          <button type="button" className="lab-icon-button" aria-label="Back to Notebook Explorer" onClick={() => setDirectoryOpen(true)} disabled={editingBlocked || runtimeBusy}><ArrowLeft size={15} /></button>
            <p className="lab-menu-help">Run saves all Notebook edits and results automatically. Saved results do not restore kernel variables.</p>
          </WorkbenchMenu>
        </div>
      </div>
      {downloadNotice && <div className="lab-download-notice" role="status">{downloadNotice}</div>}
      {downloadError && <div className="lab-runtime-error" role="alert">Download failed: {downloadError}</div>}
      {runtimeError && <div className="lab-runtime-error" role="alert"><AlertCircle size={15} />{runtimeError}</div>}
      {persistenceError && <div className="lab-runtime-error" role="alert"><AlertCircle size={15} />{persistenceError}{saveConflict ? <><span>Download or Save as to keep your local copy.</span><button type="button" disabled={editingBlocked || runtimeBusy} onClick={() => notebook && onSelectNotebook?.(notebook.path)}>Reopen saved Notebook</button></> : <button type="button" disabled={editingBlocked || runtimeBusy} onClick={() => void saveWorkspace()}>Retry Save</button>}</div>}
      {saveAsOpen && <form className="lab-save-as" onSubmit={(event) => void saveNotebookAs(event)}><label htmlFor="lab-save-as-filename">Save a workspace copy</label><input id="lab-save-as-filename" autoFocus value={saveAsFilename} onChange={(event) => setSaveAsFilename(event.target.value)} placeholder="notebook-name.ipynb" /><button type="submit" disabled={!saveAsFilename.trim() || editingBlocked || runtimeBusy}>{persistenceState === 'saving' ? 'Saving…' : 'Save Notebook'}</button><button type="button" onClick={() => setSaveAsOpen(false)}>Cancel</button></form>}

      {deletedCells.length > 0 && <div className="lab-deletion-notice" role="status"><span>{deletedCells.length} cell{deletedCells.length === 1 ? '' : 's'} removed. Undo is available while this Notebook stays open.</span><button type="button" onClick={undoCellDeletion} disabled={editingBlocked || runtimeBusy}><RotateCcw size={14} />Undo deletion</button></div>}
      <div className="lab-cell-list">
        {cells.map((cell, index) => (
          <article className={`lab-cell lab-cell-${cell.cell_type} ${activeCellId === cell.id ? 'active' : ''}`} key={cell.id} onClick={(event) => { if (!(event.target as HTMLElement).closest('button')) setActiveCellId(cell.id) }} onFocus={() => setActiveCellId(cell.id)}>
            <div className="lab-cell-input">
              <div className="lab-cell-gutter" title={cell.cell_type === 'markdown' && !editingBlocked && !runtimeBusy ? 'Double-click MD gutter to edit Markdown' : undefined} onDoubleClick={() => {
                if (cell.cell_type !== 'markdown' || editingBlocked || runtimeBusy) return
                setActiveCellId(cell.id)
                setMarkdownEditRequest((current) => ({ cellId: cell.id, sequence: current.sequence + 1 }))
              }}>
                <span className="cell-type-label">{cell.cell_type === 'code' ? 'Code' : cell.cell_type === 'markdown' ? 'MD' : 'Raw'}</span>
                {cell.cell_type === 'code' && <span className="cell-gutter-label">[{cell.execution_count ?? ' '}]</span>}
              </div>
              <div className="lab-cell-body">
                {cell.cell_type === 'markdown' ? <MarkdownCell editRequest={markdownEditRequest.cellId === cell.id ? markdownEditRequest.sequence : 0} source={cell.source} label={`markdown cell ${index + 1}`} disabled={editingBlocked || runtimeBusy} onChange={(source) => updateCell(cell.id, source)} onSave={() => void saveWorkspace()} /> : <NotebookCellEditor
                  source={cell.source}
                  cellType={cell.cell_type}
                  label={`${cell.cell_type} cell ${index + 1}`}
                  disabled={editingBlocked || runtimeBusy}
                  onChange={(source) => updateCell(cell.id, source)}
                  onSave={() => void saveWorkspace()}
                  onRun={() => void runCell(cell.id)}
                />}
              </div>
              <div className="lab-cell-actions">
                {cell.cell_type === 'code' && <button className="lab-icon-button" type="button" title="Run cell" aria-label="Run cell" onClick={() => void runCell(cell.id)} disabled={saveConflict || editingBlocked || runtimeBusy}><Play size={14} /></button>}
                {cellHasContent(cell) ? <details className="lab-cell-more"><summary title="More cell actions" aria-label="More cell actions"><MoreHorizontal size={15} /></summary><button className="lab-cell-menu-delete" type="button" onClick={(event) => { event.currentTarget.closest('details')?.removeAttribute('open'); removeCell(cell.id) }} disabled={editingBlocked || runtimeBusy || cells.length === 1}>Delete cell…</button></details> : <button className="lab-icon-button" type="button" title="Delete empty cell" aria-label="Delete empty cell" onClick={() => removeCell(cell.id)} disabled={editingBlocked || runtimeBusy || cells.length === 1}><Trash2 size={14} /></button>}
              </div>
            </div>
            {cell.cell_type === 'code' && <div className="lab-prediction">
              <label htmlFor={`prediction-${cell.id}`}>Your prediction <span>Optional</span></label>
              <textarea id={`prediction-${cell.id}`} value={cell.prediction || ''} maxLength={2000} rows={2}
                placeholder="What do you expect this code to do?"
                disabled={editingBlocked || runtimeBusy}
                onChange={(event) => updatePrediction(cell.id, event.target.value)} />
              {cell.execution?.prediction && <p><strong>Prediction recorded for this run</strong> {cell.execution.prediction}</p>}
            </div>}
            {cell.cell_type === 'code' && <CellResult cell={cell} phase={runningCellId === cell.id ? runtimeState === 'starting' ? 'starting' : 'running' : undefined} saved={persistenceState === 'saved'} />}
            {notebook && cell.cell_type === 'code' && cell.execution && persistenceState === 'saved' && !runtimeBusy &&
              checkpointRef.current.revision !== 'unpersisted' && Array.from(notebook.path).length <= 490 &&
              <a className="lab-mentor-link" target="_blank" rel="noopener noreferrer"
                href={`/learning/mentor/?${new URLSearchParams({ notebook: notebook.path, cell: String(index), version: checkpointRef.current.revision })}`}>
                Ask Mentor about this saved run
              </a>}
          </article>
        ))}
      </div>
      <div className="lab-add-cell">
        <button type="button" disabled={editingBlocked || runtimeBusy} onClick={() => appendCell('code')}><Plus size={14} />Code</button>
        <button type="button" disabled={editingBlocked || runtimeBusy} onClick={() => appendCell('markdown')}><Plus size={14} />Markdown</button>
        {runtimeState === 'running' && <span><LoaderCircle size={14} />Running cell</span>}
        {runtimeState === 'ready' && <span>Kernel ready</span>}
        {runtimeState === 'idle' && <span>Kernel starts on first run</span>}
      </div>

      </> : <div className="lab-editor-empty"><NotebookText size={28} /><h2>Select a Notebook</h2><p>Choose a Notebook from the directory, or create a new one.</p><button className="typing-directory-toggle" onClick={() => setDirectoryOpen(true)}>Open Notebooks</button></div>}
      </section>
      <section hidden={!directoryOpen} id="lab-notebook-directory" className="lab-notes-pane" aria-label="Notebooks">
        <header className="lab-notes-header"><div><h1>Notebooks</h1><small>{selectedFolder.split('/').pop() || 'All notebooks'}</small></div><button className="lab-new-notebook-button" type="button" onClick={() => { setNewNotebookOpen(true); setNewNotebookTitle(''); setNewNotebookError('') }} disabled={!onCreateNotebook || editingBlocked || runtimeBusy}><Plus size={14} /> New</button></header>
        {newNotebookOpen && <form className="lab-new-notebook-form" onSubmit={async (event) => { event.preventDefault(); const title = newNotebookTitle.trim(); if (!title || !onCreateNotebook || mutationBusyRef.current) return; if (!canLeave()) return; mutationBusyRef.current = true; setMutationBusy(true); try { await onCreateNotebook(title); setNewNotebookOpen(false); setNewNotebookTitle(''); setNewNotebookError('') } catch (error) { setNewNotebookError(error instanceof Error ? error.message : 'Unable to create Notebook') } finally { mutationBusyRef.current = false; setMutationBusy(false) } }}><NotebookText size={16} /><input autoFocus maxLength={300} value={newNotebookTitle} onChange={(event) => setNewNotebookTitle(event.target.value)} placeholder="Notebook name" aria-label="Notebook name" /><button type="submit" disabled={!newNotebookTitle.trim() || mutationBusy}>Create</button><button type="button" disabled={mutationBusy} onClick={() => setNewNotebookOpen(false)}>Cancel</button>{newNotebookError && <span role="alert">{newNotebookError}</span>}</form>}
        <div className="lab-notebook-picker" aria-label="Available notebooks">
            <div className="lab-picker-heading">
              <span>Directory</span>
              <small>{notebooksLoading || directoryError ? '—' : directory?.total ?? 0} matching</small>
            </div>
            <div className="lab-directory-tools"><label className="lab-directory-search"><Search size={14} /><input maxLength={200} value={directoryQuery} onChange={(event) => setDirectoryQuery(event.target.value)} placeholder="Search notebook titles" aria-label="Search notebook titles" /></label><label className="lab-directory-sort">Sort<select value={directorySort} onChange={(event) => setDirectorySort(event.target.value as NotebookSort)}><option value="updated">Last edited</option><option value="title">Title</option></select></label></div>
        {notebooksLoading ? (
          <div className="lab-empty-detail lab-catalog-status">{directorySlow ? 'Notebook directory is taking longer…' : 'Loading Notebooks…'}</div>
        ) : directoryError ? (
          <div className="lab-empty-detail lab-catalog-status lab-catalog-error" role="alert">
            <span>{directoryError}</span>
            <button type="button" onClick={() => setDirectoryRetry((value) => value + 1)}>Retry directory</button>
          </div>
        ) : directory && directory.notebook_count > 0 ? (
          <>
            <div className="lab-notebook-directory" aria-label="Notebook directory">
              {visibleDirectoryEntries.map((entry) => (
                <div className={`lab-notebook-row ${entry.path === notebook?.path ? 'active' : ''}`} key={entry.path}>
                  {renamingPath === entry.path ? <><span className="lab-notebook-row-icon" aria-hidden="true"><NotebookText size={16} /></span><form className="lab-notebook-rename-form" onSubmit={async (event) => { event.preventDefault(); const filename = renameTitle.trim(); if (filename && onRenameNotebook && !mutationBusyRef.current) { if (entry.path === notebook?.path && (unsaved || editingBlocked || runtimeBusy)) { setRenameError('Save this Notebook and stop execution before renaming it.'); return } mutationBusyRef.current = true; setMutationBusy(true); try { setRenameError(''); await onRenameNotebook(entry.path, filename, renameVersion); setRenamingPath(''); setRenameTitle('') } catch (error) { setRenameError(error instanceof Error ? error.message : 'Unable to rename Notebook') } finally { mutationBusyRef.current = false; setMutationBusy(false) } } }}><input autoFocus value={renameTitle} onChange={(event) => { setRenameTitle(event.target.value); setRenameError('') }} aria-label={`Rename file ${entry.path}`} /><button type="submit" disabled={!renameTitle.trim() || mutationBusy}>Save</button><button type="button" disabled={mutationBusy} onClick={() => { setRenamingPath(''); setRenameError('') }}>Cancel</button>{renameError && <small className="lab-notebook-rename-error">{renameError}</small>}</form></> : <><button className="lab-notebook-row-open" type="button" disabled={editingBlocked || runtimeBusy} onClick={() => onSelectNotebook?.(entry.path)} aria-label={`Open ${entry.title}`} aria-current={entry.path === notebook?.path ? 'page' : undefined} title={entry.title}><span className="lab-notebook-row-icon" aria-hidden="true"><NotebookText size={16} /></span><span className="lab-notebook-row-copy"><strong>{entry.title}</strong><NotebookEditedAt value={entry.updated_at} /></span></button>{onRenameNotebook && <button className="lab-notebook-rename" type="button" disabled={editingBlocked || runtimeBusy} onClick={() => { setRenamingPath(entry.path); setRenameVersion(entry.path === notebook?.path ? checkpointRef.current.revision : entry.updated_at || 'unpersisted'); setRenameTitle(entry.path.split('/').pop() || `${entry.title}.ipynb`) }} aria-label={`Rename file ${entry.path}`}>Rename</button>}</>}
                </div>
              ))}
            </div>
            {!visibleDirectoryEntries.length && <div className="lab-directory-empty"><Search size={16} />No notebooks match this search.</div>}
            {directoryPageCount > 1 && <div className="lab-directory-pagination"><button type="button" onClick={() => setDirectoryPage((page) => Math.max(0, page - 1))} aria-label="Previous Notebook page" disabled={directoryPage === 0}><ChevronLeft size={14} /></button><span>Page {directoryPage + 1} of {directoryPageCount}</span><button type="button" onClick={() => setDirectoryPage((page) => Math.min(directoryPageCount - 1, page + 1))} aria-label="Next Notebook page" disabled={directoryPage === directoryPageCount - 1}><ChevronRight size={14} /></button></div>}
          </>
        ) : (
          <div className="lab-empty-detail">
            <NotebookText size={18} aria-hidden="true" />
            <span>No Notebooks are available yet.</span>
          </div>
        )}
        </div>
      </section>
    </section>
  )
}

export default LabWorkspace
