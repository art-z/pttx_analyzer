import { findSlideTitleElements } from '../slides/slide-title-detect.js'
import { ensureSyntheticTextElement } from '../components/synthetic-text-element.js'
import { pickBodyTypography, extractDesignTokens } from '../constructor/tokens.js'
import { estimateTextInkHeightPt } from './separate-vertical-text.js'

const GAP_PT = 12

function slideSizeOf(slide, report) {
  return slide?.render?.slide_size_pt
    || report?.typography?.visibility?.slide_size_pt
    || report?.slides?.summary?.slide_size_pt
    || { width: 960, height: 540 }
}

function unionBoxes(boxes) {
  const items = boxes.filter((box) => box?.width > 0 && box?.height > 0)
  if (!items.length) return null
  const x = Math.min(...items.map((box) => box.x || 0))
  const y = Math.min(...items.map((box) => box.y || 0))
  const right = Math.max(...items.map((box) => (box.x || 0) + box.width))
  const bottom = Math.max(...items.map((box) => (box.y || 0) + box.height))
  return { x, y, width: right - x, height: bottom - y }
}

function elementBox(element) {
  const normalized = element?.geometry_norm
  if (normalized?.width > 0 && normalized?.height > 0) return normalized
  return null
}

function boxesOverlap(left, right) {
  const width = Math.min(left.x + left.width, right.x + right.width) - Math.max(left.x, right.x)
  const height = Math.min(left.y + left.height, right.y + right.height) - Math.max(left.y, right.y)
  return width > 0.008 && height > 0.008
}

function styleUnderTitle(title, tokens) {
  const body = pickBodyTypography(tokens)
  const titleType = title?.typography || {}
  const titleSize = Number(titleType.size_pt) || Number(body.sizePt) || 28
  const size = Math.max(14, Math.min(Number(body.sizePt) || 16, titleSize * 0.55))
  return {
    family: titleType.family || body.family || null,
    size_pt: size,
    color: titleType.color || body.color || null,
    alignment: 'l',
    line_height_ratio: 1.2,
    bold: false,
  }
}

export function layoutUnderTitle(slide, report, text, tokens = null) {
  const detected = findSlideTitleElements(slide, report)
  const titleBox = unionBoxes((detected.elements || []).map(elementBox))
  if (!titleBox || !String(text || '').trim()) return null

  const slideSize = slideSizeOf(slide, report)
  const resolvedTokens = tokens || (report ? extractDesignTokens(report) : {
    bodyTypographyOptions: [],
    typeScales: [],
    defaultFontFamily: 'Arial',
    defaultTextColor: '#000000',
    titleColors: [],
  })
  const typography = styleUnderTitle(detected.primary, resolvedTokens)
  const inkPt = estimateTextInkHeightPt(
    { text, typography },
    titleBox.width * slideSize.width,
  ) || typography.size_pt * 1.2 * 3
  const gap = GAP_PT / slideSize.height
  const height = Math.min(0.42, Math.max(inkPt / slideSize.height, (typography.size_pt * 1.2 * 2) / slideSize.height))
  const box = {
    x: titleBox.x,
    y: titleBox.y + titleBox.height + gap,
    width: titleBox.width,
    height,
  }
  if (box.y + box.height > 0.98) return null

  return {
    box,
    typography,
    titleIds: detected.elementIds || new Set(),
    slideSize,
  }
}

function obstacles(slide, titleIds) {
  return (slide?.content_elements || [])
    .map((element) => ({ element, box: elementBox(element) }))
    .filter((item) => item.box && !titleIds.has(item.element.element_id))
    .filter((item) => Math.min(item.box.width, item.box.height) >= 0.02)
}

function clearBox(box, blockers, gap) {
  let next = { ...box }
  for (let pass = 0; pass < blockers.length + 1; pass += 1) {
    const hit = blockers
      .filter((blocker) => boxesOverlap(next, blocker))
      .sort((left, right) => left.y - right.y)[0]
    if (!hit) return next
    next = { ...next, y: hit.y + hit.height + gap }
    if (next.y + next.height > 0.98) return null
  }
  return null
}

export function placeTextUnderTitle(slide, report, text, { avoidOccupied = true } = {}) {
  const layout = layoutUnderTitle(slide, report, text)
  if (!layout) return { slide, elementIds: [], created: false }

  const gap = GAP_PT / layout.slideSize.height
  const box = avoidOccupied
    ? clearBox(layout.box, obstacles(slide, layout.titleIds).map((item) => item.box), gap)
    : layout.box
  if (!box) return { slide, elementIds: [], created: false }

  const instance = {
    synthetic: true,
    detection_method: 'under_title',
    element_ids: [],
    slide_number: slide.slide_number,
    typography: layout.typography,
    container_norm: box,
    container: {
      x_pt: box.x * layout.slideSize.width,
      y_pt: box.y * layout.slideSize.height,
      width_pt: box.width * layout.slideSize.width,
      height_pt: box.height * layout.slideSize.height,
    },
  }
  return ensureSyntheticTextElement(slide, {
    instance,
    kind: 'slide_description',
    text,
  })
}
