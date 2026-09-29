import { findSlideTitleElements } from '../slides/slide-title-detect.js'
import { resolveRepeatItemCount } from '../components/repeat-layout-analysis.js'

const BOUNDS_TOLERANCE = 0.008
const HIT_SLOP = 0.008
const FULL_BLEED_MIN = 0.92
const MIN_OBSTACLE_AREA = 0.002
const DEFAULT_MARGIN = 0.04
const TITLE_GAP = 0.02
const TITLE_BOX_GAP = 0.03
const TITLE_BAND_MAX = 0.28
const BOTTOM_TITLE_MID = 0.55
const COPY_GAP = 0.012
const MAX_COPIES = 12
const WIDE_SLOT_MIN = 0.45
const CONTRAST_RATIO_MIN = 2
const CONTRAST_FILL_MIN_AREA = 0.12
const CONTRAST_FILL_MIN_ALPHA = 0.85
const ASSET_BOARD_MIN_VISUALS = 12
const ASSET_BOARD_SMALL_AREA = 0.025
const ASSET_BOARD_MEDIAN_AREA = 0.012

const REGISTRY_GROUPS = new Set(['repeats', 'singletons', 'tables', 'charts', 'diagrams'])

const INK_CHAR_RATIO = 0.52
const INK_LINE_RATIO = 1.15

const donorTitleCache = new WeakMap()
const cache = new WeakMap()
const registryEntryCache = new WeakMap()
const assetTemplateStatsCache = new WeakMap()

function median(values) {
  const sorted = values.filter((value) => Number.isFinite(value)).sort((left, right) => left - right)
  if (!sorted.length) return null
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

function finiteBox(box) {
  if (!box) return null
  const x = Number(box.x)
  const y = Number(box.y)
  const width = Number(box.width)
  const height = Number(box.height)
  if (![x, y, width, height].every(Number.isFinite)) return null
  if (width <= 0 || height <= 0) return null
  return { x, y, width, height }
}

function boxArea(box) {
  return Math.max(0, box.width) * Math.max(0, box.height)
}

function visualBox(item) {
  if (!['image', 'shape', 'line', 'fill'].includes(item?.kind)) return null
  const box = finiteBox(item.geometry_norm)
  if (!box || coversSlide(box)) return null
  if (item.kind === 'fill' && boxArea(box) >= 0.2) return null
  return box
}

function isAssetBoardSource(source) {
  const visuals = [
    ...(source?.render?.layers || []),
    ...(source?.content_elements || []),
  ]
    .map(visualBox)
    .filter(Boolean)
  if (visuals.length < ASSET_BOARD_MIN_VISUALS) return false

  const contentTextCount = (source?.content_elements || [])
    .filter((element) => element?.kind === 'text' && String(element.text || '').trim())
    .length
  const textSlots = (source?.editable_slots || []).filter((slot) => (
    slot.role === 'title'
    || slot.role === 'body'
    || ['title', 'ctrTitle', 'body', 'obj', 'content'].includes(slot.placeholder_type)
  ))
  if (textSlots.length > 1) return false
  if (contentTextCount > 4 && visuals.length < 40) return false

  const areas = visuals.map(boxArea).sort((left, right) => left - right)
  const smallCount = areas.filter((area) => area > 0 && area <= ASSET_BOARD_SMALL_AREA).length
  const medianArea = areas[Math.floor(areas.length / 2)] || 0
  return smallCount >= ASSET_BOARD_MIN_VISUALS && medianArea <= ASSET_BOARD_MEDIAN_AREA
}

export function isAssetBoardTemplate(template) {
  return isAssetBoardSource(template)
}

export function assetTemplateStats(report) {
  if (!report) return new Map()
  if (assetTemplateStatsCache.has(report)) return assetTemplateStatsCache.get(report)
  const stats = new Map()
  const add = (templateId, key) => {
    if (!templateId) return
    const item = stats.get(templateId) || {
      templateId,
      assetSlideCount: 0,
      assetTemplate: false,
    }
    item[key] = key === 'assetSlideCount' ? item[key] + 1 : true
    stats.set(templateId, item)
  }
  for (const template of report.slide_templates?.templates || []) {
    if (isAssetBoardTemplate(template)) {
      add(template.template_id, 'assetTemplate')
      if (template.layout_source && template.layout_source !== template.template_id) add(template.layout_source, 'assetTemplate')
    }
  }
  for (const slide of report.slides?.slides || []) {
    if (!isAssetBoardSource(slide)) continue
    add(slide.template_id, 'assetSlideCount')
    if (slide.layout_source && slide.layout_source !== slide.template_id) add(slide.layout_source, 'assetSlideCount')
  }
  assetTemplateStatsCache.set(report, stats)
  return stats
}

export function templateAssetBoardPenalty(report, templateId, penalty = 300) {
  if (!report || !templateId) return 0
  const template = (report.slide_templates?.templates || []).find((item) => (
    item.template_id === templateId || item.layout_source === templateId
  ))
  const stats = assetTemplateStats(report).get(templateId)
  const assetSlides = stats?.assetSlideCount || 0
  const assetTemplate = stats?.assetTemplate || isAssetBoardTemplate(template)
  return (assetTemplate ? penalty : 0) + assetSlides * Math.round(penalty / 2)
}

function intersects(left, right) {
  const width = Math.min(left.x + left.width, right.x + right.width) - Math.max(left.x, right.x)
  const height = Math.min(left.y + left.height, right.y + right.height) - Math.max(left.y, right.y)
  return width > HIT_SLOP && height > HIT_SLOP
}

function isFullBleed(box) {
  return box.width >= FULL_BLEED_MIN && box.height >= FULL_BLEED_MIN
}

function templateHasFullBleedBackground(template) {
  return (template?.render?.layers || []).some((layer) => {
    if (layer.kind !== 'image') return false
    const box = finiteBox(layer.geometry_norm)
    return Boolean(box && isFullBleed(box))
  })
}

function parseRgb(color) {
  const value = String(color || '').trim()
  const hex = value.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i)
  if (hex) {
    const raw = hex[1].length === 3
      ? hex[1].split('').map((char) => char + char).join('')
      : hex[1]
    const number = parseInt(raw, 16)
    return { r: (number >> 16) & 255, g: (number >> 8) & 255, b: number & 255 }
  }
  const rgb = value.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i)
  if (!rgb) return null
  return { r: Number(rgb[1]), g: Number(rgb[2]), b: Number(rgb[3]) }
}

function channelLuminance(channel) {
  const value = channel / 255
  return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
}

function relativeLuminance(color) {
  const rgb = parseRgb(color)
  if (!rgb) return null
  return 0.2126 * channelLuminance(rgb.r)
    + 0.7152 * channelLuminance(rgb.g)
    + 0.0722 * channelLuminance(rgb.b)
}

export function contrastRatio(left, right) {
  const leftLuminance = relativeLuminance(left)
  const rightLuminance = relativeLuminance(right)
  if (leftLuminance == null || rightLuminance == null) return 1
  const lighter = Math.max(leftLuminance, rightLuminance)
  const darker = Math.min(leftLuminance, rightLuminance)
  return (lighter + 0.05) / (darker + 0.05)
}

function fillPaint(layer) {
  const fill = layer?.fill
  if (!fill || fill.kind === 'none') return null
  const alpha = Number(fill.alpha ?? 1)
  if (Number.isFinite(alpha) && alpha < CONTRAST_FILL_MIN_ALPHA) return null
  if (fill.color) return fill.color
  const stops = Array.isArray(fill.stops) ? fill.stops : []
  return stops.find((stop) => stop?.color)?.color || null
}

function boxContains(outer, inner) {
  return outer.x <= inner.x + BOUNDS_TOLERANCE
    && outer.y <= inner.y + BOUNDS_TOLERANCE
    && outer.x + outer.width >= inner.x + inner.width - BOUNDS_TOLERANCE
    && outer.y + outer.height >= inner.y + inner.height - BOUNDS_TOLERANCE
}

function coversSlide(box) {
  return box.x <= BOUNDS_TOLERANCE
    && box.y <= BOUNDS_TOLERANCE
    && box.x + box.width >= 1 - BOUNDS_TOLERANCE
    && box.y + box.height >= 1 - BOUNDS_TOLERANCE
}

function laterHidesContrast(later, target) {
  return coversSlide(later.box) || boxContains(later.box, target.box)
}

const DARK_SURFACE_LUMINANCE = 0.4

function visibleSurfaceFills(source) {
  const paints = (source?.render?.layers || [])
    .filter((layer) => layer.kind === 'fill')
    .map((layer) => ({
      z: Number(layer.z_index) || 0,
      box: finiteBox(layer.geometry_norm),
      color: fillPaint(layer),
    }))
    .filter((layer) => layer.box && layer.color)
    .sort((left, right) => left.z - right.z || 0)

  return paints.filter((layer, index) => {
    if (boxArea(layer.box) < CONTRAST_FILL_MIN_AREA) return false
    return !paints.slice(index + 1).some((later) => laterHidesContrast(later, layer))
  })
}

// Colour of the surface a slide's content sits on (topmost visible fill or
// the background colour).
export function surfaceFillColor(source) {
  const visible = visibleSurfaceFills(source)
  return visible.length
    ? visible[visible.length - 1].color
    : (source?.render?.background_color || source?.colors?.background || null)
}

export function darkSurfaceFillColor(source) {
  const visible = visibleSurfaceFills(source)
  const top = visible.length
    ? visible[visible.length - 1].color
    : (source?.render?.background_color || source?.colors?.background || null)
  if (!top || relativeLuminance(top) == null || relativeLuminance(top) >= DARK_SURFACE_LUMINANCE) return null
  return top
}

function templateHasContrastingFill(template) {
  const background = template?.render?.background_color || template?.colors?.background || '#FFFFFF'
  const paints = (template?.render?.layers || [])
    .filter((layer) => layer.kind === 'fill')
    .map((layer) => ({
      z: Number(layer.z_index) || 0,
      box: finiteBox(layer.geometry_norm),
      color: fillPaint(layer),
    }))
    .filter((layer) => layer.box && layer.color)
    .sort((left, right) => left.z - right.z || 0)

  return paints.some((layer, index) => {
    if (boxArea(layer.box) < CONTRAST_FILL_MIN_AREA) return false
    if (contrastRatio(layer.color, background) < CONTRAST_RATIO_MIN) return false
    const hidden = paints.slice(index + 1).some((later) => laterHidesContrast(later, layer))
    return !hidden
  })
}

function narrativeShellFailReason(report, template, foundOn) {
  const templates = report?.slide_templates?.templates || []
  if (templates.length <= 1) return null
  if (foundOn?.has(template?.template_id)) return null
  const roles = template?.detected_roles || []
  if (roles.includes('quote')) return 'quote_template'
  if (roles.includes('snippet')) return 'snippet_template'
  return null
}

function sourceTemplateIds(component) {
  const ids = new Set((component?.templates || []).filter(Boolean))
  for (const instance of component?.instances || []) {
    if (instance?.template_id) ids.add(instance.template_id)
  }
  return ids
}

function isGraphicHomePlacement(component, template, unit, report) {
  if (!['tables', 'charts', 'diagrams'].includes(component?.group)) return false
  if (!unit || !template?.template_id) return false
  const hasNativeInstance = (component.instances || []).some((instance) => (
    instance.template_id === template.template_id && instanceNorm(instance, slideSize(report))
  ))
  const previewSlideNumber = component.raw?.baseline_preview?.slide_number
  const previewSlide = (report?.slides?.slides || []).find((slide) => (
    slide.slide_number === previewSlideNumber
  ))
  const hasBaselinePreview = component.isBaseline
    && previewSlide?.template_id === template.template_id
  if (!hasNativeInstance && !hasBaselinePreview) return false
  const box = finiteBox(unit)
  return Boolean(box
    && box.x >= -BOUNDS_TOLERANCE
    && box.y >= -BOUNDS_TOLERANCE
    && box.x + box.width <= 1 + BOUNDS_TOLERANCE
    && box.y + box.height <= 1 + BOUNDS_TOLERANCE)
}

function slideSize(report) {
  return report?.typography?.visibility?.slide_size_pt
    || report?.spatial?.slide_size_pt
    || { width: 960, height: 540 }
}

function normFromPt(pt, size) {
  if (!pt?.width_pt || !pt?.height_pt || !size?.width || !size?.height) return null
  return finiteBox({
    x: (pt.x_pt || 0) / size.width,
    y: (pt.y_pt || 0) / size.height,
    width: pt.width_pt / size.width,
    height: pt.height_pt / size.height,
  })
}

function instanceNorm(instance, size) {
  return finiteBox(instance?.container_norm)
    || finiteBox(instance?.geometry_norm)
    || normFromPt(instance?.container || instance?.geometry_pt, size)
}

function componentNorm(component, size) {
  return finiteBox(component?.raw?.baseline_preview?.geometry_norm)
    || finiteBox(component?.container_norm)
    || normFromPt(component?.container, size)
}

export function isRegistryComponent(component) {
  return REGISTRY_GROUPS.has(component?.group)
}

function repeatAxis(instance) {
  const split = instance?.repeat?.split_mode
  const grid = instance?.repeat?.grid
  if (grid && split !== 'horizontal_series' && split !== 'row_card') return 'grid'
  if (split === 'row_card' || instance?.layout === 'column') return 'column'
  return 'row'
}

function unitFromRepeatInstance(instance, size) {
  const box = instanceNorm(instance, size)
  if (!box) return null
  const count = Math.max(1, resolveRepeatItemCount(instance?.repeat))
  const axis = repeatAxis(instance)
  const origin = { x: box.x, y: box.y }
  if (axis === 'grid') {
    const cols = Math.max(1, Number(instance.repeat?.grid?.cols) || Number(instance.repeat?.layout_cols) || 1)
    const rows = Math.max(1, Number(instance.repeat?.grid?.rows) || Number(instance.repeat?.layout_rows) || Math.ceil(count / cols))
    return {
      ...origin,
      width: box.width / cols,
      height: box.height / rows,
      axis,
      cols,
      sampleCount: count,
    }
  }
  if (axis === 'column' && count > 1) {
    return { ...origin, width: box.width, height: box.height / count, axis, cols: 1, sampleCount: count }
  }
  if (axis === 'row' && count > 1) {
    return { ...origin, width: box.width / count, height: box.height, axis, cols: count, sampleCount: count }
  }
  return { ...origin, width: box.width, height: box.height, axis, cols: 1, sampleCount: count }
}

export function measureComponentUnit(component, report) {
  const size = slideSize(report)
  if (!isRegistryComponent(component)) return null

  if (component.group === 'repeats') {
    const measured = (component.instances || [])
      .map((instance) => unitFromRepeatInstance(instance, size))
      .filter(Boolean)
    if (!measured.length) {
      const fallback = componentNorm(component, size)
      if (!fallback) return null
      return {
        x: fallback.x,
        y: fallback.y,
        width: fallback.width,
        height: fallback.height,
        axis: 'row',
        cols: 1,
        repeatable: true,
      }
    }
    const best = [...measured].sort((left, right) => right.sampleCount - left.sampleCount)[0]
    const sameAxis = measured.filter((item) => item.axis === best.axis)
    return {
      x: best.x,
      y: best.y,
      width: median(sameAxis.map((item) => item.width)),
      height: median(sameAxis.map((item) => item.height)),
      axis: best.axis,
      cols: best.cols,
      repeatable: true,
    }
  }

  const box = (component.instances || []).map((instance) => instanceNorm(instance, size)).find(Boolean)
    || componentNorm(component, size)
  if (!box) return null
  return {
    x: box.x,
    y: box.y,
    width: box.width,
    height: box.height,
    axis: 'pack',
    cols: 1,
    repeatable: false,
    ...(component.group === 'charts' ? { flexible: 'chart', chartType: component.chartType || component.chart_type || null } : {}),
  }
}

function marginValue(margins, key) {
  const value = Number(margins?.[key])
  return Number.isFinite(value) ? value : DEFAULT_MARGIN
}

function slotBox(slot) {
  return finiteBox(slot?.geometry_norm) || null
}

export function measureTextInkBox(frame, text, typography = {}, slideSize = { width: 960, height: 540 }) {
  const box = finiteBox(frame)
  const value = String(text || '')
  if (!box || !value.trim()) return box
  const fontSize = Number(typography?.size_pt)
  const sizePt = Number.isFinite(fontSize) && fontSize > 0 ? fontSize : 28
  const ratio = Number(typography?.line_height_ratio ?? typography?.lineHeightRatio)
  const lineRatio = Number.isFinite(ratio) && ratio > 0 ? ratio : INK_LINE_RATIO
  const lineHeightPt = sizePt * lineRatio
  const slideWidth = slideSize?.width || 960
  const slideHeight = slideSize?.height || 540
  const widthPt = Math.max(1, box.width * slideWidth)
  const charWidth = sizePt * INK_CHAR_RATIO
  let lineCount = 0
  let maxLinePt = 0
  for (const rawLine of value.split('\n')) {
    const line = rawLine.trim()
    if (!line) continue
    const rawWidth = line.length * charWidth
    lineCount += Math.max(1, Math.ceil(rawWidth / widthPt))
    maxLinePt = Math.max(maxLinePt, Math.min(rawWidth, widthPt))
  }
  if (!lineCount) return box

  const inkWidth = Math.min(box.width, maxLinePt / slideWidth)
  const inkHeight = (lineCount * lineHeightPt) / slideHeight
  const alignment = String(typography?.alignment || 'l').toLowerCase()
  let x = box.x
  if (alignment === 'ctr' || alignment === 'center' || alignment === 'c') {
    x = box.x + (box.width - inkWidth) / 2
  } else if (alignment === 'r' || alignment === 'right') {
    x = box.x + box.width - inkWidth
  }
  const anchor = String(typography?.vertical_anchor || typography?.anchor || 't').toLowerCase()
  let y = box.y
  if (inkHeight <= box.height && (anchor === 'b' || anchor === 'bottom')) {
    y = box.y + box.height - inkHeight
  } else if (inkHeight <= box.height && (anchor === 'ctr' || anchor === 'middle')) {
    y = box.y + (box.height - inkHeight) / 2
  }
  return { x, y, width: inkWidth, height: inkHeight }
}

function intervalGap(start, end, otherStart, otherEnd) {
  if (end < otherStart) return otherStart - end
  if (otherEnd < start) return start - otherEnd
  return 0
}

function titleClearanceBox(slot, ink) {
  const text = finiteBox(ink)
  const frame = finiteBox(slot)
  if (!text) return frame
  if (!frame) return text
  const band = frame.height <= TITLE_BAND_MAX
  if (!band) return text
  const x = Math.min(frame.x, text.x)
  const y = Math.min(frame.y, text.y)
  const right = Math.max(frame.x + frame.width, text.x + text.width)
  const bottom = Math.max(frame.y + frame.height, text.y + text.height)
  return { x, y, width: right - x, height: bottom - y }
}

function containsBox(box, frame) {
  return box.x >= frame.x - BOUNDS_TOLERANCE
    && box.y >= frame.y - BOUNDS_TOLERANCE
    && box.x + box.width <= frame.x + frame.width + BOUNDS_TOLERANCE
    && box.y + box.height <= frame.y + frame.height + BOUNDS_TOLERANCE
}

export function shiftComponentClearOfTitle(componentBox, title = {}, frame = null, gap = TITLE_BOX_GAP) {
  const component = finiteBox(componentBox)
  const bounds = finiteBox(frame) || { x: 0, y: 0, width: 1, height: 1 }
  if (!component) return { box: null, side: null, shifted: false, fits: false }
  const clearance = titleClearanceBox(finiteBox(title.slot), finiteBox(title.ink))
  if (!clearance) {
    return { box: component, side: null, shifted: false, fits: containsBox(component, bounds) }
  }

  const gapX = intervalGap(
    component.x,
    component.x + component.width,
    clearance.x,
    clearance.x + clearance.width,
  )
  const gapY = intervalGap(
    component.y,
    component.y + component.height,
    clearance.y,
    clearance.y + clearance.height,
  )
  if (gapX >= gap - 0.0001 && gapY >= gap - 0.0001) {
    return { box: component, side: null, shifted: false, fits: containsBox(component, bounds) }
  }

  const anchor = finiteBox(title.slot) || finiteBox(title.ink) || clearance
  const atBottom = anchor.y + anchor.height / 2 >= BOTTOM_TITLE_MID
  const side = atBottom ? 'bottom' : 'top'
  const free = atBottom
    ? {
      x: bounds.x,
      y: bounds.y,
      width: bounds.width,
      height: (clearance.y - gap) - bounds.y,
    }
    : {
      x: bounds.x,
      y: clearance.y + clearance.height + gap,
      width: bounds.width,
      height: (bounds.y + bounds.height) - (clearance.y + clearance.height + gap),
    }

  if (!(free.width > 0) || !(free.height > 0)
    || component.width > free.width + BOUNDS_TOLERANCE
    || component.height > free.height + BOUNDS_TOLERANCE) {
    return { box: component, side, shifted: false, fits: false }
  }

  let x = component.x
  let y = component.y
  if (x < free.x) x = free.x
  if (x + component.width > free.x + free.width) x = free.x + free.width - component.width
  if (y < free.y) y = free.y
  if (y + component.height > free.y + free.height) y = free.y + free.height - component.height
  const next = { x, y, width: component.width, height: component.height }
  const shifted = Math.abs(x - component.x) > 0.001 || Math.abs(y - component.y) > 0.001
  return { box: next, side, shifted, fits: containsBox(next, free) }
}

function donorTitle(template, report) {
  if (!template || !report) return null
  const cached = donorTitleCache.get(template)
  if (cached) return cached
  const slideNumber = template.preview_slide || template.slide_numbers?.[0]
  const slide = (report?.slides?.slides || []).find((item) => item.slide_number === slideNumber)
  const primary = slide ? findSlideTitleElements(slide, report).primary : null
  const sample = primary?.text
    ? { text: String(primary.text), typography: primary.typography || null }
    : null
  donorTitleCache.set(template, sample)
  return sample
}

function titleSlotBox(slot, template, report, titleText) {
  const frame = slotBox(slot)
  if (!frame) return null
  if (slot.role !== 'title' && slot.role !== 'subtitle') return frame
  const donor = slot.role === 'title' ? donorTitle(template, report) : null
  const text = slot.role === 'title' && String(titleText || '').trim()
    ? String(titleText)
    : donor?.text
  if (!text) return frame
  const typography = {
    ...(donor?.typography || {}),
    ...(slot.typography || {}),
  }
  return measureTextInkBox(frame, text, typography, slideSize(report)) || frame
}

export function templateContentFrame(template, report, { titleText = '' } = {}) {
  const margins = report?.layout?.content_margins || {}
  const left = marginValue(margins, 'left_norm')
  const rightInset = marginValue(margins, 'right_norm')
  const bottomInset = marginValue(margins, 'bottom_norm')
  let top = marginValue(margins, 'top_norm')

  for (const slot of template?.editable_slots || []) {
    if (slot.role !== 'title' && slot.role !== 'subtitle') continue
    const box = titleSlotBox(slot, template, report, titleText)
    if (!box || box.width < WIDE_SLOT_MIN) continue
    top = Math.max(top, box.y + box.height + TITLE_GAP)
  }

  const bottom = 1 - bottomInset
  return {
    x: left,
    y: top,
    width: Math.max(0, 1 - rightInset - left),
    height: Math.max(0, bottom - top),
  }
}

function templateTitleBand(template, report, titleText = '') {
  let slot = null
  let ink = null
  for (const item of template?.editable_slots || []) {
    if (item.role !== 'title' && item.role !== 'subtitle') continue
    const frame = slotBox(item)
    if (!frame || frame.width < WIDE_SLOT_MIN) continue
    const measured = titleSlotBox(item, template, report, titleText)
    slot = frame
    const same = measured && Math.abs(measured.x - frame.x) < 0.001
      && Math.abs(measured.y - frame.y) < 0.001
      && Math.abs(measured.width - frame.width) < 0.001
      && Math.abs(measured.height - frame.height) < 0.001
    ink = measured && !same ? measured : null
    if (item.role === 'title') break
  }
  return { slot, ink }
}

export function templateObstacles(template, report = null, { titleText = '' } = {}) {
  const obstacles = []
  for (const layer of template?.render?.layers || []) {
    if (layer.kind !== 'image') continue
    const box = finiteBox(layer.geometry_norm)
    if (!box || isFullBleed(box) || boxArea(box) < MIN_OBSTACLE_AREA) continue
    obstacles.push({ ...box, source: 'image', id: layer.layer_id || layer.asset || 'image' })
  }
  for (const slot of template?.editable_slots || []) {
    if (slot.role !== 'title' && slot.role !== 'subtitle') continue
    const box = titleSlotBox(slot, template, report, titleText)
    if (!box) continue
    obstacles.push({ ...box, source: 'slot', id: slot.shape_id || slot.role })
  }
  return obstacles
}

export function contentMarginFrame(report) {
  const margins = report?.layout?.content_margins || {}
  const left = marginValue(margins, 'left_norm')
  const rightInset = marginValue(margins, 'right_norm')
  const top = marginValue(margins, 'top_norm')
  const bottomInset = marginValue(margins, 'bottom_norm')
  return {
    x: left,
    y: top,
    width: Math.max(0, 1 - rightInset - left),
    height: Math.max(0, 1 - bottomInset - top),
  }
}

function classifyBox(box, frame, obstacles) {
  const outsideFrame = box.x < frame.x - BOUNDS_TOLERANCE
    || box.y < frame.y - BOUNDS_TOLERANCE
    || box.x + box.width > frame.x + frame.width + BOUNDS_TOLERANCE
    || box.y + box.height > frame.y + frame.height + BOUNDS_TOLERANCE
  const outsideSlide = box.x < -BOUNDS_TOLERANCE
    || box.y < -BOUNDS_TOLERANCE
    || box.x + box.width > 1 + BOUNDS_TOLERANCE
    || box.y + box.height > 1 + BOUNDS_TOLERANCE
  if (outsideFrame || outsideSlide) return 'out_of_bounds'
  if (obstacles.some((obstacle) => intersects(box, obstacle))) return 'obstacle'
  return null
}

function layoutBoxes(anchor, count, unit, frame) {
  const boxes = []
  const pitchX = unit.width + COPY_GAP
  const pitchY = unit.height + COPY_GAP
  if (unit.axis === 'column') {
    for (let index = 0; index < count; index += 1) {
      boxes.push({
        x: anchor.x,
        y: anchor.y + index * pitchY,
        width: unit.width,
        height: unit.height,
      })
    }
    return boxes
  }
  if (unit.axis === 'grid') {
    const cols = Math.max(1, Number(unit.cols) || 1)
    for (let index = 0; index < count; index += 1) {
      boxes.push({
        x: anchor.x + (index % cols) * pitchX,
        y: anchor.y + Math.floor(index / cols) * pitchY,
        width: unit.width,
        height: unit.height,
      })
    }
    return boxes
  }
  if (unit.axis === 'pack') {
    const right = frame.x + frame.width
    let x = anchor.x
    let y = anchor.y
    for (let index = 0; index < count; index += 1) {
      if (index > 0 && x + unit.width > right + BOUNDS_TOLERANCE) {
        x = anchor.x
        y += pitchY
      }
      boxes.push({ x, y, width: unit.width, height: unit.height })
      x += pitchX
    }
    return boxes
  }
  for (let index = 0; index < count; index += 1) {
    boxes.push({
      x: anchor.x + index * pitchX,
      y: anchor.y,
      width: unit.width,
      height: unit.height,
    })
  }
  return boxes
}

function countAtAnchor(anchor, unit, frame, obstacles) {
  const origin = { ...anchor, width: unit.width, height: unit.height }
  if (classifyBox(origin, frame, obstacles)) return null
  if (unit.repeatable === false) {
    return { maxCount: 1, failReason: null, failAtCount: null }
  }

  let maxCount = 1
  let failReason = null
  let failAtCount = null
  for (let count = 2; count <= MAX_COPIES; count += 1) {
    const failed = layoutBoxes(anchor, count, unit, frame)
      .map((box) => classifyBox(box, frame, obstacles))
      .find(Boolean)
    if (failed) {
      failReason = failed
      failAtCount = count
      break
    }
    maxCount = count
  }
  return { maxCount, failReason, failAtCount }
}

// Charts are drawn into whatever box they get, so a chart is not a rigid
// unit: it takes the largest free region of the template (content margins,
// below/above the title, clear of pictures and title/subtitle slots) that is
// still big enough to read. Circular charts need a square plot plus a legend.
export const CIRCULAR_CHART_TYPES = new Set(['pie', 'doughnut', 'donut'])
const CHART_OBSTACLE_GAP = 0.012
const CHART_MIN_WIDTH_PT = 320
const CHART_MIN_SLIDE_WIDTH_RATIO = 0.6
const CHART_MIN_HEIGHT_PT = 180
// Wide bar/line/area charts stay readable up to ~3.2:1; a lower cap left free
// width unused beside a chart squeezed under a mid-slide title.
const CHART_MAX_ASPECT = 3.2
const CIRCULAR_MIN_SIDE_PT = 140
const CIRCULAR_PLOT_SHARE = 0.84
const CIRCULAR_LEGEND_WIDTH = 1.35

function freeRectangles(bounds, obstacles) {
  const bottom = bounds.y + bounds.height
  const right = bounds.x + bounds.width
  const ys = [...new Set([bounds.y, bottom, ...obstacles.flatMap((item) => [item.y, item.y + item.height])])]
    .filter((y) => y >= bounds.y - 1e-9 && y <= bottom + 1e-9)
    .sort((a, b) => a - b)
  const rects = []
  for (let i = 0; i < ys.length; i += 1) {
    for (let j = i + 1; j < ys.length; j += 1) {
      const top = ys[i]
      const low = ys[j]
      const blocked = obstacles
        .filter((item) => item.y < low - 1e-9 && item.y + item.height > top + 1e-9)
        .map((item) => [Math.max(bounds.x, item.x), Math.min(right, item.x + item.width)])
        .filter(([a, b]) => b > a)
        .sort((a, b) => a[0] - b[0])
      let cursor = bounds.x
      for (const [a, b] of [...blocked, [right, right]]) {
        if (a > cursor + 1e-9) rects.push({ x: cursor, y: top, width: a - cursor, height: low - top })
        cursor = Math.max(cursor, b)
      }
    }
  }
  return rects
}

function chartBoxInRect(rect, circular, size) {
  const wPt = rect.width * size.width
  const hPt = rect.height * size.height
  if (circular) {
    const side = Math.min(wPt, hPt * CIRCULAR_PLOT_SHARE)
    if (side < CIRCULAR_MIN_SIDE_PT) return null
    const heightPt = side / CIRCULAR_PLOT_SHARE
    const widthPt = Math.min(wPt, side * CIRCULAR_LEGEND_WIDTH)
    const width = widthPt / size.width
    return {
      box: { x: rect.x + (rect.width - width) / 2, y: rect.y, width, height: heightPt / size.height },
      score: side,
    }
  }
  const minWidthPt = Math.max(CHART_MIN_WIDTH_PT, size.width * CHART_MIN_SLIDE_WIDTH_RATIO)
  if (wPt < minWidthPt || hPt < CHART_MIN_HEIGHT_PT) return null
  const heightPt = Math.min(hPt, wPt * 0.8)
  const widthPt = Math.min(wPt, heightPt * CHART_MAX_ASPECT)
  return {
    box: { x: rect.x, y: rect.y, width: widthPt / size.width, height: heightPt / size.height },
    score: widthPt * heightPt,
  }
}

export function probeChartOnTemplate(unit, template, report, { titleText = '' } = {}) {
  const size = slideSize(report)
  const frame = contentMarginFrame(report)
  const circular = CIRCULAR_CHART_TYPES.has(String(unit?.chartType || '').toLowerCase())
  let top = frame.y
  let bottom = frame.y + frame.height
  // The whole title slot is kept clear (its text may be anchored anywhere in
  // it); a chart can shrink, a title cannot move out of its slot.
  const band = templateTitleBand(template, report, titleText)
  const slotFrame = finiteBox(band.slot)
  const inkFrame = finiteBox(band.ink)
  const clearance = slotFrame && inkFrame
    ? {
      x: Math.min(slotFrame.x, inkFrame.x),
      y: Math.min(slotFrame.y, inkFrame.y),
      width: Math.max(slotFrame.x + slotFrame.width, inkFrame.x + inkFrame.width) - Math.min(slotFrame.x, inkFrame.x),
      height: Math.max(slotFrame.y + slotFrame.height, inkFrame.y + inkFrame.height) - Math.min(slotFrame.y, inkFrame.y),
    }
    : slotFrame || inkFrame
  if (clearance) {
    const anchor = finiteBox(band.slot) || clearance
    if (anchor.y + anchor.height / 2 >= BOTTOM_TITLE_MID) bottom = Math.min(bottom, clearance.y - TITLE_BOX_GAP)
    else top = Math.max(top, clearance.y + clearance.height + TITLE_BOX_GAP)
  }
  const bounds = { x: frame.x, y: top, width: frame.width, height: bottom - top }
  const rejected = (reason) => ({ status: 'rejected', max_count: 0, fail_reason: reason, fail_at_count: 1, capped: false, anchor: null })
  if (!(bounds.width > 0) || !(bounds.height > 0)) return rejected('title_clearance')
  const obstacles = templateObstacles(template, report, { titleText }).map((item) => ({
    x: item.x - CHART_OBSTACLE_GAP,
    y: item.y - CHART_OBSTACLE_GAP,
    width: item.width + CHART_OBSTACLE_GAP * 2,
    height: item.height + CHART_OBSTACLE_GAP * 2,
  }))
  let best = null
  for (const rect of freeRectangles(bounds, obstacles)) {
    const placed = chartBoxInRect(rect, circular, size)
    if (placed && (!best || placed.score > best.score + 1e-6)) best = placed
  }
  if (!best) return rejected(obstacles.length ? 'obstacle' : 'out_of_bounds')
  return {
    status: 'fit',
    max_count: 1,
    fail_reason: null,
    fail_at_count: null,
    capped: false,
    anchor: { x: best.box.x, y: best.box.y },
    box: best.box,
    fit_width: best.box.width,
    fit_area: best.box.width * best.box.height,
    flexible: true,
  }
}

// After the title/description are placed (a synthetic title may land where
// the template had no slot), a chart that overlaps text or a picture is
// refitted into the largest free region left inside the content margins.
export function refitChartsClearOfText(report, slide) {
  const elements = slide?.content_elements || []
  const charts = elements.filter((element) => element.kind === 'chart' && (element.placement_content || element.component_data || element.baseline_preview))
  if (!charts.length) return slide
  const size = slide.render?.slide_size_pt || slideSize(report)
  const frame = contentMarginFrame(report)
  const inflate = (box) => ({
    x: box.x - CHART_OBSTACLE_GAP,
    y: box.y - CHART_OBSTACLE_GAP,
    width: box.width + CHART_OBSTACLE_GAP * 2,
    height: box.height + CHART_OBSTACLE_GAP * 2,
  })
  const layerObstacles = (slide.render?.layers || [])
    .filter((layer) => layer.kind === 'image')
    .map((layer) => finiteBox(layer.geometry_norm))
    .filter((box) => box && !isFullBleed(box) && boxArea(box) >= MIN_OBSTACLE_AREA)
  let changed = false
  const next = elements.map((element) => {
    if (!charts.includes(element)) return element
    const box = finiteBox(element.geometry_norm)
    if (!box) return element
    const obstacles = [
      ...elements
        .filter((other) => other !== element && (
          (other.kind === 'text' && String(other.text || '').trim())
          || ['image', 'chart', 'table', 'diagram'].includes(other.kind)
        ))
        .map((other) => finiteBox(other.geometry_norm))
        .filter((other) => other && !isFullBleed(other)),
      ...layerObstacles,
    ].map(inflate)
    if (!obstacles.some((obstacle) => intersects(box, obstacle))) return element
    const circular = CIRCULAR_CHART_TYPES.has(String(element.chart_type || element.chart?.type || '').toLowerCase())
    let best = null
    for (const rect of freeRectangles(frame, obstacles)) {
      const placed = chartBoxInRect(rect, circular, size)
      if (placed && (!best || placed.score > best.score + 1e-6)) best = placed
    }
    if (!best) return element
    changed = true
    const target = best.box
    return {
      ...element,
      geometry_norm: { ...element.geometry_norm, ...target },
      geometry_pt: {
        ...(element.geometry_pt || {}),
        x_pt: target.x * size.width,
        y_pt: target.y * size.height,
        width_pt: target.width * size.width,
        height_pt: target.height * size.height,
      },
      chart_refit: true,
    }
  })
  return changed ? { ...slide, content_elements: next } : slide
}

// A layout whose only title placeholder is caption-sized (e.g. a 10pt label
// under a picture) cannot show the slide title legibly; content is not
// placed on it (the variant would be rejected as title_too_small anyway).
const MIN_TEMPLATE_TITLE_PT = 14

export function templateHasCaptionTitle(template) {
  const titles = (template?.editable_slots || []).filter((slot) => slot.role === 'title' || ['title', 'ctrTitle'].includes(slot.placeholder_type))
  if (!titles.length) return false
  return titles.every((slot) => Number(slot.typography?.size_pt) > 0 && Number(slot.typography.size_pt) < MIN_TEMPLATE_TITLE_PT)
}

export function probeComponentOnTemplate(unit, template, report, { titleText = '' } = {}) {
  if (templateHasCaptionTitle(template)) {
    return { status: 'rejected', max_count: 0, fail_reason: 'caption_title', fail_at_count: 1, capped: false, anchor: null }
  }
  if (unit?.flexible === 'chart') return probeChartOnTemplate(unit, template, report, { titleText })
  const frame = contentMarginFrame(report)
  const obstacles = templateObstacles(template, report, { titleText })
  if (!unit?.width || !unit?.height) {
    return {
      status: 'unknown',
      max_count: 0,
      fail_reason: 'no_unit',
      fail_at_count: null,
      capped: false,
      anchor: null,
    }
  }

  const x = Number(unit.x)
  const y = Number(unit.y)
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    return {
      status: 'rejected',
      max_count: 0,
      fail_reason: 'no_origin',
      fail_at_count: 1,
      capped: false,
      anchor: null,
    }
  }

  const anchor = { x, y }
  const origin = { ...anchor, width: unit.width, height: unit.height }
  const imageHit = obstacles.some((obstacle) => obstacle.source !== 'slot' && intersects(origin, obstacle))
  if (imageHit) {
    return {
      status: 'rejected',
      max_count: 0,
      fail_reason: 'obstacle',
      fail_at_count: 1,
      capped: false,
      anchor,
    }
  }
  if (classifyBox(origin, frame, []) === 'out_of_bounds') {
    return {
      status: 'rejected',
      max_count: 0,
      fail_reason: 'out_of_bounds',
      fail_at_count: 1,
      capped: false,
      anchor,
    }
  }

  const band = templateTitleBand(template, report, titleText)
  const shifted = shiftComponentClearOfTitle(origin, band, frame)
  if (!shifted.fits || !shifted.box) {
    return {
      status: 'rejected',
      max_count: 0,
      fail_reason: 'title_clearance',
      fail_at_count: 1,
      capped: false,
      anchor,
    }
  }

  const resolvedAnchor = { x: shifted.box.x, y: shifted.box.y }
  const placed = countAtAnchor(resolvedAnchor, unit, frame, obstacles)
  if (!placed) {
    return {
      status: 'rejected',
      max_count: 0,
      fail_reason: classifyBox(
        { ...resolvedAnchor, width: unit.width, height: unit.height },
        frame,
        obstacles,
      ) || 'title_clearance',
      fail_at_count: 1,
      capped: false,
      anchor: resolvedAnchor,
    }
  }

  return {
    status: 'fit',
    max_count: placed.maxCount,
    fail_reason: placed.failReason,
    fail_at_count: placed.failAtCount,
    capped: placed.maxCount === MAX_COPIES && !placed.failReason,
    anchor: resolvedAnchor,
  }
}

function templateById(report, templateId) {
  return (report?.slide_templates?.templates || []).find((item) => (
    item.template_id === templateId || item.layout_source === templateId
  )) || null
}

function placedContentBox(element) {
  const id = String(element?.element_id || '')
  const placed = id.includes('__repeat_')
    || Boolean(element?.placement_content)
    || Boolean(element?.component_data)
    || Boolean(element?.baseline_preview)
  if (!placed) return null
  return finiteBox(element?.geometry_norm)
}

function slideTitleText(slide) {
  const texts = (slide?.content_elements || []).filter((element) => (
    element?.kind === 'text' && String(element.text || '').trim() && !placedContentBox(element)
  ))
  const titled = texts.filter((element) => (
    String(element.text_role || element.role || element.name || '').toLowerCase().includes('title')
  ))
  const pool = titled.length ? titled : texts.filter((element) => {
    const box = finiteBox(element.geometry_norm)
    return box && box.y < 0.22 && box.width >= WIDE_SLOT_MIN
  })
  return pool
    .map((element) => String(element.text).trim())
    .sort((left, right) => right.length - left.length)[0] || ''
}

export function auditPlacedContent(report, slide, templateId) {
  const template = templateById(report, templateId)
  if (!template || !slide) return { ok: true, reason: null }
  const frame = contentMarginFrame(report)
  const obstacles = templateObstacles(template, report, { titleText: slideTitleText(slide) })
  const boxes = (slide.content_elements || []).map(placedContentBox).filter(Boolean)
  if (!boxes.length) return { ok: true, reason: null }
  for (const box of boxes) {
    const reason = classifyBox(box, frame, obstacles)
    if (reason) return { ok: false, reason }
  }
  return { ok: true, reason: null }
}

function templateLabel(template) {
  return template?.layout_name || template?.layout_file || template?.template_id || 'Шаблон'
}

export function buildComponentTemplateRegistry(report, components = []) {
  const templates = report?.slide_templates?.templates || []
  const entries = []

  for (const component of components) {
    if (!isRegistryComponent(component)) continue
    const unit = measureComponentUnit(component, report)
    const foundOn = sourceTemplateIds(component)
    const placements = templates.map((template) => {
      // A native graphic or a baseline preview already occupies this exact
      // source slide. Generic margins/decorations can reject its real bbox.
      if (!unit?.flexible && isGraphicHomePlacement(component, template, unit, report)) {
        return {
          template_id: template.template_id,
          template_label: templateLabel(template),
          status: 'fit',
          max_count: 1,
          fail_reason: null,
          fail_at_count: null,
          capped: false,
          anchor: { x: unit.x, y: unit.y },
        }
      }
      const narrativeReason = narrativeShellFailReason(report, template, foundOn)
      if (narrativeReason) {
        return {
          template_id: template.template_id,
          template_label: templateLabel(template),
          status: 'rejected',
          max_count: 0,
          fail_reason: narrativeReason,
          fail_at_count: null,
          capped: false,
          anchor: null,
        }
      }
      const probe = probeComponentOnTemplate(unit, template, report)
      const foreignShell = probe.status === 'fit' && !foundOn.has(template.template_id)
      const failReason = foreignShell && templateHasFullBleedBackground(template)
        ? 'full_bleed_background'
        : foreignShell && templateHasContrastingFill(template)
          ? 'contrasting_fill'
          : null
      if (failReason) {
        return {
          template_id: template.template_id,
          template_label: templateLabel(template),
          status: 'rejected',
          max_count: 0,
          fail_reason: failReason,
          fail_at_count: null,
          capped: false,
          anchor: probe.anchor || null,
        }
      }
      return {
        template_id: template.template_id,
        template_label: templateLabel(template),
        ...probe,
        ...(probe.box ? { fit_width: probe.box.width, fit_area: probe.box.width * probe.box.height } : {}),
      }
    }).sort((left, right) => {
      const status = Number(right.status === 'fit') - Number(left.status === 'fit')
      if (status) return status
      if (unit?.flexible === 'chart') {
        const width = (right.fit_width || right.box?.width || 0) - (left.fit_width || left.box?.width || 0)
        if (Math.abs(width) > 1e-9) return width
        const area = (right.fit_area || 0) - (left.fit_area || 0)
        if (Math.abs(area) > 1e-9) return area
      }
      return (right.max_count || 0) - (left.max_count || 0)
        || left.template_label.localeCompare(right.template_label, 'ru')
    })
    const accepted = placements.filter((item) => item.status === 'fit')
    entries.push({
      component_id: component.id,
      label: component.label,
      kind: component.kind,
      group: component.group,
      repeatable: Boolean(unit?.repeatable),
      axis: unit?.axis || null,
      cols: unit?.cols || 1,
      unit_norm: unit ? { x: unit.x, y: unit.y, width: unit.width, height: unit.height } : null,
      ...(unit?.flexible ? { flexible: unit.flexible, chart_type: unit.chartType || null } : {}),
      templates: placements,
      summary: {
        template_count: placements.length,
        accepted_count: accepted.length,
        rejected_count: placements.length - accepted.length,
        max_count: accepted.reduce((max, item) => Math.max(max, item.max_count || 0), 0),
      },
    })
  }

  return { components: entries }
}

export function getComponentTemplateRegistry(report, components = []) {
  if (!report) return { components: [] }
  const cached = cache.get(report)
  if (cached) return cached
  const built = buildComponentTemplateRegistry(report, components)
  cache.set(report, built)
  return built
}

export function lookupTemplateFit(registry, componentId) {
  if (!registry || !componentId) return null
  let index = registryEntryCache.get(registry)
  if (!index) {
    index = new Map((registry.components || []).map((item) => [item.component_id, item]))
    registryEntryCache.set(registry, index)
  }
  return index.get(componentId) || null
}

export const PLACEMENT_AXIS_LABELS = {
  row: 'в ряд',
  column: 'колонкой',
  grid: 'сеткой',
  pack: 'укладкой',
}

export function fittingTemplatesForComponent(entry, sourceTemplateIds = []) {
  const found = new Set((sourceTemplateIds || []).filter(Boolean))
  return (entry?.templates || [])
    .filter((item) => item.status === 'fit' && item.max_count > 0 && item.template_id && !found.has(item.template_id))
    .map((item) => ({
      template_id: item.template_id,
      template_label: item.template_label,
      max_count: item.max_count,
      ...(item.box ? { box: item.box, fit_width: item.fit_width || item.box.width, fit_area: item.fit_area || item.box.width * item.box.height } : {}),
      axis: entry.axis || null,
      repeatable: Boolean(entry.repeatable),
    }))
}

export function placementFitLabel(entry) {
  if (!entry || entry.status === 'unknown') return 'нет размера'
  if (entry.status === 'rejected' || !entry.max_count) return 'не встаёт'
  if (entry.capped) return `≥ ${entry.max_count}`
  return String(entry.max_count)
}

export function placementFailLabel(entry) {
  if (!entry?.fail_reason || entry.status === 'unknown') return '—'
  if (entry.status === 'fit') {
    if (entry.fail_reason === 'obstacle') return `копия ${entry.fail_at_count} пересекает картинку или заголовок`
    return `копия ${entry.fail_at_count} выходит за кадр`
  }
  if (entry.fail_reason === 'no_unit') return 'нет размера'
  if (entry.fail_reason === 'full_bleed_background') return 'сплошной фон, компонент там не найден'
  if (entry.fail_reason === 'contrasting_fill') return 'контрастная заливка, компонент там не найден'
  if (entry.fail_reason === 'quote_template') return 'шаблон цитаты'
  if (entry.fail_reason === 'snippet_template') return 'шаблон кода'
  if (entry.fail_reason === 'title_clearance') return 'компонент не умещается рядом с заголовком'
  if (entry.fail_reason === 'obstacle') return 'даже одна копия пересекает картинку или заголовок'
  return 'даже одна копия не входит в кадр'
}
