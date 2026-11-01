import type { useController } from '../../hooks/useController'
import { useMotorControl } from '../../hooks/useMotorControl'

const axisStates = { idle: '待机', starting: '启动中', running: '驱动反馈运行', stopping: '停止中', unknown: '结果未知' }
const sessionStates = { connecting: '连接中', monitoring: '控制会话活动', disconnecting: '停止并断开中', disconnected: '已断开', failed: '故障结束' }

export function MotorControls({ controller, unlocked, disabled, visible }: {
  controller: ReturnType<typeof useController>; unlocked: boolean; disabled: boolean; visible: boolean
}) {
  const motor = useMotorControl(controller, unlocked)
  const { status, known, pending, error, operate, active } = motor
  async function connect() {
    if (!window.confirm('将连接真实电机控制。启动会按已保存方向、速度和加减速运行；请先核对两轴用途、参数、有效行程保护及独立急停。软件停止和运行时限不能替代机械保护。连接本身不启动、不使能。是否继续？')) return
    await operate('connect')
  }
  return <section className="hw-sensor-panel" hidden={!visible} aria-label="真实电机启停">
    <h3>真实电机固定参数启停</h3>
    <p className="hw-note">两台电机共用串口，使用已保存参数。关闭是请求停止，不释放、不切断电源。驱动未使能时拒绝启动；不自动清错、重连或续跑。有限行程必须先确认有效保护。后台时限不是硬件看门狗。</p>
    <p className="hw-note" role="status">{!known ? '控制状态未知或权限已锁定' : !status ? '未建立电机控制会话' : `控制会话 ${status.sessionId.slice(0, 8)} · ${sessionStates[status.state]} · 配置 ${status.configVersion.slice(0, 12)}`}</p>
    {error && <p className="settings-warning" role="alert">{error}</p>}
    {status?.error && <p className="settings-warning" role="alert">{status.error}</p>}
    <div className="hw-sensor-actions">
      <button disabled={!controller.online || !unlocked || !known || pending || disabled || active} onClick={() => void connect()}>连接真实电机控制</button>
      <button disabled={!controller.online || !active} onClick={() => void operate('stop', undefined, true)}>两电机软件急停</button>
      <button disabled={!controller.online || !active} onClick={() => void operate('disconnect')}>停止并断开电机控制</button>
    </div>
    <div className="hw-grid">{(['motor1', 'motor2'] as const).map((target, index) => {
      const axis = status?.axes[target]
      const reading = status?.readings[target]
      const fresh = known && status?.state === 'monitoring' && reading?.quality === 'valid' && reading.speed?.quality === 'valid'
      return <article className="hw-box" key={target} aria-label={`${index + 1} 号电机真实控制`}>
        <h4>{index + 1} 号电机<span>{known && axis ? axisStates[axis.state] : '状态未知'}</span></h4>
        <p className="hw-note">{fresh ? `速度 ${reading.speed!.rpm} r/min · ${reading.enabled ? '已使能' : '未使能'} · ${reading.running ? '运行位为 1' : '运行位为 0'}` : '状态/速度反馈过期或不可用'}</p>
        {axis?.startBlocked && <p className="hw-note">启动条件：{axis.startBlocked}</p>}
        {axis?.error && <p className="settings-warning">{axis.error}</p>}
        <p className="hw-note">{fresh && axis?.driverStopped ? '驱动反馈停止；机械安全停止未确认' : '机械停止未确认'}</p>
        <div className="hw-sensor-actions">
          <button disabled={!controller.online || !unlocked || disabled || pending || !known || !fresh || !axis?.canStart} onClick={() => void operate('start', target)}>启动 {index + 1} 号电机</button>
          <button disabled={!controller.online || !active} onClick={() => void operate('stop', target)}>停止 {index + 1} 号电机</button>
        </div>
      </article>
    })}</div>
  </section>
}
