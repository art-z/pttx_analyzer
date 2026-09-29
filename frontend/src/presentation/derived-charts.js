// Charts derived from numbers the model already put in the slide context
// (KPI metrics, comparison tables). Nothing is invented: every value comes
// from the context, units must agree, ranges ("5–7 ч") and mixed units are
// never charted. Used only when the context has no explicit chart.

const MAX_POINTS = 6
const SHARE_TOLERANCE = 3

function normalizeUnit(unit) {
  return String(unit ?? '').replace(/\u00a0/g, ' ').replace(/\s+/g, '').toLowerCase()
}

// "45 мин", "$200", "0,5 $/презентацию", "95%" -> { value, unit }; ranges and
// non-numbers -> null.
export function parseNumericCell(cell) {
  const text = String(cell ?? '').replace(/\u00a0/g, ' ').trim()
  if (!text) return null
  const match = text.match(/^([$€₽£]?)\s*(-?\d+(?:[.,]\d+)?)\s*(.*)$/u)
  if (!match) return null
  const rest = match[3].trim()
  if (/^[–—-]\s*\d/u.test(rest) || /\d/u.test(rest)) return null
  const value = Number(match[2].replace(',', '.'))
  if (!Number.isFinite(value)) return null
  return { value, unit: normalizeUnit(`${match[1]}${rest}`) }
}

function isShare(values, unit) {
  const sum = values.reduce((total, value) => total + value, 0)
  return unit === '%' && values.length >= 2 && values.every((value) => value > 0)
    && Math.abs(sum - 100) <= SHARE_TOLERANCE
}

export function chartFromMetrics(metrics = []) {
  if (metrics.length < 2 || metrics.length > MAX_POINTS) return null
  const points = metrics.map((metric) => {
    const parsed = parseNumericCell(`${metric?.value ?? ''}${metric?.unit ?? ''}`)
    const label = String(metric?.description || metric?.text || metric?.label || '').trim()
    return parsed && label ? { ...parsed, label } : null
  })
  if (points.some((point) => !point)) return null
  const unit = points[0].unit
  if (!unit || points.some((point) => point.unit !== unit)) return null
  const values = points.map((point) => point.value)
  // Percentages above 100 (ROI, growth) do not share an axis with shares.
  if (unit === '%' && values.some((value) => value < 0 || value > 100)) return null
  return {
    type: isShare(values, unit) ? 'doughnut' : 'bar',
    title: '',
    text: '',
    labels: points.map((point) => point.label),
    values,
    unit,
    derived_from: 'metrics',
  }
}

export function chartFromTable(table) {
  const headers = Array.isArray(table?.headers) ? table.headers.map((item) => String(item ?? '').trim()) : []
  const rows = Array.isArray(table?.rows) ? table.rows.filter(Array.isArray) : []
  if (headers.length < 2 || !rows.length) return null
  const seriesNames = headers.slice(1)
  const parsedRows = rows.map((row) => {
    const label = String(row[0] ?? '').trim()
    const cells = seriesNames.map((_, index) => parseNumericCell(row[index + 1]))
    if (!label || cells.some((cell) => !cell)) return null
    const unit = cells[0].unit
    return cells.every((cell) => cell.unit === unit) ? { label, unit, values: cells.map((cell) => cell.value) } : null
  }).filter(Boolean)
  if (!parsedRows.length) return null
  const groups = new Map()
  for (const row of parsedRows) {
    if (!groups.has(row.unit)) groups.set(row.unit, [])
    groups.get(row.unit).push(row)
  }
  const [unit, group] = [...groups.entries()].sort((left, right) => right[1].length - left[1].length)[0]
  const suffix = unit ? `, ${unit}` : ''
  if (group.length >= 2) {
    const picked = group.slice(0, MAX_POINTS)
    return {
      type: 'bar',
      title: `${String(table?.title || '').trim()}${suffix}`.replace(/^, /, ''),
      text: '',
      labels: picked.map((row) => row.label),
      series: seriesNames.map((name, index) => ({ label: name, values: picked.map((row) => row.values[index]) })),
      unit,
      derived_from: 'tables',
    }
  }
  const [row] = group
  if (seriesNames.length < 2) return null
  return {
    type: 'bar',
    title: `${row.label}${suffix}`,
    text: '',
    labels: seriesNames,
    values: row.values,
    unit,
    derived_from: 'tables',
  }
}

export function deriveChartsFromSpec(spec) {
  if (!spec || (spec.charts || []).length) return []
  const charts = []
  const metricChart = chartFromMetrics(spec.metrics || [])
  if (metricChart) charts.push(metricChart)
  for (const table of spec.tables || []) {
    const tableChart = chartFromTable(table)
    if (tableChart) charts.push(tableChart)
  }
  return charts
}
