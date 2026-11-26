export type CellOutput = {
  kind: 'stream' | 'result' | 'error'
  text: string
}

export type NotebookCell = {
  cell_type: 'markdown' | 'code' | 'raw'
  source: string
  execution_count: number | null
  output_count: number
  outputs?: CellOutput[]
  execution?: CellExecution | null
  prediction?: string
}

export type CellExecution = {
  status: 'success' | 'error' | 'interrupted' | 'timeout'
  started_at: string
  finished_at: string
  duration_ms: number
  source: string
  message: string
  prediction?: string
}

export type LabNotebook = {
  path: string
  title: string
  language: string | null
  cells: NotebookCell[]
  updated_at?: string
}
