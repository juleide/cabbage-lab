import { useEffect, useRef, useState } from 'react'
import type { useController } from '../../hooks/useController'
import type { MotionSafetyConfig, MotionPreview, MotorSafety, SafetyAssessment, SafetySnapshot, SafetyTarget } from '../../../../shared/motion-safety'

const labels = { motor1: '1 号电机', motor2: '2 号电机', lift: '升降装置' }
const commonFields = { minimumMm: '行程下限（mm）', maximumMm: '行程上限（mm）', maxStepMm: '单次距离上限（mm）', maxDurationMs: '单次时长上限（ms）' }
const motorFields = { ...commonFields, pulsesPerMm: '每毫米脉冲数', zeroPulse: '零点脉冲', maxSpeedRpm: '规划速度上限（r/min）' }
const liftFields = { ...commonFields, feedbackMaxAgeMs: '反馈过期阈值（ms）', stopTimeoutMs: '停止等待上限（ms）' }
const evidenceLabels = { emergencyCircuit: '硬接线急停核验材料', disconnectProtection: '断线制动核验材料', mechanicalLimits: '行程与机械限位材料', motorParameters: '电机参数映射与标定材料', liftFeedback: '升降反馈与停止语义材料' }

export function MotionSafetySettings({ controller, unlocked, visible, disabled, onDirtyChange }: {
  controller: ReturnType<typeof useController>; unlocked: boolean; visible: boolean; disabled: boolean
  onDirtyChange: (dirty: boolean) => void
}) {
  const { request, online } = controller
  const [draft, setDraft] = useState<MotionSafetyConfig | null>(null)
  const [saved, setSaved] = useState('')
  const [baseVersion, setBaseVersion] = useState('')
  const [baseHardware, setBaseHardware] = useState('')
  const [assessment, setAssessment] = useState<SafetyAssessment | null>(null)
  const [known, setKnown] = useState(false)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const [statusError, setStatusError] = useState('')
  const [target, setTarget] = useState<SafetyTarget>('motor1')
  const [input, setInput] = useState({ fromMm: '', positionMm: '', durationMs: '', speedRpm: '' })
  const [result, setResult] = useState<MotionPreview | null>(null)
  const profileForm = useRef<HTMLFormElement>(null)
  const previewForm = useRef<HTMLFormElement>(null)
  const revision = useRef(0)
  const mounted = useRef(true)
  const dirty = !!draft && JSON.stringify(draft) !== saved
  const dirtyRef = useRef(dirty)
  dirtyRef.current = dirty
  const draftRef = useRef(draft)
  draftRef.current = draft
  const locked = disabled || pending || !online || !unlocked || !known || !!assessment?.error
  useEffect(() => { onDirtyChange(dirty) }, [dirty, onDirtyChange])
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; revision.current++ } }, [])

  function apply(value: SafetySnapshot) {
    setDraft(value.config); setSaved(JSON.stringify(value.config))
    setBaseVersion(value.assessment.configVersion); setBaseHardware(value.assessment.hardwareVersion)
    setAssessment(value.assessment); setKnown(true); setResult(null)
  }

  useEffect(() => {
    let live = true
    let timer: ReturnType<typeof setTimeout> | undefined
    setKnown(false)
    setPending(false)
    if (!visible || !online || !unlocked) return
    async function poll(first = false) {
      const version = revision.current
      try {
        if (first && (!draftRef.current || !dirtyRef.current)) {
          const value = await request<SafetySnapshot>('hardware.safety.get')
          if (live && version === revision.current) apply(value)
        } else {
          const value = await request<SafetyAssessment>('hardware.safety.status')
          if (live && version === revision.current) { setAssessment(value); setKnown(true) }
        }
        if (live && version === revision.current) setStatusError('')
      } catch (reason) {
        if (live && version === revision.current) { setKnown(false); setStatusError((reason as Error).message) }
      } finally { if (live) timer = setTimeout(() => void poll(), 1000) }
    }
    void poll(true)
    return () => { live = false; clearTimeout(timer); revision.current++ }
  }, [online, unlocked, visible, request])

  function edit(value: MotionSafetyConfig) { setDraft(value); setResult(null) }
  async function load() {
    if (dirty && !window.confirm('安全草稿尚未保存，重新载入会放弃这些修改。是否继续？')) return
    const version = ++revision.current
    setPending(true); setError('')
    try {
      const value = await request<SafetySnapshot>('hardware.safety.get')
      if (mounted.current && version === revision.current) apply(value)
    } catch (reason) { if (mounted.current && version === revision.current) setError((reason as Error).message) }
    finally { if (mounted.current && version === revision.current) { revision.current++; setPending(false) } }
  }
  async function save() {
    if (!draft || locked || !profileForm.current?.reportValidity()) return
    const version = ++revision.current
    setPending(true); setError('')
    try {
      const value = await request<SafetySnapshot>('hardware.safety.save', { config: draft, expectedVersion: baseVersion, expectedHardwareVersion: baseHardware })
      if (mounted.current && version === revision.current) { apply(value); controller.notify('运动安全草稿已保存，不产生运动许可') }
    } catch (reason) { if (mounted.current && version === revision.current) setError((reason as Error).message) }
    finally { if (mounted.current && version === revision.current) { revision.current++; setPending(false) } }
  }
  async function preview() {
    if (!assessment || dirty || locked || baseVersion !== assessment.configVersion || !previewForm.current?.reportValidity()) return
    const version = ++revision.current
    setPending(true); setError(''); setResult(null)
    try {
      const value = await request<MotionPreview>('hardware.safety.preview', {
        target, fromMm: Number(input.fromMm), positionMm: Number(input.positionMm), durationMs: Number(input.durationMs),
        ...(target === 'lift' ? {} : { speedRpm: Number(input.speedRpm) }),
        expectedVersion: baseVersion, expectedHardwareVersion: baseHardware
      })
      if (mounted.current && version === revision.current) setResult(value)
    } catch (reason) { if (mounted.current && version === revision.current) setError((reason as Error).message) }
    finally { if (mounted.current && version === revision.current) { revision.current++; setPending(false) } }
  }

  const capability = assessment?.targets[target]
  const resultCurrent = result && known && !dirty && !assessment?.error && capability?.canPreview && result.configVersion === assessment?.configVersion && result.hardwareVersion === assessment.hardwareVersion
  return <section hidden={!visible} className="hw-sensor-panel" aria-label="运动安全配置">
    <h3>运动安全草稿与能力评估</h3>
    <p className="hw-note">保存到 config/motion-safety.json；可手动修改文件，备份草稿后重启控制端应用。所有运动参数默认留空。材料引用、审核人和连接指纹都是记录，不是设备身份验证或运动授权；填满后也不会开放真实启动。</p>
    <div className="hw-sensor-actions"><button disabled={!online || !unlocked || pending} onClick={() => void load()}>重新载入安全草稿</button><span className="hw-note">{dirty ? '安全草稿未保存' : '安全草稿无未保存修改'}</span></div>
    {(error || statusError || assessment?.error) && <p className="settings-warning" role="alert">{error || statusError || assessment?.error}</p>}
    {draft && <>
      <form ref={profileForm} className="hw-body" onSubmit={event => event.preventDefault()}><fieldset disabled={locked}>
        <div className="hw-grid">{(['machineId', 'reviewedBy', 'reviewedAt'] as const).map(key => <label key={key}>{{ machineId: '设备/工装编号（人工记录）', reviewedBy: '记录审核人', reviewedAt: '记录审核日期' }[key]}<input type={key === 'reviewedAt' ? 'date' : 'text'} maxLength={512} value={draft[key]} onChange={event => edit({ ...draft, [key]: event.target.value })} /></label>)}</div>
        <div className="hw-box"><p className="hw-note">连接指纹：{assessment?.bindingMatches ? '已匹配保存的连接配置（非设备身份核验）' : '未绑定或保存的连接配置已变化'}<br />草稿绑定：{draft.hardwareVersion || '未绑定'}<br />当前连接：{assessment?.hardwareVersion || '未知'}</p><button type="button" onClick={() => {
          if (assessment && window.confirm('仅把安全草稿绑定到当前已保存的电机/升降连接配置，不核验设备身份，不确认材料真实性，不开放运动。请核对站号、端口和对应标定材料。是否记录此绑定？')) {
            edit({ ...draft, hardwareVersion: assessment.hardwareVersion }); setBaseHardware(assessment.hardwareVersion)
          }
        }}>记录当前连接配置绑定</button></div>
        <details><summary>核验材料引用（不自动认定验收通过）</summary><div className="hw-grid">{Object.entries(evidenceLabels).map(([key, label]) => <label key={key}>{label}<input maxLength={512} placeholder="报告编号、文件路径及章节；不要填写密码" value={draft.evidence[key as keyof typeof evidenceLabels]} onChange={event => edit({ ...draft, evidence: { ...draft.evidence, [key]: event.target.value } })} /></label>)}</div></details>
        <div className="hw-switch">{(['motor1', 'motor2', 'lift'] as const).map(key => <button type="button" key={key} aria-pressed={target === key} onClick={() => { setTarget(key); setResult(null); setInput({ fromMm: '', positionMm: '', durationMs: '', speedRpm: '' }) }}>{labels[key]}安全参数</button>)}</div>
        <article className="hw-box"><h4>{labels[target]}规划约束<span>未知值请留空</span></h4><div className="hw-grid">{Object.entries(target === 'lift' ? liftFields : motorFields).map(([field, label]) => {
          const axis = draft[target] as unknown as Record<string, number | null>
          return <label key={field}>{label}<input aria-label={`${labels[target]}${label}`} type="number" step={field.endsWith('Ms') || field === 'zeroPulse' || target === 'lift' ? 1 : 'any'} min={field.endsWith('Ms') ? 1 : undefined} max={field.endsWith('Ms') ? 60000 : undefined} value={axis[field] ?? ''} placeholder="待核验，不猜测默认值" onChange={event => edit({ ...draft, [target]: { ...draft[target], [field]: event.target.value === '' ? null : Number(event.target.value) } })} /></label>
        })}{target !== 'lift' && <label>标定方向<select aria-label="标定方向" value={(draft[target] as MotorSafety).direction ?? ''} onChange={event => edit({ ...draft, [target]: { ...draft[target], direction: event.target.value ? Number(event.target.value) : null } as MotorSafety })}><option value="">待核验</option><option value="1">正向 +1</option><option value="-1">反向 -1</option></select></label>}</div><p className="hw-note">mm 为人工标定坐标；电机规划仅接受非负 31 位整数脉冲，升降仅接受整数 mm、0～9999 mm 编码容量（不是允许行程）。时长 1～60000 ms 是本地规划约束，不是厂家停止时限或运动完成预测。</p></article>
        <button type="button" className="hw-primary" disabled={!dirty} onClick={() => void save()}>保存安全草稿</button>
      </fieldset></form>
      <div className="hw-result" role="status"><strong>{known ? '真实运动始终禁用' : '评估状态未知，禁止执行'}</strong><p>仅离线规划：{known && capability?.canPreview ? '已保存草稿可计算（非安全验收）' : '缺少完整且匹配的已保存草稿'}</p>{known && capability && <details><summary>查看{labels[target]}的阻断原因（{capability.reasons.length} 项）</summary><ul>{capability.reasons.map((reason, index) => <li key={`${reason.code}-${index}`}>{reason.message}</li>)}</ul></details>}<button disabled>真实运动未开放</button></div>
      <form ref={previewForm} className="hw-body" onSubmit={event => { event.preventDefault(); void preview() }}><fieldset disabled={locked || dirty || !capability?.canPreview || baseVersion !== assessment?.configVersion}>
        <h3>{labels[target]}离线目标计算</h3><p className="hw-note">起点由人工输入，不读取设备当前位置；结果不可执行，不写设备，不生成运动许可。</p>
        <div className="hw-grid">{(['fromMm', 'positionMm', 'durationMs', ...(target === 'lift' ? [] : ['speedRpm'])] as (keyof typeof input)[]).map(key => <label key={key}>{{ fromMm: '人工起点（mm）', positionMm: '规划目标（mm）', durationMs: '规划时长（ms）', speedRpm: '规划速度（r/min）' }[key]}<input type="number" required step={key === 'durationMs' || target === 'lift' ? 1 : 'any'} value={input[key]} onChange={event => { setInput({ ...input, [key]: event.target.value }); setResult(null) }} /></label>)}</div>
        <button type="submit">仅计算离线目标</button>
      </fieldset></form>
      {result && <div role="status" className="hw-result">{resultCurrent ? '离线结果（不可执行）' : '历史离线结果，配置或状态已变化，不再适用'}：{result.target === 'lift' ? `ASCII cm ${result.positionAsciiCm}` : `目标脉冲 ${result.targetPulse}，高字 ${result.highWord}，低字 ${result.lowWord}`}<p>{result.message}</p></div>}
    </>}
  </section>
}
