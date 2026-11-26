import type { NotebookCell } from './labTypes'

export function changeCellType<T extends NotebookCell>(cell: T, type: NotebookCell['cell_type']): T {
  if (cell.cell_type === type) return cell
  return { ...cell, cell_type: type, outputs: [], output_count: 0, execution_count: null, execution: undefined, prediction: undefined }
}

export type DeletedCell<T> = { cell: T; index: number; nextId?: string; previousId?: string }

export function captureDeletedCell<T extends { id: string }>(cells: T[], id: string): DeletedCell<T> | undefined {
  const index = cells.findIndex((cell) => cell.id === id)
  if (index < 0 || cells.length <= 1) return undefined
  return { cell: structuredClone(cells[index]), index, nextId: cells[index + 1]?.id, previousId: cells[index - 1]?.id }
}

export function restoreDeletedCell<T extends { id: string }>(cells: T[], deleted: DeletedCell<T>): T[] {
  if (cells.some((cell) => cell.id === deleted.cell.id)) return cells
  const next = cells.findIndex((cell) => cell.id === deleted.nextId)
  const previous = cells.findIndex((cell) => cell.id === deleted.previousId)
  const index = next >= 0 ? next : previous >= 0 ? previous + 1 : Math.min(deleted.index, cells.length)
  return [...cells.slice(0, index), structuredClone(deleted.cell), ...cells.slice(index)]
}


export function cellHasContent(cell: NotebookCell): boolean {
  return cell.source.length > 0 || !!cell.prediction || (cell.outputs?.length || 0) > 0 || cell.output_count > 0 || cell.execution_count !== null || !!cell.execution
}
