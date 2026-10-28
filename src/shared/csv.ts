import type { Sample } from './controller.ts'

export function samplesToCsv(samples: readonly Sample[], includeHeader = true): string {
  const header = ['时间', '法向力(N)', '按压接触面积(cm²)', '摩擦力(N)', '速度(mm/s)', '动摩擦系数', '气压(MPa)', '抓取接触面积(cm²)', '抓取力(N)']
  const rows = samples.map(sample => [
    sample.time, sample.normal.toFixed(2), sample.area.toFixed(2), sample.friction.toFixed(2),
    sample.speed.toFixed(2), sample.coefficient.toFixed(3), sample.pressure.toFixed(2),
    (sample.area * 0.68).toFixed(2), (sample.normal * 0.74).toFixed(2)
  ].join(','))
  return (includeHeader ? '\ufeff' + header.join(',') + '\r\n' : '') + rows.join('\r\n') + (rows.length ? '\r\n' : '')
}
