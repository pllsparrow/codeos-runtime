import { useEffect, useState } from 'react'
import { Monitor, Moon, Sun } from 'lucide-react'
import { applyTheme, readTheme, THEME_KEY, themePreference, type ThemePreference } from './theme'

export default function ThemeControl() {
  const [preference, setPreference] = useState<ThemePreference>(readTheme)
  useEffect(() => {
    const media = window.matchMedia?.('(prefers-color-scheme: dark)') || { matches: false, addEventListener() {}, removeEventListener() {} }
    const update = () => applyTheme(preference, media.matches)
    const synchronize = (event: StorageEvent) => {
      if (event.key === THEME_KEY || event.key === null) setPreference(themePreference(event.newValue))
    }
    update()
    media.addEventListener('change', update)
    window.addEventListener('storage', synchronize)
    return () => { media.removeEventListener('change', update); window.removeEventListener('storage', synchronize) }
  }, [preference])
  const choose = (value: ThemePreference) => {
    setPreference(value)
    try { window.localStorage.setItem(THEME_KEY, value) } catch { /* Keep the current tab usable without storage. */ }
  }
  return <div className="theme-control" role="group" aria-label="Color theme">{([
    ['light', 'Light', Sun], ['dark', 'Dark', Moon], ['system', 'System', Monitor],
  ] as const).map(([value, label, Icon]) => <button type="button" key={value} aria-label={`${label} theme`} title={`${label} theme`} aria-pressed={preference === value} onClick={() => choose(value)}><Icon size={15} aria-hidden="true" /><span>{label}</span></button>)}</div>
}
