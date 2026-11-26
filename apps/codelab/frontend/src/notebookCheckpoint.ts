import type { LabNotebook } from './labTypes'

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.entries(value).filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`
  return JSON.stringify(value) ?? 'null'
}

export function notebookMatches(expected: LabNotebook, actual: LabNotebook): boolean {
  const normalize = (notebook: LabNotebook) => ({
    path: notebook.path, title: notebook.title, language: notebook.language,
    cells: notebook.cells.map((cell) => cell.execution ? { ...cell, execution: { ...cell.execution, started_at: new Date(cell.execution.started_at).toISOString(), finished_at: new Date(cell.execution.finished_at).toISOString() } } : cell),
  })
  return canonical(normalize(expected)) === canonical(normalize(actual))
}

export class NotebookCheckpoint {
  private pending?: { body: string; key: string }
  revision: string
  constructor(revision = 'unpersisted') { this.revision = revision }

  async save(notebook: LabNotebook, key: () => string, write: (body: string, key: string) => Promise<{ updated_at: string }>, read: () => Promise<{ notebook: LabNotebook; updated_at: string } | null>): Promise<string> {
    const body = JSON.stringify({ notebook, expected_version: this.revision })
    if (this.pending?.body !== body) this.pending = { body, key: key() }
    const saved = await write(body, this.pending.key)
    const restored = await read()
    if (!restored || saved.updated_at !== restored.updated_at || !notebookMatches(notebook, restored.notebook)) throw Object.assign(new Error('The saved Notebook changed before confirmation. Your local cells and results are kept; download or save a copy before reopening.'), { status: 409 })
    this.revision = saved.updated_at
    this.pending = undefined
    return saved.updated_at
  }
}
