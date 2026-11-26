import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { EditorState } from '@codemirror/state'
import { EditorView, keymap, placeholder } from '@codemirror/view'
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
import { markdown, markdownKeymap } from '@codemirror/lang-markdown'
import { notesLivePreview } from './notesLivePreview'

export function mountEditor(parent: HTMLElement, options: { value: string; onChange: (value: string) => void; onSave: () => void }) {
  const view = new EditorView({
    parent,
    state: EditorState.create({ doc: options.value, extensions: [
      markdown(), history(), EditorView.lineWrapping, ...notesLivePreview,
      placeholder('Start writing…'),
      EditorView.contentAttributes.of({ 'aria-label': 'Your note', 'aria-multiline': 'true', 'aria-describedby': 'writing-help note-error', spellcheck: 'true' }),
      keymap.of([{ key: 'Mod-s', run: () => { options.onSave(); return true } }, { key: 'Ctrl-s', run: () => { options.onSave(); return true } }, ...markdownKeymap, ...defaultKeymap, ...historyKeymap]),
      EditorView.updateListener.of(update => { if (update.docChanged) options.onChange(update.state.doc.toString()) }),
      EditorView.theme({
        '&': { backgroundColor: 'transparent', color: 'var(--body)', fontSize: '16px' },
        '&.cm-focused': { outline: 'none' },
        '.cm-content': { fontFamily: 'inherit', minHeight: '58vh', padding: '0', lineHeight: '1.95', caretColor: 'var(--ink)' },
        '.cm-line': { padding: '0' },
        '.cm-scroller': { fontFamily: 'inherit', overflow: 'visible' },
        '.cm-cursor': { borderLeftColor: 'var(--ink)' },
        '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': { backgroundColor: '#8fc7a233' },
      }),
    ] }),
  })
  return { focus: () => view.focus(), destroy: () => view.destroy() }
}

export function mountReader(parent: HTMLElement, source: string) {
  const root = createRoot(parent)
  root.render(createElement(ReactMarkdown, { remarkPlugins: [remarkGfm], children: source }))
  return { destroy: () => root.unmount() }
}
