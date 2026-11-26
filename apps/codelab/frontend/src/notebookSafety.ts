import type { CellOutput, LabNotebook, NotebookCell } from './labTypes'

const MAX_CELL_OUTPUT_BYTES = 16_000
const MAX_CELL_OUTPUTS = 50

export function boundedOutputs(outputs: CellOutput[], next: CellOutput): CellOutput[] {
  const encoder = new TextEncoder()
  const used = outputs.reduce((total, output) => total + encoder.encode(output.text).length, 0)
  if (used >= MAX_CELL_OUTPUT_BYTES || outputs.length >= MAX_CELL_OUTPUTS) return outputs
  const remaining = MAX_CELL_OUTPUT_BYTES - used
  const bytes = encoder.encode(next.text)
  if (bytes.length <= remaining) return [...outputs, next]
  const suffix = '\n[Output truncated]'
  const prefix = new TextDecoder().decode(bytes.slice(0, Math.max(0, remaining - encoder.encode(suffix).length)), { stream: true })
  return [...outputs, { ...next, text: prefix + suffix.slice(0, remaining) }]
}

export function notebookSnapshot(notebook: LabNotebook, cells: (NotebookCell & { id: string })[]): LabNotebook {
  const { updated_at: _updatedAt, ...record } = notebook
  return { ...record, cells: cells.map(({ id: _id, ...cell }) => ({ ...cell, output_count: cell.outputs?.length ?? cell.output_count })) }
}

export function notebookFilename(requested: string): string {
  if (/[\u0000-\u001f]/.test(requested)) throw new Error('Enter a filename without control characters')
  const stem = requested.trim().replace(/\.ipynb$/i, '').trim()
  if (!stem || /[\\/\u0000-\u001f:]/.test(stem) || stem === '.' || stem === '..') {
    throw new Error('Enter a filename without folders or control characters')
  }
  if ([...stem].length > 300) throw new Error('Notebook filenames must use at most 300 characters')
  return `${stem}.ipynb`
}

export function editIndentation(source: string, start: number, end: number, unindent: boolean): { source: string; start: number; end: number } {
  if (start === end && !unindent) {
    return { source: `${source.slice(0, start)}    ${source.slice(end)}`, start: start + 4, end: start + 4 }
  }
  const lineStart = source.lastIndexOf('\n', Math.max(0, start - 1)) + 1
  const selectedEnd = end > lineStart && source[end - 1] === '\n' ? end - 1 : end
  const lineEndIndex = source.indexOf('\n', selectedEnd)
  const lineEnd = lineEndIndex === -1 ? source.length : lineEndIndex
  const lines = source.slice(lineStart, lineEnd).split('\n')
  if (unindent) {
    let removedBeforeStart = 0
    let removedTotal = 0
    const nextLines = lines.map((line, index) => {
      const removed = Math.min(4, line.match(/^ */)?.[0].length || 0)
      if (index === 0) removedBeforeStart = removed
      removedTotal += removed
      return line.slice(removed)
    })
    return { source: `${source.slice(0, lineStart)}${nextLines.join('\n')}${source.slice(lineEnd)}`, start: Math.max(lineStart, start - removedBeforeStart), end: Math.max(lineStart, end - removedTotal) }
  }
  return { source: `${source.slice(0, lineStart)}${lines.map((line) => `    ${line}`).join('\n')}${source.slice(lineEnd)}`, start: start + 4, end: end + lines.length * 4 }
}
