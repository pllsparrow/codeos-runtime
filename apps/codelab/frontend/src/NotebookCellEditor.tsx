import { useMemo, useRef } from 'react'
import CodeMirror from '@uiw/react-codemirror'
import { notebookEditorExtensions } from './notebookEditor'
import { markdownLivePreview } from './markdownLivePreview'

export default function NotebookCellEditor({ source, cellType, label, disabled, onChange, onSave, onRun, livePreview = false }: {
  source: string
  cellType: string
  label: string
  disabled: boolean
  onChange: (source: string) => void
  onSave: () => void
  onRun: () => void
  livePreview?: boolean
}) {
  const actions = useRef({ save: onSave, run: onRun })
  actions.current = { save: onSave, run: onRun }
  const extensions = useMemo(() => notebookEditorExtensions(cellType, label, {
    save: () => actions.current.save(), run: () => actions.current.run(),
  }).concat(livePreview ? markdownLivePreview : []), [cellType, label, livePreview])

  return <CodeMirror
    className="lab-cell-editor"
    value={source}
    editable={!disabled}
    readOnly={disabled}
    extensions={extensions}
    basicSetup={{ autocompletion: false, foldGutter: false, lineNumbers: !livePreview, highlightActiveLine: !livePreview, highlightActiveLineGutter: !livePreview }}
    placeholder={cellType === 'code' ? 'Write Python code...' : cellType === 'markdown' ? 'Write Markdown...' : 'Write plain text...'}
    onChange={onChange}
  />
}
