import type { LabConfig } from '../../../../shared/controller'

interface Props {
  draft: LabConfig | null
  disabled: boolean
  saving: boolean
  error: string | null
  onChange: (config: LabConfig) => void
  onSave: () => void
}
export function ExperimentSettings({ draft, disabled, saving, error, onChange, onSave }: Props) {
  if (!draft) return <section className="settings-card"><h3>等待控制端配置</h3><p>控制端连接后才能读取和修改试验配置。</p></section>
  return (
    <section className="settings-card">
      <h3>试验与采集</h3>
      {error && <p className="settings-warning">{error}</p>}
      <form onSubmit={event => { event.preventDefault(); onSave() }}>
        <fieldset disabled={disabled || saving}>
          <div className="settings-fields">
            <label>默认夹爪气压（MPa）
              <input type="number" min="0" max="0.6" step="0.01" required value={Number.isFinite(draft.defaultPressure) ? draft.defaultPressure : ''}
                onChange={event => onChange({ ...draft, defaultPressure: event.currentTarget.valueAsNumber })} />
            </label>
            <label>采样间隔（毫秒）
              <input type="number" min="100" max="5000" step="1" required value={Number.isFinite(draft.sampleIntervalMs) ? draft.sampleIntervalMs : ''}
                onChange={event => onChange({ ...draft, sampleIntervalMs: event.currentTarget.valueAsNumber })} />
            </label>
            <label>试验记录前缀
              <input maxLength={24} pattern="[A-Za-z0-9_-]{1,24}" required value={draft.recordPrefix}
                onChange={event => onChange({ ...draft, recordPrefix: event.currentTarget.value })} />
            </label>
            <label>默认记录库
              <select value={draft.defaultLibrary} onChange={event => onChange({ ...draft, defaultLibrary: event.currentTarget.value as LabConfig['defaultLibrary'] })}>
                <option value="cabbage_test_2026">当前记录库</option>
                <option value="cabbage_test_archive">归档记录库</option>
              </select>
            </label>
          </div>
          <button className="btn primary" type="submit">{saving ? '正在保存…' : '保存并生效'}</button>
        </fieldset>
      </form>
      <p className="settings-hint">停止试验和全部执行机构后可保存配置，保存后立即生效。</p>
      <p className="settings-warning">气压范围仅用于模拟，不代表真实设备的安全限值。</p>
    </section>
  )
}
