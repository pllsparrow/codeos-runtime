import type { LabNotebook } from './labTypes.ts'

export function notebookDownloadFilename(title: string): string {
  const cleaned = title.trim().replace(/\.ipynb$/i, '').replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g, '_')
  let stem = ''
  for (const char of cleaned) {
    if (new TextEncoder().encode(stem + char).length > 180) break
    stem += char
  }
  stem = stem.replace(/[. ]+$/, '') || 'Notebook'
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(stem)) stem = `Notebook-${stem}`
  return `${stem}.ipynb`
}

export function notebookExport(notebook: LabNotebook, includesUnsavedChanges: boolean) {
  return {
    nbformat: 4,
    nbformat_minor: 5,
    metadata: {
      ...(notebook.language ? { language_info: { name: notebook.language } } : {}),
      ...(notebook.language === 'python' ? { kernelspec: { name: 'python3', display_name: 'Python 3', language: 'python' } } : {}),
      codeos: { title: notebook.title, includes_unsaved_changes: includesUnsavedChanges },
    },
    cells: notebook.cells.map((cell, index) => ({
      id: `codeos-cell-${index + 1}`,
      cell_type: cell.cell_type,
      source: cell.source,
      metadata: {
        codeos: {
          ...(cell.prediction !== undefined ? { prediction: cell.prediction } : {}),
          ...(cell.execution ? { execution: structuredClone(cell.execution) } : {}),
          ...(cell.cell_type === 'code' ? { output_kinds: (cell.outputs || []).map((output) => output.kind) } : {}),
        },
      },
      ...(cell.cell_type === 'code' ? {
        execution_count: cell.execution_count,
        // The internal model retains text, not original MIME/error fields. Preserve that text without inventing them.
        outputs: (cell.outputs || []).map((output) => output.kind === 'result'
          ? { output_type: 'display_data', data: { 'text/plain': output.text }, metadata: {} }
          : { output_type: 'stream', name: output.kind === 'error' ? 'stderr' : 'stdout', text: output.text }),
      } : {}),
    })),
  }
}

export function downloadNotebook(notebook: LabNotebook, includesUnsavedChanges: boolean): string {
  const filename = notebookDownloadFilename(notebook.title)
  const content = JSON.stringify(notebookExport(notebook, includesUnsavedChanges), null, 2) + '\n'
  const url = URL.createObjectURL(new Blob([content], { type: 'application/x-ipynb+json;charset=utf-8' }))
  const link = document.createElement('a')
  try {
    link.href = url
    link.download = filename
    link.hidden = true
    document.body.appendChild(link)
    link.click()
  } finally {
    link.remove()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }
  return filename
}
