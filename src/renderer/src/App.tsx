import { useRef, useState } from 'react'
import { useController } from './hooks/useController'
import { useDisplayRange } from './hooks/useDisplayRange'
import { useTheme } from './hooks/useTheme'
import { IconDefinitions } from './components/Icon'
import { ScreenViewport } from './components/ScreenViewport'
import { AppHeader } from './components/AppHeader'
import { Toast } from './components/Toast'
import { RunLogsDialog } from './dialogs/RunLogsDialog'
import { EmergencyResetDialog } from './dialogs/EmergencyResetDialog'
import { Dashboard } from './pages/Dashboard'
import { Settings } from './pages/Settings'

export default function App() {
  const controller = useController()
  const appearance = useTheme()
  const display = useDisplayRange()
  const { state, online, busy, error, logs, notice, notify, send } = controller
  const [page, setPage] = useState<'dashboard' | 'settings'>('dashboard')
  const [dialog, setDialog] = useState<'logs' | 'reset' | null>(null)
  const [exporting, setExporting] = useState(false)
  const exportPending = useRef(false)

  async function onExport(runId?: string) {
    if (exportPending.current) return
    if (!window.labDesktop || !online) { notify('控制端离线，无法导出'); return }
    exportPending.current = true
    setExporting(true)
    try {
      const result = await window.labDesktop.exportRecords(runId)
      if (!result.saved) notify('已取消导出')
      else if (result.outputKind === 'directory') {
        const directory = result.outputPath.split(/[\\/]/).pop() || result.outputPath
        notify(`已导出 ${result.count} 组数据，共 ${result.fileCount} 个 CSV，目录：${directory}`)
      } else notify(`已导出 ${result.count} 组试验数据`)
    } catch (reason) { notify(`导出失败：${(reason as Error).message}`) }
    finally { exportPending.current = false; setExporting(false) }
  }

  return (
    <div className={state?.stopped ? 'stopped' : ''}>
      <IconDefinitions />
      <ScreenViewport variant={page}>
        {page === 'dashboard' && <AppHeader stopped={state?.stopped ?? false} running={state?.running ?? false} online={online}
          onSettings={() => setPage('settings')}
          onEmergency={() => { void send({ type: 'emergency' }) }} onReset={() => setDialog('reset')} />}
        {page === 'settings'
          ? <Settings display={display} onBack={() => setPage('dashboard')} controller={controller} appearance={appearance} exporting={exporting} onExport={onExport} />
          : <Dashboard range={display.range} notify={notify} state={state} online={online} busy={busy} error={error} exporting={exporting}
              onCommand={command => { void send(command) }} onExport={() => { void onExport() }}
              onLogs={() => setDialog('logs')} onSettings={() => setPage('settings')} />}
      </ScreenViewport>
      <Toast notice={notice} />
      {dialog === 'logs' && <RunLogsDialog logs={logs} onClose={() => setDialog(null)} />}
      {dialog === 'reset' && <EmergencyResetDialog onClose={() => setDialog(null)} onConfirm={() => {
        void send({ type: 'reset' }).then(ok => { if (ok) setDialog(null) })
      }} />}
    </div>
  )
}
