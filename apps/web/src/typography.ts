// Text size and theme preferences. Safari private mode can make localStorage throw, so every
// access is guarded and the app still works (without remembering the choice).

export type TextSize = 'small' | 'standard' | 'large' | 'xlarge'
export type Theme = 'system' | 'dark' | 'light'

export const TEXT_SCALE: Record<TextSize, number> = { small: 0.9, standard: 1, large: 1.125, xlarge: 1.25 }

const KEYS = { size: 'tot_text_size', theme: 'tot_theme' } as const

function read(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function write(key: string, value: string) {
  try {
    localStorage.setItem(key, value)
  } catch {
    /* applied for this visit only */
  }
}

export function getTextSize(): TextSize {
  const v = read(KEYS.size)
  return v === 'small' || v === 'large' || v === 'xlarge' ? v : 'standard'
}

export function getTheme(): Theme {
  const v = read(KEYS.theme)
  return v === 'dark' || v === 'light' ? v : 'system'
}

/**
 * iOS Dynamic Type: Safari resolves `font: -apple-system-body` to the size the user chose in
 * Settings > Display & Brightness > Text Size. Other browsers reject the value, so we keep 16px.
 */
export function systemBodyPx(): number {
  try {
    if (!CSS.supports('font', '-apple-system-body')) return 16
    const probe = document.createElement('span')
    probe.style.cssText = 'position:absolute;visibility:hidden;font:-apple-system-body'
    document.body.appendChild(probe)
    const px = parseFloat(getComputedStyle(probe).fontSize)
    probe.remove()
    // Clamp so an extreme accessibility size cannot break the layout beyond repair.
    return Number.isFinite(px) ? Math.min(28, Math.max(14, px)) : 16
  } catch {
    return 16
  }
}

function effectiveDark(theme: Theme): boolean {
  return theme === 'dark' || (theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches)
}

export function applyAppearance() {
  const root = document.documentElement
  root.style.setProperty('--base-px', String(systemBodyPx()))
  root.style.setProperty('--text-scale', String(TEXT_SCALE[getTextSize()]))

  const theme = getTheme()
  if (theme === 'system') root.removeAttribute('data-theme')
  else root.setAttribute('data-theme', theme)

  // Colors the browser chrome (iOS status bar, Android address bar) to match the page.
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', effectiveDark(theme) ? '#1d1b1e' : '#f8f4f1')
}

export function setTextSize(size: TextSize) {
  write(KEYS.size, size)
  applyAppearance()
}

export function setTheme(theme: Theme) {
  write(KEYS.theme, theme)
  applyAppearance()
}

/** Call once at startup. Re-applies when the system theme flips or the user returns from changing iOS text size. */
export function initAppearance() {
  applyAppearance()
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyAppearance)
  document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && applyAppearance())
}
