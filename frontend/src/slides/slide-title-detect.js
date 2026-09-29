export const TITLE_ZONE_MAX_Y = 0.22
export const TITLE_TOP_MAX_Y = 0.18
export const TITLE_TOP_MIN_WIDTH = 0.45
const MIN_TITLE_SCORE = 45

function normalizeRole(element) {
  return String(element.text_role || element.role || element.name || '').toLowerCase()
}

function boxFromNorm(geometry = {}) {
  return {
    x: geometry.x || 0,
    y: geometry.y || 0,
    width: geometry.width || 0,
    height: geometry.height || 0,
  }
}

function boxFromPt(geometry = {}) {
  return {
    x: geometry.x_pt || 0,
    y: geometry.y_pt || 0,
    width: geometry.width_pt || 0,
    height: geometry.height_pt || 0,
  }
}

function overlapRatio(left, right) {
  const xOverlap = Math.max(0, Math.min(left.x + left.width, right.x + right.width) - Math.max(left.x, right.x))
  const yOverlap = Math.max(0, Math.min(left.y + left.height, right.y + right.height) - Math.max(left.y, right.y))
  const intersection = xOverlap * yOverlap
  if (!intersection) return 0
  const leftArea = Math.max(left.width * left.height, 0.000001)
  const rightArea = Math.max(right.width * right.height, 0.000001)
  return intersection / Math.min(leftArea, rightArea)
}

function findSpatialTitleForSlide(slide, report) {
  const component = report?.typography?.spatial?.components
    ?.find((item) => item.id === 'slide_title')
  if (!component) return null
  return component.instances?.find((item) => item.slide_number === slide.slide_number) || null
}

function findTitleSizePt(report) {
  const component = report?.typography?.spatial?.components
    ?.find((item) => item.id === 'slide_title')
  const fromSpatial = component?.typography?.dominant_size_pt
    || component?.detection?.title_scale_levels?.[0]?.size_pt
  if (fromSpatial) return fromSpatial

  const titleLevel = (report?.typography?.type_scale || [])
    .flatMap((scale) => scale.levels || [])
    .find((level) => level.role_hint === 'slide_title' || (level.slide_title_probability || 0) >= 0.5)
  return titleLevel?.size_pt || 28
}

function matchesSpatialTitle(element, spatialTitle) {
  if (!spatialTitle) return false
  if (element.shape_id != null && spatialTitle.shape_id != null) {
    return String(element.shape_id) === String(spatialTitle.shape_id)
  }

  const elementPt = element.geometry_pt ? boxFromPt(element.geometry_pt) : null
  const spatialPt = {
    x: spatialTitle.x_pt || 0,
    y: spatialTitle.y_pt || 0,
    width: spatialTitle.width_pt || 0,
    height: spatialTitle.height_pt || 0,
  }
  if (elementPt && spatialPt.width && spatialPt.height) {
    if (overlapRatio(elementPt, spatialPt) >= 0.45) return true
  }

  const elementNorm = boxFromNorm(element.geometry_norm)
  const spatialNorm = boxFromNorm({
    x: spatialTitle.x_norm,
    y: spatialTitle.y_norm,
    width: spatialTitle.width_norm,
    height: spatialTitle.height_norm,
  })
  return spatialNorm.width > 0 && overlapRatio(elementNorm, spatialNorm) >= 0.45
}

function titleDetectionMethod(element, spatialTitle) {
  if (matchesSpatialTitle(element, spatialTitle)) return 'spatial'
  const placeholder = element.placeholder_type
  if (placeholder === 'title' || placeholder === 'ctrTitle') return 'placeholder'
  const role = normalizeRole(element)
  if (role === 'title' || role === 'ctrtitle') return 'role'
  if (element.component_ref?.component_id === 'slide_title') return 'component_ref'
  return 'heuristic'
}

export function scoreSlideTitleCandidate(element, slide, context = {}) {
  if (element?.kind !== 'text') return -Infinity

  let score = 0
  const geometry = boxFromNorm(element.geometry_norm)
  const placeholder = element.placeholder_type

  if (placeholder === 'title' || placeholder === 'ctrTitle') score += 100
  if (placeholder === 'subTitle') score -= 50

  const role = normalizeRole(element)
  if (role === 'title' || role === 'ctrtitle') score += 90
  if (role === 'subtitle') score -= 40

  if (element.component_ref?.component_id === 'slide_title') score += 95

  const spatialTitle = context.spatialTitle
  if (matchesSpatialTitle(element, spatialTitle)) score += 120

  if (geometry.y < TITLE_ZONE_MAX_Y) score += 28
  if (geometry.y < TITLE_TOP_MAX_Y && geometry.width >= TITLE_TOP_MIN_WIDTH) score += 24

  const sizePt = element.typography?.size_pt || 0
  const titleSizePt = context.titleSizePt || 28
  if (sizePt >= titleSizePt * 0.65) score += 18
  if (sizePt >= titleSizePt * 0.9) score += 12

  score -= geometry.y * 12
  score += Math.min(geometry.width, 1) * 8

  const text = element.text || element.text_sample || ''
  if (text.length > 140) score -= 35
  if ((element.text_paragraphs?.length || 1) > 3) score -= 25

  if (slide?.layout_name && /title/i.test(slide.layout_name) && geometry.y < 0.35) {
    score += 8
  }

  return score
}

export function findSlideTitleElements(slide, report = null, contentElements = null) {
  const elements = contentElements || slide?.content_elements || []
  const textElements = elements.filter((element) => element.kind === 'text')
  const spatialTitle = findSpatialTitleForSlide(slide, report)
  const titleSizePt = findTitleSizePt(report)
  const context = { spatialTitle, titleSizePt }

  let best = null
  let bestScore = -Infinity
  for (const element of textElements) {
    const score = scoreSlideTitleCandidate(element, slide, context)
    if (score > bestScore) {
      bestScore = score
      best = element
    }
  }

  if (!best || bestScore < MIN_TITLE_SCORE) {
    return {
      elementIds: new Set(),
      elements: [],
      primary: null,
      method: 'none',
      score: bestScore,
    }
  }

  const matched = [best]
  if (best.text_group_id) {
    for (const element of elements) {
      if (element.text_group_id === best.text_group_id && element !== best) {
        matched.push(element)
      }
    }
  }

  const elementIds = new Set(
    matched.map((element) => element.element_id).filter(Boolean),
  )

  return {
    elementIds,
    elements: matched,
    primary: best,
    method: titleDetectionMethod(best, spatialTitle),
    score: bestScore,
  }
}

export function isSlideTitleElement(element, titleElementIds) {
  return Boolean(element?.element_id && titleElementIds?.has(element.element_id))
}
