import { contrastRatio } from '../presentation/component-template-fit.js'
import { ptToSlideCqw, slideWidthPt } from './slide-metrics.js'

const DEFAULT_PALETTE = ['#0077FF', '#00A86B', '#FF6B35', '#7B61FF', '#FFB020']
const MIN_CHART_SERIES_COLORS = 2
const CARTESIAN_PLOT = { left: 2, top: 2, right: 2, bottom: 2 }
const DEFAULT_AXIS_LINE_COLOR = '#C5CED6'
const DEFAULT_GRID_LINE_COLOR = '#E3E8ED'
const DEFAULT_AXIS_LABEL_SIZE_PT = 8
const TEXT_CONTRAST_MIN = 2

function normalizeHexColor(value) {
  if (!value) return null
  const cleaned = String(value).trim().toUpperCase()
  const hex = cleaned.startsWith('#') ? cleaned : `#${cleaned}`
  return /^#[0-9A-F]{6}$/.test(hex) ? hex : null
}

function normalizeReservedColorSet(reservedColors) {
  if (!reservedColors) return new Set()
  if (reservedColors instanceof Set) return reservedColors
  const values = Array.isArray(reservedColors) ? reservedColors : [reservedColors]
  return new Set(
    values
      .map((color) => normalizeHexColor(color))
      .filter(Boolean),
  )
}

function mergePalettes(primary, supplement, minCount = MIN_CHART_SERIES_COLORS, reservedColors = null) {
  const merged = []
  const seen = new Set()
  const reserved = normalizeReservedColorSet(reservedColors)
  const append = (colors) => {
    for (const color of colors || []) {
      const normalized = normalizeHexColor(color)
      if (!normalized || seen.has(normalized) || reserved.has(normalized)) continue
      seen.add(normalized)
      merged.push(normalized)
    }
  }
  append(primary)
  if (merged.length < minCount) append(supplement)
  if (merged.length < minCount) append(DEFAULT_PALETTE.filter((color) => !reserved.has(color)))
  if (merged.length < minCount) append(DEFAULT_PALETTE)
  return merged
}

function collectReservedTextColors(tokens) {
  const reserved = new Set()
  const add = (color) => {
    const normalized = normalizeHexColor(color)
    if (normalized) reserved.add(normalized)
  }
  add(tokens?.defaultTextColor)
  add(tokens?.themeColors?.dk1)
  add(tokens?.themeColors?.tx1)
  for (const color of tokens?.titleColors || []) add(color)
  for (const option of tokens?.bodyTypographyOptions || []) add(option.color)
  return reserved
}

export function resolveChartPalette(element, tokens = null, {
  minColors = MIN_CHART_SERIES_COLORS,
  preferDesignSystem = false,
} = {}) {
  const chart = element.chart || {}
  const styleTokens = chart.style_tokens || element.style_tokens || {}
  const reserved = collectReservedTextColors(tokens)
  const fromTokens = (styleTokens.series_palette || [])
    .map((item) => item?.color)
    .filter(Boolean)
  const chartSeries = (tokens?.chartSeriesPalette || []).filter((color) => !reserved.has(normalizeHexColor(color)))
  const designSystem = (tokens?.palette || []).filter((color) => !reserved.has(normalizeHexColor(color)))
  const fromElement = Array.isArray(element.series_palette) ? element.series_palette
    : Array.isArray(chart.series_palette) ? chart.series_palette : []

  const primary = preferDesignSystem && chartSeries.length ? chartSeries
    : fromTokens.length ? fromTokens
      : chartSeries.length ? chartSeries
      : fromElement.length ? fromElement
        : []
  const supplement = [...chartSeries, ...designSystem, ...DEFAULT_PALETTE]
  return mergePalettes(primary, supplement, minColors, reserved)
}

function resolveChartData(element) {
  const chart = element.chart || {}
  const categories = chart.categories_preview
    || element.categories_preview
    || ['Q1', 'Q2', 'Q3', 'Q4']
  const series = chart.series
    || element.series_preview
    || [{ name: 'Series A', values_preview: [12, 19, 8, 15] }]
  return { categories, series }
}

function resolveStyleTokens(element) {
  return element.chart?.style_tokens || element.style_tokens || {}
}

function resolveCircularLayout(element) {
  return resolveStyleTokens(element).circular_layout || {}
}

function resolveCenterMetric(element) {
  const layout = resolveCircularLayout(element)
  const preview = element.center_metric_preview
    || element.chart?.center_metric_preview
    || layout.center_metric?.preview
  if (!preview?.value) return null
  return {
    value: preview.value,
    unit: preview.unit || '',
    valueTypography: layout.center_metric?.value_typography || preview.value_typography || {},
    unitTypography: layout.center_metric?.unit_typography || preview.unit_typography || {},
  }
}

export function resolveDoughnutHoleSize(element, metric) {
  const layout = resolveCircularLayout(element)
  const configured = Number(
    element.chart?.subtype?.hole_size
    ?? element.subtype?.hole_size
    ?? layout.center_metric?.required_hole_size
    ?? 68
  )
  if (!metric) return Math.max(0, Math.min(configured, 90))

  const diameterPt = Number(element.geometry_pt?.width_pt)
    || Number(element.baseline_preview?.geometry_pt?.width_pt)
    || Number(element.default_geometry_pt?.width_pt)
    || 240
  const valueSize = Number(metric.valueTypography?.size_pt) || 18
  const unitSize = Number(metric.unitTypography?.size_pt) || Math.max(10, valueSize * 0.62)
  const textWidth = String(metric.value || '').length * valueSize * 0.58
    + String(metric.unit || '').length * unitSize * 0.55
  const textHeight = Math.max(valueSize, unitSize) * 1.18
  const padding = Math.max(4, Math.max(valueSize, unitSize) * 0.2)
  const requiredRadius = Math.hypot(textWidth / 2, textHeight / 2) + padding
  const required = Math.ceil(requiredRadius / Math.max(diameterPt / 2, 1) * 100)
  return Math.max(64, Math.min(84, Math.max(configured, required)))
}

function isCircularChartType(chartType) {
  return chartType === 'pie' || chartType === 'doughnut' || chartType === 'donut'
}

function normalizeSeriesValues(series, categoryCount) {
  const values = series.values_preview || series.values || []
  if (values.length >= categoryCount) return values.slice(0, categoryCount)
  return [...values, ...Array.from({ length: categoryCount - values.length }, () => 0)]
}

function createSvg(className, { preserveAspect = false } = {}) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('class', className)
  svg.setAttribute('viewBox', '0 0 100 100')
  svg.setAttribute('preserveAspectRatio', preserveAspect ? 'xMidYMid meet' : 'none')
  svg.style.width = '100%'
  svg.style.height = '100%'
  svg.style.display = 'block'
  return svg
}

function collectSeriesPaletteColors(styleTokens = {}, tokens = null) {
  const colors = new Set()
  const add = (value) => {
    const normalized = normalizeHexColor(value)
    if (normalized) colors.add(normalized)
  }
  for (const item of styleTokens.series_palette || []) add(item?.color)
  for (const item of styleTokens.series_fill_variants || []) add(item?.color)
  for (const color of tokens?.chartSeriesPalette || []) add(color)
  for (const color of tokens?.palette || []) add(color)
  return colors
}

function opaquePlateColor(fill) {
  if (!fill || fill.kind === 'none') return null
  if (Number(fill.alpha ?? 1) < 0.85) return null
  return normalizeHexColor(fill.color)
}

function designSystemTextColors(tokens) {
  const colors = []
  for (const color of tokens?.titleColors || []) colors.push(color)
  for (const option of tokens?.bodyTypographyOptions || []) colors.push(option?.color)
  colors.push(tokens?.defaultTextColor)
  const theme = tokens?.themeColors || {}
  for (const key of ['lt1', 'lt2', 'bg1', 'bg2', 'dk1', 'tx1']) colors.push(theme[key])
  return colors
}

function pickContrastingTextColor(tokens, surfaceColor) {
  let best = null
  let bestRatio = 0
  const seen = new Set()
  for (const candidate of designSystemTextColors(tokens)) {
    const normalized = normalizeHexColor(candidate)
    if (!normalized || seen.has(normalized)) continue
    seen.add(normalized)
    const ratio = contrastRatio(normalized, surfaceColor)
    if (ratio <= bestRatio) continue
    bestRatio = ratio
    best = normalized
  }
  return bestRatio >= TEXT_CONTRAST_MIN ? best : null
}

function labelPlateColor(styleTokens, tokenKey) {
  return opaquePlateColor(tokenKey && styleTokens?.[tokenKey]?.fill)
    || opaquePlateColor(styleTokens?.axis_label?.fill)
}

export function resolveChartTextColor(tokens, styleTokens = {}, {
  typography = null,
  tokenKey = null,
  preferBody = false,
  surfaceColor = null,
} = {}) {
  const inferredTypographyColor = normalizeHexColor(typography?.color)
  if (styleTokens.inference?.source === 'pseudo_chart' && inferredTypographyColor) {
    return inferredTypographyColor
  }
  const bodyCandidates = [
    tokens?.bodyTypographyOptions?.[0]?.color,
    tokens?.activeTemplate?.colors?.text_styles?.body?.primary,
    tokens?.defaultTextColor,
    tokens?.themeColors?.dk1,
    tokens?.themeColors?.tx1,
  ]
  const styleCandidates = [
    typography?.color,
    tokenKey && styleTokens[tokenKey]?.typography?.color,
    tokenKey && styleTokens[tokenKey]?.color,
    styleTokens.legend?.typography?.color,
    styleTokens.value_axis?.typography?.color,
    styleTokens.category_axis?.typography?.color,
    styleTokens.axis_label?.typography?.color,
    styleTokens.axis_label?.color,
  ]
  const tailCandidates = [
    tokens?.titleColors?.[0],
    '#17212D',
  ]
  const candidates = preferBody
    ? [...bodyCandidates, ...styleCandidates, ...tailCandidates]
    : [...styleCandidates, ...bodyCandidates, ...tailCandidates]
  const reservedSeries = collectSeriesPaletteColors(styleTokens, tokens)
  let resolved = '#17212D'
  for (const candidate of candidates) {
    const normalized = normalizeHexColor(candidate)
    if (!normalized) continue
    if (preferBody && reservedSeries.has(normalized)) continue
    resolved = normalized
    break
  }
  if (labelPlateColor(styleTokens, tokenKey) || !surfaceColor) return resolved
  if (contrastRatio(resolved, surfaceColor) >= TEXT_CONTRAST_MIN) return resolved
  return pickContrastingTextColor(tokens, surfaceColor) || resolved
}

function applyChartTypography(node, typography, tokens, styleTokens, {
  fallbackSizePt = null,
  tokenKey = null,
  preferBody = false,
  surfaceColor = null,
} = {}) {
  const color = resolveChartTextColor(tokens, styleTokens, {
    typography,
    tokenKey,
    preferBody,
    surfaceColor,
  })
  node.style.color = color
  if (typography?.family || tokens?.defaultFontFamily) {
    node.style.fontFamily = typography?.family || tokens.defaultFontFamily
  }
  if (typography?.size_pt) node.style.fontSize = `${typography.size_pt}pt`
  else if (fallbackSizePt) node.style.fontSize = `${fallbackSizePt}pt`
  if (typography?.bold !== undefined && typography?.bold !== null) {
    node.style.fontWeight = typography.bold ? '700' : '400'
  }
  if (typography?.italic) node.style.fontStyle = 'italic'
  if (typography?.line_height_ratio) node.style.lineHeight = String(typography.line_height_ratio)
}

function resolveAxisLineColor(styleTokens) {
  return normalizeHexColor(styleTokens.axis_line?.color) || DEFAULT_AXIS_LINE_COLOR
}

function resolveGridLineColor(styleTokens) {
  return normalizeHexColor(styleTokens.grid_line?.color) || DEFAULT_GRID_LINE_COLOR
}

function resolveChartLineWidth(style, chartWidthPt, fallback = 0.35) {
  const widthPt = Number(style?.width_pt)
  if (!Number.isFinite(widthPt) || widthPt <= 0) return fallback
  return Math.max(0.05, Math.min(1.5, widthPt / Math.max(chartWidthPt, 1) * 100))
}

function computeCartesianMaxValue(series, categoryCount) {
  return Math.max(
    1,
    ...series.flatMap((item) => normalizeSeriesValues(item, categoryCount)),
  )
}

function computeValueTicks(maxValue) {
  const targetSteps = 4
  const roughStep = maxValue / targetSteps
  const magnitude = 10 ** Math.floor(Math.log10(Math.max(roughStep, 1)))
  const normalized = roughStep / magnitude
  let niceNormalized = 1
  if (normalized > 5) niceNormalized = 10
  else if (normalized > 2) niceNormalized = 5
  else if (normalized > 1) niceNormalized = 2
  const step = niceNormalized * magnitude
  const ticks = []
  for (let value = 0; value <= maxValue + step * 0.01; value += step) {
    ticks.push(Math.round(value))
    if (ticks.length >= 6) break
  }
  if (ticks[ticks.length - 1] < maxValue) {
    ticks.push(Math.round(Math.ceil(maxValue / step) * step))
  }
  return ticks
}

function formatAxisValue(value) {
  const rounded = Math.round(Number(value) || 0)
  if (Math.abs(rounded) >= 1000) return `${Math.round(rounded / 100) / 10}k`
  return String(rounded)
}

function appendSvgLine(svg, { x1, y1, x2, y2, color, width = 0.35, opacity = 1 }) {
  const line = document.createElementNS('http://www.w3.org/2000/svg', 'line')
  line.setAttribute('x1', String(x1))
  line.setAttribute('y1', String(y1))
  line.setAttribute('x2', String(x2))
  line.setAttribute('y2', String(y2))
  line.setAttribute('stroke', color)
  line.setAttribute('stroke-width', String(width))
  if (opacity < 1) line.setAttribute('stroke-opacity', String(opacity))
  svg.append(line)
  return line
}

let labelMeasureContext = null

function estimateLabelWidthPt(value, sizePt, fontFamily = 'Arial, sans-serif') {
  const text = String(value ?? '')
  if (!text) return 0
  if (typeof document !== 'undefined') {
    try {
      if (!labelMeasureContext) labelMeasureContext = document.createElement('canvas').getContext('2d')
      if (labelMeasureContext) {
        const sizePx = sizePt * (96 / 72)
        labelMeasureContext.font = `${sizePx}px "${fontFamily}", Arial, sans-serif`
        return labelMeasureContext.measureText(text).width * (72 / 96)
      }
    } catch {
      // The character-width approximation below keeps server-side tests deterministic.
    }
  }
  const wide = (text.match(/[MWШЩЮЖ@%8]/g) || []).length
  const narrow = (text.match(/[ilI1.,:;|!]/g) || []).length
  return sizePt * Math.max(1, text.length * 0.54 + wide * 0.18 - narrow * 0.2)
}

export function buildCartesianLayout(categories, series, {
  categoryMode = 'bar',
  chartWidthPt = 600,
  chartHeightPt = 280,
  categoryLabelSizePt = DEFAULT_AXIS_LABEL_SIZE_PT,
  valueLabelSizePt = 7.5,
  fontFamily = 'Arial, sans-serif',
  showCategoryAxis = true,
  showValueAxis = true,
  categoryLabelLines = 0,
  topReservePt = 0,
} = {}) {
  const maxValue = computeCartesianMaxValue(series, categories.length)
  const ticks = computeValueTicks(maxValue)
  const valueLabelWidthPt = showValueAxis
    ? Math.max(0, ...ticks.map((tick) => estimateLabelWidthPt(formatAxisValue(tick), valueLabelSizePt, fontFamily)))
    : 0
  const axisGapPt = showValueAxis ? Math.max(3, valueLabelSizePt * 0.55) : 0
  const left = showValueAxis
    ? Math.min(28, Math.max(2, ((valueLabelWidthPt + axisGapPt) / Math.max(chartWidthPt, 1)) * 100))
    : CARTESIAN_PLOT.left
  const categoryWidthsPt = categories.map((label) => estimateLabelWidthPt(label, categoryLabelSizePt, fontFamily))
  const endpointRight = categoryMode === 'line' && showCategoryAxis && categoryWidthsPt.length
    ? (categoryWidthsPt.at(-1) / 2 / Math.max(chartWidthPt, 1)) * 100
    : CARTESIAN_PLOT.right
  const endpointLeft = categoryMode === 'line' && showCategoryAxis && categoryWidthsPt.length
    ? (categoryWidthsPt[0] / 2 / Math.max(chartWidthPt, 1)) * 100
    : 0
  // A label plan (round 14) reserves whole wrapped lines under the axis.
  const bottom = showCategoryAxis
    ? categoryLabelLines > 0
      ? Math.min(32, Math.max(4, ((categoryLabelLines * categoryLabelSizePt * 1.2 + 3) / Math.max(chartHeightPt, 1)) * 100))
      : Math.min(18, Math.max(4, ((categoryLabelSizePt * 1.25 + 3) / Math.max(chartHeightPt, 1)) * 100))
    : CARTESIAN_PLOT.bottom
  const plot = {
    left: Math.max(left, endpointLeft),
    top: Math.max(CARTESIAN_PLOT.top, Math.min(25, (topReservePt / Math.max(chartHeightPt, 1)) * 100)),
    right: Math.min(20, Math.max(CARTESIAN_PLOT.right, endpointRight)),
    bottom,
  }
  const plotWidth = 100 - plot.left - plot.right
  const plotHeight = 100 - plot.top - plot.bottom
  const categoryCount = Math.max(categories.length, 1)
  const groupWidth = plotWidth / categoryCount
  const stepX = plotWidth / Math.max(categoryCount - 1, 1)
  const categoryXs = categories.map((_, index) => (
    categoryMode === 'line'
      ? plot.left + index * stepX
      : plot.left + (index + 0.5) * groupWidth
  ))
  return {
    plot,
    plotWidth,
    plotHeight,
    maxValue,
    groupWidth,
    stepX,
    categoryXs,
    valueTicks: ticks,
    valueLabelWidthPt,
    axisGapPercent: axisGapPt / Math.max(chartWidthPt, 1) * 100,
    chartWidthPt,
  }
}

function renderCartesianAxes(
  svg,
  {
    categories,
    layout,
    styleTokens,
    showCategoryAxis = true,
    showValueAxis = true,
    isBaseline = false,
  },
) {
  const { plot, plotHeight, maxValue } = layout
  const gridToken = styleTokens.grid_line || {}
  const axisToken = styleTokens.axis_line || {}
  const gridVisible = gridToken.visible === true || (!isBaseline && gridToken.visible !== false)
  const axisVisible = axisToken.visible === true || (!isBaseline && axisToken.visible !== false)
  const sharedToken = gridVisible ? gridToken : axisToken
  const sharedColor = gridVisible ? resolveGridLineColor(styleTokens) : resolveAxisLineColor(styleTokens)
  const sharedWidth = resolveChartLineWidth(sharedToken, layout.chartWidthPt)

  if (showValueAxis && gridVisible && gridToken.horizontal_visible !== false) {
    const ticks = computeValueTicks(maxValue)
    ticks.forEach((tick) => {
      const y = plot.top + plotHeight - (tick / maxValue) * plotHeight
      appendSvgLine(svg, {
        x1: plot.left,
        y1: y,
        x2: 100 - layout.plot.right,
        y2: y,
        color: sharedColor,
        width: sharedWidth,
        opacity: tick === 0 ? 1 : 0.85,
      })
    })
  }

  if (showCategoryAxis && gridVisible && gridToken.vertical_visible === true) {
    layout.categoryXs.forEach((x) => appendSvgLine(svg, {
      x1: x,
      y1: plot.top,
      x2: x,
      y2: plot.top + plotHeight,
      color: sharedColor,
      width: sharedWidth,
      opacity: 0.85,
    }))
  }

  if (showValueAxis && axisVisible) {
    appendSvgLine(svg, {
      x1: plot.left,
      y1: plot.top,
      x2: plot.left,
      y2: plot.top + plotHeight,
      color: sharedColor,
      width: sharedWidth,
    })
  }

  if (showCategoryAxis && axisVisible) {
    const baselineY = plot.top + plotHeight
    appendSvgLine(svg, {
      x1: plot.left,
      y1: baselineY,
      x2: 100 - layout.plot.right,
      y2: baselineY,
      color: sharedColor,
      width: sharedWidth,
    })
  }
}

function resolveAxisLabelSizePt(styleTokens, tokenKey, fallback = DEFAULT_AXIS_LABEL_SIZE_PT) {
  return styleTokens[tokenKey]?.typography?.size_pt
    || styleTokens.axis_label?.typography?.size_pt
    || fallback
}

export function resolveBaseChartLabelTypography(tokens = null) {
  const body = tokens?.bodyTypographyOptions?.[0] || {}
  return {
    family: body.family || tokens?.defaultFontFamily || 'Arial, sans-serif',
    size_pt: Number(body.size_pt || body.sizePt) || DEFAULT_AXIS_LABEL_SIZE_PT,
    color: normalizeHexColor(
      body.color
      || tokens?.activeTemplate?.colors?.text_styles?.body?.primary
      || tokens?.defaultTextColor,
    ) || '#17212D',
    bold: Boolean(body.bold),
  }
}

function mountCartesianAxisLabels(container, {
  categories,
  layout,
  tokens,
  styleTokens,
  slideSizePt,
  showCategoryAxis = true,
  showValueAxis = true,
  preferBody = true,
  surfaceColor = null,
  categoryLines = null,
  planColor = null,
}) {
  const overlay = document.createElement('div')
  overlay.className = 'catalog-chart-axis-labels'
  overlay.setAttribute('aria-hidden', 'true')

  const widthPt = slideWidthPt(slideSizePt)
  const baseTypography = resolveBaseChartLabelTypography(tokens)
  const categoryTypography = {
    ...baseTypography,
    ...(styleTokens.axis_label?.typography || {}),
    ...(styleTokens.category_axis?.typography || {}),
  }
  const valueTypography = {
    ...baseTypography,
    ...(styleTokens.axis_label?.typography || {}),
    ...(styleTokens.value_axis?.typography || {}),
  }
  const categoryFontFamily = categoryTypography.family
  const valueFontFamily = valueTypography.family
  const labelColor = planColor || resolveChartTextColor(tokens, styleTokens, {
    tokenKey: 'category_axis',
    typography: styleTokens.category_axis?.typography || styleTokens.axis_label?.typography || {},
    preferBody,
    surfaceColor,
  })
  const valueColor = planColor || resolveChartTextColor(tokens, styleTokens, {
    tokenKey: 'value_axis',
    typography: styleTokens.value_axis?.typography || styleTokens.axis_label?.typography || {},
    preferBody,
    surfaceColor,
  })
  const labelSize = ptToSlideCqw(resolveAxisLabelSizePt(styleTokens, 'category_axis', baseTypography.size_pt), widthPt)
  const valueSize = ptToSlideCqw(resolveAxisLabelSizePt(styleTokens, 'value_axis', baseTypography.size_pt), widthPt)

  if (showValueAxis) {
    const yLabels = document.createElement('div')
    yLabels.className = 'catalog-chart-y-axis-labels'
    yLabels.style.width = '100%'
    ;(layout.valueTicks || computeValueTicks(layout.maxValue)).forEach((tick) => {
      const y = layout.plot.top + layout.plotHeight - (tick / layout.maxValue) * layout.plotHeight
      const node = document.createElement('span')
      node.className = 'catalog-chart-axis-tick catalog-chart-axis-tick--y'
      node.style.top = `${y}%`
      node.style.left = '0'
      node.style.width = `${Math.max(0, layout.plot.left - (layout.axisGapPercent || 0))}%`
      node.style.color = valueColor
      node.style.fontSize = valueSize
      node.style.fontFamily = `"${valueFontFamily}", Arial, sans-serif`
      if (valueTypography.bold) node.style.fontWeight = '700'
      node.textContent = formatAxisValue(tick)
      yLabels.append(node)
    })
    overlay.append(yLabels)
  }

  if (showCategoryAxis) {
    const xLabels = document.createElement('div')
    xLabels.className = 'catalog-chart-x-axis-labels'
    xLabels.style.top = `${layout.plot.top + layout.plotHeight}%`
    xLabels.style.bottom = 'auto'
    xLabels.style.height = `${layout.plot.bottom}%`
    categories.forEach((label, index) => {
      const node = document.createElement('span')
      node.className = 'catalog-chart-category-label'
      node.style.left = `${layout.categoryXs[index]}%`
      node.style.color = labelColor
      node.style.fontSize = labelSize
      node.style.fontFamily = `"${categoryFontFamily}", Arial, sans-serif`
      if (categoryTypography.bold) node.style.fontWeight = '700'
      if (categoryLines?.[index]) {
        // Planned whole-word lines: no ellipsis, no mid-word cut.
        node.textContent = categoryLines[index].join('\n')
        node.style.whiteSpace = 'pre'
        node.style.maxWidth = 'none'
        node.style.overflow = 'visible'
        node.style.textOverflow = 'clip'
        node.style.lineHeight = '1.2'
      } else {
        node.textContent = String(label)
      }
      xLabels.append(node)
    })
    overlay.append(xLabels)
  }

  container.append(overlay)
  return overlay
}

export function computeCenterMetricFitScale({
  diameter,
  holeSize,
  contentWidth,
  contentHeight,
  safetyRatio = 0.82,
}) {
  const innerDiameter = Math.max(1, Number(diameter) * Number(holeSize) / 100)
  const safeDiameter = innerDiameter * safetyRatio
  return Math.max(0.1, Math.min(
    1,
    safeDiameter / Math.max(Number(contentWidth) || 1, 1),
    safeDiameter / Math.max(Number(contentHeight) || 1, 1),
  ))
}

function fitCenterMetricOverlay(parent, overlay, value, unit, holeSize) {
  if (typeof parent.getBoundingClientRect !== 'function'
    || typeof overlay.getBoundingClientRect !== 'function') return
  const fit = () => {
    const plotRect = parent.getBoundingClientRect()
    const valueRect = value.getBoundingClientRect()
    const unitRect = unit.getBoundingClientRect()
    const gap = parseFloat(globalThis.getComputedStyle?.(overlay)?.gap || '0') || 0
    const scale = computeCenterMetricFitScale({
      diameter: Math.min(plotRect.width, plotRect.height),
      holeSize,
      contentWidth: valueRect.width + unitRect.width + gap,
      contentHeight: Math.max(valueRect.height, unitRect.height),
    })
    if (scale >= 0.999) return
    for (const node of [value, unit]) {
      const current = parseFloat(globalThis.getComputedStyle?.(node)?.fontSize || node.style.fontSize)
      if (Number.isFinite(current) && current > 0) node.style.fontSize = `${current * scale}px`
    }
    overlay.dataset.fitScale = String(Math.round(scale * 10000) / 10000)
  }
  fit()
  if (typeof globalThis.requestAnimationFrame === 'function') globalThis.requestAnimationFrame(fit)
  if (globalThis.document?.fonts?.ready) globalThis.document.fonts.ready.then(fit)
}

function mountCenterMetric(parent, metric, tokens, styleTokens, holeSize = 68, surfaceColor = null) {
  if (!metric) return null
  const overlay = document.createElement('div')
  overlay.className = 'catalog-chart-center-metric'
  const freeDiameterPct = Math.max(30, Math.min(holeSize * 0.82, 74))
  overlay.style.width = `${freeDiameterPct}%`
  overlay.style.height = `${freeDiameterPct}%`
  const value = document.createElement('span')
  value.className = 'catalog-chart-center-metric-value'
  value.textContent = metric.value
  applyChartTypography(value, metric.valueTypography, tokens, styleTokens, {
    fallbackSizePt: 18,
    tokenKey: 'center_metric',
    surfaceColor,
  })
  const unit = document.createElement('span')
  unit.className = 'catalog-chart-center-metric-unit'
  unit.textContent = metric.unit
  applyChartTypography(unit, metric.unitTypography, tokens, styleTokens, {
    fallbackSizePt: 12,
    tokenKey: 'center_metric',
    surfaceColor,
  })
  overlay.append(value, unit)
  parent.append(overlay)
  fitCenterMetricOverlay(parent, overlay, value, unit, holeSize)
  return overlay
}

function renderBarChart(svg, { categories, series }, palette, fillVariants = [], renderOptions = {}) {
  const layout = renderOptions.layout || buildCartesianLayout(categories, series, { categoryMode: 'bar' })
  const {
    plot,
    plotHeight,
    maxValue,
    groupWidth,
  } = layout
  const barGap = groupWidth * 0.12
  const barWidth = (groupWidth - barGap) / Math.max(series.length, 1)
  const styleTokens = renderOptions.styleTokens || {}
  const showCategoryAxis = styleTokens.category_axis?.visible !== false
  const showValueAxis = styleTokens.value_axis?.visible !== false

  renderCartesianAxes(svg, {
    categories,
    layout,
    styleTokens,
    showCategoryAxis,
    showValueAxis,
    isBaseline: Boolean(renderOptions.isBaseline),
  })

  series.forEach((item, seriesIndex) => {
    const values = normalizeSeriesValues(item, categories.length)
    values.forEach((value, categoryIndex) => {
      const colorIndex = series.length === 1 ? categoryIndex : seriesIndex
      const height = (value / maxValue) * plotHeight
      const x = plot.left + categoryIndex * groupWidth + barGap / 2 + seriesIndex * barWidth
      const y = plot.top + plotHeight - height
      const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect')
      rect.setAttribute('x', String(x))
      rect.setAttribute('y', String(y))
      rect.setAttribute('width', String(Math.max(barWidth * 0.92, 0.5)))
      rect.setAttribute('height', String(height))
      applySeriesFill(
        svg,
        rect,
        fillVariants[colorIndex],
        palette[colorIndex % palette.length],
        `bar-${seriesIndex}-${categoryIndex}`,
      )
      const radiusRatio = Number(styleTokens.series_geometry?.corner_radius_ratio)
      const radiusX = Number.isFinite(radiusRatio)
        ? Math.min(barWidth * 0.92 / 2, height / 2, barWidth * 0.92 * Math.max(0, radiusRatio))
        : 0.8
      const plotWidthPt = Number(renderOptions.chartWidthPt) || 0
      const plotHeightPt = Number(renderOptions.chartHeightPt) || 0
      const radiusY = plotWidthPt > 0 && plotHeightPt > 0
        ? Math.min(height / 2, radiusX * (plotWidthPt / plotHeightPt))
        : radiusX
      rect.setAttribute('rx', String(Math.round(radiusX * 1000) / 1000))
      rect.setAttribute('ry', String(Math.round(radiusY * 1000) / 1000))
      svg.append(rect)
    })
  })
}

function gradientVector(angleDeg = 0) {
  const radians = ((Number(angleDeg) || 0) - 90) * (Math.PI / 180)
  return {
    x1: `${50 - Math.cos(radians) * 50}%`,
    y1: `${50 - Math.sin(radians) * 50}%`,
    x2: `${50 + Math.cos(radians) * 50}%`,
    y2: `${50 + Math.sin(radians) * 50}%`,
  }
}

function applySeriesFill(svg, node, fillVariant, fallbackColor, gradientId) {
  const fallback = normalizeHexColor(fallbackColor) || DEFAULT_PALETTE[0]
  if (!fillVariant || fillVariant.kind === 'solid' || !Array.isArray(fillVariant.stops) || fillVariant.stops.length < 2) {
    node.setAttribute('fill', normalizeHexColor(fillVariant?.color) || fallback)
    return
  }

  let defs = svg.querySelector('defs')
  if (!defs) {
    defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs')
    svg.prepend(defs)
  }

  const existing = defs.querySelector(`#${gradientId}`)
  if (existing) existing.remove()

  const gradient = document.createElementNS('http://www.w3.org/2000/svg', 'linearGradient')
  gradient.setAttribute('id', gradientId)
  const vector = gradientVector(fillVariant.angle_deg)
  gradient.setAttribute('x1', vector.x1)
  gradient.setAttribute('y1', vector.y1)
  gradient.setAttribute('x2', vector.x2)
  gradient.setAttribute('y2', vector.y2)
  fillVariant.stops.forEach((stop) => {
    const stopNode = document.createElementNS('http://www.w3.org/2000/svg', 'stop')
    stopNode.setAttribute('offset', `${Math.round(Number(stop.position || 0) * 100)}%`)
    stopNode.setAttribute('stop-color', stop.color || fallback)
    if (stop.alpha != null) stopNode.setAttribute('stop-opacity', String(stop.alpha))
    gradient.append(stopNode)
  })
  defs.append(gradient)
  node.setAttribute('fill', `url(#${gradientId})`)
}

export function resolveChartFillVariants(element, tokens = null) {
  const styleTokens = resolveStyleTokens(element)
  const fromTokens = styleTokens.series_fill_variants || []
  if (fromTokens.length) return fromTokens
  return tokens?.chartSeriesFillVariants || []
}

export function resolveSeriesDisplayColor(fillVariants, palette, seriesIndex) {
  const fallback = normalizeHexColor(palette[seriesIndex % palette.length])
    || DEFAULT_PALETTE[seriesIndex % DEFAULT_PALETTE.length]
  const variant = fillVariants?.[seriesIndex]
  if (!variant) return fallback
  if (variant.kind === 'solid' || !Array.isArray(variant.stops) || variant.stops.length < 2) {
    return normalizeHexColor(variant.color) || fallback
  }
  return normalizeHexColor(variant.stops[0]?.color) || fallback
}

function resolveSeriesLegendSwatchStyle(fillVariants, palette, seriesIndex) {
  const variant = fillVariants?.[seriesIndex]
  const fallback = resolveSeriesDisplayColor(fillVariants, palette, seriesIndex)
  if (!variant || variant.kind === 'solid' || !Array.isArray(variant.stops) || variant.stops.length < 2) {
    return { background: fallback }
  }
  const angle = Number(variant.angle_deg || 0) + 90
  const stops = variant.stops
    .map((stop) => `${stop.color || fallback} ${Math.round(Number(stop.position || 0) * 100)}%`)
    .join(', ')
  return { background: `linear-gradient(${angle}deg, ${stops})` }
}

function pathNumber(value) {
  return Math.round(value * 1000) / 1000
}

export function buildMonotoneChartPath(points) {
  if (!points.length) return ''
  if (points.length === 1) return `M ${pathNumber(points[0].x)} ${pathNumber(points[0].y)}`

  const slopes = points.slice(0, -1).map((point, index) => (
    (points[index + 1].y - point.y) / Math.max(points[index + 1].x - point.x, 0.0001)
  ))
  const tangents = points.map((_, index) => {
    if (index === 0) return slopes[0]
    if (index === points.length - 1) return slopes.at(-1)
    const left = slopes[index - 1]
    const right = slopes[index]
    if (left === 0 || right === 0 || Math.sign(left) !== Math.sign(right)) return 0
    return (left + right) / 2
  })

  slopes.forEach((slope, index) => {
    if (slope === 0) {
      tangents[index] = 0
      tangents[index + 1] = 0
      return
    }
    const a = tangents[index] / slope
    const b = tangents[index + 1] / slope
    const magnitude = Math.hypot(a, b)
    if (magnitude <= 3) return
    const scale = 3 / magnitude
    tangents[index] = scale * a * slope
    tangents[index + 1] = scale * b * slope
  })

  let path = `M ${pathNumber(points[0].x)} ${pathNumber(points[0].y)}`
  for (let index = 0; index < points.length - 1; index += 1) {
    const current = points[index]
    const next = points[index + 1]
    const dx = next.x - current.x
    path += ` C ${pathNumber(current.x + dx / 3)} ${pathNumber(current.y + tangents[index] * dx / 3)}`
    path += ` ${pathNumber(next.x - dx / 3)} ${pathNumber(next.y - tangents[index + 1] * dx / 3)}`
    path += ` ${pathNumber(next.x)} ${pathNumber(next.y)}`
  }
  return path
}

function applySmoothSeriesStroke(node, color, styleTokens) {
  const widthPt = Number(styleTokens.series_line?.width_pt) || 1.4
  const widthPx = Math.max(1.25, Math.min(3.5, widthPt * (96 / 72)))
  node.setAttribute('fill', 'none')
  node.setAttribute('stroke', color)
  node.setAttribute('stroke-width', String(widthPx))
  node.setAttribute('stroke-linejoin', 'round')
  node.setAttribute('stroke-linecap', 'round')
  node.setAttribute('vector-effect', 'non-scaling-stroke')
}

function renderLineAreaChart(svg, { categories, series }, palette, { filled = false, ...renderOptions } = {}) {
  const layout = renderOptions.layout || buildCartesianLayout(categories, series, { categoryMode: 'line' })
  const {
    plot,
    plotHeight,
    maxValue,
    stepX,
  } = layout
  const styleTokens = renderOptions.styleTokens || {}
  const showCategoryAxis = styleTokens.category_axis?.visible !== false
  const showValueAxis = styleTokens.value_axis?.visible !== false

  renderCartesianAxes(svg, {
    categories,
    layout,
    styleTokens,
    showCategoryAxis,
    showValueAxis,
    isBaseline: Boolean(renderOptions.isBaseline),
  })

  series.forEach((item, seriesIndex) => {
    const values = normalizeSeriesValues(item, categories.length)
    const points = values.map((value, index) => {
      const x = plot.left + index * stepX
      const y = plot.top + plotHeight - (value / maxValue) * plotHeight
      return { x, y }
    })
    if (!points.length) return
    const curvePath = buildMonotoneChartPath(points)
    if (filled) {
      const area = document.createElementNS('http://www.w3.org/2000/svg', 'path')
      const baseY = plot.top + plotHeight
      const first = points[0]
      const last = points.at(-1)
      area.setAttribute('d', `${curvePath} L ${pathNumber(last.x)} ${pathNumber(baseY)} L ${pathNumber(first.x)} ${pathNumber(baseY)} Z`)
      area.setAttribute('fill', palette[seriesIndex % palette.length])
      area.setAttribute('fill-opacity', series.length > 1 ? '0.14' : '0.2')
      svg.append(area)
    }
    const line = document.createElementNS('http://www.w3.org/2000/svg', 'path')
    line.setAttribute('d', curvePath)
    applySmoothSeriesStroke(line, palette[seriesIndex % palette.length], styleTokens)
    svg.append(line)
  })
}

function renderPieChart(svg, { categories, series }, palette, { doughnut = false, holeSize = 50 } = {}) {
  const values = normalizeSeriesValues(series[0] || {}, categories.length)
  const total = values.reduce((sum, value) => sum + value, 0) || 1
  const cx = 50
  const cy = 50
  // The plot box already represents min(source image width, source image height).
  // Fill that square: using 38 here silently reduced the real chart diameter to 76%.
  const outerRadius = 50
  const innerRadius = doughnut ? outerRadius * (Math.max(0, Math.min(holeSize, 90)) / 100) : 0
  let startAngle = -Math.PI / 2

  values.forEach((value, index) => {
    const angle = (value / total) * Math.PI * 2
    const endAngle = startAngle + angle
    const x1 = cx + Math.cos(startAngle) * outerRadius
    const y1 = cy + Math.sin(startAngle) * outerRadius
    const x2 = cx + Math.cos(endAngle) * outerRadius
    const y2 = cy + Math.sin(endAngle) * outerRadius
    const largeArc = angle > Math.PI ? 1 : 0
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
    if (innerRadius > 0) {
      const ix1 = cx + Math.cos(startAngle) * innerRadius
      const iy1 = cy + Math.sin(startAngle) * innerRadius
      const ix2 = cx + Math.cos(endAngle) * innerRadius
      const iy2 = cy + Math.sin(endAngle) * innerRadius
      path.setAttribute(
        'd',
        `M ${x1} ${y1} A ${outerRadius} ${outerRadius} 0 ${largeArc} 1 ${x2} ${y2} L ${ix2} ${iy2} A ${innerRadius} ${innerRadius} 0 ${largeArc} 0 ${ix1} ${iy1} Z`,
      )
    } else {
      path.setAttribute(
        'd',
        `M ${cx} ${cy} L ${x1} ${y1} A ${outerRadius} ${outerRadius} 0 ${largeArc} 1 ${x2} ${y2} Z`,
      )
    }
    path.setAttribute('fill', palette[index % palette.length])
    svg.append(path)
    startAngle = endAngle
  })
}

function mountDataLabels(container, { data, layout, chartType, plan, slideSizePt }) {
  const texts = plan?.data_labels?.texts
  if (!plan?.data_labels?.visible || !texts) return null
  const overlay = document.createElement('div')
  overlay.className = 'catalog-chart-data-labels'
  overlay.setAttribute('aria-hidden', 'true')
  Object.assign(overlay.style, { position: 'absolute', inset: '0', zIndex: '1', pointerEvents: 'none' })
  const { plot, plotHeight, maxValue, groupWidth } = layout
  const barGap = groupWidth * 0.12
  const barWidth = (groupWidth - barGap) / Math.max(data.series.length, 1)
  data.series.forEach((item, seriesIndex) => {
    normalizeSeriesValues(item, data.categories.length).forEach((value, index) => {
      const text = texts[seriesIndex]?.[index]
      if (text == null) return
      const x = chartType === 'bar'
        ? plot.left + index * groupWidth + barGap / 2 + seriesIndex * barWidth + barWidth * 0.46
        : layout.categoryXs[index]
      const y = plot.top + plotHeight - (Math.max(0, value) / maxValue) * plotHeight
      const node = document.createElement('span')
      node.className = 'catalog-chart-data-label'
      Object.assign(node.style, {
        position: 'absolute',
        left: `${x}%`,
        top: `${y}%`,
        transform: 'translate(-50%, -100%)',
        paddingBottom: '0.15em',
        whiteSpace: 'nowrap',
        lineHeight: '1',
        color: plan.color,
        fontSize: ptToSlideCqw(plan.size_pt, slideWidthPt(slideSizePt)),
        fontFamily: `"${plan.family}", Arial, sans-serif`,
      })
      node.textContent = text
      overlay.append(node)
    })
  })
  container.append(overlay)
  return overlay
}

function mountLegend(node, chartType, data, palette, styleTokens, tokens, fillVariants = [], surfaceColor = null, { plan = null, slideSizePt = null } = {}) {
  if (plan ? !plan.legend?.visible : styleTokens.legend?.visible === false) return null
  const legend = document.createElement('div')
  legend.className = 'catalog-chart-legend'
  const textColor = plan?.color || resolveChartTextColor(tokens, styleTokens, {
    tokenKey: 'legend',
    preferBody: true,
    surfaceColor,
  })
  legend.style.color = textColor
  if (plan) {
    legend.style.fontSize = ptToSlideCqw(plan.size_pt, slideWidthPt(slideSizePt))
    legend.style.fontFamily = `"${plan.family}", Arial, sans-serif`
    legend.style.gap = '0.3em 0.9em'
    legend.style.lineHeight = '1.2'
  }
  const legendItems = isCircularChartType(chartType)
    ? data.categories.map((label, index) => ({
      label,
      swatchStyle: { background: palette[index % palette.length] },
    }))
    : data.series.map((item, index) => ({
      label: item.name || `Series ${index + 1}`,
      swatchStyle: resolveSeriesLegendSwatchStyle(fillVariants, palette, index),
    }))
  const planned = plan?.legend?.items
  legendItems.slice(0, planned ? legendItems.length : 6).forEach((item, index) => {
    const entry = document.createElement('span')
    entry.className = 'catalog-chart-legend-item'
    entry.style.color = textColor
    const swatch = document.createElement('i')
    Object.assign(swatch.style, item.swatchStyle)
    if (planned?.[index]) {
      entry.style.fontSize = 'inherit'
      entry.style.gap = '0.4em'
      entry.style.whiteSpace = 'pre'
      Object.assign(swatch.style, { width: '0.8em', height: '0.8em', flex: '0 0 auto' })
      entry.append(swatch, document.createTextNode(planned[index].join('\n')))
    } else {
      entry.append(swatch, document.createTextNode(item.label))
    }
    legend.append(entry)
  })
  node.append(legend)
  return legend
}

function mountCircularChart(node, element, chartType, data, palette, styleTokens, tokens, fillVariants = [], surfaceColor = null, { plan = null, slideSizePt = null, boxPt = null } = {}) {
  node.classList.add('catalog-chart--circular')
  const layout = resolveCircularLayout(element)
  const planLegend = plan?.legend?.visible ? plan.legend : null
  const plotRatio = planLegend && boxPt && planLegend.position !== 'right'
    ? Math.max(0.3, Math.min(1, (boxPt.height - planLegend.band_pt) / Math.max(boxPt.height, 1)))
    : Number(element.baseline_preview?.plot_region_norm?.height)
    || Number(layout.plot_height_ratio)
    || 0.84

  const stack = document.createElement('div')
  stack.className = 'catalog-chart-circular-stack'
  node.append(stack)

  const plotWrap = document.createElement('div')
  plotWrap.className = 'catalog-chart-circular-plot-wrap'
  plotWrap.style.flex = `0 0 ${Math.round(plotRatio * 1000) / 10}%`
  if (planLegend?.position === 'right' && boxPt) {
    // Legend column beside the circle (wide boxes).
    stack.style.flexDirection = 'row'
    stack.style.alignItems = 'center'
    plotWrap.style.flex = `0 0 ${Math.round(planLegend.diameter_pt / Math.max(boxPt.width, 1) * 1000) / 10}%`
    plotWrap.style.height = '100%'
  }
  stack.append(plotWrap)

  const plot = document.createElement('div')
  plot.className = 'catalog-chart-plot catalog-chart-plot--square'
  plotWrap.append(plot)

  const svg = createSvg('catalog-chart-svg', { preserveAspect: true })
  const centerMetric = resolveCenterMetric(element)
  const holeSize = resolveDoughnutHoleSize(element, centerMetric)
  if (chartType === 'pie') {
    renderPieChart(svg, data, palette, { doughnut: false })
  } else {
    renderPieChart(svg, data, palette, { doughnut: true, holeSize })
  }
  plot.append(svg)

  if (centerMetric && (layout.center_metric?.enabled !== false)) {
    mountCenterMetric(plot, centerMetric, tokens, styleTokens, holeSize, surfaceColor)
  }

  const legend = mountLegend(stack, chartType, data, palette, styleTokens, tokens, fillVariants, surfaceColor, { plan, slideSizePt })
  if (legend && planLegend) {
    Object.assign(legend.style, planLegend.position === 'right'
      ? { flex: '1 1 auto', flexDirection: 'column', flexWrap: 'nowrap', alignItems: 'flex-start', justifyContent: 'center', marginTop: '0', paddingTop: '0', paddingLeft: '0.6em', minWidth: '0' }
      : { flex: '1 1 auto', marginTop: '0', paddingTop: '0.2em' })
  }
}

export function mountChart(node, element, slideSizePt, { tokens = null, surfaceColor = null } = {}) {
  const isBaseline = Boolean(element.is_baseline || String(element.element_id || '').endsWith('_baseline'))
  node.classList.add('catalog-chart', 'catalog-chart--rendered', 'catalog-chart--transparent-plot')
  if (isBaseline) node.classList.add('catalog-chart--baseline')
  node.style.overflow = 'hidden'
  node.style.boxSizing = 'border-box'
  node.style.background = 'transparent'
  node.style.borderColor = 'transparent'

  const chartType = String(element.chart_type || element.chart?.type || 'bar').toLowerCase()
  const data = resolveChartData(element)
  const categoryCount = Math.max(data.categories.length, data.series.length, MIN_CHART_SERIES_COLORS)
  const minColors = isCircularChartType(chartType) ? Math.max(MIN_CHART_SERIES_COLORS, categoryCount) : MIN_CHART_SERIES_COLORS
  const palette = resolveChartPalette(element, tokens, { minColors })
  const fillVariants = resolveChartFillVariants(element, tokens)
  const styleTokens = resolveStyleTokens(element)
  // Label plan (round 14, chart-labels.js): legend / labels / sizes / colour.
  const plan = element.chart?.label_plan?.version === 1 ? element.chart.label_plan : null
  const showCategoryAxis = plan ? Boolean(plan.category_axis?.visible) : styleTokens.category_axis?.visible !== false
  const showValueAxis = plan ? Boolean(plan.value_axis?.visible) : styleTokens.value_axis?.visible !== false
  const showLegend = plan ? Boolean(plan.legend?.visible) : styleTokens.legend?.visible !== false && data.series.length > 1
  const slideWidth = slideWidthPt(slideSizePt)
  const boxPt = {
    width: Number(element.geometry_norm?.width) * slideWidth || Number(element.geometry_pt?.width_pt) || 600,
    height: Number(element.geometry_norm?.height) * Number(slideSizePt?.height || 540) || Number(element.geometry_pt?.height_pt) || 280,
  }

  if (isCircularChartType(chartType)) {
    mountCircularChart(node, element, chartType, data, palette, styleTokens, tokens, fillVariants, surfaceColor, { plan, slideSizePt, boxPt })
    return node
  }

  const plot = document.createElement('div')
  plot.className = 'catalog-chart-plot'
  plot.style.position = 'absolute'
  plot.style.left = '0'
  plot.style.right = '0'
  plot.style.top = '0'
  plot.style.background = 'transparent'
  // With a label plan use the same box the plan was measured on.
  const chartHeightPt = (plan && boxPt.height) || Number(element.geometry_pt?.height_pt)
    || Number(element.geometry_norm?.height) * Number(slideSizePt?.height || 540)
    || 280
  const chartWidthPt = (plan && boxPt.width) || Number(element.geometry_pt?.width_pt)
    || Number(element.geometry_norm?.width) * slideWidthPt(slideSizePt)
    || 600
  const legendSizePt = resolveAxisLabelSizePt(styleTokens, 'legend', 8)
  const legendBandPercent = showLegend
    ? plan?.legend?.band_pt
      ? Math.min(30, (plan.legend.band_pt / Math.max(chartHeightPt, 1)) * 100)
      : Math.min(18, Math.max(7, ((legendSizePt * 1.35 + 5) / Math.max(chartHeightPt, 1)) * 100))
    : 0
  plot.style.bottom = `${legendBandPercent}%`
  node.append(plot)

  const svg = createSvg('catalog-chart-svg')
  svg.style.background = 'transparent'
  const categoryMode = chartType === 'bar' ? 'bar' : 'line'
  const baseLabelTypography = resolveBaseChartLabelTypography(tokens)
  const categoryLabelSizePt = resolveAxisLabelSizePt(styleTokens, 'category_axis', baseLabelTypography.size_pt)
  const valueLabelSizePt = resolveAxisLabelSizePt(styleTokens, 'value_axis', baseLabelTypography.size_pt)
  const layout = buildCartesianLayout(data.categories, data.series, {
    categoryMode,
    chartWidthPt,
    chartHeightPt: chartHeightPt * (1 - legendBandPercent / 100),
    categoryLabelSizePt,
    valueLabelSizePt,
    fontFamily: styleTokens.category_axis?.typography?.family || baseLabelTypography.family,
    showCategoryAxis,
    showValueAxis,
    categoryLabelLines: plan?.category_axis?.lines ? Math.max(1, ...plan.category_axis.lines.map((lines) => lines.length)) : 0,
    topReservePt: plan?.data_labels?.visible ? plan.data_labels.band_pt : 0,
  })
  const axisRenderOptions = {
    styleTokens,
    tokens,
    layout,
    isBaseline,
    chartWidthPt,
    chartHeightPt: chartHeightPt * (1 - legendBandPercent / 100),
  }
  if (chartType === 'line') {
    renderLineAreaChart(svg, data, palette, { filled: false, ...axisRenderOptions })
  } else if (chartType === 'area') {
    renderLineAreaChart(svg, data, palette, { filled: true, ...axisRenderOptions })
  } else {
    renderBarChart(svg, data, palette, fillVariants, axisRenderOptions)
  }
  plot.append(svg)

  mountCartesianAxisLabels(plot, {
    categories: data.categories,
    layout,
    tokens,
    styleTokens,
    slideSizePt,
    showCategoryAxis,
    showValueAxis,
    preferBody: true,
    surfaceColor,
    categoryLines: plan?.category_axis?.lines || null,
    planColor: plan?.color || null,
  })
  mountDataLabels(plot, { data, layout, chartType, plan, slideSizePt })

  if (showLegend) {
    const legend = mountLegend(node, chartType, data, palette, styleTokens, tokens, fillVariants, surfaceColor, { plan, slideSizePt })
    if (legend) {
      legend.style.height = `${legendBandPercent}%`
      legend.style.margin = '0'
      legend.style.padding = '0'
    }
  }

  return node
}
