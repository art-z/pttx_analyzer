import { findSlide, listAllComponents } from './catalog.js'
import {
  layoutItemOriginsInBBox,
  measureRepeatPitch,
  resolveRepeatShape,
  unionBBoxPt,
  buildContainerRepeatPreviewSlide,
} from './container-render.js'
import { mapContextItemToFields } from './component-semantics.js'
import { collectRepeatElementIds } from './from-vgroups.js'
import { detectSlideMetricLayouts, METRIC_PATTERNS } from '../slides/metric-detect.js'
import { stackGeometryNorm } from '../slides/flex-layout.js'
import { clearTextElementContent, isolateSlideMetricPreview, patchSlideTextContent } from '../slides/text-content-patch.js'
import { adaptMetricsForLayout, formatMetricDisplay, normalizeMetricItems } from '../presentation/metric-contract.js'

function elementBBoxPt(element) {
  const geometry = element?.geometry_pt || {}
  if (!geometry.width_pt || !geometry.height_pt) return null
  return {
    x_pt: geometry.x_pt || 0,
    y_pt: geometry.y_pt || 0,
    width_pt: geometry.width_pt,
    height_pt: geometry.height_pt,
  }
}

function cloneSlide(slide) {
  return JSON.parse(JSON.stringify(slide))
}

function metricFields(metric, roles = ['heading', 'body']) {
  return mapContextItemToFields('metrics', metric, roles)
}

function elementById(slide, elementId) {
  return (slide.content_elements || []).find((element) => element.element_id === elementId) || null
}

function withMetricExportData(element, metric) {
  if (!metric) return element
  const value = String(metric.value || '')
  const unit = String(metric.unit || '')
  const renderedUnit = unit && /^[A-Za-z\u0400-\u04FF]/u.test(unit) ? ` ${unit}` : unit
  // Template runs carry the value/unit styling (e.g. 48pt value, 20pt unit).
  // A template with a single content run gets the whole display text, so the
  // unit is not dropped.
  const contentRunCount = (element.text_runs || []).filter((run) => !run?.break).length
  let contentRunIndex = 0
  return {
    ...element,
    text_runs: element.text_runs?.map((run) => {
      if (run?.break) return run
      const text = contentRunCount === 1
        ? formatMetricDisplay(metric)
        : contentRunIndex === 0 ? value : contentRunIndex === 1 ? renderedUnit : ''
      contentRunIndex += 1
      return { ...run, text }
    }),
    text_paragraphs: element.text_paragraphs?.map((paragraph, index) => ({
      ...paragraph,
      text: index === 0 ? String(element.text || '') : '',
    })),
    metric: {
      ...(element.metric || {}),
      value,
      unit,
    },
  }
}

function applyMetricPairToElements(slide, elementIds, pair, fields, metric = null) {
  if (!pair) return slide

  const patches = []
  if (pair.valueElementId && fields.heading) {
    patches.push({ id: pair.valueElementId, text: fields.heading })
  }
  if (pair.captionElementId && fields.body) {
    patches.push({ id: pair.captionElementId, text: fields.body })
  }

  // patchSlideTextContent resets text_runs; the value element gets the
  // template runs back so value and unit keep their own styling.
  const templateValueRuns = elementById(slide, pair.valueElementId)?.text_runs

  let next = slide
  for (const patch of patches) {
    next = patchSlideTextContent(next, {
      elementIds: [patch.id],
      text: patch.text,
    })
  }

  const keepIds = new Set([
    ...elementIds,
    ...patches.map((patch) => patch.id),
  ])

  return {
    ...next,
    content_elements: (next.content_elements || []).map((element) => {
      if (!elementIds.includes(element.element_id)) return element
      if (keepIds.has(element.element_id) && patches.some((patch) => patch.id === element.element_id)) {
        return element.element_id === pair.valueElementId
          ? withMetricExportData({ ...element, text_runs: templateValueRuns }, metric)
          : element
      }
      if (element.kind === 'text' || element.kind === 'badge') {
        return clearTextElementContent(element)
      }
      return element
    }),
  }
}

function bboxNormFromPt(bboxPt, slideSizePt) {
  const width = slideSizePt?.width || 960
  const height = slideSizePt?.height || 540
  return {
    x: (bboxPt.x_pt || 0) / width,
    y: (bboxPt.y_pt || 0) / height,
    width: (bboxPt.width_pt || 0) / width,
    height: (bboxPt.height_pt || 0) / height,
  }
}

function bboxPtFromNorm(bboxNorm, slideSizePt) {
  const width = slideSizePt?.width || 960
  const height = slideSizePt?.height || 540
  return {
    x_pt: (bboxNorm?.x || 0) * width,
    y_pt: (bboxNorm?.y || 0) * height,
    width_pt: (bboxNorm?.width || 0) * width,
    height_pt: (bboxNorm?.height || 0) * height,
  }
}

function translateMetricElement(element, dxPt, dyPt, slideSizePt, suffix) {
  const next = JSON.parse(JSON.stringify(element))
  next.element_id = `${element.element_id}__metric_${suffix}`

  if (next.text_group_id) {
    next.text_group_id = `${next.text_group_id}__metric_${suffix}`
  }

  if (next.geometry_pt) {
    next.geometry_pt = {
      ...next.geometry_pt,
      x_pt: (next.geometry_pt.x_pt || 0) + dxPt,
      y_pt: (next.geometry_pt.y_pt || 0) + dyPt,
    }
    next.geometry_norm = bboxNormFromPt(next.geometry_pt, slideSizePt)
  }

  if (next.text_group_geometry_pt) {
    next.text_group_geometry_pt = {
      ...next.text_group_geometry_pt,
      x_pt: (next.text_group_geometry_pt.x_pt || 0) + dxPt,
      y_pt: (next.text_group_geometry_pt.y_pt || 0) + dyPt,
    }
    next.text_group_geometry_norm = bboxNormFromPt(next.text_group_geometry_pt, slideSizePt)
  }

  return next
}

function translatedMetricPair(pair, suffix) {
  if (!pair) return null
  return {
    ...pair,
    valueElementId: pair.valueElementId ? `${pair.valueElementId}__metric_${suffix}` : null,
    captionElementId: pair.captionElementId ? `${pair.captionElementId}__metric_${suffix}` : null,
  }
}

function slotElementIds(slot) {
  const ids = new Set(slot?.element_ids || [])
  if (slot?.pair?.valueElementId) ids.add(slot.pair.valueElementId)
  if (slot?.pair?.captionElementId) ids.add(slot.pair.captionElementId)
  return [...ids]
}

function slotElements(sourceSlide, slot) {
  const ids = new Set(slotElementIds(slot))
  return (sourceSlide.content_elements || [])
    .filter((element) => ids.has(element.element_id))
    .map((element) => JSON.parse(JSON.stringify(element)))
}

function typographySize(element) {
  return element?.typography?.size_pt || 0
}

// Same text-size heuristic as preview-layout-guard (0.48em per char,
// 1.15em per line), so a fitted box also passes the overflow check.
const METRIC_CHAR_WIDTH_EM = 0.48
const METRIC_LINE_HEIGHT_EM = 1.15
const METRIC_MIN_VALUE_FONT_SCALE = 0.55
export const METRIC_ROW_MIN_SCALE = 0.6

function slideHeightOf(element, slideSizePt) {
  if (slideSizePt?.height) return slideSizePt.height
  const geometry = element?.geometry_pt
  const norm = element?.geometry_norm
  if (geometry?.height_pt && norm?.height) return geometry.height_pt / norm.height
  return 540
}

function scaleSizeValue(value, scale) {
  const size = Number(value)
  if (!Number.isFinite(size) || size <= 0) return value
  return Math.round(size * scale * 100) / 100
}

function scaleElementFont(element, scale) {
  if (!(scale > 0) || scale === 1) return element
  const next = JSON.parse(JSON.stringify(element))
  if (next.typography) {
    next.typography.size_pt = scaleSizeValue(next.typography.size_pt, scale)
    if (next.typography.line_height_pt) {
      next.typography.line_height_pt = scaleSizeValue(next.typography.line_height_pt, scale)
    }
  }
  if (next.paragraph_spacing_pt?.line_height_pt) {
    next.paragraph_spacing_pt.line_height_pt = scaleSizeValue(next.paragraph_spacing_pt.line_height_pt, scale)
  }
  if (Array.isArray(next.text_runs)) {
    next.text_runs = next.text_runs.map((run) => {
      if (!run || run.break) return run
      const scaled = { ...run }
      if (scaled.size_pt) scaled.size_pt = scaleSizeValue(scaled.size_pt, scale)
      if (scaled.typography?.size_pt) {
        scaled.typography = { ...scaled.typography, size_pt: scaleSizeValue(scaled.typography.size_pt, scale) }
      }
      return scaled
    })
  }
  return next
}

export function estimateMetricTextLines(text, widthPt, sizePt) {
  const charsPerLine = Math.max(1, Math.floor(widthPt / (sizePt * METRIC_CHAR_WIDTH_EM)))
  return String(text || '').split('\n').reduce((total, line) => (
    total + Math.max(1, Math.ceil(line.length / charsPerLine))
  ), 0)
}

function horizontalInsets(element) {
  return (Number(element?.body_insets_pt?.left) || 0) + (Number(element?.body_insets_pt?.right) || 0)
}

function verticalInsets(element) {
  return (Number(element?.body_insets_pt?.top) || 0) + (Number(element?.body_insets_pt?.bottom) || 0)
}

// The value stays on one line: a display that is wider than its box gets a
// smaller font (not below 55% of the template size).
function fitMetricValueElement(element) {
  const size = typographySize(element)
  const width = element?.geometry_pt?.width_pt
  const text = String(element?.text || '')
  if (!size || !width || !text.trim()) return element
  const longest = Math.max(...text.split('\n').map((line) => line.length), 1)
  const needed = longest * size * METRIC_CHAR_WIDTH_EM
  const available = Math.max(1, width - horizontalInsets(element))
  if (needed <= available) return element
  return scaleElementFont(element, Math.max(METRIC_MIN_VALUE_FONT_SCALE, available / needed))
}

// A caption keeps its width and grows down to the lines its text needs
// (flex stacks size text by content, so this is the geometry it renders with).
function fitMetricCaptionElement(element, slideSizePt = null) {
  const size = typographySize(element)
  const geometry = element?.geometry_pt
  const text = String(element?.text || '')
  if (!size || !geometry?.width_pt || !geometry?.height_pt || !text.trim()) return element
  const lines = estimateMetricTextLines(text, Math.max(1, geometry.width_pt - horizontalInsets(element)), size)
  const needed = lines * size * METRIC_LINE_HEIGHT_EM + verticalInsets(element)
  if (needed <= geometry.height_pt) return element
  const slideHeight = slideHeightOf(element, slideSizePt)
  const maxHeight = Math.max(geometry.height_pt, slideHeight * 0.96 - (geometry.y_pt || 0))
  const height = Math.min(needed, maxHeight)
  if (height <= geometry.height_pt) return element
  return {
    ...element,
    geometry_pt: { ...geometry, height_pt: height },
    geometry_norm: element.geometry_norm
      ? { ...element.geometry_norm, height: height / slideHeight }
      : element.geometry_norm,
  }
}

// Metric contract for one slot: largest text = value+unit, next = description,
// a third text gets the optional label; every other text in the slot is
// cleared so no template placeholder survives.
function applyMetricFieldsToElements(elements, metric, { slideSizePt = null } = {}) {
  const fields = metricFields(metric)
  const texts = elements
    .filter((element) => element.kind === 'text')
    .sort((left, right) => typographySize(right) - typographySize(left))
  const textIds = new Set(texts.map((element) => element.element_id))
  const label = String(metric?.label || '').trim()
  const display = formatMetricDisplay(metric)
  let labelUsed = !label || label === display || label === fields.heading

  return elements.map((element) => {
    if (element.element_id === texts[0]?.element_id && fields.heading) {
      return fitMetricValueElement(withMetricExportData({
        ...element,
        text: fields.heading,
        text_sample: fields.heading,
      }, metric))
    }
    if (element.element_id === texts[1]?.element_id) {
      if (!fields.body) return clearTextElementContent(element)
      return fitMetricCaptionElement({ ...element, text: fields.body, text_sample: fields.body }, slideSizePt)
    }
    if (textIds.has(element.element_id) && element.element_id !== texts[0]?.element_id) {
      if (!labelUsed) {
        labelUsed = true
        return fitMetricCaptionElement({ ...element, text: label, text_sample: label }, slideSizePt)
      }
      return clearTextElementContent(element)
    }
    return element
  })
}

function wireHeroFlexStack(elements, pair, containerNorm) {
  const valueId = pair?.valueElementId
  const captionId = pair?.captionElementId
  if (!valueId || !captionId) return elements

  const valueEl = elements.find((element) => element.element_id === valueId)
  const captionEl = elements.find((element) => element.element_id === captionId)
  if (!valueEl || !captionEl) return elements

  const groupId = `metric_stack_${valueId}`
  const groupNorm = stackGeometryNorm([valueEl, captionEl]) || containerNorm || valueEl.geometry_norm
  const valuePt = valueEl.geometry_pt || {}
  const captionPt = captionEl.geometry_pt || {}
  const valueCenterY = (valuePt.y_pt || 0) + (valuePt.height_pt || 0) / 2
  const captionCenterY = (captionPt.y_pt || 0) + (captionPt.height_pt || 0) / 2
  const verticalTolerance = Math.max(valuePt.height_pt || 0, captionPt.height_pt || 0, 1) * 0.55
  const isRow = Math.abs(valueCenterY - captionCenterY) <= verticalTolerance
    && (captionPt.x_pt || 0) >= (valuePt.x_pt || 0) + (valuePt.width_pt || 0) * 0.7
  const direction = isRow ? 'row' : 'column'
  const centersAligned = Math.abs(valueCenterY - captionCenterY) <= Math.max(2, verticalTolerance * 0.2)
  const alignItems = direction === 'row' && centersAligned ? 'center' : 'flex-start'
  const gapPt = isRow
    ? Math.max(0, (captionPt.x_pt || 0) - ((valuePt.x_pt || 0) + (valuePt.width_pt || 0)))
    : Math.max(0, (captionPt.y_pt || 0) - ((valuePt.y_pt || 0) + (valuePt.height_pt || 0)))

  return elements.map((element) => {
    if (element.element_id === valueId) {
      return {
        ...element,
        text_group_id: groupId,
        text_line_index: 0,
        text_group_geometry_norm: groupNorm,
        split_from_shape: true,
        vertical_anchor: direction === 'column' ? 'ctr' : element.vertical_anchor,
        text_group_spacing_pt: {
          flex_stack_layout: direction === 'column' ? 'compact_display' : 'metric_row',
          flex_stack_direction: direction,
          flex_stack_align_items: alignItems,
          ...(direction === 'row' ? { item_gap_pt: gapPt } : { line_gap_pt: gapPt }),
        },
      }
    }
    if (element.element_id === captionId) {
      return {
        ...element,
        text_group_id: groupId,
        text_line_index: 1,
        text_group_geometry_norm: groupNorm,
        split_from_shape: true,
        vertical_anchor: direction === 'column' ? 'ctr' : element.vertical_anchor,
        text_group_spacing_pt: {
          flex_stack_layout: direction === 'column' ? 'compact_display' : 'metric_row',
          flex_stack_direction: direction,
          flex_stack_align_items: alignItems,
          ...(direction === 'row' ? { item_gap_pt: gapPt } : { line_gap_pt: gapPt }),
        },
      }
    }
    return element
  })
}

function metricFlexLayoutDirection(layout) {
  if (layout?.layout_direction === 'column') return 'column'
  if (layout?.detection_method === 'vgroup_metric_column') return 'column'
  return 'row'
}

function resolveMetricHeroColumnGeometry(sourceSlide, layout) {
  const slideSizePt = sourceSlide?.render?.slide_size_pt || { width: 960, height: 540 }
  const hero = layout.hero_region || layout
  const heroNorm = layout.container_norm || hero.container_norm || {}
  const heroPt = bboxPtFromNorm(heroNorm, slideSizePt)
  const templateElements = slotElements(sourceSlide, hero)
  const templateBox = unionBBoxPt(templateElements.map(elementBBoxPt).filter(Boolean)) || heroPt
  const stepY = Math.max(templateBox.height_pt * 1.08, 36)
  const marginPt = slideSizePt.height * 0.02
  const playgroundPt = {
    x_pt: heroPt.x_pt,
    y_pt: heroPt.y_pt,
    width_pt: Math.max(heroPt.width_pt, templateBox.width_pt),
    height_pt: Math.max(heroPt.height_pt, slideSizePt.height - heroPt.y_pt - marginPt),
  }

  return {
    slideSizePt,
    hero,
    heroPt,
    heroNorm,
    templateBox,
    pitch: {
      stepX: templateBox.width_pt,
      stepY,
      itemWidth: templateBox.width_pt,
      itemHeight: templateBox.height_pt,
      cols: 1,
    },
    playgroundPt,
    marginPt,
  }
}

function buildMetricHeroColumnFlexAssembly(sourceSlide, layout, metrics) {
  const { slideSizePt, hero, templateBox, pitch, playgroundPt } = resolveMetricHeroColumnGeometry(sourceSlide, layout)
  const itemCount = metrics.length
  const shape = { rows: itemCount, cols: 1 }
  const origins = layoutItemOriginsInBBox({
    itemCount,
    playgroundBBox: playgroundPt,
    pitch,
    shape,
    anchor: { x_pt: templateBox.x_pt, y_pt: templateBox.y_pt },
  })

  const generated = []
  for (let index = 0; index < itemCount; index += 1) {
    const templateElements = slotElements(sourceSlide, hero)
    const target = origins[index] || templateBox
    const dx = target.x_pt - templateBox.x_pt
    const dy = target.y_pt - templateBox.y_pt

    let cloned = templateElements.map((element) => translateMetricElement(
      element,
      dx,
      dy,
      slideSizePt,
      index + 1,
    ))
    cloned = applyMetricFieldsToElements(cloned, metrics[index], { slideSizePt })
    cloned = wireHeroFlexStack(
      cloned,
      translatedMetricPair(hero.pair, index + 1),
      hero.container_norm || layout.container_norm,
    )
    generated.push(...cloned)
  }

  return { slideSizePt, elements: generated }
}

function buildMetricHeroFlexAssembly(sourceSlide, layout, metrics) {
  const hero = layout.hero_region || layout
  const slideSizePt = sourceSlide.render?.slide_size_pt || { width: 960, height: 540 }
  const templateElements = slotElements(sourceSlide, hero)
  let elements = applyMetricFieldsToElements(templateElements, metrics[0], { slideSizePt })
  elements = wireHeroFlexStack(elements, hero.pair, hero.container_norm || layout.container_norm)
  return { slideSizePt, elements }
}

function resolveMetricHeroRowGeometry(sourceSlide, layout) {
  const slideSizePt = sourceSlide?.render?.slide_size_pt || { width: 960, height: 540 }
  const hero = layout.hero_region || layout
  const heroNorm = layout.container_norm || hero.container_norm || {}
  const heroPt = bboxPtFromNorm(heroNorm, slideSizePt)
  const templateElements = slotElements(sourceSlide, hero)
  const templateBox = unionBBoxPt(templateElements.map(elementBBoxPt).filter(Boolean)) || heroPt
  const pitch = measureRepeatPitch([templateBox], 'row')
  const marginPt = slideSizePt.width * 0.02
  const playgroundPt = {
    x_pt: heroPt.x_pt,
    y_pt: heroPt.y_pt,
    width_pt: Math.max(heroPt.width_pt, slideSizePt.width - heroPt.x_pt - marginPt),
    height_pt: heroPt.height_pt,
  }

  return {
    slideSizePt,
    hero,
    heroPt,
    heroNorm,
    templateBox,
    pitch,
    playgroundPt,
    marginPt,
  }
}

export function computeMetricHeroRowCapacity(sourceSlide, layout) {
  if (!sourceSlide || !layout) return 1
  if (layout.pattern !== METRIC_PATTERNS.hero) {
    return layout.capacity_expandable || layout.item_capacity || 1
  }

  const { slideSizePt, heroPt, templateBox, pitch, marginPt } = resolveMetricHeroRowGeometry(sourceSlide, layout)
  const stepX = pitch.stepX || templateBox.width_pt || heroPt.width_pt
  const itemWidth = pitch.itemWidth || templateBox.width_pt || heroPt.width_pt
  if (!stepX || !itemWidth) return 1

  let maxCount = 1
  for (let count = 1; count <= 8; count += 1) {
    const lastRight = templateBox.x_pt + (count - 1) * stepX + itemWidth
    if (lastRight <= slideSizePt.width - marginPt) maxCount = count
    else break
  }

  return Math.max(1, maxCount)
}

export function computeMetricRepeatRowCapacity(sourceSlide, layout) {
  if (!sourceSlide || layout?.pattern !== METRIC_PATTERNS.repeat) {
    return layout?.capacity_expandable || layout?.item_capacity || 1
  }

  const slideSizePt = sourceSlide.render?.slide_size_pt || { width: 960, height: 540 }
  const slots = layout.metric_slots || []
  const itemBoxes = slots
    .map((slot) => unionBBoxPt(slotElements(sourceSlide, slot).map(elementBBoxPt).filter(Boolean)))
    .filter(Boolean)
  if (!itemBoxes.length) return layout.item_capacity || 1

  const pitch = measureRepeatPitch(itemBoxes, 'row')
  const first = [...itemBoxes].sort((left, right) => left.x_pt - right.x_pt)[0]
  const stepX = pitch.stepX || first.width_pt
  const itemWidth = pitch.itemWidth || first.width_pt
  const rightEdge = slideSizePt.width * 0.98
  if (!stepX || !itemWidth) return layout.item_capacity || 1

  let maxCount = 1
  for (let count = 1; count <= 8; count += 1) {
    const lastRight = first.x_pt + (count - 1) * stepX + itemWidth
    if (lastRight <= rightEdge) maxCount = count
    else break
  }
  return Math.max(layout.item_capacity || slots.length || 1, maxCount)
}

export function computeMetricHeroPreviewBBox(sourceSlide, layout, itemCount = 1) {
  const heroNorm = layout?.container_norm || layout?.hero_region?.container_norm
  if (!sourceSlide || !layout || !heroNorm) return { bboxPt: null, bboxNorm: null }

  const { slideSizePt, hero, templateBox, pitch, playgroundPt } = resolveMetricHeroRowGeometry(sourceSlide, layout)
  const heroPt = bboxPtFromNorm(heroNorm, slideSizePt)
  const count = Math.max(1, itemCount)

  if (count <= 1 || layout.pattern !== METRIC_PATTERNS.hero) {
    return {
      bboxPt: heroPt,
      bboxNorm: heroNorm,
    }
  }

  if (metricFlexLayoutDirection(layout) === 'column') {
    const { templateBox, pitch, playgroundPt } = resolveMetricHeroColumnGeometry(sourceSlide, layout)
    const shape = { rows: count, cols: 1 }
    const origins = layoutItemOriginsInBBox({
      itemCount: count,
      playgroundBBox: playgroundPt,
      pitch,
      shape,
      anchor: { x_pt: templateBox.x_pt, y_pt: templateBox.y_pt },
    })
    const itemBoxes = origins.map((origin) => ({
      x_pt: origin.x_pt,
      y_pt: origin.y_pt,
      width_pt: pitch.itemWidth || templateBox.width_pt,
      height_pt: pitch.itemHeight || templateBox.height_pt,
    }))
    const bboxPt = unionBBoxPt([heroPt, ...itemBoxes])
    return {
      bboxPt,
      bboxNorm: bboxNormFromPt(bboxPt, slideSizePt),
    }
  }

  const shape = { cols: count, rows: 1 }
  const origins = layoutItemOriginsInBBox({
    itemCount: count,
    playgroundBBox: playgroundPt,
    pitch,
    shape,
    anchor: { x_pt: templateBox.x_pt, y_pt: templateBox.y_pt },
  })

  const itemWidth = pitch.itemWidth || templateBox.width_pt || heroPt.width_pt
  const itemHeight = pitch.itemHeight || templateBox.height_pt || heroPt.height_pt
  const itemBoxes = origins.map((origin) => ({
    x_pt: origin.x_pt,
    y_pt: origin.y_pt,
    width_pt: itemWidth,
    height_pt: itemHeight,
  }))

  const bboxPt = unionBBoxPt([heroPt, ...itemBoxes])
  return {
    bboxPt,
    bboxNorm: bboxNormFromPt(bboxPt, slideSizePt),
  }
}

// Right edge a row may use: the deck content margin (the same frame the
// placement audit checks), never closer than 2% to the slide edge.
function contentRightEdgePt(report, slideSizePt, marginPt) {
  const rightNorm = Number(report?.layout?.content_margins?.right_norm)
  const byMargin = slideSizePt.width - marginPt
  if (!Number.isFinite(rightNorm) || rightNorm < 0 || rightNorm >= 0.5) return byMargin
  return Math.min(byMargin, slideSizePt.width * (1 - rightNorm))
}

function metricRowFitScale({ slideSizePt, templateBox, pitch, marginPt, rightEdgePt = null }, itemCount) {
  const stepX = pitch?.stepX || templateBox?.width_pt
  const itemWidth = pitch?.itemWidth || templateBox?.width_pt
  if (!stepX || !itemWidth || itemCount <= 1) return 1
  const available = (rightEdgePt ?? (slideSizePt.width - marginPt)) - templateBox.x_pt
  const needed = (itemCount - 1) * stepX + itemWidth
  return needed <= available ? 1 : available / needed
}

function scalePitch(pitch, scale) {
  if (scale === 1) return pitch
  return Object.fromEntries(Object.entries(pitch || {}).map(([key, value]) => [
    key,
    typeof value === 'number' && /step|width|height|gap/i.test(key) ? value * scale : value,
  ]))
}

function scaleBoxAround(box, originPt, scale) {
  return {
    ...box,
    x_pt: originPt.x_pt + ((box.x_pt || 0) - originPt.x_pt) * scale,
    y_pt: originPt.y_pt + ((box.y_pt || 0) - originPt.y_pt) * scale,
    width_pt: (box.width_pt || 0) * scale,
    height_pt: (box.height_pt || 0) * scale,
  }
}

function scaleMetricElementAround(element, originPt, scale, slideSizePt) {
  if (scale === 1) return element
  const next = scaleElementFont(element, scale)
  if (next.geometry_pt) {
    next.geometry_pt = scaleBoxAround(next.geometry_pt, originPt, scale)
    next.geometry_norm = bboxNormFromPt(next.geometry_pt, slideSizePt)
  }
  if (next.text_group_geometry_pt) {
    next.text_group_geometry_pt = scaleBoxAround(next.text_group_geometry_pt, originPt, scale)
    next.text_group_geometry_norm = bboxNormFromPt(next.text_group_geometry_pt, slideSizePt)
  }
  if (next.body_insets_pt) {
    next.body_insets_pt = Object.fromEntries(Object.entries(next.body_insets_pt).map(([key, value]) => [
      key,
      typeof value === 'number' ? value * scale : value,
    ]))
  }
  return next
}

// How many items a split/hero row holds when the item may shrink down to
// METRIC_ROW_MIN_SCALE. Column heroes keep their detected capacity.
export function computeMetricRowFitCapacity(sourceSlide, layout, { minScale = METRIC_ROW_MIN_SCALE, report = null } = {}) {
  const detected = layout?.capacity_expandable || layout?.capacity_visible || layout?.item_capacity || 1
  if (!sourceSlide || !layout) return detected
  if (layout.pattern !== METRIC_PATTERNS.split && layout.pattern !== METRIC_PATTERNS.hero) return detected
  if (layout.pattern === METRIC_PATTERNS.hero && metricFlexLayoutDirection(layout) === 'column') return detected
  const geometry = resolveMetricHeroRowGeometry(sourceSlide, layout)
  geometry.rightEdgePt = contentRightEdgePt(report, geometry.slideSizePt, geometry.marginPt)
  let maxCount = 1
  for (let count = 2; count <= 8; count += 1) {
    if (metricRowFitScale(geometry, count) >= minScale) maxCount = count
    else break
  }
  return maxCount
}

function buildMetricHeroRowFlexAssembly(sourceSlide, layout, metrics, report = null) {
  const geometry = resolveMetricHeroRowGeometry(sourceSlide, layout)
  geometry.rightEdgePt = contentRightEdgePt(report, geometry.slideSizePt, geometry.marginPt)
  const { slideSizePt, hero, templateBox, playgroundPt } = geometry
  const itemCount = metrics.length
  const rowScale = Math.min(1, Math.max(METRIC_ROW_MIN_SCALE, metricRowFitScale(geometry, itemCount)))
  const pitch = scalePitch(geometry.pitch, rowScale)
  const shape = { cols: itemCount, rows: 1 }
  const origins = layoutItemOriginsInBBox({
    itemCount,
    playgroundBBox: playgroundPt,
    pitch,
    shape,
    anchor: { x_pt: templateBox.x_pt, y_pt: templateBox.y_pt },
  })

  const generated = []
  for (let index = 0; index < itemCount; index += 1) {
    const templateElements = slotElements(sourceSlide, hero)
      .map((element) => scaleMetricElementAround(element, templateBox, rowScale, slideSizePt))
    const target = origins[index] || templateBox
    const dx = target.x_pt - templateBox.x_pt
    const dy = target.y_pt - templateBox.y_pt

    let cloned = templateElements.map((element) => translateMetricElement(
      element,
      dx,
      dy,
      slideSizePt,
      index + 1,
    ))
    cloned = applyMetricFieldsToElements(cloned, metrics[index], { slideSizePt })
    cloned = wireHeroFlexStack(
      cloned,
      translatedMetricPair(hero.pair, index + 1),
      hero.container_norm || layout.container_norm,
    )
    generated.push(...cloned)
  }

  return { slideSizePt, elements: generated, rowScale }
}

function buildMetricRowFlexAssembly(sourceSlide, layout, metrics, { expanded = false } = {}) {
  const slideSizePt = sourceSlide.render?.slide_size_pt || { width: 960, height: 540 }
  const slots = layout.metric_slots || []
  const flexLayout = metricFlexLayoutDirection(layout)
  const basePlaygroundPt = bboxPtFromNorm(layout.container_norm || {}, slideSizePt)
  const itemBoxes = slots
    .map((slot) => unionBBoxPt(slotElements(sourceSlide, slot).map(elementBBoxPt).filter(Boolean)))
    .filter(Boolean)

  const pitch = measureRepeatPitch(itemBoxes, flexLayout)
  const itemCount = expanded ? metrics.length : Math.min(metrics.length, slots.length)
  const firstBox = flexLayout === 'column'
    ? [...itemBoxes].sort((left, right) => left.y_pt - right.y_pt)[0]
    : [...itemBoxes].sort((left, right) => left.x_pt - right.x_pt)[0]
  const playgroundPt = expanded && firstBox
    ? (flexLayout === 'column'
      ? {
        x_pt: basePlaygroundPt.x_pt,
        y_pt: firstBox.y_pt,
        width_pt: basePlaygroundPt.width_pt,
        height_pt: Math.max(basePlaygroundPt.height_pt, slideSizePt.height * 0.98 - firstBox.y_pt),
      }
      : {
        x_pt: firstBox.x_pt,
        y_pt: basePlaygroundPt.y_pt,
        width_pt: Math.max(basePlaygroundPt.width_pt, slideSizePt.width * 0.98 - firstBox.x_pt),
        height_pt: basePlaygroundPt.height_pt,
      })
    : basePlaygroundPt
  const shape = expanded
    ? (flexLayout === 'column' ? { rows: itemCount, cols: 1 } : { cols: itemCount, rows: 1 })
    : resolveRepeatShape(itemCount, pitch, flexLayout)
  const origins = layoutItemOriginsInBBox({
    itemCount,
    playgroundBBox: playgroundPt,
    pitch,
    shape,
    anchor: firstBox ? { x_pt: firstBox.x_pt, y_pt: firstBox.y_pt } : null,
  })

  const generated = []
  for (let index = 0; index < itemCount; index += 1) {
    const slot = slots[index % slots.length]
    const templateElements = slotElements(sourceSlide, slot)
    const templateBox = unionBBoxPt(templateElements.map(elementBBoxPt).filter(Boolean))
    if (!templateBox) continue

    const target = origins[index] || templateBox
    const dx = target.x_pt - templateBox.x_pt
    const dy = target.y_pt - templateBox.y_pt

    let cloned = templateElements.map((element) => translateMetricElement(
      element,
      dx,
      dy,
      slideSizePt,
      index + 1,
    ))
    cloned = applyMetricFieldsToElements(cloned, metrics[index], { slideSizePt })
    cloned = wireHeroFlexStack(cloned, translatedMetricPair(slot.pair, index + 1), slot.container_norm)
    generated.push(...cloned)
  }

  return { slideSizePt, elements: generated }
}

function buildMetricComboFlexAssembly(sourceSlide, layout, metrics) {
  const heroAssembly = buildMetricHeroFlexAssembly(sourceSlide, layout, metrics.slice(0, 1))
  const heroIds = new Set(layout.hero_region?.element_ids || [])
  const repeatSlots = (layout.metric_slots || []).filter((slot) => (
    slot.vgroup_id !== layout.hero_region?.vgroup_id
    && !(slot.element_ids || []).some((elementId) => heroIds.has(elementId))
  ))
  if (metrics.length <= 1) return heroAssembly
  if (!repeatSlots.length) return null

  const repeatElements = repeatSlots.flatMap((slot) => slotElements(sourceSlide, slot))
  const repeatBox = unionBBoxPt(repeatElements.map(elementBBoxPt).filter(Boolean))
  const repeatLayout = {
    ...layout,
    container_norm: repeatBox ? bboxNormFromPt(repeatBox, heroAssembly.slideSizePt) : layout.container_norm,
    metric_slots: repeatSlots,
  }
  const repeatAssembly = buildMetricRowFlexAssembly(sourceSlide, repeatLayout, metrics.slice(1))
  return {
    slideSizePt: heroAssembly.slideSizePt,
    elements: [...heroAssembly.elements, ...repeatAssembly.elements],
  }
}

function buildMetricFlexAssemblySlide(report, layout, metrics, { expanded = false } = {}) {
  const specMetrics = (metrics || []).filter((item) => (
    String(item?.title || item?.value || '').trim() || String(item?.text || item?.description || '').trim()
  ))
  if (!specMetrics.length || !layout) return null

  const sourceSlide = findSlide(report, layout.slide_number)
  if (!sourceSlide) return null

  const shell = cloneSlide(sourceSlide)
  const isFlexRow = layout.pattern === METRIC_PATTERNS.repeat
    || (layout.metric_slots?.length >= 2 && layout.detection_method === 'vgroup_metric_flex_row')

  let assembled
  if (layout.pattern === METRIC_PATTERNS.combo) {
    assembled = buildMetricComboFlexAssembly(sourceSlide, layout, specMetrics)
    if (!assembled) {
      return applyMetricsToLayout(report, layout, specMetrics, { expanded, flexAssembly: false })
    }
  } else if (layout.pattern === METRIC_PATTERNS.split && expanded && specMetrics.length > 1) {
    assembled = buildMetricHeroRowFlexAssembly(sourceSlide, layout, specMetrics, report)
  } else if (isFlexRow && layout.metric_slots?.length >= 2) {
    assembled = buildMetricRowFlexAssembly(sourceSlide, layout, specMetrics, { expanded })
  } else if (layout.pattern === METRIC_PATTERNS.repeat) {
    return applyMetricsToLayout(report, layout, specMetrics, { expanded, flexAssembly: false })
  } else if (layout.pattern === METRIC_PATTERNS.hero && specMetrics.length > 1) {
    assembled = metricFlexLayoutDirection(layout) === 'column'
      ? buildMetricHeroColumnFlexAssembly(sourceSlide, layout, specMetrics)
      : buildMetricHeroRowFlexAssembly(sourceSlide, layout, specMetrics, report)
  } else {
    assembled = buildMetricHeroFlexAssembly(sourceSlide, layout, specMetrics)
  }

  shell.content_elements = assembled.elements
  return finalizeMetricPreviewSlide(shell, layout, assembled.elements.map((element) => element.element_id))
}

export function computeMetricPreviewBBox(slide) {
  const slideSizePt = slide?.render?.slide_size_pt || { width: 960, height: 540 }
  const bboxPt = unionBBoxPt(
    (slide?.content_elements || []).map(elementBBoxPt).filter(Boolean),
  )
  return {
    bboxPt,
    bboxNorm: bboxPt ? bboxNormFromPt(bboxPt, slideSizePt) : null,
  }
}

function collectMetricPreviewElementIds(layout, extraIds = []) {
  const ids = new Set(extraIds.filter(Boolean))

  const hero = layout?.hero_region
  for (const elementId of hero?.element_ids || []) {
    ids.add(elementId)
  }
  if (hero?.pair?.valueElementId) ids.add(hero.pair.valueElementId)
  if (hero?.pair?.captionElementId) ids.add(hero.pair.captionElementId)

  for (const slot of layout?.metric_slots || []) {
    for (const elementId of slot?.element_ids || []) {
      ids.add(elementId)
    }
    if (slot?.pair?.valueElementId) ids.add(slot.pair.valueElementId)
    if (slot?.pair?.captionElementId) ids.add(slot.pair.captionElementId)
  }

  return [...ids]
}

function finalizeMetricPreviewSlide(slide, layout, extraIds = []) {
  return isolateSlideMetricPreview(slide, {
    keepElementIds: collectMetricPreviewElementIds(layout, extraIds),
  })
}

function applyHeroMetrics(slide, heroRegion, metrics) {
  if (!heroRegion || !metrics.length) return slide
  const metric = metrics[0]
  const fields = metricFields(metric)
  return applyMetricPairToElements(
    slide,
    heroRegion.element_ids || [],
    heroRegion.pair,
    fields,
    metric,
  )
}

function applyMetricFlexRow(slide, layout, metrics) {
  const slots = layout.metric_slots || []
  let next = slide

  slots.forEach((slot, index) => {
    const metric = metrics[index]
    if (!metric || !slot?.pair) return
    next = applyMetricPairToElements(
      next,
      slot.element_ids || [],
      slot.pair,
      metricFields(metric),
      metric,
    )
  })

  return finalizeMetricPreviewSlide(next, layout)
}

function applyMetricSplit(slide, layout, metrics, { expanded = false } = {}) {
  const hero = layout.hero_region
  let next = slide

  if (expanded && metrics.length > 1) {
    const assembled = buildMetricHeroRowFlexAssembly(slide, layout, metrics)
    next = {
      ...next,
      content_elements: assembled.elements,
    }
    return finalizeMetricPreviewSlide(
      next,
      layout,
      assembled.elements.map((element) => element.element_id),
    )
  }

  next = applyHeroMetrics(next, hero, metrics.slice(0, 1))
  return finalizeMetricPreviewSlide(next, layout)
}

function buildRepeatMetricsSlide(report, layout, metrics, component, instance) {
  const itemCount = Math.min(metrics.length, layout.item_capacity || metrics.length)
  const modelData = {
    item_count: itemCount,
    layout: instance?.layout || layout.repeat_instance?.layout || 'row',
    grid: instance?.repeat?.grid || layout.repeat_instance?.repeat?.grid || null,
    items: metrics.slice(0, itemCount).map((metric, index) => ({
      index: index + 1,
      fields: {
        ...metricFields(metric),
        metric_value: metric.value,
        metric_unit: metric.unit,
      },
    })),
  }

  const repeatSlide = buildContainerRepeatPreviewSlide(report, component, instance, { modelData })
  if (!repeatSlide) return null

  const repeatIds = (repeatSlide.content_elements || [])
    .filter((element) => String(element.element_id).includes('__repeat_'))
    .map((element) => element.element_id)

  return isolateSlideMetricPreview(repeatSlide, { keepElementIds: repeatIds })
}

function resolveRepeatComponent(report, layout) {
  if (layout.repeat_component_id) {
    const component = listAllComponents(report).find((item) => item.id === layout.repeat_component_id)
    if (component && layout.repeat_instance) {
      return { component, instance: layout.repeat_instance }
    }
  }

  const target = layout.repeat_region?.vgroup_id
  if (target) {
    // Exact vgroup first; otherwise the nearest ancestor/descendant vgroup
    // (metric detection may name g1.2.2 while the repeat instance is g1.2).
    const related = (vgroupId) => Boolean(vgroupId) && (
      vgroupId === target
      || target.startsWith(`${vgroupId}.`)
      || vgroupId.startsWith(`${target}.`)
    )
    let best = null
    const components = listAllComponents(report).filter((item) => item.group === 'repeats')
    for (const component of components) {
      for (const instance of component.instances || []) {
        if (instance.slide_number !== layout.slide_number || !related(instance.vgroup_id)) continue
        const distance = Math.abs(String(instance.vgroup_id).split('.').length - target.split('.').length)
        if (!best || distance < best.distance) best = { component, instance, distance }
      }
    }
    if (best) return { component: best.component, instance: best.instance }
  }

  return null
}

const UNIT_ONLY_TEXT = /^[\s%‰°₽$€£×]+$/u

function normalizeContractText(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().toLowerCase()
}

function baseElementId(elementId) {
  return String(elementId || '').split('__')[0]
}

// Metric contract check on a rendered layout:
// - template text that is still unchanged in the preview is cleared (no
//   "Описание"/"91%" placeholders left in unused or extra slots);
// - every metric must show its value and description; otherwise the layout
//   is rejected (null) unless allowPartial is set.
export function enforceMetricContract(slide, sourceSlide, metrics, {
  allowPartial = false,
  requested = metrics?.length || 0,
} = {}) {
  if (!slide) return null
  const isText = (element) => element.kind === 'text' || element.kind === 'badge'
  const sourceTexts = new Map((sourceSlide?.content_elements || [])
    .filter(isText)
    .map((element) => [element.element_id, normalizeContractText(element.text)]))
  const metricTexts = (metrics || []).flatMap((metric) => [
    formatMetricDisplay(metric),
    metric.value,
    metric.description,
    metric.label,
  ]).map(normalizeContractText).filter(Boolean)

  let cleared = 0
  const elements = (slide.content_elements || []).map((element) => {
    if (!isText(element)) return element
    const text = normalizeContractText(element.text)
    if (!text || UNIT_ONLY_TEXT.test(text)) return element
    const templateText = sourceTexts.get(baseElementId(element.element_id))
    if (!templateText || templateText !== text) return element
    if (metricTexts.some((item) => item === text)) return element
    cleared += 1
    return clearTextElementContent(element)
  })

  const texts = elements.filter(isText).map((element) => normalizeContractText(element.text)).filter(Boolean)
  const rendered = (metrics || []).filter((metric) => {
    const value = normalizeContractText(metric.value)
    const description = normalizeContractText(metric.description || metric.text)
    return (!value || texts.some((text) => text.includes(value)))
      && (!description || texts.some((text) => text.includes(description)))
  }).length

  if (!allowPartial && rendered < requested) return null
  return {
    ...slide,
    content_elements: elements,
    metric_contract: { requested, rendered, placeholders_cleared: cleared },
  }
}

export function metricLayoutMaxItems(report, layout, { expanded = false } = {}) {
  if (!layout) return 0
  const detected = layout.pattern === METRIC_PATTERNS.hero || expanded
    ? (layout.capacity_expandable || layout.capacity_visible || layout.item_capacity || 1)
    : (layout.capacity_visible || layout.item_capacity || 1)
  if (!expanded && layout.pattern !== METRIC_PATTERNS.hero) return detected
  if (layout.pattern !== METRIC_PATTERNS.split && layout.pattern !== METRIC_PATTERNS.hero) return detected
  return Math.max(detected, computeMetricRowFitCapacity(findSlide(report, layout.slide_number), layout, { report }))
}

// Single metric adapter: {value, unit, description, label?} -> layout.
// 1..N metrics; a layout that cannot show all of them is rejected unless
// allowPartial is passed.
export function applyMetricsToLayout(report, layout, metrics, {
  expanded = false,
  flexAssembly = false,
  allowPartial = false,
} = {}) {
  if (!layout) return null
  const adapted = adaptMetricsForLayout(metrics, layout)
  if (!adapted.length) return null
  const maxItems = Math.max(1, metricLayoutMaxItems(report, layout, { expanded }))
  if (adapted.length > maxItems && !allowPartial) return null
  const specMetrics = adapted.slice(0, maxItems)
  const rendered = renderMetricsToLayout(report, layout, specMetrics, { expanded, flexAssembly })
  return enforceMetricContract(rendered, findSlide(report, layout.slide_number), specMetrics, {
    allowPartial,
    requested: specMetrics.length,
  })
}

function renderMetricsToLayout(report, layout, specMetrics, { expanded = false, flexAssembly = false } = {}) {
  if (!specMetrics.length || !layout) return null

  if (flexAssembly) {
    return buildMetricFlexAssemblySlide(report, layout, specMetrics, { expanded })
  }

  let slide = cloneSlide(findSlide(report, layout.slide_number))
  if (!slide) return null

  if (layout.pattern === METRIC_PATTERNS.hero) {
    slide = applyHeroMetrics(slide, layout.hero_region || layout, specMetrics)
    return finalizeMetricPreviewSlide(slide, layout)
  }

  if (layout.pattern === METRIC_PATTERNS.repeat) {
    if (layout.metric_slots?.length && layout.detection_method === 'vgroup_metric_flex_row') {
      return applyMetricFlexRow(slide, layout, specMetrics)
    }

    const resolved = resolveRepeatComponent(report, layout)
    if (resolved) {
      return buildRepeatMetricsSlide(report, layout, specMetrics, resolved.component, resolved.instance)
    }

    if (layout.metric_slots?.length) {
      return applyMetricFlexRow(slide, layout, specMetrics)
    }

    return null
  }

  if (layout.pattern === METRIC_PATTERNS.combo) {
    slide = applyHeroMetrics(slide, layout.hero_region, specMetrics.slice(0, 1))
    const repeatResolved = resolveRepeatComponent(report, layout.repeat_region ? {
      ...layout,
      repeat_region: layout.repeat_region,
      repeat_component_id: layout.repeat?.repeat_component_id || layout.repeat_component_id,
      repeat_instance: layout.repeat?.repeat_instance || layout.repeat_instance,
    } : layout)
    if (!repeatResolved) {
      return finalizeMetricPreviewSlide(slide, layout)
    }

    const repeatSlide = buildRepeatMetricsSlide(
      report,
      layout.repeat_region || layout.repeat,
      specMetrics.slice(1),
      repeatResolved.component,
      repeatResolved.instance,
    )
    if (!repeatSlide) return finalizeMetricPreviewSlide(slide, layout)

    const repeatIds = new Set((repeatSlide.content_elements || []).map((element) => element.element_id))
    const heroIds = new Set(layout.hero_region?.element_ids || [])

    slide = {
      ...slide,
      content_elements: [
        ...(slide.content_elements || []).filter((element) => heroIds.has(element.element_id)),
        ...(repeatSlide.content_elements || []).filter((element) => repeatIds.has(element.element_id)),
      ],
    }
    return finalizeMetricPreviewSlide(slide, layout, [...repeatIds])
  }

  if (layout.pattern === METRIC_PATTERNS.split) {
    return applyMetricSplit(slide, layout, specMetrics, { expanded })
  }

  return null
}

// Metric layouts depend only on the template deck, but vgroup detection over
// every donor slide is expensive (minutes on a 50-slide deck) and this list is
// asked for per template, per title variant and per slide. Compute it once per
// report (and per slide list, in case a caller swaps it) and hand out copies of
// the array so callers can sort/filter freely.
const deckMetricLayoutCache = new WeakMap()

export function listDeckMetricLayouts(report) {
  const slides = report?.slides?.slides || []
  const cacheable = report && typeof report === 'object'
  const cached = cacheable ? deckMetricLayoutCache.get(report) : null
  if (cached && cached.slides === slides && cached.count === slides.length) return [...cached.layouts]
  const layouts = []
  for (const slide of slides) {
    const repeatElementIds = collectRepeatElementIds(report, slide.slide_number)
    const { layouts: slideLayouts } = detectSlideMetricLayouts(slide, report, { repeatElementIds })
    layouts.push(...slideLayouts)
  }
  if (cacheable) deckMetricLayoutCache.set(report, { slides, count: slides.length, layouts })
  return [...layouts]
}
