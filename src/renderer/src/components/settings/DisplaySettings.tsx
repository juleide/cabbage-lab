import { useEffect, useState } from 'react'
import type { useDisplayRange } from '../../hooks/useDisplayRange'
import { DEFAULT_DISPLAY_RANGE } from '../../../../shared/display'

export function DisplaySettings({ display, notify }: { display: ReturnType<typeof useDisplayRange>; notify: (message: string) => void }) {
  const [draft, setDraft] = useState(display.range)
  useEffect(() => { setDraft(display.range) }, [display.range])
  async function save(reset = false) {
    const next = reset ? { ...DEFAULT_DISPLAY_RANGE } : draft
    if (await display.save(next)) {
      setDraft(next)
      notify(reset ? '云图显示范围已恢复默认' : '云图显示范围已保存并应用')
    }
  }
  return (
    <section className="settings-card">
      <h3>云图显示</h3>
      <p className="settings-description">设置颜色对应的数值范围，保存后自动记住，下次启动继续使用。</p>
      <form onSubmit={event => { event.preventDefault(); void save() }}>
        <fieldset disabled={!display.ready || display.saving}>
          <div className="settings-fields">
            <label>显示下限<input type="number" min="-65535" max="65535" step="any" required value={Number.isFinite(draft.minimum) ? draft.minimum : ''}
              onChange={event => setDraft({ ...draft, minimum: event.currentTarget.valueAsNumber })} /></label>
            <label>显示上限<input type="number" min="-65535" max="65535" step="any" required value={Number.isFinite(draft.maximum) ? draft.maximum : ''}
              onChange={event => setDraft({ ...draft, maximum: event.currentTarget.valueAsNumber })} /></label>
          </div>
          <div className="settings-actions">
            <button className="btn primary" type="submit">{display.saving ? '保存中…' : '保存并应用'}</button>
            <button className="btn" type="button" onClick={() => { void save(true) }}>恢复默认</button>
          </div>
        </fieldset>
      </form>
      {display.error && <p className="settings-warning" role="alert">{display.error}</p>}
      <p className="settings-hint">使用线性色标，默认范围 0～4095。低于下限或高于上限的点使用端点颜色显示，原始值、修正值和统计值不改变。</p>
      <p className="settings-hint">零点修正后可能出现负值，可将显示下限设为负数观察变化。当前数值尚未标定，不代表实际压力。</p>
    </section>
  )
}
