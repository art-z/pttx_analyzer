import { contrastRatio, surfaceFillColor } from './component-template-fit.js'

// Every chart carries a legend or labels (round 14):
//   pie/doughnut  - a legend "category — percent" beside or below the circle;
//   bar/line/area - category labels under the axis, value labels above the
//                   bars/points when the template hides the value axis, and a
//                   legend when there are several series.
// Colour: a design-system text colour with WCAG contrast >= 4.5 (>= 3 for
// large text) against every surface under the chart box. Size: <= the body
// text size, never below CHART_LABEL_MIN_PT. Labels live inside the chart box
// (bands reserved from it), wrap by whole words (a word that still does not
// fit is abbreviated at a syllable boundary with a period); a chart whose
// labels still do not fit is reported as unfit so the hit-test rejects it.

export const CHART_LABEL_MIN_PT = 9
export const CHART_LABEL_LINE_HEIGHT = 1.2
export const LARGE_TEXT_PT = 18
const MAX_CATEGORY_LINES = 2
const MAX_LEGEND_LINES = 2
const CATEGORY_BAND_MAX = 0.3
const LEGEND_BAND_MAX = 0.3
const CIRCLE_MIN_PT = 72
const CIRCULAR_TYPES = new Set(['pie', 'doughnut', 'donut'])

export function requiredContrast(sizePt, bold = false) {
  return sizePt >= LARGE_TEXT_PT || (bold && sizePt >= 14) ? 3 : 4.5
}

function hex(value) {
  const match = String(value ?? '').trim().match(/^#?([0-9a-f]{6})$/i)
  return match ? `#${match[1].toUpperCase()}` : null
}

export function bodyTextSizePt(tokens) {
  const body = tokens?.bodyTypographyOptions?.[0] || {}
  return Number(body.size_pt ?? body.sizePt) || 12
}

function templateOf(report, slide) {
  const templates = report?.slide_templates?.templates || []
  return templates.find((item) => (slide?.template_id && item.template_id === slide.template_id)
    || (slide?.layout_source && item.layout_source === slide.layout_source)) || null
}

function fillColor(layer) {
  const fill = layer?.fill
  if (!fill || fill.kind === 'none' || Number(fill.alpha ?? 1) < 0.5) return null
  return hex(fill.color) || hex(fill.stops?.find((stop) => stop?.color)?.color)
}

// Colours actually painted under the chart box: a 5x5 sample grid, each point
// takes the topmost template fill covering it (an image counts as the
// template's measured background colour), else the slide background.
export function chartSurfaceColors(report, slide, element) {
  const box = element?.geometry_norm
  const template = templateOf(report, slide)
  const base = hex(slide?.render?.background_color) || hex(template?.colors?.background) || '#FFFFFF'
  // No placed box yet: the slide's topmost visible surface.
  if (!box) return [hex(surfaceFillColor(slide)) || base]
  const imageColor = hex(template?.colors?.background) || base
  const layers = (slide?.render?.layers || [])
    .filter((layer) => layer.geometry_norm && (layer.kind === 'image' || (layer.kind === 'fill' && fillColor(layer))))
    .sort((left, right) => (Number(left.z_index) || 0) - (Number(right.z_index) || 0))
  const colors = new Set()
  for (let i = 0; i < 5; i += 1) {
    for (let j = 0; j < 5; j += 1) {
      const x = box.x + box.width * (i + 0.5) / 5
      const y = box.y + box.height * (j + 0.5) / 5
      let color = base
      for (const layer of layers) {
        const g = layer.geometry_norm
        if (x < g.x || x > g.x + g.width || y < g.y || y > g.y + g.height) continue
        color = layer.kind === 'image' ? imageColor : fillColor(layer)
      }
      colors.add(color)
    }
  }
  return [...colors]
}

// Design-system text colours, most specific first.
export function designTextColors(tokens, template = null) {
  const styles = template?.colors?.text_styles || {}
  const theme = tokens?.themeColors || {}
  const list = [
    styles.body?.primary,
    ...(tokens?.bodyTypographyOptions || []).map((option) => option?.color),
    tokens?.activeTemplate?.colors?.text_styles?.body?.primary,
    tokens?.defaultTextColor,
    ...(styles.body?.candidates || []),
    ...(template?.colors?.text || []),
    styles.title?.primary,
    ...(tokens?.titleColors || []),
    theme.dk1, theme.tx1, theme.dk2, theme.lt1, theme.bg1, theme.lt2,
    template?.colors?.theme?.dk1, template?.colors?.theme?.lt1,
  ]
  return [...new Set(list.map(hex).filter(Boolean))]
}

export function pickChartTextColor(preferred, candidates, surfaces, sizePt, bold = false) {
  const required = requiredContrast(sizePt, bold)
  const pool = [...new Set([hex(preferred), ...candidates.map(hex)].filter(Boolean))]
  const worst = (color) => Math.min(...(surfaces.length ? surfaces : ['#FFFFFF']).map((surface) => contrastRatio(color, surface)))
  let best = null
  for (const color of pool) {
    const contrast = worst(color)
    if (contrast >= required) return { color, contrast: round2(contrast), required, ok: true }
    if (!best || contrast > best.contrast) best = { color, contrast }
  }
  return best
    ? { color: best.color, contrast: round2(best.contrast), required, ok: false }
    : { color: '#17212D', contrast: round2(worst('#17212D')), required, ok: false }
}

function round2(value) {
  return Math.round(value * 100) / 100
}

function roundHalf(value) {
  return Math.round(value * 2) / 2
}

// Conservative Arial-like width (pt) used for planning; the DOM renderer draws
// the exact planned lines, so a slightly wide estimate only costs space.
export function labelWidthPt(text, sizePt) {
  const value = String(text ?? '')
  if (!value) return 0
  const wide = (value.match(/[MWШЩЮЖФЫ@%mшщюжфы]/g) || []).length
  const narrow = (value.match(/[ilI1.,:;|!'\u00a0 ]/g) || []).length
  return sizePt * Math.max(0.6, value.length * 0.56 + wide * 0.2 - narrow * 0.26)
}

const VOWELS = /[аеёиоуыэюяaeiouy]/i
const NO_END = /[ьъйаеёиоуыэюяaeiouy]/i

// "Инфраструктура" -> "Инфраструкт.", "Разработка" -> "Разраб.": cut after a
// consonant that precedes a vowel, keep >= 3 letters.
export function abbreviateWord(word, maxWidthPt, sizePt) {
  if (labelWidthPt(word, sizePt) <= maxWidthPt) return word
  for (let length = word.length - 2; length >= 3; length -= 1) {
    const prefix = word.slice(0, length)
    if (NO_END.test(prefix.at(-1)) || !VOWELS.test(word[length] || '')) continue
    const short = `${prefix}.`
    if (labelWidthPt(short, sizePt) <= maxWidthPt) return short
  }
  return null
}

// Whole-word wrap into at most maxLines lines; null when a word alone is wider
// than the line or more lines are needed.
export function wrapWords(text, maxWidthPt, sizePt, maxLines = MAX_CATEGORY_LINES) {
  const words = String(text ?? '').trim().split(/ +/).filter(Boolean)
  if (!words.length) return ['']
  const lines = []
  let current = ''
  for (const word of words) {
    if (labelWidthPt(word, sizePt) > maxWidthPt) return null
    const joined = current ? `${current} ${word}` : word
    if (!current || labelWidthPt(joined, sizePt) <= maxWidthPt) current = joined
    else {
      lines.push(current)
      current = word
    }
  }
  lines.push(current)
  return lines.length <= maxLines ? lines : null
}

function wrapOrAbbreviate(text, maxWidthPt, sizePt, maxLines, allowAbbreviation) {
  const lines = wrapWords(text, maxWidthPt, sizePt, maxLines)
  if (lines || !allowAbbreviation) return lines
  const words = String(text ?? '').trim().split(/ +/).filter(Boolean)
  const shortened = words.map((word) => abbreviateWord(word, maxWidthPt, sizePt))
  if (shortened.some((word) => word == null)) return null
  return wrapWords(shortened.join(' '), maxWidthPt, sizePt, maxLines)
}

// Target size: a step below body text (0.85x), never above body, never below
// the minimum (unless the body itself is smaller).
export function chartLabelSizePt(bodySizePt, tokenSizePt = null) {
  const floor = Math.min(CHART_LABEL_MIN_PT, bodySizePt)
  const wanted = Number(tokenSizePt) > 0 ? Number(tokenSizePt) : bodySizePt * 0.85
  return roundHalf(Math.max(floor, Math.min(bodySizePt, wanted)))
}

function sizeSteps(start, floor) {
  const steps = []
  for (let size = start; size >= floor - 1e-6; size = roundHalf(size - 0.5)) steps.push(size)
  if (!steps.length) steps.push(floor)
  return steps
}

export function formatChartValue(value) {
  const number = Number(value) || 0
  if (Math.abs(number) >= 10000) return `${Math.round(number / 100) / 10}k`.replace('.', ',')
  const rounded = Math.round(number * 10) / 10
  return String(rounded).replace('.', ',')
}

export function formatPercent(value) {
  const rounded = Math.round(value)
  if (Math.abs(value - rounded) < 0.05) return `${rounded}%`
  return `${(Math.round(value * 10) / 10).toString().replace('.', ',')}%`
}

function chartData(element) {
  const chart = element.chart || {}
  const categories = (chart.categories_preview || element.categories_preview || []).map((item) => String(item ?? ''))
  const series = (chart.series || element.series_preview || []).map((item, index) => ({
    name: String(item?.label || item?.name || `Ряд ${index + 1}`),
    values: (item?.values_preview || item?.values || []).map((value) => Number(value) || 0),
  }))
  return { categories, series }
}

function legendRows(items, widthPt, sizePt) {
  // Items flow left to right; each item = swatch + gap + text (<= 2 lines).
  const swatch = sizePt * 0.8 + sizePt * 0.4
  const gap = sizePt * 0.9
  let rows = 1
  let rowWidth = 0
  let rowLines = 1
  let heightLines = 0
  const laid = []
  for (const item of items) {
    const lines = wrapOrAbbreviate(item, Math.max(10, widthPt - swatch), sizePt, MAX_LEGEND_LINES, true)
    if (!lines) return null
    const itemWidth = swatch + Math.max(...lines.map((line) => labelWidthPt(line, sizePt)))
    if (rowWidth && rowWidth + gap + itemWidth > widthPt) {
      rows += 1
      heightLines += rowLines
      rowWidth = itemWidth
      rowLines = lines.length
    } else {
      rowWidth = rowWidth ? rowWidth + gap + itemWidth : itemWidth
      rowLines = Math.max(rowLines, lines.length)
    }
    laid.push(lines)
  }
  heightLines += rowLines
  return { rows, lines: laid, heightPt: heightLines * sizePt * CHART_LABEL_LINE_HEIGHT + (rows - 1) * sizePt * 0.3 + 4 }
}

function legendColumn(items, widthPt, sizePt) {
  const swatch = sizePt * 0.8 + sizePt * 0.4
  const laid = []
  let heightPt = 0
  for (const item of items) {
    const lines = wrapOrAbbreviate(item, widthPt - swatch, sizePt, MAX_LEGEND_LINES, true)
    if (!lines) return null
    laid.push(lines)
    heightPt += lines.length * sizePt * CHART_LABEL_LINE_HEIGHT + sizePt * 0.45
  }
  return { lines: laid, heightPt }
}

function planCircular(data, box, size, floor) {
  const values = data.series[0]?.values || []
  const total = values.reduce((sum, value) => sum + Math.max(0, value), 0) || 1
  const items = data.categories.map((category, index) => `${category} —\u00a0${formatPercent(Math.max(0, values[index] || 0) / total * 100)}`)
  const right = box.width >= box.height * 1.35
  for (const sizePt of sizeSteps(size, floor)) {
    if (right) {
      const diameter = Math.min(box.height, box.width * 0.58)
      const legendWidth = box.width - diameter - sizePt
      const column = legendWidth > sizePt * 4 ? legendColumn(items, legendWidth, sizePt) : null
      if (column && column.heightPt <= box.height && diameter >= Math.min(CIRCLE_MIN_PT, box.height)) {
        return { sizePt, legend: { visible: true, position: 'right', items: column.lines, width_pt: round2(legendWidth), band_pt: round2(column.heightPt), diameter_pt: round2(diameter) } }
      }
    }
    const flow = legendRows(items, box.width, sizePt)
    if (!flow) continue
    const diameter = Math.min(box.width, box.height - flow.heightPt - 2)
    if (flow.heightPt <= box.height * 0.45 && diameter >= Math.min(CIRCLE_MIN_PT, box.height * 0.5)) {
      return { sizePt, legend: { visible: true, position: 'bottom', items: flow.lines, rows: flow.rows, band_pt: round2(flow.heightPt), diameter_pt: round2(diameter) } }
    }
  }
  return null
}

function planCartesian(data, box, chartType, styleTokens, size, floor) {
  const count = Math.max(data.categories.length, 1)
  const multi = data.series.length > 1
  const valueAxisOn = styleTokens.value_axis?.visible !== false
  const maxValue = Math.max(1, ...data.series.flatMap((item) => item.values))
  for (const allowAbbreviation of [false, true]) {
    for (const sizePt of sizeSteps(size, floor)) {
      // Legend band first (several series): it takes the bottom of the box.
      let legend = { visible: false }
      let legendBand = 0
      if (multi) {
        const flow = legendRows(data.series.map((item) => item.name), box.width, sizePt)
        if (!flow || flow.heightPt > box.height * LEGEND_BAND_MAX) continue
        legend = { visible: true, position: 'bottom', items: flow.lines, rows: flow.rows, band_pt: round2(flow.heightPt) }
        legendBand = flow.heightPt
      }
      // Value labels replace a hidden value axis where they cannot collide:
      // bars, or a single line/area series; otherwise the value axis shows.
      const dataLabelsWanted = !valueAxisOn && (chartType === 'bar' || !multi)
      for (const useDataLabels of dataLabelsWanted ? [true, false] : [false]) {
        const valueReserve = useDataLabels ? 0 : labelWidthPt(formatChartValue(maxValue), sizePt) + sizePt * 0.8
        const plotWidth = box.width * 0.96 - valueReserve
        const slot = plotWidth / count
        let dataLabels = { visible: false }
        if (useDataLabels) {
          const barSlot = chartType === 'bar' ? slot * 0.88 / Math.max(1, data.series.length) : slot
          const texts = data.series.map((item) => item.values.map(formatChartValue))
          if (!texts.flat().every((text) => labelWidthPt(text, sizePt) <= barSlot)) continue
          dataLabels = { visible: true, texts, band_pt: round2(sizePt * CHART_LABEL_LINE_HEIGHT + 2) }
        }
        const lines = data.categories.map((category) => wrapOrAbbreviate(category, slot * 0.94, sizePt, MAX_CATEGORY_LINES, allowAbbreviation))
        if (lines.some((item) => !item)) continue
        const lineCount = Math.max(1, ...lines.map((item) => item.length))
        const categoryBand = lineCount * sizePt * CHART_LABEL_LINE_HEIGHT + 3
        const plotHeight = box.height - legendBand - categoryBand - (dataLabels.band_pt || 0)
        if (categoryBand > box.height * CATEGORY_BAND_MAX || plotHeight < box.height * 0.35) continue
        return {
          sizePt,
          legend,
          category_axis: { visible: true, lines, band_pt: round2(categoryBand), abbreviated: allowAbbreviation },
          value_axis: { visible: !dataLabels.visible },
          data_labels: dataLabels,
        }
      }
    }
  }
  return null
}

// Label plan for one chart element placed on `slide`.
export function planChartLabels(element, { report = null, slide = null, tokens = null, surfaces = null } = {}) {
  const chartType = String(element.chart_type || element.chart?.type || 'bar').toLowerCase()
  const styleTokens = element.chart?.style_tokens || element.style_tokens || {}
  const slideSize = slide?.render?.slide_size_pt || { width: 960, height: 540 }
  const geometry = element.geometry_norm || {}
  const box = {
    width: Number(element.geometry_pt?.width_pt) || Number(geometry.width) * slideSize.width || 0,
    height: Number(element.geometry_pt?.height_pt) || Number(geometry.height) * slideSize.height || 0,
  }
  if (element.geometry_norm) {
    box.width = Number(geometry.width) * slideSize.width
    box.height = Number(geometry.height) * slideSize.height
  }
  const bodySizePt = bodyTextSizePt(tokens)
  const floor = Math.min(CHART_LABEL_MIN_PT, bodySizePt)
  const tokenSize = styleTokens.category_axis?.typography?.size_pt || styleTokens.axis_label?.typography?.size_pt
  const size = chartLabelSizePt(bodySizePt, CIRCULAR_TYPES.has(chartType) ? styleTokens.legend?.typography?.size_pt : tokenSize)
  const data = chartData(element)
  const template = templateOf(report, slide)
  const surfaceList = surfaces || chartSurfaceColors(report, slide, element)
  const family = styleTokens.category_axis?.typography?.family
    || tokens?.bodyTypographyOptions?.[0]?.family
    || tokens?.defaultFontFamily
    || 'Arial'
  const laid = CIRCULAR_TYPES.has(chartType)
    ? planCircular(data, box, size, floor)
    : planCartesian(data, box, chartType, styleTokens, size, floor)
  const sizePt = laid?.sizePt || floor
  // The chart's own label colour is kept only when it is a design-system
  // colour (not a renderer fallback such as #17212D).
  const dsColors = designTextColors(tokens, template)
  const tokenColor = hex(styleTokens.category_axis?.typography?.color || styleTokens.legend?.typography?.color)
  const preferred = tokenColor && dsColors.includes(tokenColor) ? tokenColor : null
  const color = pickChartTextColor(preferred, dsColors, surfaceList, sizePt)
  return {
    version: 1,
    chart_type: chartType,
    fits: Boolean(laid),
    reason: laid ? null : 'chart_labels_unfit',
    size_pt: sizePt,
    body_size_pt: bodySizePt,
    family,
    color: color.color,
    contrast: color.contrast,
    contrast_required: color.required,
    contrast_ok: color.ok,
    surfaces: surfaceList,
    legend: laid?.legend || { visible: false },
    category_axis: laid?.category_axis || { visible: false },
    value_axis: laid?.value_axis || { visible: false },
    data_labels: laid?.data_labels || { visible: false },
  }
}

// Style tokens the DOM renderer and the PPTX exporter read.
export function applyChartLabelPlan(element, plan) {
  const chart = element.chart || {}
  const current = chart.style_tokens || element.style_tokens || {}
  const typography = (token) => ({
    ...(token?.typography || {}),
    family: plan.family,
    size_pt: plan.size_pt,
    color: plan.color,
    bold: false,
  })
  const circular = CIRCULAR_TYPES.has(plan.chart_type)
  const styleTokens = {
    ...current,
    legend: { ...(current.legend || {}), visible: plan.legend.visible, position: plan.legend.position || current.legend?.position || 'below', typography: typography(current.legend) },
    category_axis: { ...(current.category_axis || {}), visible: circular ? current.category_axis?.visible !== false : plan.category_axis.visible, typography: typography(current.category_axis) },
    value_axis: { ...(current.value_axis || {}), visible: circular ? current.value_axis?.visible !== false : plan.value_axis.visible, typography: typography(current.value_axis) },
    data_labels: {
      visible: Boolean(plan.data_labels.visible),
      show_value: Boolean(plan.data_labels.visible),
      show_percent: false,
      show_category_name: false,
      position: 'outside_end',
      typography: typography(current.data_labels),
    },
  }
  return {
    ...element,
    ...(element.style_tokens ? { style_tokens: styleTokens } : {}),
    chart: { ...chart, style_tokens: styleTokens, label_plan: plan },
  }
}

export function planSlideChartLabels(report, slide, tokens) {
  if (!slide?.content_elements?.some((element) => element.kind === 'chart')) return { slide, issues: [] }
  const issues = []
  const content_elements = slide.content_elements.map((element) => {
    if (element.kind !== 'chart') return element
    const plan = planChartLabels(element, { report, slide, tokens })
    if (!plan.fits) {
      issues.push({ code: 'chart_labels_unfit', severity: 'error', element_id: element.element_id || null })
    }
    return applyChartLabelPlan(element, plan)
  })
  return { slide: { ...slide, content_elements }, issues }
}
