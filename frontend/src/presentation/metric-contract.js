const NUMBER_SOURCE = String.raw`[+\-]?(?:\d[\d\s]*(?:[.,]\d+)?|[.,]\d+)`
const SUFFIX_UNIT_SOURCE = String.raw`(?:%|‰|°|℃|℉|×|x|X|[₽$€£]|[A-Za-z\u0400-\u04FF][A-Za-z\u0400-\u04FF.\-/]{0,11})`
const PREFIX_UNIT_SOURCE = String.raw`[₽$€£]`

const SUFFIX_METRIC_RE = new RegExp(`^\\s*(${NUMBER_SOURCE})\\s*(${SUFFIX_UNIT_SOURCE})\\s*$`, 'u')
const PREFIX_METRIC_RE = new RegExp(`^\\s*(${PREFIX_UNIT_SOURCE})\\s*(${NUMBER_SOURCE})\\s*$`, 'u')
const NUMBER_RE = new RegExp(`^\\s*${NUMBER_SOURCE}\\s*$`, 'u')
const UNIT_RE = new RegExp(`^\\s*(?:${SUFFIX_UNIT_SOURCE})\\s*$`, 'u')

function clean(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim()
}

export function parseMetricDisplay(value) {
  const display = clean(value)
  if (!display) return null

  const suffix = display.match(SUFFIX_METRIC_RE)
  if (suffix) {
    return { value: clean(suffix[1]), unit: clean(suffix[2]), unit_position: 'suffix' }
  }

  const prefix = display.match(PREFIX_METRIC_RE)
  if (prefix) {
    return { value: clean(prefix[2]), unit: clean(prefix[1]), unit_position: 'prefix' }
  }

  return null
}

export function formatMetricDisplay(metric) {
  const value = clean(metric?.value)
  const unit = clean(metric?.unit)
  if (!value) return ''
  if (!unit) return value
  if (metric?.unit_position === 'prefix' || /^[₽$€£]$/u.test(unit)) return `${unit}${value}`
  if (/^[A-Za-z\u0400-\u04FF]/u.test(unit)) return `${value} ${unit}`
  return `${value}${unit}`
}

export function adaptMetricsForLayout(metrics, layout) {
  const { metrics: normalized } = normalizeMetricItems(metrics)
  if (!layout || layout.unit_mode !== 'none') return normalized

  return normalized.map((metric) => {
    if (!metric.unit) return metric
    const display = formatMetricDisplay(metric)
    return {
      ...metric,
      value: display,
      unit: '',
      title: display,
      text: metric.description || metric.text || '',
    }
  })
}

export function layoutAcceptsMetricUnits(layout, metrics = []) {
  if (!layout || layout.unit_mode === 'none') {
    return !(metrics || []).some((metric) => clean(metric?.unit))
  }
  return true
}

export function normalizeMetricItem(item, { index = 0 } = {}) {
  const source = item && typeof item === 'object' ? item : { title: item }
  const explicitValue = clean(source.value)
  const explicitUnit = clean(source.unit)
  const description = clean(source.description || source.text || source.caption)
  const rawDisplay = clean(source.title || source.display || source.label)
  const parsed = parseMetricDisplay(rawDisplay)

  const value = explicitValue || parsed?.value || (NUMBER_RE.test(rawDisplay) ? rawDisplay : '')
  const unit = explicitUnit || parsed?.unit || ''
  const unitPosition = source.unit_position || parsed?.unit_position
    || (/^[₽$€£]$/u.test(unit) ? 'prefix' : 'suffix')
  const errors = []

  if (!value || !NUMBER_RE.test(value)) errors.push('value')
  if (unit && !UNIT_RE.test(unit)) errors.push('unit')
  if (!description) errors.push('description')

  if (errors.length) {
    return {
      metric: null,
      issue: { index, code: 'invalid_metric', missing_or_invalid: errors, source },
    }
  }

  const metric = {
    ...source,
    value,
    unit,
    description,
    unit_position: unitPosition,
  }
  metric.title = formatMetricDisplay(metric)
  metric.text = description
  return { metric, issue: null }
}

export function normalizeMetricItems(items = []) {
  const metrics = []
  const issues = []

  ;(Array.isArray(items) ? items : []).forEach((item, index) => {
    const normalized = normalizeMetricItem(item, { index })
    if (normalized.metric) metrics.push(normalized.metric)
    if (normalized.issue) issues.push(normalized.issue)
  })

  return { metrics, issues }
}

export function isCompleteMetric(item) {
  return Boolean(normalizeMetricItem(item).metric)
}
