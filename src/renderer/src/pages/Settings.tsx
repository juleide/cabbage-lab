import { useCallback, useEffect, useState } from 'react'
import type { LabConfig, RunRecord } from '../../../shared/controller'
import type { useController } from '../hooks/useController'
import type { useTheme } from '../hooks/useTheme'
import { AppearanceSettings } from '../components/settings/AppearanceSettings'
import { ExperimentSettings } from '../components/settings/ExperimentSettings'
import { RecordsSettings } from '../components/settings/RecordsSettings'
import { DiagnosticsSettings } from '../components/settings/DiagnosticsSettings'

interface Props {
  onBack: () => void
  controller: ReturnType<typeof useController>
  appearance: ReturnType<typeof useTheme>
  exporting: boolean
  onExport: (runId: string) => void
}
const sections = [
  { id: 'appearance', label: '外观与主题' },
  { id: 'experiment', label: '试验与采集' },
  { id: 'records', label: '数据与日志' },
  { id: 'diagnostics', label: '运行与诊断' },
  { id: 'hardware', label: '设备连接' }
] as const

type Section = typeof sections[number]['id']

export function Settings({ onBack, controller, appearance, exporting, onExport }: Props) {
  const { state, config, configError, online, busy, error, info, notify, request } = controller
  const [section, setSection] = useState<Section>('appearance')
  const [draft, setDraft] = useState<LabConfig | null>(config)
  const [saving, setSaving] = useState(false)
  const idle = !!state && !state.running && !Object.values(state.devices).some(Boolean)
  useEffect(() => { setDraft(config) }, [config])
  const loadRecords = useCallback(() => request<RunRecord[]>('records.list'), [request])

  async function save() {
    if (!draft || saving) return
    setSaving(true)
    try {
      await request<LabConfig>('config.update', { config: draft })
      notify('配置已保存并生效')
    } catch (reason) { notify((reason as Error).message) }
    finally { setSaving(false) }
  }
  async function openDirectory(kind: 'data' | 'logs' | 'config') {
    try {
      if (!window.labDesktop) throw new Error('请通过 Electron 应用打开目录')
      await window.labDesktop.openDirectory(kind)
    } catch (reason) { notify((reason as Error).message) }
  }
  function restart() {
    if (window.confirm('确认重启 Python 控制端？重启后执行机构保持停止，不自动恢复试验。')) void controller.restart()
  }

  return (
    <main className="settings-page">
      <nav className="settings-nav" aria-label="设置分类">
        <button className="settings-back" onClick={onBack}>
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m14 6-6 6 6 6M8 12h12" /></svg>
          返回试验台
        </button>
        <div className="settings-nav-items">
        {sections.map(item => <button key={item.id} className={section === item.id ? 'active' : ''}
          aria-current={section === item.id ? 'page' : undefined} onClick={() => setSection(item.id)}><SettingsNavIcon section={item.id} /><span>{item.label}</span><svg className="settings-nav-chevron" viewBox="0 0 24 24" aria-hidden="true"><path d="m9 6 6 6-6 6" /></svg></button>)}
        </div>
        <div className="settings-nav-note">
          <span className="settings-mode"><i />模拟环境</span>
          <span>未连接真实硬件</span>
        </div>
      </nav>
      <div className="settings-content">
        {section === 'appearance' && <AppearanceSettings theme={appearance.theme} ready={appearance.ready}
          error={appearance.themeError} onChange={appearance.setTheme} />}
        {section === 'experiment' && <ExperimentSettings draft={draft} onChange={setDraft} saving={saving}
          disabled={!online || !idle || busy} error={configError} onSave={() => void save()} />}
        {section === 'records' && <RecordsSettings info={info} online={online} library={state?.database}
          exporting={exporting} loadRecords={loadRecords} onExport={onExport} onDirectory={openDirectory} />}
        {section === 'diagnostics' && <DiagnosticsSettings info={info} online={online} idle={idle}
          busy={busy || exporting || saving} error={error} onRestart={restart} onStop={() => { void controller.send({ type: 'stop' }) }} />}
        {section === 'hardware' && (
          <section className="settings-card">
            <h3>设备连接 · 暂未开放</h3>
            <p>设备连接功能尚未启用，当前仅支持模拟操作。</p>

            <p className="settings-warning">模拟模式不会向真实设备发送控制指令。</p>
          </section>
        )}
      </div>
    </main>
  )
}

function SettingsNavIcon({ section }: { section: Section }) {
  const paths: Record<Section, string> = {
    appearance: 'M12 3a9 9 0 1 0 9 9c0-2-2-2-3-2h-2a2 2 0 0 1-2-2c0-1 1-2 0-3l-2-2ZM7 10h.01M9 6h.01M6 14h.01',
    experiment: 'M5 3v7m0 4v7M12 3v12m0 4v2M19 3v3m0 4v11M2 10h6m1 5h6m1-9h6',
    records: 'M5 5c0-3 14-3 14 0s-14 3-14 0Zm0 0v14c0 3 14 3 14 0V5M5 12c0 3 14 3 14 0',
    diagnostics: 'M3 12h4l3-8 4 16 3-8h4',
    hardware: 'M8 3v5m8-5v5M6 8h12v4a6 6 0 0 1-12 0V8Zm6 10v3'
  }
  return <svg className="settings-nav-icon" viewBox="0 0 24 24" aria-hidden="true"><path d={paths[section]} /></svg>
}
