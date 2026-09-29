import { listMetricComponents } from '../components/metric-catalog.js'
import { listGraphicTables } from '../components/table-catalog.js'

const CATALOG_BLOCKS = new Set(['metrics', 'charts', 'tables', 'diagrams'])

export function catalogCoversScenarioBlock(report, block) {
  if (!report || !CATALOG_BLOCKS.has(block)) return false

  if (block === 'metrics') {
    return listMetricComponents(report).length > 0
  }

  const graphic = report?.graphic_components || {}
  if (block === 'charts') return (graphic.charts || []).length > 0
  if (block === 'diagrams') return (graphic.diagrams || []).length > 0
  if (block === 'tables') {
    return (graphic.tables || []).length > 0 || listGraphicTables(report).length > 0
  }

  return false
}

export function filterShellBlockGaps(report, gaps = []) {
  return (gaps || []).filter((gap) => {
    const match = String(gap).match(/^нет компонента для (\w+)/)
    if (!match) return true
    return !catalogCoversScenarioBlock(report, match[1])
  })
}
