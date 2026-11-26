import { HighlightStyle } from '@codemirror/language'
import { tags } from '@lezer/highlight'

export const notebookHighlightStyle = HighlightStyle.define([
  { tag: tags.keyword, color: 'var(--codeos-code-keyword, #7c3aad)' },
  { tag: [tags.string, tags.special(tags.string)], color: 'var(--codeos-code-string, #26734d)' },
  { tag: [tags.number, tags.bool, tags.null], color: 'var(--codeos-code-number, #175fbd)' },
  { tag: tags.comment, color: 'var(--codeos-code-comment, #667680)', fontStyle: 'italic' },
  { tag: [tags.function(tags.variableName), tags.definition(tags.variableName)], color: 'var(--codeos-code-function, #996018)' },
  { tag: [tags.typeName, tags.className], color: 'var(--codeos-code-type, #0e7784)' },
  { tag: tags.operator, color: 'var(--codeos-code-operator, #45679a)' },
  { tag: tags.punctuation, color: 'var(--codeos-code-punctuation, #61717d)' },
  { tag: tags.heading, color: 'var(--codeos-code-number, #175fbd)', fontWeight: '700' },
  { tag: tags.strong, color: 'var(--codeos-code-keyword, #7c3aad)', fontWeight: '700' },
  { tag: tags.emphasis, color: 'var(--codeos-code-keyword, #7c3aad)', fontStyle: 'italic' },
  { tag: [tags.link, tags.url], color: 'var(--codeos-code-number, #126c9d)', textDecoration: 'underline' },
  { tag: tags.monospace, color: 'var(--codeos-code-string, #26734d)' },
])
