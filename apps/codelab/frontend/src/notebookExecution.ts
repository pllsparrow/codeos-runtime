export async function executeNotebookCells<T extends { cell_type: string; source: string }>(cells: T[], run: (cell: T) => Promise<boolean>, cancelled: () => boolean): Promise<boolean> {
  for (const cell of cells) {
    if (cancelled()) return false
    if (cell.cell_type !== 'code' || !cell.source.trim()) continue
    if (!await run(cell)) return false
  }
  return !cancelled()
}

export const kernelHttpRequest: typeof fetch = (input, init = {}) => {
  const timeout = AbortSignal.timeout(30_000)
  const inherited = init.signal || (input instanceof Request ? input.signal : undefined)
  return fetch(input, { ...init, signal: inherited ? AbortSignal.any([inherited, timeout]) : timeout })
}
