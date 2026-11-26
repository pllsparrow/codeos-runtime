import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react'
import { Check, ChevronDown } from 'lucide-react'

type Language = 'python' | 'go'
const languages: { value: Language; label: string; version: string }[] = [
  { value: 'python', label: 'Python', version: 'Python 3.12' },
  { value: 'go', label: 'Go', version: 'Go 1.26' },
]

export default function OJLanguageMenu({ value, disabled, onChange }: {
  value: Language; disabled: boolean; onChange: (language: Language) => void
}) {
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const root = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const options = useRef<(HTMLButtonElement | null)[]>([])
  const id = useId()
  const selected = languages.findIndex(language => language.value === value)

  useEffect(() => {
    if (open) options.current[active]?.focus()
  }, [open, active])
  useEffect(() => {
    if (disabled) setOpen(false)
  }, [disabled])
  useEffect(() => {
    if (!open) return
    const dismiss = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('pointerdown', dismiss)
    return () => document.removeEventListener('pointerdown', dismiss)
  }, [open])

  const show = (index = selected) => { setActive(index); setOpen(true) }
  const close = () => { setOpen(false); trigger.current?.focus() }
  const navigate = (event: KeyboardEvent) => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close() }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      setActive(index => (index + (event.key === 'ArrowDown' ? 1 : languages.length - 1)) % languages.length)
    }
    if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault(); setActive(event.key === 'Home' ? 0 : languages.length - 1)
    }
  }

  return <div className="oj-language-menu" ref={root} onBlur={event => {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOpen(false)
  }}>
    <button ref={trigger} type="button" className={`oj-language-trigger${open ? ' is-open' : ''}`}
      aria-label="Programming language" aria-haspopup="listbox" aria-expanded={open} aria-controls={open ? id : undefined}
      disabled={disabled} onClick={() => open ? close() : show()} onKeyDown={event => {
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault(); show(event.key === 'ArrowUp' ? languages.length - 1 : selected)
        }
      }}>
      <span>{languages[selected].label}</span><ChevronDown size={14} aria-hidden="true" />
    </button>
    {open && <div className="oj-language-popover" id={id} role="listbox" aria-label="Programming language" onKeyDown={navigate}>
      {languages.map((language, index) => <button key={language.value} type="button" role="option"
        className="oj-language-option" aria-selected={value === language.value} tabIndex={active === index ? 0 : -1}
        ref={element => { options.current[index] = element }}
        onFocus={() => setActive(index)} onClick={() => { close(); onChange(language.value) }}>
        <span className="oj-language-option-label">{language.label}</span>
        <span className="oj-language-version">{language.version}</span>
        <Check className="oj-language-check" size={13} aria-hidden="true" />
      </button>)}
    </div>}
  </div>
}
