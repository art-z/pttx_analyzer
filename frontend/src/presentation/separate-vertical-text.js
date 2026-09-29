import { findSlideTitleElements } from '../slides/slide-title-detect.js'
import { textAreaWidthPt, wrapText } from './text-measure.js'

const DEFAULT_SLIDE_SIZE = { width: 960, height: 540 }
const DEFAULT_LINE_HEIGHT_RATIO = 1.15
const COLUMN_OVERLAP = 0.28
const GAP_PT = 4
const MIN_SHIFT_PT = 0.5

function slideSizeOf(report, slide) {
  return slide?.render?.slide_size_pt
    || report?.typography?.visibility?.slide_size_pt
    || DEFAULT_SLIDE_SIZE
}

function boxOf(geometry) {
  if (!geometry) return null
  const box = {
    x: Number(geometry.x),
    y: Number(geometry.y),
    width: Number(geometry.width),
    height: Number(geometry.height),
  }
  if (![box.x, box.y, box.width, box.height].every(Number.isFinite)) return null
  if (box.width <= 0 || box.height <= 0) return null
  return box
}

function lineHeightPt(element) {
  const size = Number(element?.typography?.size_pt)
  if (!Number.isFinite(size) || size < 1) return null
  const spacing = element.paragraph_spacing_pt || {}
  // Spacing the extractor marked as not applicable is not rendered (the
  // browser uses its normal line height), so it must not be measured either:
  // a PPTX 0.375 "exact" ratio made a 24pt KPI value look 9pt tall.
  if (element.typography?.line_height_applicable === false || spacing.line_height_applicable === false) {
    return size * DEFAULT_LINE_HEIGHT_RATIO
  }
  const explicit = Number(element.typography?.line_height_pt ?? spacing.line_height_pt)
  if (Number.isFinite(explicit) && explicit > 0) return explicit
  const ratio = Number(
    element.typography?.line_height_ratio
    ?? element.typography?.lineHeightRatio
    ?? spacing.line_spacing_ratio,
  )
  if (Number.isFinite(ratio) && ratio > 0) return size * ratio
  return size * DEFAULT_LINE_HEIGHT_RATIO
}

// Lines after word wrap (font advance tables, breaks only between words; see
// text-measure.js). The width is the box width; body insets are subtracted.
// wrap="none" never wraps: only explicit line breaks count.
function wrappedLineCount(element, widthPt, fontSize) {
  if (String(element?.wrap ?? '').trim().toLowerCase() === 'none') return String(element?.text || '').split('\n').length
  return wrapText(String(element?.text || ''), textAreaWidthPt(element, widthPt), fontSize, element?.typography || {}).lineCount
}

export function estimateTextInkHeightPt(element, widthPt) {
  const fontSize = Number(element?.typography?.size_pt)
  const lineHeight = lineHeightPt(element)
  if (!fontSize || !lineHeight || !(widthPt > 0) || !String(element?.text || '').trim()) return null
  const lines = wrappedLineCount(element, widthPt, fontSize)
  const spacing = element.paragraph_spacing_pt || {}
  const before = Number(spacing.space_before) || 0
  const after = Number(spacing.space_after) || 0
  return lines * lineHeight + before + after
}

function placeInk(box, inkHeight, anchor) {
  if (anchor === 'b') {
    const inkBottom = box.y + box.height
    return { inkTop: inkBottom - inkHeight, inkBottom }
  }
  if (anchor === 'ctr') {
    const inkTop = box.y + (box.height - inkHeight) / 2
    return { inkTop, inkBottom: inkTop + inkHeight }
  }
  return { inkTop: box.y, inkBottom: box.y + inkHeight }
}

function sharesColumn(left, right) {
  const width = Math.min(left.box.x + left.box.width, right.box.x + right.box.width)
    - Math.max(left.box.x, right.box.x)
  if (width <= 0) return false
  const narrower = Math.min(left.box.width, right.box.width)
  return narrower > 0 && width / narrower >= COLUMN_OVERLAP
}

function shiftGeometry(geometry, dyNorm, dyPt, yKey, ptKey) {
  if (!geometry) return geometry
  return {
    ...geometry,
    [yKey]: (Number(geometry[yKey]) || 0) + dyNorm,
    ...(ptKey ? { [ptKey]: (Number(geometry[ptKey]) || 0) + dyPt } : {}),
  }
}

function shiftElement(element, dyNorm, slideHeight) {
  const dyPt = dyNorm * slideHeight
  if (element.geometry_norm) {
    element.geometry_norm = {
      ...element.geometry_norm,
      y: (Number(element.geometry_norm.y) || 0) + dyNorm,
    }
  }
  if (element.geometry_pt) {
    element.geometry_pt = {
      ...element.geometry_pt,
      y_pt: (Number(element.geometry_pt.y_pt) || 0) + dyPt,
    }
  }
  if (element.text_group_geometry_norm) {
    element.text_group_geometry_norm = shiftGeometry(
      element.text_group_geometry_norm,
      dyNorm,
      dyPt,
      'y',
    )
  }
  if (element.text_group_geometry_pt) {
    element.text_group_geometry_pt = {
      ...element.text_group_geometry_pt,
      y_pt: (Number(element.text_group_geometry_pt.y_pt) || 0) + dyPt,
    }
  }
}

function shiftUnit(unit, dyNorm, slideHeight) {
  for (const element of [...unit.members, ...(unit.companions || [])]) {
    shiftElement(element, dyNorm, slideHeight)
  }
}

function groupBox(members) {
  const grouped = boxOf(members[0]?.text_group_geometry_norm)
  if (grouped) return grouped
  const boxes = members.map((element) => boxOf(element.geometry_norm)).filter(Boolean)
  if (!boxes.length) return null
  const x = Math.min(...boxes.map((box) => box.x))
  const y = Math.min(...boxes.map((box) => box.y))
  const right = Math.max(...boxes.map((box) => box.x + box.width))
  const bottom = Math.max(...boxes.map((box) => box.y + box.height))
  return { x, y, width: right - x, height: bottom - y }
}

function unitBox(unit) {
  const text = groupBox(unit.members)
  const companions = (unit.companions || []).map((element) => boxOf(element.geometry_norm)).filter(Boolean)
  if (!companions.length) return text
  const boxes = [text, ...companions].filter(Boolean)
  const x = Math.min(...boxes.map((box) => box.x))
  const y = Math.min(...boxes.map((box) => box.y))
  const right = Math.max(...boxes.map((box) => box.x + box.width))
  const bottom = Math.max(...boxes.map((box) => box.y + box.height))
  return { x, y, width: right - x, height: bottom - y }
}

function boxesNear(left, right, tolerance = 0.04) {
  return Boolean(left && right
    && left.x < right.x + right.width + tolerance
    && left.x + left.width > right.x - tolerance
    && left.y < right.y + right.height + tolerance
    && left.y + left.height > right.y - tolerance)
}

function groupInkHeightNorm(members, slideSize) {
  const direction = members[0]?.text_group_spacing_pt?.flex_stack_direction === 'row' ? 'row' : 'column'
  const gapPt = Number(
    direction === 'row'
      ? members[0]?.text_group_spacing_pt?.item_gap_pt
      : members[0]?.text_group_spacing_pt?.line_gap_pt,
  ) || 0
  const heights = members.map((element) => {
    const box = boxOf(element.geometry_norm)
    const widthPt = (box?.width || 0) * slideSize.width
    return estimateTextInkHeightPt(element, widthPt)
  }).filter((height) => height != null)
  if (!heights.length) return null
  const stacked = direction === 'row'
    ? Math.max(...heights)
    : heights.reduce((total, height) => total + height, 0) + gapPt * Math.max(0, heights.length - 1)
  return stacked / slideSize.height
}

function buildUnits(elements, slideSize) {
  const groups = new Map()
  const units = []
  for (const element of elements) {
    if (element?.kind !== 'text' || !String(element.text || '').trim()) continue
    const repeatKey = String(element.element_id || '').match(/__repeat_(\d+)(?:_|$)/u)?.[1]
    const groupId = repeatKey ? `repeat:${repeatKey}` : element.text_group_id
    if (!groupId) {
      const box = boxOf(element.geometry_norm)
      if (!box) continue
      const inkPt = estimateTextInkHeightPt(element, box.width * slideSize.width)
      const inkHeight = inkPt != null ? inkPt / slideSize.height : box.height
      const ink = placeInk(box, inkHeight, element.vertical_anchor)
      units.push({
        members: [element],
        box,
        inkHeight,
        ...ink,
      })
      continue
    }
    if (!groups.has(groupId)) groups.set(groupId, [])
    groups.get(groupId).push(element)
  }

  for (const members of groups.values()) {
    const box = groupBox(members)
    if (!box) continue
    const inkHeight = groupInkHeightNorm(members, slideSize) ?? box.height
    const ink = placeInk(box, inkHeight, members[0]?.vertical_anchor)
    units.push({
      members,
      box,
      inkHeight,
      ...ink,
    })
  }
  for (const unit of units) {
    const repeatKey = String(unit.members[0]?.element_id || '').match(/__repeat_(\d+)(?:_|$)/u)?.[1]
    if (!repeatKey) continue
    const textBox = groupBox(unit.members)
    unit.companions = elements.filter((element) => element.kind !== 'text'
      && String(element.element_id || '').match(/__repeat_(\d+)(?:_|$)/u)?.[1] === repeatKey
      && boxesNear(boxOf(element.geometry_norm), textBox))
    unit.box = unitBox(unit)
  }
  return units
}

function isBlockingImage(element) {
  if (element?.kind !== 'image') return false
  const box = boxOf(element.geometry_norm)
  if (!box) return false
  if (box.width >= 0.98 && box.height >= 0.98) return false
  return Math.min(box.width, box.height) >= 0.08 && box.width * box.height >= 0.02
}

function writeGroupBox(element, box, slideSize) {
  element.text_group_geometry_norm = { ...box }
  element.text_group_geometry_pt = {
    ...(element.text_group_geometry_pt || {}),
    x_pt: box.x * slideSize.width,
    y_pt: box.y * slideSize.height,
    width_pt: box.width * slideSize.width,
    height_pt: box.height * slideSize.height,
  }
}

function expandColumnGroups(elements, slideSize) {
  const groups = new Map()
  for (const element of elements) {
    if (element?.kind !== 'text' || !element.text_group_id || !String(element.text || '').trim()) continue
    if (!groups.has(element.text_group_id)) groups.set(element.text_group_id, [])
    groups.get(element.text_group_id).push(element)
  }

  for (const members of groups.values()) {
    if (members[0]?.text_group_spacing_pt?.flex_stack_direction === 'row') continue
    const box = groupBox(members)
    const ink = groupInkHeightNorm(members, slideSize)
    if (!box || ink == null) continue
    const height = Math.min(Math.max(box.height, ink), Math.max(0, 1 - box.y))
    if (height <= box.height + 0.001) continue
    const next = { ...box, height }
    for (const element of members) writeGroupBox(element, next, slideSize)
  }
}

function imageObstacles(elements) {
  return elements.filter(isBlockingImage).map((element) => {
    const box = boxOf(element.geometry_norm)
    return {
      box,
      inkTop: box.y,
      inkBottom: box.y + box.height,
    }
  })
}

function refreshUnit(unit) {
  const box = unitBox(unit)
  if (!box) return
  const anchor = unit.members[0]?.vertical_anchor
  const ink = placeInk(box, unit.inkHeight, anchor)
  unit.box = box
  unit.inkTop = ink.inkTop
  unit.inkBottom = ink.inkBottom
}

function compareVertical(left, right) {
  if (Math.abs(left.inkTop - right.inkTop) > 0.002) return left.inkTop - right.inkTop
  if (Math.abs(left.box.y - right.box.y) > 0.002) return left.box.y - right.box.y
  const leftTitle = left.members.some((element) => element.role === 'title')
  const rightTitle = right.members.some((element) => element.role === 'title')
  if (leftTitle !== rightTitle) return leftTitle ? -1 : 1
  return 0
}

function stillCoversImage(element, obstacles, minShift) {
  if (!element?.synthetic || element.kind !== 'text') return false
  const box = boxOf(element.geometry_norm)
  if (!box) return false
  const unit = { box, inkTop: box.y, inkBottom: box.y + box.height }
  return obstacles.some((obstacle) => sharesColumn(unit, obstacle)
    && unit.inkTop < obstacle.inkBottom - minShift
    && unit.inkBottom > obstacle.inkTop + minShift)
}

function safeTopNorm(report) {
  const top = Number(report?.layout?.content_margins?.top_norm)
  if (!Number.isFinite(top) || top <= 0) return 0
  return Math.min(top, 0.25)
}

function titleIdsOf(slide, report) {
  return findSlideTitleElements(slide, report).elementIds || new Set()
}

function isTitleUnit(unit, titleIds) {
  return unit.members.some((element) => (
    element.role === 'title' || titleIds.has(element.element_id)
  ))
}

function pullTitleOntoSlide(units, titleIds, safeTop, minShift, slideSize) {
  for (const unit of units) {
    if (!isTitleUnit(unit, titleIds)) continue
    if (unit.inkTop >= -minShift) continue
    const dy = safeTop - unit.inkTop
    const lowest = Math.max(unit.box.y + unit.box.height, unit.inkBottom)
    const applied = Math.min(dy, Math.max(0, 1 - lowest))
    if (applied < minShift) continue
    shiftUnit(unit, applied, slideSize.height)
    refreshUnit(unit)
  }
}

function clearUnitFromObstacles(unit, obstacles, gapNorm, minShift, slideSize) {
  let moved = false
  for (const obstacle of obstacles) {
    if (!sharesColumn(unit, obstacle)) continue
    if (unit.inkBottom <= obstacle.inkTop + minShift) continue
    if (unit.inkTop >= obstacle.inkBottom - minShift) continue
    const dy = obstacle.inkBottom + gapNorm - unit.inkTop
    const lowest = Math.max(unit.box.y + unit.box.height, unit.inkBottom)
    const applied = Math.min(dy, 1 - lowest)
    if (applied < minShift) continue
    shiftUnit(unit, applied, slideSize.height)
    refreshUnit(unit)
    moved = true
  }
  return moved
}

export function separateVerticalText(slide, report = null) {
  const elements = slide?.content_elements
  if (!elements?.length) return slide
  const slideSize = slideSizeOf(report, slide)
  expandColumnGroups(elements, slideSize)
  const units = buildUnits(elements, slideSize)
  const obstacles = imageObstacles(elements)
  const gapNorm = GAP_PT / slideSize.height
  const minShift = MIN_SHIFT_PT / slideSize.height
  pullTitleOntoSlide(units, titleIdsOf(slide, report), safeTopNorm(report), minShift, slideSize)
  if (units.length < 2 && !obstacles.length) return slide

  for (let pass = 0; pass < units.length; pass += 1) {
    let moved = false
    for (let index = 0; index < units.length; index += 1) {
      for (let other = 0; other < units.length; other += 1) {
        if (index === other) continue
        const first = units[index]
        const second = units[other]
        if (!sharesColumn(first, second)) continue
        const order = compareVertical(first, second)
        if (order === 0) continue
        const upper = order < 0 ? first : second
        const lower = upper === first ? second : first
        const neededTop = upper.inkBottom + gapNorm
        if (lower.inkTop >= neededTop - minShift) continue
        const dy = neededTop - lower.inkTop
        const lowest = Math.max(lower.box.y + lower.box.height, lower.inkBottom)
        const room = 1 - lowest
        const applied = Math.min(dy, room)
        if (applied < minShift) continue
        shiftUnit(lower, applied, slideSize.height)
        refreshUnit(lower)
        moved = true
      }
    }
    for (const unit of units) {
      if (clearUnitFromObstacles(unit, obstacles, gapNorm, minShift, slideSize)) moved = true
    }
    if (!moved) break
  }
  slide.content_elements = elements.filter((element) => !stillCoversImage(element, obstacles, minShift))
  return slide
}
