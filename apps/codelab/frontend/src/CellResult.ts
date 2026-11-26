import { createElement as h } from 'react'
import type { NotebookCell } from './labTypes'

export function resultSourceChanged(cell: NotebookCell): boolean {
  return !!cell.execution && cell.source !== cell.execution.source
}

export default function CellResult({ cell, phase, saved }: { cell: NotebookCell; phase?: 'starting' | 'running'; saved: boolean }) {
  const outputs = cell.outputs || []
  if (!phase && !cell.execution && !outputs.length && cell.execution_count === null) return null
  const status = phase || cell.execution?.status || 'recorded'
  const labels = { starting: 'Starting kernel', running: 'Running', success: 'Success', error: 'Execution error', interrupted: 'Interrupted', timeout: 'Timed out', recorded: 'Recorded output' }
  const execution = !phase ? cell.execution : undefined
  const changed = resultSourceChanged(cell)
  return h('section', { className: `lab-result lab-result-${status}`, 'aria-label': 'Cell execution result', 'aria-busy': !!phase },
    h('div', { className: 'lab-result-content' },
      outputs.length ? h('pre', { className: 'lab-result-output', tabIndex: 0, 'aria-label': 'Execution output' }, outputs.map((output, index) => h('span', { key: index, className: `lab-result-text-${output.kind}` }, output.text)))
        : h('p', { className: 'lab-result-empty' }, phase ? 'Waiting for output…' : status === 'success' ? 'No text output' : 'No recorded text output'),
      execution?.message && h('p', { className: 'lab-result-message' }, execution.message),
    ),
    (phase || changed || ['error', 'interrupted', 'timeout'].includes(status) || !saved) && h('div', { className: 'lab-result-alerts' },
      (phase || ['error', 'interrupted', 'timeout'].includes(status)) && h('span', { role: 'status' }, labels[status]),
      changed && h('strong', { className: 'lab-result-stale' }, 'Source changed · run again'),
      !saved && h('span', null, phase ? 'Result is not saved yet' : 'Notebook not saved'),
    ),
    h('details', { className: 'lab-result-details' },
      h('summary', null, 'Execution details'),
      h('div', { className: 'lab-result-footer' },
        h('span', { className: 'lab-result-status', role: 'status' }, labels[status]),
        !phase && cell.execution_count !== null && h('span', { className: 'lab-result-count' }, `Execution [${cell.execution_count}]`),
        execution && h('span', { className: 'lab-result-duration' }, `${(execution.duration_ms / 1000).toFixed(2)} s`),
        execution && h('time', { dateTime: execution.finished_at, title: new Date(execution.finished_at).toLocaleString() }, new Date(execution.finished_at).toLocaleTimeString()),

        h('span', null, phase ? 'Result is not saved yet' : saved ? 'Saved with Notebook' : 'Notebook not saved'),
        phase === 'starting' && cell.execution && h('span', null, 'Previous result kept during startup'),
      ),
    ),
  )
}
