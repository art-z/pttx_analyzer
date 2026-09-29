import { findSlide } from './catalog.js'
import { buildShellSlide } from '../constructor/templates.js'
import { applyModelDataToComponent, buildBaselineGraphicElement } from './model-data.js'

const TITLE_ZONE_MAX_Y = 0.22
const TITLE_TOP_MAX_Y = 0.18
const TITLE_TOP_MIN_WIDTH = 0.45
const FULLWIDTH_CONTENT_MIN = 0.55
const FULLWIDTH_CONTENT_MIN_HEIGHT = 0.18
const SPLIT_SIDE_MIN_WIDTH = 0.28
const SPLIT_SIDE_MIN_HEIGHT = 0.25
const SPLIT_LEFT_MAX_CENTER = 0.48
const SPLIT_RIGHT_MIN_CENTER = 0.52
const SPLIT_MAX_WIDTH = 0.58
const SHELL_BOTTOM = 0.96
const CONTENT_REGION_MARGIN = 0.018
const CANVAS_SIDE_MARGIN = 0.04
const CANVAS_FULL_WIDTH = 0.92
const GRAPHIC_KINDS = new Set(['table', 'chart', 'diagram'])
const REMOVABLE_CONTENT_KINDS = new Set(['table', 'chart', 'diagram', 'image'])
const CIRCULAR_CHART_TYPES = new Set(['pie', 'doughnut', 'donut'])
const SPATIAL_HEATMAP_WEIGHTS = {
  text_regions: 0.3,
  image_regions: 0.15,
  repeated_groups: 0.4,
  safe_space: 0.15,
}

function denseProjectionRange(values, thresholdRatio = 0.45) {
  const peak = Math.max(0, ...values)
  if (peak <= 0) return null
  const threshold = peak * thresholdRatio
  const active = values.map((value, index) => value >= threshold ? index : -1).filter((index) => index >= 0)
  if (!active.length) return null
  return { start: active[0], end: active.at(-1), peak }
}

function median(values) {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}

function titleCandidate(element, fallback = false) {
  if (element?.kind !== 'text') return false
  const geometry = element.geometry_norm || {}
  const y = Number(geometry.y ?? 1)
  if (y >= TITLE_ZONE_MAX_Y) return false
  const role = String(
    element.placeholder_type || element.text_role || element.role || element.name || '',
  ).toLowerCase()
  if (['title', 'ctrtitle', 'ctr_title'].includes(role)) return true
  return fallback && y < TITLE_TOP_MAX_Y && Number(geometry.width || 0) >= TITLE_TOP_MIN_WIDTH
}

function inferredTitleContentGap(report) {
  const saved = Number(report?.layout?.content_margins?.title_content_gap_norm)
  if (Number.isFinite(saved) && saved >= 0) return saved
  const gaps = []
  for (const slide of report?.slides?.slides || []) {
    const elements = slide.content_elements || []
    let titles = elements.filter((element) => titleCandidate(element))
    if (!titles.length) titles = elements.filter((element) => titleCandidate(element, true))
    if (!titles.length) continue
    const title = titles.sort((a, b) => {
      const aBox = a.geometry_norm || {}
      const bBox = b.geometry_norm || {}
      return Number(bBox.width || 0) * Number(bBox.height || 0)
        - Number(aBox.width || 0) * Number(aBox.height || 0)
    })[0]
    const titleBox = title.geometry_norm || {}
    const titleBottom = Number(titleBox.y || 0) + Number(titleBox.height || 0)
    const contentTops = elements
      .filter((element) => element !== title)
      .map((element) => element.geometry_norm || {})
      .filter((box) => Number(box.width || 0) >= 0.01 && Number(box.height || 0) >= 0.005)
      .map((box) => Number(box.y || 0))
      .filter((top) => top >= titleBottom)
    if (!contentTops.length) continue
    const gap = Math.min(...contentTops) - titleBottom
    if (gap >= 0 && gap <= 0.28) gaps.push(gap)
  }
  return median(gaps) ?? 0
}

function spatialBBoxBelowTitle(report, placement, bbox) {
  const gap = inferredTitleContentGap(report)
  if (!gap || !placement?.slide_number) return bbox
  const slide = findSlide(report, placement.slide_number)
  const elements = slide?.content_elements || []
  let titles = elements.filter((element) => titleCandidate(element))
  if (!titles.length) titles = elements.filter((element) => titleCandidate(element, true))
  if (!titles.length) return bbox
  const title = titles.sort((a, b) => Number((a.geometry_norm || {}).y || 1) - Number((b.geometry_norm || {}).y || 1))[0]
  const titleBox = title.geometry_norm || {}
  const requiredTop = Number(titleBox.y || 0) + Number(titleBox.height || 0) + gap
  const bottom = bbox.y + bbox.height
  const y = Math.max(bbox.y, requiredTop)
  if (bottom - y < 0.3) return bbox
  return { ...bbox, y, height: bottom - y, title_clearance_norm: gap }
}

export function resolveSpatialContentBBox(report) {
  const components = report?.typography?.spatial?.components || []
  const byId = new Map(components.map((component) => [component.id, component]))
  const sources = Object.entries(SPATIAL_HEATMAP_WEIGHTS)
    .map(([id, weight]) => ({ id, weight, heatmap: byId.get(id)?.heatmap }))
    .filter(({ id, heatmap }) => (
      heatmap?.cols > 0
      && heatmap?.rows > 0
      && (id === 'safe_space' ? Array.isArray(heatmap.free_ratios) : Array.isArray(heatmap.counts))
    ))
  if (sources.length < 2) return null

  const { cols, rows } = sources[0].heatmap
  const compatible = sources.filter(({ heatmap }) => heatmap.cols === cols && heatmap.rows === rows)
  if (compatible.length < 2) return null
  const weightTotal = compatible.reduce((sum, source) => sum + source.weight, 0)
  const scores = Array.from({ length: rows }, () => Array(cols).fill(0))

  for (const source of compatible) {
    const normalizedWeight = source.weight / weightTotal
    const maxCount = Math.max(1, Number(source.heatmap.max_count) || 1)
    for (let row = 0; row < rows; row += 1) {
      for (let col = 0; col < cols; col += 1) {
        const value = source.id === 'safe_space'
          ? 1 - Number(source.heatmap.free_ratios?.[row]?.[col] ?? 1)
          : Number(source.heatmap.counts?.[row]?.[col] || 0) / maxCount
        scores[row][col] += Math.max(0, Math.min(1, value)) * normalizedWeight
      }
    }
  }

  const rowProjection = scores.map((row) => row.reduce((sum, value) => sum + value, 0) / cols)
  const colProjection = Array.from({ length: cols }, (_, col) => (
    scores.reduce((sum, row) => sum + row[col], 0) / rows
  ))
  const rowRange = denseProjectionRange(rowProjection)
  const colRange = denseProjectionRange(colProjection)
  if (!rowRange || !colRange) return null

  const halfCellX = 0.5 / cols
  const halfCellY = 0.5 / rows
  let left = Math.max(0, colRange.start / cols - halfCellX)
  let right = Math.min(1, (colRange.end + 1) / cols + halfCellX)
  let top = Math.max(0, rowRange.start / rows - halfCellY)
  let bottom = Math.min(1, (rowRange.end + 1) / rows + halfCellY)
  const margins = report?.layout?.content_margins || {}
  if (Number.isFinite(margins.left_norm)) left = Math.max(left, margins.left_norm)
  if (Number.isFinite(margins.right_norm)) right = Math.min(right, 1 - margins.right_norm)
  if (Number.isFinite(margins.top_norm)) top = Math.max(top, margins.top_norm)
  if (Number.isFinite(margins.bottom_norm)) bottom = Math.min(bottom, 1 - margins.bottom_norm)

  const width = right - left
  const height = bottom - top
  if (width < 0.55 || height < 0.3) return null
  return {
    x: left,
    y: top,
    width,
    height,
    confidence: Math.min(1, compatible.length / Object.keys(SPATIAL_HEATMAP_WEIGHTS).length),
    source_ids: compatible.map((source) => source.id),
  }
}

function applySpatialChartGeometry(report, component, placement) {
  const chartType = String(component.chartType || component.chart_type || component.raw?.chart_type || '').toLowerCase()
  if (component.kind !== 'chart' || CIRCULAR_CHART_TYPES.has(chartType)) return placement
  const bbox = resolveSpatialContentBBox(report)
  if (!bbox) return placement
  const adjustedBBox = spatialBBoxBelowTitle(report, placement, bbox)
  const size = reportDefaultSize(report)
  return {
    ...placement,
    geometry_source: 'spatial_heatmap',
    spatial_bbox_confidence: bbox.confidence,
    spatial_bbox_sources: bbox.source_ids,
    geometry_norm: {
      x: adjustedBBox.x,
      y: adjustedBBox.y,
      width: adjustedBBox.width,
      height: adjustedBBox.height,
    },
    geometry_pt: {
      x_pt: adjustedBBox.x * size.width,
      y_pt: adjustedBBox.y * size.height,
      width_pt: adjustedBBox.width * size.width,
      height_pt: adjustedBBox.height * size.height,
    },
    title_clearance_norm: adjustedBBox.title_clearance_norm || null,
  }
}

export function resolveBaselinePreviewPlacement(report, component) {
  const fromReport = component.raw?.baseline_preview
  let placement = fromReport
    ? maximizeLegacyCartesianChartPlacement(report, component, fromReport)
    : resolveBaselinePreviewClient(report, component)
  return applySpatialChartGeometry(report, component, placement)
}

function maximizeLegacyCartesianChartPlacement(report, component, placement) {
  const chartType = String(component.chartType || component.chart_type || component.raw?.chart_type || '').toLowerCase()
  const expandableStrategies = new Set(['replace_fullwidth_content', 'title_top_canvas', 'title_only_shell', 'synthetic'])
  if (component.kind !== 'chart'
    || CIRCULAR_CHART_TYPES.has(chartType)
    || placement?.chart_canvas_full
    || !expandableStrategies.has(placement?.match_strategy)
    || !placement?.geometry_norm) return placement

  const geometry = placement.geometry_norm
  const legacyRegionHeight = (geometry.height || 0) / 0.82
  const legacyRegionWidth = (geometry.width || 0) / 0.94
  if (!legacyRegionHeight || !legacyRegionWidth) return placement

  const y = Math.max(0, (geometry.y || 0) - legacyRegionHeight * 0.04)
  const x = Math.max(0, (geometry.x || 0) - legacyRegionWidth * 0.03)
  const width = Math.min(1 - x, legacyRegionWidth)
  const height = Math.min(SHELL_BOTTOM - y, legacyRegionHeight)
  const size = reportDefaultSize(report)
  return {
    ...placement,
    geometry_norm: { x, y, width, height },
    geometry_pt: {
      x_pt: x * size.width,
      y_pt: y * size.height,
      width_pt: width * size.width,
      height_pt: height * size.height,
    },
  }
}

function resolveBaselinePreviewClient(report, component) {
  const kind = component.kind
  const replaced = findReplaceableGraphicSlide(report, component, kind)
  if (replaced) return replaced
  const fullwidth = findReplaceableFullwidthContent(report, component, kind)
  if (fullwidth) return fullwidth
  const split = findReplaceableSplitGraphic(report, component, kind)
  if (split) return split
  const canvas = findTitleTopCanvas(report, component, kind)
  if (canvas) return canvas
  const shelled = findTitleOnlyShell(report, component, kind)
  if (shelled) return shelled
  return syntheticPreview(report, component, kind)
}

function slideList(report) {
  return report?.slides?.slides || []
}

function shellTemplates(report) {
  return report?.slide_semantics?.shell_templates || []
}

function reportDefaultSize(report) {
  const size = report?.typography?.visibility?.slide_size_pt
  return { width: size?.width || 960, height: size?.height || 540 }
}

function isTitleElement(element) {
  if (element?.kind !== 'text') return false
  const y = element.geometry_norm?.y ?? 1
  if (y >= TITLE_ZONE_MAX_Y) return false
  const role = String(element.text_role || element.role || element.name || '').toLowerCase()
  if (role === 'title' || role === 'ctrtitle') return true
  return y < 0.16
}

function replaceGraphicScore(slide, kind, graphicCount) {
  const elements = slide.content_elements || []
  const titleElements = elements.filter(isTitleElement)
  const otherText = elements.filter((element) => (
    element.kind === 'text'
    && !isTitleElement(element)
    && !element.component_ref
  ))
  const otherGraphics = elements.filter((element) => (
    GRAPHIC_KINDS.has(element.kind) && element.kind !== kind
  ))
  let score = 0
  if (titleElements.length) score += 40
  score += graphicCount === 1 ? 35 : -(graphicCount - 1) * 12
  score -= otherText.length * 6
  score -= otherGraphics.length * 8
  score -= (slide.component_instances || []).length * 4
  return score
}

function findReplaceableGraphicSlide(report, component, kind) {
  const candidates = []
  for (const slide of slideList(report)) {
    const graphics = (slide.content_elements || []).filter((element) => element.kind === kind)
    if (!graphics.length) continue
    graphics.sort((left, right) => (
      ((right.geometry_norm?.width || 0) * (right.geometry_norm?.height || 0))
      - ((left.geometry_norm?.width || 0) * (left.geometry_norm?.height || 0))
    ))
    const element = graphics[0]
    candidates.push({
      score: replaceGraphicScore(slide, kind, graphics.length),
      slide,
      element,
    })
  }
  if (!candidates.length) return null
  candidates.sort((left, right) => right.score - left.score || left.slide.slide_number - right.slide.slide_number)
  const best = candidates[0]
  return {
    match_strategy: 'replace_graphic',
    slide_number: best.slide.slide_number,
    layout_source: best.slide.layout_source,
    layout_name: best.slide.layout_name,
    shell_id: shellTemplates(report).find((shell) => shell.layout_source === best.slide.layout_source)?.shell_id || null,
    geometry_norm: { ...(best.element.geometry_norm || {}) },
    geometry_pt: { ...(best.element.geometry_pt || {}) },
    replaced_element_id: best.element.element_id,
    score: best.score,
  }
}

function finiteBox(box) {
  if (!box) return null
  const x = Number(box.x)
  const y = Number(box.y)
  const width = Number(box.width)
  const height = Number(box.height)
  if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0) return null
  return { x, y, width, height }
}

function elementBox(element) {
  const geometry = element?.geometry_norm || {}
  return {
    x: geometry.x || 0,
    y: geometry.y || 0,
    width: geometry.width || 0,
    height: geometry.height || 0,
  }
}

function boxArea(box) {
  return Math.max(0, box.width || 0) * Math.max(0, box.height || 0)
}

function isTopTitle(element) {
  if (element?.kind !== 'text' || element.component_ref) return false
  const box = elementBox(element)
  const role = String(element.text_role || element.role || element.name || '').toLowerCase()
  if ((role === 'title' || role === 'ctrtitle') && box.y < TITLE_ZONE_MAX_Y) return true
  return box.y < TITLE_TOP_MAX_Y && box.width >= TITLE_TOP_MIN_WIDTH
}

function pickTopTitle(elements) {
  const candidates = (elements || []).filter(isTopTitle)
  if (!candidates.length) return null
  return candidates.sort((left, right) => (
    boxArea(elementBox(right)) - boxArea(elementBox(left))
    || (elementBox(left).y - elementBox(right).y)
  ))[0]
}

function countNonTitleText(slide) {
  return (slide.content_elements || []).filter((element) => (
    element.kind === 'text'
    && !isTitleElement(element)
    && !element.component_ref
  )).length
}

function isFullwidthContent(element, titleBox) {
  const box = elementBox(element)
  if (box.width < FULLWIDTH_CONTENT_MIN || box.height < FULLWIDTH_CONTENT_MIN_HEIGHT) return false
  const titleBottom = titleBox.y + titleBox.height
  return box.y >= titleBottom - 0.05
}

function fitGeometryBox(box, kind, slide) {
  const size = slide?.render?.slide_size_pt || { width: 960, height: 540 }
  const padX = kind === 'chart' ? 0 : box.width * 0.02
  const padY = kind === 'chart' ? 0 : box.height * 0.03
  const fitted = {
    x: box.x + padX,
    y: box.y + padY,
    width: Math.max(0.08, box.width - padX * 2),
    height: Math.max(0.08, box.height - padY * 2),
  }
  if (kind === 'table') fitted.height = Math.min(fitted.height, box.height * 0.96)
  return {
    norm: fitted,
    pt: {
      x_pt: fitted.x * size.width,
      y_pt: fitted.y * size.height,
      width_pt: fitted.width * size.width,
      height_pt: fitted.height * size.height,
    },
  }
}

function buildReplaceContentPreview(slide, element, strategy, score, kind) {
  const geometry = fitGeometryBox(elementBox(element), kind, slide)
  return {
    match_strategy: strategy,
    slide_number: slide.slide_number,
    layout_source: slide.layout_source,
    layout_name: slide.layout_name,
    shell_id: null,
    geometry_norm: geometry.norm,
    geometry_pt: geometry.pt,
    replaced_element_id: element.element_id,
    replaced_element_kind: element.kind,
    score,
  }
}

function findReplaceableFullwidthContent(report, component, kind) {
  const candidates = []
  for (const slide of slideList(report)) {
    const elements = slide.content_elements || []
    const title = pickTopTitle(elements)
    if (!title) continue
    const titleBox = elementBox(title)
    const removable = elements.filter((element) => (
      REMOVABLE_CONTENT_KINDS.has(element.kind)
      && !element.component_ref
      && isFullwidthContent(element, titleBox)
    ))
    if (!removable.length) continue
    removable.sort((left, right) => boxArea(elementBox(right)) - boxArea(elementBox(left)))
    const element = removable[0]
    let score = boxArea(elementBox(element)) * 120
    score += titleBox.width >= 0.7 ? 35 : 20
    if (element.kind === 'table' || element.kind === 'chart') score += 8
    score -= Math.max(0, removable.length - 1) * 6
    score -= countNonTitleText(slide) * 10
    candidates.push({ score, slide, element })
  }
  if (!candidates.length) return null
  candidates.sort((left, right) => right.score - left.score || left.slide.slide_number - right.slide.slide_number)
  const best = candidates[0]
  const preview = buildReplaceContentPreview(best.slide, best.element, 'replace_fullwidth_content', best.score, kind)
  preview.shell_id = shellTemplates(report).find((shell) => shell.layout_source === best.slide.layout_source)?.shell_id || null
  return preview
}

function splitSide(element) {
  const box = elementBox(element)
  if (box.width > SPLIT_MAX_WIDTH || box.width < SPLIT_SIDE_MIN_WIDTH) return null
  if (box.height < SPLIT_SIDE_MIN_HEIGHT) return null
  const centerX = box.x + box.width / 2
  if (centerX <= SPLIT_LEFT_MAX_CENTER) return 'left'
  if (centerX >= SPLIT_RIGHT_MIN_CENTER) return 'right'
  return null
}

function splitHasOppositeText(elements, graphic, side, title) {
  const graphicBox = elementBox(graphic)
  const titleId = title?.element_id
  for (const element of elements) {
    if (element.kind !== 'text' || element.component_ref) continue
    if (element.element_id === titleId) continue
    if (title && isTopTitle(element)) continue
    const box = elementBox(element)
    const centerX = box.x + box.width / 2
    if (side === 'left' && centerX >= SPLIT_RIGHT_MIN_CENTER) return true
    if (side === 'right' && centerX <= SPLIT_LEFT_MAX_CENTER) return true
  }
  return graphicBox.width >= SPLIT_SIDE_MIN_WIDTH && countNonTitleText({ content_elements: elements }) > 0
}

function findReplaceableSplitGraphic(report, component, kind) {
  const candidates = []
  for (const slide of slideList(report)) {
    const elements = slide.content_elements || []
    const title = pickTopTitle(elements)
    for (const element of elements) {
      if (!REMOVABLE_CONTENT_KINDS.has(element.kind) || element.component_ref) continue
      const side = splitSide(element)
      if (!side) continue
      if (isFullwidthContent(element, elementBox(title || { y: 0, height: 0 }))) continue
      if (!splitHasOppositeText(elements, element, side, title)) continue
      let score = boxArea(elementBox(element)) * 90
      if (title) score += 25
      score += 15
      score -= countNonTitleText(slide) * 8
      candidates.push({ score, slide, element, side })
    }
  }
  if (!candidates.length) return null
  candidates.sort((left, right) => right.score - left.score || left.slide.slide_number - right.slide.slide_number)
  const best = candidates[0]
  const preview = buildReplaceContentPreview(best.slide, best.element, 'replace_split_graphic', best.score, kind)
  preview.shell_id = shellTemplates(report).find((shell) => shell.layout_source === best.slide.layout_source)?.shell_id || null
  preview.split_side = best.side
  return preview
}

function canvasBelowTopTitle(titleBox) {
  const y = Math.min(SHELL_BOTTOM - 0.08, titleBox.y + titleBox.height + CONTENT_REGION_MARGIN)
  if (titleBox.width >= 0.6) {
    return {
      x: CANVAS_SIDE_MARGIN,
      y,
      width: CANVAS_FULL_WIDTH,
      height: Math.max(0.08, SHELL_BOTTOM - y),
    }
  }
  return {
    x: Math.max(CANVAS_SIDE_MARGIN, titleBox.x),
    y,
    width: Math.min(CANVAS_FULL_WIDTH, Math.max(titleBox.width, 0.72)),
    height: Math.max(0.08, SHELL_BOTTOM - y),
  }
}

function blocksTitleCanvas(element, titleBox) {
  if (element.kind === 'text' && isTopTitle(element)) return false
  const box = elementBox(element)
  const canvasTop = titleBox.y + titleBox.height + CONTENT_REGION_MARGIN
  if (box.y + box.height <= canvasTop + 0.01) return boxArea(box) >= 0.02
  return true
}

function findTitleTopCanvas(report, component, kind) {
  const candidates = []
  for (const slide of slideList(report)) {
    const elements = slide.content_elements || []
    const title = pickTopTitle(elements)
    if (!title) continue
    const titleBox = elementBox(title)
    const blocking = elements.filter((element) => (
      !element.component_ref
      && element.element_id !== title.element_id
      && blocksTitleCanvas(element, titleBox)
    ))
    if (blocking.some((element) => (
      REMOVABLE_CONTENT_KINDS.has(element.kind) && isFullwidthContent(element, titleBox)
    ))) continue
    const canvas = canvasBelowTopTitle(titleBox)
    if (canvas.height < 0.28 || canvas.width < 0.55) continue
    let score = boxArea(canvas) * 100
    score += titleBox.width >= 0.7 ? 30 : 15
    blocking.forEach((element) => {
      const area = boxArea(elementBox(element))
      if (area < 0.02) score -= 2
      else if (element.kind === 'text') score -= 12
      else score -= 8
    })
    candidates.push({
      score,
      slide,
      canvas,
      geometry: fitGeometryInRegion(canvas, kind, slide),
    })
  }
  if (!candidates.length) return null
  candidates.sort((left, right) => right.score - left.score || left.slide.slide_number - right.slide.slide_number)
  const best = candidates[0]
  return {
    match_strategy: 'title_top_canvas',
    slide_number: best.slide.slide_number,
    layout_source: best.slide.layout_source,
    layout_name: best.slide.layout_name,
    shell_id: shellTemplates(report).find((shell) => shell.layout_source === best.slide.layout_source)?.shell_id || null,
    content_region: best.canvas,
    geometry_norm: best.geometry.norm,
    geometry_pt: best.geometry.pt,
    score: best.score,
  }
}

function titleOnlyShellScore(previewSlide, shell) {
  let score = shell.slide_count || 0
  const region = shell.content_region || {}
  score += (region.width || 0) * 20
  score += (region.height || 0) * 15
  if ((region.width || 0) < 0.72) score -= 40
  if ((region.height || 0) < 0.38) score -= 35
  if ((region.y || 0) > 0.42) score -= 30
  const residual = (previewSlide.content_elements || []).filter((element) => (
    !isTitleElement(element) && !element.component_ref
  ))
  if (!residual.length) score += 55
  else {
    score -= residual.length * 10
    if (residual.some((element) => GRAPHIC_KINDS.has(element.kind))) score -= 25
  }
  if (pickTopTitle(previewSlide.content_elements || [])) score += 18
  else score -= 50
  return score
}

function fitGeometryInRegion(region, kind, slide) {
  const size = slide?.render?.slide_size_pt || { width: 960, height: 540 }
  const padX = kind === 'chart' ? 0 : region.width * 0.03
  const padY = kind === 'chart' ? 0 : region.height * 0.04
  const box = {
    x: region.x + padX,
    y: region.y + padY,
    width: Math.max(0.08, region.width - padX * 2),
    height: Math.max(0.08, region.height - padY * 2),
  }
  if (kind === 'table') box.height = Math.min(box.height, region.height * 0.78)
  return {
    norm: box,
    pt: {
      x_pt: box.x * size.width,
      y_pt: box.y * size.height,
      width_pt: box.width * size.width,
      height_pt: box.height * size.height,
    },
  }
}

function findTitleOnlyShell(report, component, kind) {
  const slides = slideList(report)
  const slideMap = new Map(slides.map((slide) => [slide.slide_number, slide]))
  const candidates = []

  for (const shell of shellTemplates(report)) {
    const previewSlide = slideMap.get(shell.preview_slide)
    if (!previewSlide || !shell.content_region?.width) continue
    candidates.push({
      score: titleOnlyShellScore(previewSlide, shell),
      shell,
      previewSlide,
      geometry: fitGeometryInRegion(shell.content_region, kind, previewSlide),
    })
  }

  if (!candidates.length) return null
  candidates.sort((left, right) => (
    right.score - left.score
    || (right.shell.slide_count || 0) - (left.shell.slide_count || 0)
    || left.previewSlide.slide_number - right.previewSlide.slide_number
  ))
  const best = candidates[0]
  return {
    match_strategy: 'title_only_shell',
    slide_number: best.previewSlide.slide_number,
    layout_source: best.shell.layout_source,
    layout_name: best.shell.layout_name || best.previewSlide.layout_name,
    shell_id: best.shell.shell_id,
    content_region: best.shell.content_region,
    geometry_norm: best.geometry.norm,
    geometry_pt: best.geometry.pt,
    score: best.score,
  }
}

function syntheticPreview(report, component, kind) {
  const size = reportDefaultSize(report)
  const widthPt = size.width * 0.62
  const heightPt = size.height * (kind === 'table' ? 0.42 : 0.48)
  const xPt = (size.width - widthPt) / 2
  const yPt = (size.height - heightPt) / 2
  return {
    match_strategy: 'synthetic',
    slide_number: null,
    layout_source: null,
    layout_name: null,
    shell_id: null,
    geometry_norm: {
      x: xPt / size.width,
      y: yPt / size.height,
      width: widthPt / size.width,
      height: heightPt / size.height,
    },
    geometry_pt: {
      x_pt: xPt,
      y_pt: yPt,
      width_pt: widthPt,
      height_pt: heightPt,
    },
    score: 0,
  }
}

function applyPlacementGeometry(element, placement) {
  const next = { ...element }
  if (placement?.geometry_pt) next.geometry_pt = { ...placement.geometry_pt }
  if (placement?.geometry_norm) next.geometry_norm = { ...placement.geometry_norm }
  return next
}

function keepsReplaceCanvasElement(element, placement, elements) {
  if (element.component_ref) return false
  if (element.element_id === placement.replaced_element_id) return false

  if (placement.match_strategy === 'replace_split_graphic') {
    if (isTopTitle(element) || isTitleElement(element)) return true
    if (element.kind !== 'text') return false
    const replaced = elements.find((item) => item.element_id === placement.replaced_element_id)
    if (!replaced) return false
    const centerX = elementBox(element).x + elementBox(element).width / 2
    if (placement.split_side === 'left' && centerX >= SPLIT_RIGHT_MIN_CENTER) return true
    if (placement.split_side === 'right' && centerX <= SPLIT_LEFT_MAX_CENTER) return true
    return false
  }

  if (element.kind === 'text') {
    return isTopTitle(element) || isTitleElement(element)
  }
  return false
}

export function filterShellContentElements(sourceSlide, report, component, placement) {
  const elements = sourceSlide.content_elements || []

  if (placement.geometry_source === 'spatial_heatmap' && component.kind === 'chart') {
    return elements.filter((element) => isTitleElement(element))
  }

  if (placement.match_strategy === 'circular_chart_example') {
    return elements.filter((element) => isTitleElement(element))
  }

  if (placement.match_strategy === 'replace_graphic'
    || placement.match_strategy === 'replace_fullwidth_content'
    || placement.match_strategy === 'replace_split_graphic') {
    return elements.filter((element) => keepsReplaceCanvasElement(element, placement, elements))
  }

  if (placement.match_strategy === 'title_top_canvas') {
    return elements.filter((element) => isTopTitle(element))
  }

  const titleOnly = buildShellSlide(sourceSlide, report, { titleOnly: true })
  return titleOnly?.content_elements || elements.filter((element) => isTitleElement(element))
}

export function buildBaselinePreviewSlide(report, component, { modelData = null, placement = null } = {}) {
  const resolvedPlacement = placement || resolveBaselinePreviewPlacement(report, component)
  let element = buildBaselineGraphicElement(report, component)
  element = applyPlacementGeometry(element, resolvedPlacement)
  if (resolvedPlacement.plot_region_norm) {
    element.baseline_preview = {
      plot_region_norm: resolvedPlacement.plot_region_norm,
      legend_region_norm: resolvedPlacement.legend_region_norm || null,
    }
  }

  if (modelData) {
    const applied = applyModelDataToComponent(component, modelData, { report, baseElement: element })
    if (applied.ok && applied.element) element = applied.element
  }

  if (resolvedPlacement.match_strategy === 'synthetic' || !resolvedPlacement.slide_number) {
    const slideSizePt = reportDefaultSize(report)
    const tokensBackground = report?.theme?.colors?.lt1 || '#FFFFFF'
    return {
      slide_number: 0,
      layout_source: null,
      render: {
        slide_size_pt: slideSizePt,
        background_color: tokensBackground,
        layers: [],
      },
      content_elements: [element],
      baselinePreview: true,
      baselinePreviewMeta: resolvedPlacement,
    }
  }

  const sourceSlide = findSlide(report, resolvedPlacement.slide_number)
  if (!sourceSlide) {
    return buildBaselinePreviewSlide(report, component, {
      modelData,
      placement: syntheticPreview(report, component, component.kind),
    })
  }

  const shellElements = filterShellContentElements(sourceSlide, report, component, resolvedPlacement)
  const slide = JSON.parse(JSON.stringify(sourceSlide))
  slide.content_elements = [...shellElements, element]
  slide.baselinePreview = true
  slide.baselinePreviewMeta = resolvedPlacement
  return slide
}

export function baselinePreviewLabel(placement) {
  if (!placement) return 'synthetic preview'
  if (placement.match_strategy === 'circular_chart_example') {
    return `shell: circular chart · ${placement.layout_name || placement.layout_source || 'slide'} · slide ${placement.slide_number}`
  }
  if (placement.match_strategy === 'replace_graphic') {
    return `shell: замена ${placement.layout_name || placement.layout_source || 'graphic'} · slide ${placement.slide_number}`
  }
  if (placement.match_strategy === 'replace_fullwidth_content') {
    return `shell: full-width ${placement.replaced_element_kind || 'content'} · ${placement.layout_name || placement.layout_source || 'slide'} · slide ${placement.slide_number}`
  }
  if (placement.match_strategy === 'replace_split_graphic') {
    return `shell: split ${placement.split_side || 'side'} · ${placement.layout_name || placement.layout_source || 'slide'} · slide ${placement.slide_number}`
  }
  if (placement.match_strategy === 'title_top_canvas') {
    return `shell: title top canvas · ${placement.layout_name || placement.layout_source || 'slide'} · slide ${placement.slide_number}`
  }
  if (placement.match_strategy === 'title_only_shell') {
    return `shell: ${placement.layout_name || placement.layout_source || placement.shell_id} · title-only · slide ${placement.slide_number}`
  }
  return 'synthetic preview · без подходящего shell'
}
