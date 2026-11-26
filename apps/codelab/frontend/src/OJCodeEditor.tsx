import { memo, useMemo, useRef } from 'react'
import CodeMirror from '@uiw/react-codemirror'
import { ojEditorExtensions } from './ojEditor'

const basicSetup = { autocompletion: true, foldGutter: true, highlightActiveLine: true, highlightActiveLineGutter: true, bracketMatching: true, closeBrackets: true, indentOnInput: true }

export default memo(function OJCodeEditor({ language = 'python', source, disabled, onChange, onCursor, onSave, onRun, onSubmit }: {
  language?: 'python' | 'go'; source: string; disabled: boolean; onChange: (source: string) => void; onCursor: (position: { line: number; column: number }) => void;
  onSave: () => void; onRun: () => void; onSubmit: () => void
}) {
  const actions = useRef({ onSave, onRun, onSubmit })
  actions.current = { onSave, onRun, onSubmit }
  // Stable extensions preserve the editor configuration and cursor during parent status updates.
  const extensions = useMemo(() => ojEditorExtensions({ save: () => actions.current.onSave(), run: () => actions.current.onRun(), submit: () => actions.current.onSubmit() }, language), [language])
  return <CodeMirror className="acm-code-mirror" value={source} editable={!disabled} height="100%" extensions={extensions} basicSetup={basicSetup}
    onChange={onChange} onUpdate={(update) => { if (update.selectionSet || update.docChanged) { const line = update.state.doc.lineAt(update.state.selection.main.head); onCursor({ line: line.number, column: update.state.selection.main.head - line.from + 1 }) } }} />
})
