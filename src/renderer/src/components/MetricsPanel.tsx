import type { Measurements } from '../domain/types'

const metrics: { name: string; unit: string; value: (values: Measurements) => number; precision?: number }[] = [
  { name: '载物台法向力', unit: 'N', value: v => v.normal },
  { name: '按压接触面积', unit: 'cm²', value: v => v.area },
  { name: '水平摩擦力', unit: 'N', value: v => v.friction },
  { name: '水平拖动速度', unit: 'mm/s', value: v => v.speed },
  { name: '动摩擦系数', unit: '—', value: v => v.coefficient, precision: 3 },
  { name: '夹爪实时气压', unit: 'MPa', value: v => v.pressure },
  { name: '抓取接触面积', unit: 'cm²', value: v => v.gripArea ?? 0 },
  { name: '抓取力', unit: 'N', value: v => v.gripForce ?? 0 }
]
export function MetricsPanel({ values, stopped, online, hasReadings = false }: { values: Measurements; stopped: boolean; online: boolean; hasReadings?: boolean }) {
  return (
    <section className="panel">
      <div className="panel-head"><div className="panel-title">实时参数</div><span className="live"><i className="dot" /><span>{!online ? '状态未知' : stopped ? '采集已暂停' : hasReadings ? '实时采集' : '等待真实读数'}</span></span></div>
      <div className="metrics">
        {metrics.map(metric => <div className="metric" key={metric.name}><div className="metric-name">{metric.name}</div><div className="metric-value"><span>{(online ? metric.value(values) : 0).toFixed(metric.precision ?? 2)}</span><small>{metric.unit}</small></div></div>)}
      </div>
    </section>
  )
}
