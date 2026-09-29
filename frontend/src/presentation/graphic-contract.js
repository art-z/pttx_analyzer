import { slugifyId, tableMatrixToDataPayload } from '../components/model-data.js'

const CHART_TYPES = new Set(['line', 'bar', 'pie', 'area', 'doughnut'])

export function normalizeChartType(type) {
  const normalized = String(type || 'bar').toLowerCase()
  if (normalized === 'column') return 'bar'
  if (CHART_TYPES.has(normalized)) return normalized
  return 'bar'
}

const TIME_LABEL_RE = /^(q[1-4]|[1-4]\s*(кв|q)|кв|h[12]|(19|20)\d{2}|янв|фев|мар|апр|май|мая|июн|июл|авг|сен|окт|ноя|дек|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|месяц|мес|недел|нед|день|дн|week|month|year|год|квартал|quarter|этап\s*\d|t\d|\d+\s*(мес|нед|дн|г|год))/i

function chartValues(chart) {
  const series = Array.isArray(chart?.series) && chart.series.length
    ? chart.series.map((item) => item?.values || [])
    : [Array.isArray(chart?.values) ? chart.values : []]
  return series.map((values) => values.map((value) => Number(String(value ?? '').replace(',', '.').replace(/[^0-9.\-]/g, ''))))
}

// Chart kinds that suit the data actually present (never invented):
//   the requested type and its aliases, a time series (quarters, months,
//   years, weeks, ...) also as line/area/bar, a single series of shares that
//   add up to ~100 also as pie/doughnut, any category comparison as bar.
export function suitableChartTypes(chart) {
  const requested = normalizeChartType(chart?.type || chart?.chart_type)
  const labels = (chart?.labels || chart?.categories || []).map((item) => String(item ?? '').trim())
  const series = chartValues(chart)
  const points = Math.max(labels.length, ...series.map((values) => values.length), 0)
  const numeric = series.length > 0 && series.every((values) => values.length >= 2 && values.every(Number.isFinite))
  const types = new Set([requested])
  const aliases = { line: ['area'], area: ['line'], pie: ['doughnut'], doughnut: ['pie'] }[requested] || []
  aliases.forEach((type) => types.add(type))
  if (!numeric || points < 2) return [...types]
  const timeSeries = labels.length >= 3 && labels.every((label) => TIME_LABEL_RE.test(label))
  if (timeSeries) ['area', 'line', 'bar'].forEach((type) => types.add(type))
  if (labels.length >= 2 && labels.length <= 12) types.add('bar')
  const single = series.length === 1 ? series[0] : null
  const sum = single ? single.reduce((total, value) => total + value, 0) : 0
  if (single && single.length >= 2 && single.length <= 6 && single.every((value) => value > 0) && Math.abs(sum - 100) <= 3) {
    types.add('doughnut')
    types.add('pie')
  }
  return [...types]
}

export function chartTypeWeight(type) {
  const normalized = normalizeChartType(type)
  if (normalized === 'bar') return 40
  if (normalized === 'pie' || normalized === 'doughnut') return 16
  if (normalized === 'area') return 8
  if (normalized === 'line') return 2
  return 0
}

export function llmChartToModelData(chart, componentId) {
  const labels = chart.labels || chart.categories || []
  const values = Array.isArray(chart.values) ? chart.values : []
  const seriesSource = Array.isArray(chart.series) && chart.series.length
    ? chart.series
    : [{ label: chart.title || 'Series 1', values }]

  return {
    component_id: componentId,
    title: chart.title || null,
    text: chart.text || null,
    chart_type: normalizeChartType(chart.type || chart.chart_type),
    categories: labels,
    series: seriesSource.map((item, index) => ({
      id: slugifyId(item.label || item.name || item.id, `series_${index}`),
      label: item.label || item.name || chart.title || `Series ${index + 1}`,
      values: Array.isArray(item.values) ? item.values : values,
    })),
  }
}

export function llmTableToModelData(table, componentId) {
  const sourceHeaders = Array.isArray(table.headers) ? table.headers : []
  const sourceRows = Array.isArray(table.rows) ? table.rows : []
  const nonEmptyRows = sourceRows.filter((row) => (
    Array.isArray(row) && row.some((cell) => !isBlankTableCell(cell))
  ))
  const sourceWidth = Math.max(
    sourceHeaders.length,
    ...nonEmptyRows.map((row) => row.length),
    0,
  )
  const retainedColumnIndexes = Array.from({ length: sourceWidth }, (_, index) => index)
    .filter((index) => (
      !isBlankTableCell(sourceHeaders[index])
      || nonEmptyRows.some((row) => !isBlankTableCell(row[index]))
    ))
  const selectRetainedCells = (row) => retainedColumnIndexes.map((index) => row?.[index] ?? '')
  const headers = selectRetainedCells(sourceHeaders)
  const rows = nonEmptyRows.map(selectRetainedCells)
  const matrix = headers.length ? [headers, ...rows] : rows
  const payload = tableMatrixToDataPayload(matrix, { header_row: 0 }, { componentId })
  return {
    ...payload,
    title: table.title || null,
    text: table.text || null,
    row_count: matrix.length,
    col_count: retainedColumnIndexes.length,
  }
}

function isBlankTableCell(value) {
  return value == null || (typeof value === 'string' && value.trim() === '')
}

export function llmDiagramToModelData(diagram, componentId) {
  const nodes = Array.isArray(diagram.nodes) ? diagram.nodes : []
  return {
    component_id: componentId,
    title: diagram.title || null,
    text: diagram.text || null,
    diagram_type: diagram.type || diagram.diagram_type || 'flow',
    nodes: nodes.map((node, index) => ({
      id: slugifyId(node.id || node.label || node.title, `node_${index + 1}`),
      label: String(node.label || node.title || node.id || `Step ${index + 1}`),
    })),
  }
}
