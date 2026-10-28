import type { Theme } from '../../../../shared/controller'

interface Props {
  theme: Theme
  ready: boolean
  error: string
  onChange: (theme: Theme) => void
}

const themes: { value: Theme; label: string; description: string }[] = [
  { value: 'light', label: '白色', description: '明亮清晰，适合日常操作' },
  { value: 'dark', label: '黑色', description: '柔和暗色，减少环境眩光' },
  { value: 'blue', label: '科技蓝', description: '清透蓝底，搭配活力亮蓝' }
]

export function AppearanceSettings({ theme, ready, error, onChange }: Props) {
  return (
    <section className="settings-card">
      <h3>外观与主题</h3>
      <p className="settings-description">选择你习惯的界面配色，应用后自动保存。</p>
      <div className="theme-cards" role="group" aria-label="界面主题">
        {themes.map(item => (
          <button
            key={item.value}
            type="button"
            className={`theme-card${theme === item.value ? ' selected' : ''}`}
            aria-pressed={theme === item.value}
            disabled={!ready}
            onClick={() => onChange(item.value)}
          >
            <div className={`theme-preview theme-preview--${item.value}`} aria-hidden="true">
              <div className="theme-preview-top"><i /><span /><b /><b /></div>
              <div className="theme-preview-panels">
                <div className="theme-preview-controls"><i /><i /><i /><b /></div>
                <div className="theme-preview-metrics"><i /><i /><i /><i /></div>
                <div className="theme-preview-map"><i /></div>
              </div>
            </div>
            <div className="theme-card-caption">
              <span>{item.label}</span>
              <span className="theme-card-check" aria-hidden="true">
                {theme === item.value && <svg viewBox="0 0 24 24"><path d="m5 12 4 4L19 6" /></svg>}
              </span>
            </div>
            <span className="theme-card-description">{item.description}</span>
          </button>
        ))}
      </div>
      {!ready && <p className="settings-hint">正在读取主题偏好…</p>}
      {error && <p className="settings-warning" role="status">{error}</p>}
      <div className="appearance-note">
        <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="13" rx="2" /><path d="M8 21h8m-4-4v4" /></svg>
        <div><strong>自动记住你的选择</strong><p>主题保存在本机，下次启动时自动恢复，不影响试验配置与数据。</p></div>
      </div>
    </section>
  )
}
