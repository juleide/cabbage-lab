import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { Theme } from '../domain/types'

const CACHE_KEY = 'lab.theme'
const isTheme = (value: unknown): value is Theme => ['light', 'dark', 'blue'].includes(String(value))

function cachedTheme(): Theme {
  try {
    const value = localStorage.getItem(CACHE_KEY)
    return isTheme(value) ? value : 'light'
  } catch { return 'light' }
}

function cacheTheme(theme: Theme) {
  try { localStorage.setItem(CACHE_KEY, theme) }
  catch { /* Electron's ui.json is authoritative even when the browser cache is unavailable. */ }
}

export function useTheme() {
  const [theme, applyTheme] = useState<Theme>(cachedTheme)
  const [ready, setReady] = useState(false)
  const [themeError, setThemeError] = useState('')
  const revision = useRef(0)

  useEffect(() => {
    let live = true
    const version = revision.current
    const read = async () => {
      try {
        const saved = window.labDesktop ? await window.labDesktop.getTheme() : cachedTheme()
        if (live && revision.current === version && isTheme(saved)) {
          applyTheme(saved)
          cacheTheme(saved)
        }
      } catch {
        if (live) setThemeError('无法读取应用主题配置，暂使用本地缓存的配色')
      } finally {
        if (live) setReady(true)
      }
    }
    void read()
    return () => { live = false }
  }, [])

  // Apply cached colors before painting; the desktop preference is restored asynchronously.
  useLayoutEffect(() => { document.documentElement.dataset.theme = theme }, [theme])

  const setTheme = useCallback(async (next: Theme) => {
    const version = ++revision.current
    try {
      // Main process serializes atomic ui.json writes and waits for them before quitting.
      if (window.labDesktop) await window.labDesktop.setTheme(next)
      else localStorage.setItem(CACHE_KEY, next)
      if (revision.current !== version) return
      cacheTheme(next)
      applyTheme(next)
      setThemeError('')
    } catch {
      if (revision.current === version) setThemeError('主题保存失败，请检查应用配置目录')
    }
  }, [])

  return { theme, setTheme, ready, themeError }
}
