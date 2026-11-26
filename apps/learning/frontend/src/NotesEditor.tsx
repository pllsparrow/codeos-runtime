import { useEffect, useMemo, useRef } from 'react'
import CodeMirror from '@uiw/react-codemirror'
import { markdown } from '@codemirror/lang-markdown'
import { EditorView, keymap } from '@codemirror/view'
import { notesLivePreview, previewFocus } from './notesLivePreview'

export default function NotesEditor({ value, disabled, onChange, onSave, navigateTo }: { value: string; disabled: boolean; onChange: (value: string) => void; onSave: () => void; navigateTo?: { from: number; request: number } | null }) {
  const save = useRef(onSave); save.current = onSave
  const editor = useRef<EditorView | null>(null)
  useEffect(() => {
    if (!navigateTo || disabled || !editor.current) return
    const view = editor.current, anchor = Math.min(navigateTo.from, view.state.doc.length)
    view.dispatch({ selection: { anchor }, effects: [previewFocus.of(true), EditorView.scrollIntoView(anchor, { y: 'start' })] })
    view.focus()
  }, [navigateTo, disabled])
  const extensions = useMemo(() => [markdown(), EditorView.lineWrapping, ...notesLivePreview,
    EditorView.contentAttributes.of({ 'aria-label': 'Note Markdown editor', 'aria-description': 'Click text to edit. Cmd or Ctrl S saves; Cmd or Ctrl Z undoes.' }),
    keymap.of([{ key: 'Mod-s', run: () => { save.current(); return true } }, { key: 'Ctrl-s', run: () => { save.current(); return true } }]),
    EditorView.theme({ '&': { fontSize: '16px', color: 'var(--notes-editor-ink, #333)', backgroundColor: 'var(--notes-editor-bg, #fffdf4)'  }, '.cm-content': { minHeight: '55vh', padding: '0', fontFamily: 'inherit', lineHeight: '1.8', caretColor: 'var(--notes-editor-ink, #333)' }, '.cm-line': { padding: '0' }, '.cm-scroller': { fontFamily: 'inherit', overflow: 'visible' }, '&.cm-focused': { outline: 'none' } }),
  ], [])
  return <CodeMirror className="notes-source-editor" value={value} editable={!disabled} readOnly={disabled} extensions={extensions} basicSetup={{ autocompletion: false, lineNumbers: false, foldGutter: false, highlightActiveLine: false, highlightActiveLineGutter: false, highlightSelectionMatches: false, syntaxHighlighting: false }} placeholder="Start writing…" onCreateEditor={(view) => { editor.current = view }} onChange={onChange} />
}
