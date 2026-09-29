import { findSlideDescriptionElements } from './slide-description-detect.js'
import { findSlideTitleElements } from './slide-title-detect.js'

export const MIN_IMAGE_WIDTH_NORM = 0.28
export const MIN_IMAGE_HEIGHT_NORM = 0.22
export const MIN_IMAGE_AREA_NORM = 0.08

export const IMAGE_LAYOUT_PATTERNS = {
  title_side: 'title_side',
  title_below: 'title_below',
  title_desc_side: 'title_desc_side',
  title_desc_below: 'title_desc_below',
  title_hero: 'title_hero',
  title_bg_side: 'title_bg_side',
  title_bg_below: 'title_bg_below',
  title_desc_bg_side: 'title_desc_bg_side',
  title_desc_bg_below: 'title_desc_bg_below',
}

function boxFromElement(element) {
  return element?.geometry_norm || {}
}

export function imageAreaNorm(element) {
  const box = boxFromElement(element)
  return (box.width || 0) * (box.height || 0)
}

export function isHairlineDecorationImage(element) {
  const box = boxFromElement(element)
  const width = box.width || 0
  const height = box.height || 0
  return height > 0 && height < 0.045 && width > 0.55
}

export function isBackgroundHeroImage(element) {
  if (element?.kind !== 'image') return false

  const box = boxFromElement(element)
  const width = box.width || 0
  const height = box.height || 0
  const area = width * height
  const x = box.x || 0
  const y = box.y || 0
  const right = x + width
  const bottom = y + height

  if (height >= 0.85 && width >= 0.4) return true
  if (width >= 0.85 && height >= 0.45) return true
  if (area >= 0.42 && (y <= 0.05 || x <= 0.05 || right >= 0.95 || bottom >= 0.95)) return true
  return false
}

export function isLargeHeroImageCandidate(element) {
  if (element?.kind !== 'image') return false
  if (isHairlineDecorationImage(element)) return false

  const box = boxFromElement(element)
  const width = box.width || 0
  const height = box.height || 0
  const area = width * height

  if (isBackgroundHeroImage(element)) return true
  if (width < MIN_IMAGE_WIDTH_NORM && height < MIN_IMAGE_HEIGHT_NORM) return false
  if (area < MIN_IMAGE_AREA_NORM) return false
  return true
}

function isGridOfLargeImages(images) {
  if (images.length < 3) return false
  const areas = images.map(imageAreaNorm).sort((left, right) => right - left)
  return areas[1] >= areas[0] * 0.55
}

function detectLayoutPattern(titleBox, imageBox, hasDescription, isBackground = false) {
  const titleBottom = (titleBox.y || 0) + (titleBox.height || 0)
  const imageTop = imageBox.y || 0
  const imageCenterX = (imageBox.x || 0) + (imageBox.width || 0) / 2
  const titleCenterX = (titleBox.x || 0) + (titleBox.width || 0) / 2

  const sideSplit = imageBox.width >= 0.42
    && imageBox.height >= 0.3
    && (imageCenterX > titleCenterX + 0.05 || titleBox.width <= 0.52)
  const below = imageTop >= titleBottom - 0.05

  if (isBackground) {
    if (hasDescription) {
      if (below && !sideSplit) return IMAGE_LAYOUT_PATTERNS.title_desc_bg_below
      if (sideSplit) return IMAGE_LAYOUT_PATTERNS.title_desc_bg_side
      return IMAGE_LAYOUT_PATTERNS.title_desc_bg_below
    }
    if (below && !sideSplit) return IMAGE_LAYOUT_PATTERNS.title_bg_below
    if (sideSplit) return IMAGE_LAYOUT_PATTERNS.title_bg_side
    return IMAGE_LAYOUT_PATTERNS.title_bg_side
  }

  if (hasDescription) {
    if (below && !sideSplit) return IMAGE_LAYOUT_PATTERNS.title_desc_below
    if (sideSplit) return IMAGE_LAYOUT_PATTERNS.title_desc_side
    return IMAGE_LAYOUT_PATTERNS.title_desc_below
  }
  if (below && !sideSplit) return IMAGE_LAYOUT_PATTERNS.title_below
  if (sideSplit) return IMAGE_LAYOUT_PATTERNS.title_side
  return IMAGE_LAYOUT_PATTERNS.title_hero
}

export function findSlideHeroImageElements(slide, report = null, options = {}) {
  const titleResult = findSlideTitleElements(slide, report)
  if (!titleResult.primary || titleResult.method === 'none') {
    return {
      primary: null,
      elements: [],
      elementIds: [],
      title: titleResult,
      description: null,
      layoutPattern: null,
      hasDescription: false,
      method: 'none',
      score: 0,
    }
  }

  const images = (slide?.content_elements || [])
    .filter(isLargeHeroImageCandidate)
    .sort((left, right) => imageAreaNorm(right) - imageAreaNorm(left))

  if (!images.length || isGridOfLargeImages(images)) {
    return {
      primary: null,
      elements: [],
      elementIds: [],
      title: titleResult,
      description: null,
      layoutPattern: null,
      hasDescription: false,
      method: 'none',
      score: 0,
    }
  }

  const primary = images[0]
  const descriptionResult = findSlideDescriptionElements(slide, report, {
    excludedElementIds: [...(titleResult.elementIds || [])],
  })
  const hasDescription = Boolean(descriptionResult.primary && descriptionResult.method !== 'none')
  const isBackground = isBackgroundHeroImage(primary)
  const titleBox = boxFromElement(titleResult.primary)
  const imageBox = boxFromElement(primary)
  const layoutPattern = detectLayoutPattern(titleBox, imageBox, hasDescription, isBackground)

  let score = 40 + Math.round(imageAreaNorm(primary) * 100)
  if (hasDescription) score += 12
  if (isBackground) score += 14
  if (layoutPattern === IMAGE_LAYOUT_PATTERNS.title_side || layoutPattern === IMAGE_LAYOUT_PATTERNS.title_bg_side) score += 10
  if (layoutPattern === IMAGE_LAYOUT_PATTERNS.title_below || layoutPattern === IMAGE_LAYOUT_PATTERNS.title_bg_below) score += 8
  if (images.length === 1) score += 6

  return {
    primary,
    elements: [primary],
    elementIds: [primary.element_id],
    title: titleResult,
    description: hasDescription ? descriptionResult : null,
    layoutPattern,
    hasDescription,
    isBackground,
    method: isBackground ? 'title_plus_background_image' : 'title_plus_hero_image',
    score,
  }
}
