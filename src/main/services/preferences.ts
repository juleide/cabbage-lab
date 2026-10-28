import { readFile, writeFile, rename } from 'node:fs/promises'
import type { DisplayRange, Theme } from '../../shared/controller'
import { DEFAULT_DISPLAY_RANGE, validateDisplayRange } from '../../shared/display'

interface Preferences { version: 1; theme: Theme; displayRange: DisplayRange }

/** One atomic write queue prevents independent preference fields from overwriting each other. */
export class UIPreferences {
  private value: Preferences = { version: 1, theme: 'light', displayRange: { ...DEFAULT_DISPLAY_RANGE } }
  private pending = Promise.resolve()
  constructor(private readonly filename: string) {}
  get theme() { return this.value.theme }
  get displayRange() { return { ...this.value.displayRange } }

  async load() {
    try {
      const saved = JSON.parse(await readFile(this.filename, 'utf8'))
      if (['light', 'dark', 'blue'].includes(saved.theme)) this.value.theme = saved.theme
      if (saved.displayRange) {
        try { this.value.displayRange = validateDisplayRange(saved.displayRange) } catch { /* Default range. */ }
      }
    } catch { /* New installation or unreadable preference: safe UI defaults. */ }
  }

  private update(patch: Partial<Preferences>) {
    const result = this.pending.then(async () => {
      const next = { ...this.value, ...patch }
      await writeFile(this.filename + '.tmp', JSON.stringify(next, null, 2), 'utf8')
      await rename(this.filename + '.tmp', this.filename)
      this.value = next
    })
    this.pending = result.catch(() => {})
    return result
  }

  setTheme(value: unknown) {
    if (typeof value !== 'string' || !['light', 'dark', 'blue'].includes(value)) throw new Error('无效的主题')
    return this.update({ theme: value as Theme })
  }
  setDisplayRange(value: unknown) { return this.update({ displayRange: validateDisplayRange(value) }) }
  flush() { return this.pending }
}
