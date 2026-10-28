interface Props {
  name: string
  checked: boolean
  disabled: boolean
  onToggle: () => void
}
export function DeviceSwitch({ name, checked, disabled, onToggle }: Props) {
  return (
    <div className={`device${checked ? ' on' : ''}`}>
      <div><span className="device-name">{name}</span><span className="device-state"><i /><span>{checked ? '运行中' : '待启动'}</span></span></div>
      <button className="switch" role="switch" aria-label={`${name}启停`} aria-checked={checked} disabled={disabled} onClick={onToggle} />
    </div>
  )
}
