import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { StateEffect, StateField, type EditorState } from '@codemirror/state'
import { syntaxTree } from '@codemirror/language'
import { Decoration, EditorView, ViewPlugin, WidgetType, type DecorationSet } from '@codemirror/view'
import MarkdownPreview from './MarkdownPreview'

export const previewFocus = StateEffect.define<boolean>()
export const previewComposition = StateEffect.define<boolean>()

export type MarkdownBlock = { from: number; to: number; source: string }

export function markdownBlocks(state: EditorState): MarkdownBlock[] {
  const blocks: MarkdownBlock[] = []
  const cursor = syntaxTree(state).cursor()
  if (cursor.firstChild()) do {
    if (cursor.name !== 'LinkReference') blocks.push({ from: cursor.from, to: cursor.to, source: state.sliceDoc(cursor.from, cursor.to) })
  } while (cursor.nextSibling())
  return blocks
}

export function blockIsSelected(state: EditorState, block: MarkdownBlock): boolean {
  return state.selection.ranges.some(({ from, to }) => from <= block.to && to >= block.from)
}

// Use the clicked text node to place the caret near the visible word, without rewriting source.
export function sourceOffsetForText(source: string, text: string, offset: number, scopeFrom = 0): number {
  const found = text ? source.indexOf(text, scopeFrom) : -1
  return found < 0 ? scopeFrom : found + Math.min(Math.max(0, offset), text.length)
}

class PreviewBlock extends WidgetType {
  private root?: Root
  constructor(readonly source: string, readonly references: string) { super() }
  eq(other: PreviewBlock) { return this.source === other.source && this.references === other.references }
  toDOM(view: EditorView) {
    const element = document.createElement('div')
    element.className = 'lab-live-preview-block'
    this.root = createRoot(element)
    this.root.render(createElement(MarkdownPreview, { source: `${this.source}${this.references}`, sourcePositions: true }))
    element.addEventListener('click', (event) => {
      if (view.state.readOnly || event.button !== 0 || event.target instanceof Element && event.target.closest('a, button, input')) return
      const selection = element.ownerDocument.getSelection()
      if (selection && !selection.isCollapsed || event.ctrlKey || event.metaKey || event.altKey) return
      const doc = element.ownerDocument as Document & {
        caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null
      }
      const caret = doc.caretPositionFromPoint?.(event.clientX, event.clientY)
      const range = !caret ? doc.caretRangeFromPoint?.(event.clientX, event.clientY) : null
      const node = caret?.offsetNode || range?.startContainer
      const offset = caret?.offset ?? range?.startOffset ?? 0
      const text = node?.nodeType === Node.TEXT_NODE && element.contains(node) ? node.textContent || '' : ''
      const scopeFrom = Number(node?.parentElement?.closest('[data-source-from]')?.getAttribute('data-source-from') || 0)
      const from = view.posAtDOM(element)
      const anchor = Math.min(view.state.doc.length, from + sourceOffsetForText(this.source, text, offset, scopeFrom))
      event.preventDefault()
      view.dispatch({ selection: { anchor }, effects: previewFocus.of(true) })
      view.focus()
    })
    return element
  }
  destroy() {
    const root = this.root
    // React teardown must not run during the parent React commit.
    if (root) queueMicrotask(() => root.unmount())
  }
  ignoreEvent() { return true }
}

function decorations(state: EditorState, focused: boolean): DecorationSet {
  const references: string[] = []
  const cursor = syntaxTree(state).cursor()
  if (cursor.firstChild()) do {
    if (cursor.name === 'LinkReference') references.push(state.sliceDoc(cursor.from, cursor.to))
  } while (cursor.nextSibling())
  const suffix = references.length ? `\n\n${references.join('\n')}` : ''
  const ranges = []
  for (const block of markdownBlocks(state)) {
    if (block.to <= block.from) continue
    if (!(focused && blockIsSelected(state, block))) {
      ranges.push(Decoration.replace({ block: true, widget: new PreviewBlock(block.source, suffix) }).range(block.from, block.to))
      continue
    }
    // Inline styles update while typing; syntax near the caret stays accessible.
    syntaxTree(state).iterate({ from: block.from, to: block.to, enter(node) {
      if (node.from < block.from || node.to > block.to) return
      const name = node.name
      const heading = /^ATXHeading([1-6])$/.exec(name)
      const className = heading ? `cm-live-heading cm-live-heading-${heading[1]}` : name === 'StrongEmphasis' ? 'cm-live-strong' : name === 'Emphasis' ? 'cm-live-emphasis' : name === 'InlineCode' ? 'cm-live-code' : ''
      if (className && node.to > node.from) ranges.push(Decoration.mark({ class: className }).range(node.from, node.to))
      const marker = name === 'HeaderMark' || name === 'EmphasisMark' || name === 'CodeMark' && node.node.parent?.name === 'InlineCode'
      if (!marker || node.to <= node.from || !state.selection.main.empty) return
      const head = state.selection.main.head
      const to = name === 'HeaderMark' && state.sliceDoc(node.to, node.to + 1) === ' ' ? node.to + 1 : node.to
      if (head < node.from || head > to) ranges.push(Decoration.replace({}).range(node.from, to))
    } })
  }
  return Decoration.set(ranges, true)
}

type PreviewState = { focused: boolean; composing: boolean; decorations: DecorationSet }
export const livePreviewField = StateField.define<PreviewState>({
  create(state) { return { focused: false, composing: false, decorations: decorations(state, false) } },
  update(value, transaction) {
    let { focused, composing } = value
    for (const effect of transaction.effects) {
      if (effect.is(previewFocus)) focused = effect.value
      if (effect.is(previewComposition)) composing = effect.value
    }
    const changed = transaction.docChanged || transaction.selection || focused !== value.focused || composing !== value.composing || syntaxTree(transaction.startState) !== syntaxTree(transaction.state)
    return { focused, composing, decorations: composing ? value.decorations.map(transaction.changes) : changed ? decorations(transaction.state, focused) : value.decorations }
  },
  provide: (field) => EditorView.decorations.from(field, (value) => value.decorations),
})

export const markdownLivePreview = [livePreviewField, ViewPlugin.define((view) => {
  let destroyed = false
  return { destroy() { destroyed = true }, update() {}, syncFocus() {
    queueMicrotask(() => { if (!destroyed) view.dispatch({ effects: previewFocus.of(view.hasFocus) }) })
  }, syncComposition() {
    queueMicrotask(() => { if (!destroyed) view.dispatch({ effects: previewComposition.of(false) }) })
  } }
}, {
  eventHandlers: {
    focus() { this.syncFocus() },
    blur() { this.syncFocus() },
    compositionstart(_event, view) { view.dispatch({ effects: previewComposition.of(true) }) },
    compositionend(_event, view) { this.syncComposition() },
  },
})]
