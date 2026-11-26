import { go } from '@codemirror/lang-go'
import { indentWithTab } from '@codemirror/commands'
import { python } from '@codemirror/lang-python'
import { indentUnit, syntaxHighlighting } from '@codemirror/language'
import { EditorState, Prec } from '@codemirror/state'
import { EditorView, keymap } from '@codemirror/view'
import { notebookHighlightStyle } from './codeHighlightStyle.ts'

export function ojEditorExtensions(actions: { save: () => void; run: () => void; submit: () => void }, language: 'python' | 'go' = 'python') {
  return [language === 'go' ? go() : python(), indentUnit.of(language === 'go' ? '\t' : '    '), EditorState.tabSize.of(4), syntaxHighlighting(notebookHighlightStyle),
    EditorView.contentAttributes.of({ 'aria-label': language === 'go' ? 'Go source code' : 'Python source code' }),
    Prec.highest(keymap.of([
      { key: 'Mod-s', preventDefault: true, run: () => { actions.save(); return true } },
      { key: 'Mod-Enter', preventDefault: true, run: () => { actions.run(); return true } },
      { key: 'Mod-Shift-Enter', preventDefault: true, run: () => { actions.submit(); return true } },
      indentWithTab,
    ])),
  ]
}
