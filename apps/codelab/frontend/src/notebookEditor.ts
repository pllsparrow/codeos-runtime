import { python } from '@codemirror/lang-python'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { indentUnit, syntaxHighlighting } from '@codemirror/language'
import { EditorState, Prec } from '@codemirror/state'
import { EditorView, keymap, type Command } from '@codemirror/view'
import { notebookHighlightStyle } from './codeHighlightStyle.ts'
import { editIndentation } from './notebookSafety.ts'

export { notebookHighlightStyle } from './codeHighlightStyle.ts'

export function notebookLanguage(cellType: string) {
  if (cellType === 'code') return python()
  if (cellType === 'markdown') return markdown({
    base: markdownLanguage,
    codeLanguages: (info) => /^(python|py|python3)(\s|$)/i.test(info) ? python().language : null,
    completeHTMLTags: false,
    pasteURLAsLink: false,
  })
  return []
}

export function notebookIndentCommand(unindent: boolean): Command {
  return (view) => {
    if (view.state.readOnly) return true
    const selection = view.state.selection.main
    const source = view.state.doc.toString()
    const edit = editIndentation(source, selection.from, selection.to, unindent)
    if (edit.source !== source) view.dispatch({
      changes: { from: 0, to: source.length, insert: edit.source },
      selection: { anchor: edit.start, head: edit.end },
      userEvent: 'input.indent',
      scrollIntoView: true,
    })
    return true
  }
}

const notebookTheme = EditorView.theme({
  '&': { backgroundColor: 'var(--codeos-surface, #ffffff)', color: 'var(--codeos-ink, #26343c)', fontSize: '13px' },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', lineHeight: '1.6' },
  '.cm-content': { padding: '12px 0', minHeight: '88px', caretColor: 'var(--codeos-accent, #175fbd)' },
  '.cm-line': { padding: '0 14px' },
  '.cm-gutters': { backgroundColor: 'var(--codeos-soft, #f6f8fa)', color: 'var(--codeos-muted, #84929e)', borderRight: '1px solid var(--codeos-border, #e0e6eb)' },
  '.cm-activeLine, .cm-activeLineGutter': { backgroundColor: 'var(--codeos-raised, #f0f0f0)' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection': { backgroundColor: 'var(--codeos-selected, #dce9fb) !important' },
  '.cm-cursor': { borderLeftColor: 'var(--codeos-accent, #175fbd)' },
})

export function notebookEditorExtensions(cellType: string, label: string, actions: { save: () => void; run: () => void }) {
  return [
    notebookLanguage(cellType), notebookTheme, syntaxHighlighting(notebookHighlightStyle),
    indentUnit.of('    '), EditorState.tabSize.of(4), EditorState.allowMultipleSelections.of(false),
    EditorView.lineWrapping,
    EditorView.contentAttributes.of({ 'aria-label': label }),
    Prec.highest(keymap.of([
      { key: 'Tab', preventDefault: true, run: notebookIndentCommand(false) },
      { key: 'Shift-Tab', preventDefault: true, run: notebookIndentCommand(true) },
      { key: 'Mod-s', preventDefault: true, run: () => { actions.save(); return true } },
      { key: 'Shift-Enter', preventDefault: true, run: () => { if (cellType === 'code') actions.run(); return true } },
    ])),
  ]
}
