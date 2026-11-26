export type ThemePreference = 'system' | 'light' | 'dark'
export const THEME_KEY = 'codeos.theme'
export function themePreference(value: string | null): ThemePreference {
  return value === 'light' || value === 'dark' ? value : 'system'
}
export function readTheme(): ThemePreference {
  try {
    const saved = window.localStorage.getItem(THEME_KEY)
    if (saved !== null) return themePreference(saved)
    const legacy = window.localStorage.getItem('codeos.learning.theme')
    const preference = themePreference(legacy)
    if (legacy !== null) {
      try { window.localStorage.setItem(THEME_KEY, preference) } catch { /* Reading still works when writes are blocked. */ }
    }
    return preference
  } catch { return 'system' }
}
export function applyTheme(preference: ThemePreference, systemDark: boolean) {
  const theme = preference === 'system' ? (systemDark ? 'dark' : 'light') : preference
  document.documentElement.dataset.theme = theme
  document.documentElement.style.colorScheme = theme
}
