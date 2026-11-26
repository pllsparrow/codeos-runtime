import { useEffect, useRef, useState } from 'react'
import NotebookCellEditor from './NotebookCellEditor'
import MarkdownPreview from './MarkdownPreview'

export default function MarkdownCell({ source, label, disabled, editRequest = 0, onChange, onSave }: {
  source: string; label: string; disabled: boolean; editRequest?: number; onChange: (source: string) => void; onSave: () => void
}) {
  const [editing, setEditing] = useState(!source.trim())
  const editorRef = useRef<HTMLDivElement>(null)
  const previewRef = useRef<HTMLDivElement>(null)
  const lastEditRequest = useRef(0)
  const beginEditing = () => { if (!disabled) setEditing(true) }
  const finishEditing = () => {
    setEditing(false)
    requestAnimationFrame(() => previewRef.current?.focus())
  }
  useEffect(() => {
    if (lastEditRequest.current === editRequest) return
    lastEditRequest.current = editRequest
    if (editRequest > 0 && !disabled) {
      setEditing(true)
      editorRef.current?.querySelector<HTMLElement>('.cm-content')?.focus()
    }
  }, [editRequest, disabled])
  useEffect(() => {
    if (editing && !disabled) editorRef.current?.querySelector<HTMLElement>('.cm-content')?.focus()
  }, [editing, disabled])

  return <section className={`lab-markdown-cell ${editing ? 'is-editing' : 'is-reading'}`} aria-label={label}>
    <div className="lab-markdown-mode">
      <span>{editing ? 'Markdown source' : 'Markdown'}</span>
      <button type="button" disabled={disabled} aria-label={`${editing ? 'Done editing' : 'Edit'} ${label}`} onClick={editing ? finishEditing : beginEditing}>{editing ? 'Done' : 'Edit'}</button>
    </div>
    {!editing && <div ref={previewRef} className="lab-markdown-reading" tabIndex={0} role="group" aria-label={`${label} preview; Enter to edit`} onKeyDown={(event) => {
      if (event.target !== event.currentTarget || event.key !== 'Enter') return
      event.preventDefault()
      beginEditing()
    }} onDoubleClick={(event) => {
      if ((event.target as HTMLElement).closest('a, button, pre, code')) return
      beginEditing()
    }}>
      {source.trim() ? <MarkdownPreview source={source} /> : <p className="lab-markdown-empty">Empty Markdown cell · Enter to edit</p>}
    </div>}
    {/* Keep the editor mounted so mode changes preserve selection and undo history. */}
    <div ref={editorRef} hidden={!editing} onKeyDownCapture={(event) => {
      if (disabled || event.nativeEvent.isComposing) return
      if (event.key === 'Escape' || event.key === 'Enter' && event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey) {
        // Let editor completion/search overlays handle Escape before leaving the cell.
        if (event.key === 'Escape' && editorRef.current?.querySelector('.cm-tooltip, .cm-panel')) return
        event.preventDefault()
        event.stopPropagation()
        finishEditing()
      }
    }}>
      <NotebookCellEditor source={source} cellType="markdown" label={label} disabled={disabled} onChange={onChange} onSave={onSave} onRun={() => {}} />
    </div>
  </section>
}
