import { listAllComponents } from '../components/catalog.js'
import { chartTypeWeight, normalizeChartType } from './graphic-contract.js'

const CHART_TYPE_ALIASES = {
  line: ['area', 'line'],
  bar: ['bar'],
  pie: ['pie', 'doughnut'],
  doughnut: ['doughnut', 'pie'],
  area: ['area', 'line'],
}

function componentsByKind(report, kind) {
  return listAllComponents(report).filter((component) => component.kind === kind)
}

function pickBaseline(components) {
  return components.find((component) => component.isBaseline) || components[0] || null
}

export function findBaselineGraphicComponent(report, kind, preferredType = null) {
  const components = componentsByKind(report, kind)
  if (!components.length) return null

  if (kind !== 'chart' || !preferredType) {
    return pickBaseline(components)
  }

  const normalized = normalizeChartType(preferredType)
  const aliases = CHART_TYPE_ALIASES[normalized] || [normalized]
  const baselines = components.filter((component) => component.isBaseline)
  const pool = baselines.length ? baselines : components

  const ranked = [...pool].sort((left, right) => {
    const score = (component) => chartTypeWeight(component.chartType)
      + (aliases.includes(component.chartType) ? 28 : 0)
    return score(right) - score(left)
  })
  return ranked[0] || null
}
