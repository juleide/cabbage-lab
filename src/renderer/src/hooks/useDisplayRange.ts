import { useEffect, useRef, useState } from 'react'
import type { DisplayRange } from '../../../shared/controller'
import { DEFAULT_DISPLAY_RANGE, validateDisplayRange } from '../../../shared/display'

export function useDisplayRange() {
  const [range, setRange] = useState<DisplayRange>({ ...DEFAULT_DISPLAY_RANGE })
  const [ready, setReady] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const pending = useRef(false)
  useEffect(() => {
    let live = true
    const load = async () => {
      try {
        const saved = window.labDesktop ? await window.labDesktop.getDisplayRange()
          : JSON.parse(localStorage.getItem('lab.displayRange') || 'null')
        if (live && saved) setRange(validateDisplayRange(saved))
      } catch { if (live) setError('显示范围读取失败，使用默认范围') }
      finally { if (live) setReady(true) }
    }
    void load()
    return () => { live = false }
  }, [])

  async function save(value: DisplayRange) {
    if (pending.current || !ready) return false
    pending.current = true
    setSaving(true)
    try {
      const checked = validateDisplayRange(value)
      if (window.labDesktop) await window.labDesktop.setDisplayRange(checked)
      else localStorage.setItem('lab.displayRange', JSON.stringify(checked))
      setRange(checked)
      setError('')
      return true
    } catch (reason) { setError((reason as Error).message); return false }
    finally { pending.current = false; setSaving(false) }
  }
  return { range, ready, saving, error, save }
}
