import { createElement as h } from 'react'

export default function NotebookEditedAt({ value }: { value: string | null | undefined }) {
  const date = value ? new Date(value) : null
  if (!date || !Number.isFinite(date.getTime())) return h('small', { className: 'lab-notebook-edited' }, 'Last edited unavailable')
  const label = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).format(date)
  const full = new Intl.DateTimeFormat(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', timeZoneName: 'short', hour12: false }).format(date)
  return h('small', { className: 'lab-notebook-edited' }, 'Last edited ', h('time', { dateTime: date.toISOString(), title: full }, label))
}
