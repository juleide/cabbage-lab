import { useEffect, useState } from 'react'
import type { DisplayRange } from '../../../../shared/controller'
import type { useDisplayRange } from '../../hooks/useDisplayRange'
import { COLOR_RANGE_BOUNDS, DEFAULT_DISPLAY_RANGE, validateColorRange } from '../../../../shared/display'
import { ColorRangeSelector } from './ColorRangeSelector'
import '../../styles/color-range.css'

interface Fields { minimum: string; maximum: string }
const fieldsFor = (value: DisplayRange): Fields => ({ minimum: String(value.minimum), maximum: String(value.maximum) })

function parseFields(fields: Fields): { value: DisplayRange | null; error: string } {
  if (!fields.minimum.trim() || !fields.maximum.trim()) return { value: null, error: '请填写显示上下限' }
  try {
    return { value: validateColorRange({ minimum: Number(fields.minimum), maximum: Number(fields.maximum) }), error: '' }
  } catch (reason) { return { value: null, error: (reason as Error).message } }
}

export function DisplaySettings({ display, notify }: { display: ReturnType<typeof useDisplayRange>; notify: (message: string) => void }) {
  const [draft, setDraft] = useState(display.range)
  const [fields, setFields] = useState(() => fieldsFor(display.range))
  const validation = parseFields(fields)
  const disabled = !display.ready || display.saving
  const dirty = !validation.value || validation.value.minimum !== display.range.minimum || validation.value.maximum !== display.range.maximum

  useEffect(() => {
    setDraft(display.range)
    setFields(fieldsFor(display.range))
  }, [display.range])

  function changeSlider(value: DisplayRange) {
    setDraft(value)
    setFields(fieldsFor(value))
  }

  function changeField(endpoint: keyof Fields, text: string) {
    const next = { ...fields, [endpoint]: text }
    setFields(next)
    const checked = parseFields(next)
    if (checked.value) setDraft(checked.value)
  }

  async function save(reset = false) {
    const next = reset ? { ...DEFAULT_DISPLAY_RANGE } : validation.value
    if (!next) return
    if (await display.save(next)) {
      setDraft(next)
      setFields(fieldsFor(next))
      notify(reset ? '云图显示范围已恢复默认' : '云图显示范围已保存并应用')
    }
  }

  return (
    <section className="settings-card">
      <h3>云图显示</h3>
      <p className="settings-description">滑条刻度固定为 −4095～4095，在其中选择显示上下限。保存后刻度和手柄位置保持不变。</p>
      <form noValidate onSubmit={event => { event.preventDefault(); void save() }}>
        <fieldset disabled={disabled}>
          <ColorRangeSelector value={draft} disabled={disabled || !!validation.error} onChange={changeSlider} />
          <details className="color-range-precise">
            <summary>精确设置<span>在固定范围内输入负数或小数</span></summary>
            <div className="settings-fields">
              <label>显示下限<input type="number" min={COLOR_RANGE_BOUNDS.minimum} max={COLOR_RANGE_BOUNDS.maximum} step="any" value={fields.minimum}
                aria-invalid={!!validation.error} aria-describedby={validation.error ? 'range-validation' : undefined}
                onChange={event => changeField('minimum', event.currentTarget.value)} /></label>
              <label>显示上限<input type="number" min={COLOR_RANGE_BOUNDS.minimum} max={COLOR_RANGE_BOUNDS.maximum} step="any" value={fields.maximum}
                aria-invalid={!!validation.error} aria-describedby={validation.error ? 'range-validation' : undefined}
                onChange={event => changeField('maximum', event.currentTarget.value)} /></label>
            </div>
          </details>
          {validation.error && <p className="settings-warning" id="range-validation" role="alert">{validation.error}</p>}
          <div className="settings-actions">
            <button className="btn primary" type="submit" disabled={!!validation.error}>{display.saving ? '保存中…' : '保存并应用'}</button>
            <button className="btn" type="button" onClick={() => { void save(true) }}>恢复默认</button>
            <span className="color-range-save-state" role="status">{!display.ready ? '正在读取配置…' : dirty ? '有未保存的调整' : '当前范围已保存'}</span>
          </div>
        </fieldset>
      </form>
      {display.error && <p className="settings-warning" role="alert">{display.error}</p>}
      <p className="settings-hint">缩小范围可突出较小变化，但更多点可能显示为最高颜色。</p>
      <p className="settings-hint">只改变颜色显示，不修改原始数据、修正值或统计结果。当前数值未标定，不代表实际压力。</p>
    </section>
  )
}
