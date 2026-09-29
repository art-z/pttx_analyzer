import { findSlideTitleElements } from './slide-title-detect.js'
import { detectSlideVgroups } from './vgroup-detect.js'

export const DESCRIPTION_ZONE_MIN_Y = 0.1
export const DESCRIPTION_ZONE_MAX_Y = 0.78
export const DESCRIPTION_MIN_WIDTH_NORM = 0.42
export const DESCRIPTION_MIN_CHARS = 20
export const DESCRIPTION_INTRO_MAX_Y = 0.62
export const DESCRIPTION_NEAR_TITLE_GAP = 0.15
export const DESCRIPTION_FOOTER_ZONE_MIN_Y = 0.58
export const DESCRIPTION_MEDIA_ROW_MIN_Y = 0.5

function normalizeRole(element) {
  return String(element?.text_role || element?.role || element?.name || '').toLowerCase()
}

function elementText(element) {
  return String(element?.text || element?.text_sample || '').trim()
}

function lineCount(element, spatialInstance = null) {
  if (element?.text_paragraphs?.length) return element.text_paragraphs.length
  if (spatialInstance?.line_count) return spatialInstance.line_count
  const text = elementText(element)
  return text ? text.split(/\n+/).filter(Boolean).length : 0
}

function spatialTextRegions(report, slideNumber) {
  const component = report?.typography?.spatial?.components
    ?.find((item) => item.id === 'text_regions')
  return (component?.instances || []).filter((item) => item.slide_number === slideNumber)
}

function spatialTitleInstance(report, slideNumber) {
  const component = report?.typography?.spatial?.components
    ?.find((item) => item.id === 'slide_title')
  return component?.instances?.find((item) => item.slide_number === slideNumber) || null
}

function matchesSpatialRegion(element, spatialRegions) {
  if (!element?.shape_id) return null
  return spatialRegions.find((item) => String(item.shape_id) === String(element.shape_id)) || null
}

function titleBottomNorm(titleResult, spatialTitle) {
  if (titleResult?.primary?.geometry_norm) {
    const box = titleResult.primary.geometry_norm
    return (box.y || 0) + (box.height || 0)
  }
  if (spatialTitle) {
    return (spatialTitle.y_norm || 0) + (spatialTitle.height_norm || 0)
  }
  return 0.18
}

function isExcludedComponentRef(element) {
  const ref = element?.component_ref
  if (!ref) return false
  const width = element.geometry_norm?.width || 0
  if (ref.layout === 'single' && width >= DESCRIPTION_MIN_WIDTH_NORM) return false
  return true
}

function collectMediaRowTextIds(slide, report) {
  const { groups } = detectSlideVgroups(slide, { report })
  const excluded = new Set()

  for (const group of groups) {
    if (group.layout !== 'row' || !group.flex) continue
    const hasImage = (group.kindCounts?.image || 0) > 0
    if (!hasImage) continue

    const groupTop = group.bboxNorm?.y ?? 0
    if (groupTop < DESCRIPTION_MEDIA_ROW_MIN_Y) continue

    for (const element of group.elements || []) {
      if (element?.kind === 'text' && element.element_id) {
        excluded.add(element.element_id)
      }
    }
  }

  return excluded
}

function introZoneMaxY(titleBottom) {
  return Math.min(titleBottom + DESCRIPTION_NEAR_TITLE_GAP, DESCRIPTION_INTRO_MAX_Y)
}

function scoreDescriptionCandidate(element, spatial, { titleBottom, titleIds, mediaRowTextIds, excludedElementIds }) {
  if (element?.kind !== 'text') return null
  if (titleIds.has(element.element_id)) return null
  if (excludedElementIds?.has(element.element_id)) return null
  if (mediaRowTextIds?.has(element.element_id)) return null
  if (isExcludedComponentRef(element)) return null

  const text = elementText(element)
  const charCount = text.length
  const lines = lineCount(element, spatial)
  const y = element.geometry_norm?.y ?? 1
  const width = element.geometry_norm?.width ?? 0
  const role = normalizeRole(element)
  const method = spatial?.detection_method || null

  if (charCount < DESCRIPTION_MIN_CHARS && lines < 2) return null
  if (y < DESCRIPTION_ZONE_MIN_Y || y > DESCRIPTION_ZONE_MAX_Y) return null
  if (y < titleBottom - 0.03) return null

  const introMaxY = introZoneMaxY(titleBottom)
  const isParagraph = method === 'paragraph_heuristic'
  if (!isParagraph && y >= DESCRIPTION_FOOTER_ZONE_MIN_Y) return null
  if (method === 'body_placeholder' && !isParagraph && y > introMaxY && y > titleBottom + 0.22) {
    return null
  }

  let score = 0
  const reasons = []

  if (spatial) {
    score += 28
    reasons.push('spatial:text_regions')
  }
  if (isParagraph) {
    score += 36
    reasons.push('paragraph')
  } else if (method === 'body_placeholder') {
    score += 30
    reasons.push('body_placeholder')
  } else if (method === 'body_scale') {
    score += 18
    reasons.push('body_scale')
  }

  if (width >= DESCRIPTION_MIN_WIDTH_NORM) {
    score += 22
    reasons.push(`width:${Math.round(width * 100)}%`)
  } else if (width < 0.24 && charCount < 40) {
    return null
  }

  if (charCount >= 40 && charCount <= 800) {
    score += 14
    reasons.push(`chars:${charCount}`)
  }
  if (lines >= 2) {
    score += 12
    reasons.push(`lines:${lines}`)
  }
  if (['subtitle', 'body', 'content', 'obj', 'description'].includes(role)) {
    score += 16
    reasons.push(`role:${role}`)
  }
  if (y <= introMaxY) {
    score += 10
    reasons.push('near_title')
  }

  if (score < 40) return null

  return {
    element,
    spatial,
    score,
    reasons,
    method: method || 'content_elements',
    charCount,
    lineCount: lines,
    text,
  }
}

function collectGroupElements(candidates, primary) {
  const groupId = primary.element.text_group_id
  if (!groupId) return [primary.element]

  const grouped = candidates
    .filter((item) => item.element.text_group_id === groupId)
    .map((item) => item.element)

  return grouped.length ? grouped : [primary.element]
}

export function findSlideDescriptionElements(slide, report, options = {}) {
  const titleResult = findSlideTitleElements(slide, report)
  const titleIds = new Set(titleResult.elementIds || [])
  const excludedElementIds = new Set(options.excludedElementIds || [])
  const spatialTitle = spatialTitleInstance(report, slide.slide_number)
  const titleBottom = titleBottomNorm(titleResult, spatialTitle)
  const spatialRegions = spatialTextRegions(report, slide.slide_number)
  const mediaRowTextIds = collectMediaRowTextIds(slide, report)

  const candidates = (slide.content_elements || [])
    .map((element) => scoreDescriptionCandidate(element, matchesSpatialRegion(element, spatialRegions), {
      titleBottom,
      titleIds,
      mediaRowTextIds,
      excludedElementIds,
    }))
    .filter(Boolean)
    .sort((left, right) => right.score - left.score || right.charCount - left.charCount)

  const primaryCandidate = candidates[0]
  if (!primaryCandidate) {
    return {
      primary: null,
      elements: [],
      elementIds: [],
      method: 'none',
      score: 0,
      reasons: [],
    }
  }

  const elements = collectGroupElements(candidates, primaryCandidate)

  return {
    primary: elements[0],
    elements,
    elementIds: elements.map((element) => element.element_id),
    method: primaryCandidate.method,
    score: primaryCandidate.score,
    reasons: primaryCandidate.reasons,
    spatial: primaryCandidate.spatial,
  }
}
