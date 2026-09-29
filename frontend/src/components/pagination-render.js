import { findSlide } from './catalog.js'
import { resolvePaginationColor, resolvePaginatorPlacementForInstance } from './pagination-catalog.js'

const MAX_DOTS = 20

function cloneSlide(slide) {
  return JSON.parse(JSON.stringify(slide))
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value))
}

function buildDotElementFromCatalog(element, dot, fillColor, strokeColor, slideWidth, slideHeight, elementId, zIndex = 12) {
  const widthPt = dot.width_pt || element.geometry_pt?.width_pt || 12
  const heightPt = dot.height_pt || element.geometry_pt?.height_pt || 12
  return buildDotElement({
    elementId,
    dot: {
      x_pt: dot.x_pt,
      y_pt: dot.y_pt,
      width_pt: widthPt,
      height_pt: heightPt,
      preset: element.mask?.kind === 'ellipse' ? 'ellipse' : 'rect',
    },
    fillColor,
    strokeColor,
    slideWidth,
    slideHeight,
    zIndex,
  })
}

function buildDotElement({
  elementId,
  dot,
  fillColor,
  strokeColor,
  slideWidth,
  slideHeight,
  zIndex = 12,
}) {
  const widthPt = dot.width_pt
  const heightPt = dot.height_pt
  return {
    element_id: elementId,
    kind: 'fill',
    name: elementId,
    geometry_pt: {
      x_pt: dot.x_pt,
      y_pt: dot.y_pt,
      width_pt: widthPt,
      height_pt: heightPt,
    },
    geometry_norm: {
      x: dot.x_pt / slideWidth,
      y: dot.y_pt / slideHeight,
      width: widthPt / slideWidth,
      height: heightPt / slideHeight,
    },
    fill: {
      kind: 'solid',
      color: fillColor,
    },
    stroke: strokeColor && strokeColor !== 'none'
      ? { kind: 'solid', color: strokeColor, width_pt: 1 }
      : null,
    mask: { kind: dot.preset === 'ellipse' || dot.preset === 'circle' ? 'ellipse' : 'rect' },
    z_index: zIndex,
  }
}

function computeDotPositions({
  pageCount,
  spacingPt,
  dotWidthPt,
  dotHeightPt,
  placement,
  slideWidth,
  slideHeight,
}) {
  const stepPt = spacingPt || dotWidthPt * 1.8
  const totalWidth = dotWidthPt + Math.max(0, pageCount - 1) * stepPt

  let startX = placement.x_pt ?? ((placement.x_norm || 0) * slideWidth)
  let yPt = placement.y_pt ?? ((placement.y_norm || 0) * slideHeight)

  if (placement.anchor_mode === 'preset') {
    startX = (placement.x_norm || 0) * slideWidth
    yPt = (placement.y_norm || 0) * slideHeight
    if (placement.align === 'center') startX -= totalWidth / 2
    else if (placement.align === 'end') startX -= totalWidth
  }

  return Array.from({ length: pageCount }, (_, index) => ({
    x_pt: startX + index * stepPt,
    y_pt: yPt,
    width_pt: dotWidthPt,
    height_pt: dotHeightPt,
    preset: 'ellipse',
  }))
}

export function buildPaginatorElements(component, modelData, report, slideSizePt, instance = null) {
  const slideWidth = slideSizePt?.width || 960
  const slideHeight = slideSizePt?.height || 540
  const style = component.styleTokens || component.raw?.style_tokens || {}
  const capacity = component.capacity || component.raw?.capacity || {}
  const sourceInstance = instance || component.instances?.[0] || null
  const sampleElements = (sourceInstance?.element_ids || [])
    .map((elementId) => findSlide(report, sourceInstance.slide_number)?.content_elements
      ?.find((element) => element.element_id === elementId))
    .filter(Boolean)
  const templateElement = sampleElements[0] || null
  const templateDot = sourceInstance?.dots?.[0] || {
    width_pt: style.dot_width_pt || 12,
    height_pt: style.dot_height_pt || 12,
    preset: style.dot_preset || 'ellipse',
  }

  const pageCount = clamp(
    Number(modelData?.page_count) || capacity.dot_count_typical || 5,
    capacity.dot_count_min || 2,
    capacity.dot_count_max || MAX_DOTS,
  )
  const activeIndex = clamp(
    Number(modelData?.active_index) || 0,
    0,
    pageCount - 1,
  )
  const placement = resolvePaginatorPlacementForInstance(component, sourceInstance, modelData)
  const spacingPt = sourceInstance?.spacing_pt
    || placement?.spacing_pt
    || style.spacing_pt
    || capacity.spacing_pt
    || (sampleElements.length > 1
      ? (sampleElements[1].geometry_pt?.x_pt || 0) - (sampleElements[0].geometry_pt?.x_pt || 0)
      : templateDot.width_pt * 1.8)
  const dotWidthPt = templateElement?.geometry_pt?.width_pt || templateDot.width_pt
  const dotHeightPt = templateElement?.geometry_pt?.height_pt || templateDot.height_pt
  const positions = computeDotPositions({
    pageCount,
    spacingPt,
    dotWidthPt,
    dotHeightPt,
    placement,
    slideWidth,
    slideHeight,
  })

  const activeFill = style.active_fill || '#0077FF'
  const inactiveFill = style.inactive_fill || '#FFFFFF'
  const activeStroke = style.active_stroke && style.active_stroke !== 'none' ? style.active_stroke : null
  const inactiveStroke = style.inactive_stroke && style.inactive_stroke !== 'none' ? style.inactive_stroke : null

  return positions.map((dot, index) => {
    if (templateElement) {
      return buildDotElementFromCatalog(
        templateElement,
        dot,
        index === activeIndex ? activeFill : inactiveFill,
        index === activeIndex ? activeStroke : inactiveStroke,
        slideWidth,
        slideHeight,
        `${component.id || component.component_id}_dot_${index + 1}`,
        12 + index,
      )
    }
    return buildDotElement({
      elementId: `${component.id || component.component_id}_dot_${index + 1}`,
      dot,
      fillColor: index === activeIndex ? activeFill : inactiveFill,
      strokeColor: index === activeIndex ? activeStroke : inactiveStroke,
      slideWidth,
      slideHeight,
      zIndex: 12 + index,
    })
  })
}

export function paginatorBBox(elements) {
  if (!elements?.length) return null
  const xs = elements.map((element) => element.geometry_pt.x_pt)
  const ys = elements.map((element) => element.geometry_pt.y_pt)
  const xe = elements.map((element) => element.geometry_pt.x_pt + element.geometry_pt.width_pt)
  const ye = elements.map((element) => element.geometry_pt.y_pt + element.geometry_pt.height_pt)
  const xPt = Math.min(...xs)
  const yPt = Math.min(...ys)
  const widthPt = Math.max(...xe) - xPt
  const heightPt = Math.max(...ye) - yPt
  return {
    x_pt: xPt,
    y_pt: yPt,
    width_pt: widthPt,
    height_pt: heightPt,
  }
}

export function applyPaginatorToSlide(report, component, instance, modelData = null) {
  const slide = cloneSlide(findSlide(report, instance.slide_number))
  if (!slide) return null

  const slideSizePt = slide.render?.slide_size_pt || report?.slides?.summary?.slide_size_pt || { width: 960, height: 540 }
  const paginatorElementIds = new Set(instance.element_ids || [])
  slide.content_elements = (slide.content_elements || []).filter((element) => !paginatorElementIds.has(element.element_id))

  if ((component.pagination_type || component.paginationType) !== 'dot_pagination') {
    return slide
  }

  const nextElements = buildPaginatorElements(component, modelData, report, slideSizePt, instance)
  slide.content_elements = [...slide.content_elements, ...nextElements]
  return slide
}

export function buildPaginatorPreviewView(report, component, { instance = null, instanceIndex = 0, modelData = null } = {}) {
  const resolvedInstance = instance || component.instances?.[instanceIndex] || component.instances?.[0]
  if (!resolvedInstance) return { slide: null, bboxPt: null, bboxNorm: null, instance: null }

  const effectiveModel = modelData || {
    page_count: resolvedInstance.dot_count,
    active_index: resolvedInstance.active_index ?? 0,
    placement_id: resolvedInstance.placement_id
      || component.defaultPlacementId
      || component.raw?.default_placement_id,
  }

  const slide = applyPaginatorToSlide(report, component, resolvedInstance, effectiveModel)
  if (!slide) return { slide: null, bboxPt: null, bboxNorm: null, instance: null }

  const slideSizePt = slide.render?.slide_size_pt || { width: 960, height: 540 }
  const paginatorElements = (slide.content_elements || []).filter((element) => (
    String(element.element_id || '').startsWith(`${component.id}_dot_`)
  ))
  const bboxPt = paginatorBBox(paginatorElements) || resolvedInstance.container || null
  const bboxNorm = bboxPt ? {
    x: bboxPt.x_pt / slideSizePt.width,
    y: bboxPt.y_pt / slideSizePt.height,
    width: bboxPt.width_pt / slideSizePt.width,
    height: bboxPt.height_pt / slideSizePt.height,
  } : resolvedInstance.container_norm || null

  return { slide, bboxPt, bboxNorm, instance: resolvedInstance, slideSizePt }
}

export function resolvePaginatorColors(component, report) {
  const style = component.styleTokens || component.raw?.style_tokens || {}
  return {
    active: resolvePaginationColor(style.active_fill, report) || style.active_fill,
    inactive: resolvePaginationColor(style.inactive_fill, report) || style.inactive_fill,
  }
}
