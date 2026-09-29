// Unit-based hit-test for generated slides: detection + correction.
//
// Model
// - Every content element belongs to a rigid *unit*: repeat/metric items
//   (`__repeat_N` / `__metric_N`), text groups, and plates (fill/image) that
//   contain the centre of a text of the same origin are joined, so a card, its
//   text and its icon always move and scale together.
// - Units made only of template decoration are fixed. Layout image layers are
//   fixed obstacles: decorative art (colour unknown) or pictures.
// - Text is measured by its ink (wrapped lines × line height) with the same
//   metrics as separate-vertical-text.js, never by its box alone. Text groups
//   are measured the way the renderer draws them: a flex stack inside
//   `text_group_geometry_norm` (member boxes are not used for positioning), so
//   a stale group box is re-synced to its members before anything else.
// - Safe area = deck content margins united with the layout's own text
//   placeholders (per layout, so covers/endings get theirs).
//
// Correction order (repeated to a fixed point, max MAX_ITERATIONS):
//   a) fit text into its box: grow into free space, then shrink to a role floor;
//   b) resolve overlaps by moving whole units along the flow; a column/row of
//      same-kind units is restacked with a min gap, scaled down to a floor if
//      the free region is too small;
//   c) clamp units into the safe area (template text: into the slide), scaling
//      uniformly down to a floor if a unit is larger than the area;
//   d) re-check. Anything still broken is reported as an error so the caller
//      rejects the candidate with a precise reason.
//
// Words: the renderer breaks lines only between words (no break-word /
// hyphenation), so a word wider than its box is an error (`word_too_wide`),
// and so is a last line of 1–2 characters (`text_orphan`). Step a) fixes them
// in this order: glue the orphan with a no-break space, let ordinary body text
// wrap vertically when there is room, widen only for unbreakable text or
// too-short frames, shrink the font to the role floor.
// The title keeps a template-derived gap to the content below (`title_gap`,
// title-gap.js): content is moved down, else the title up, else both.
import { estimateTextInkHeightPt } from './separate-vertical-text.js'
import { bodyInsetsPt, glueOrphans, textAreaWidthPt, wrapText } from './text-measure.js'
import { effectiveTextRect, horizontalTextSpan, inheritVerticalAnchors, normalizeAlignment, normalizeVerticalAnchor, resolveVerticalAnchor } from './text-rect.js'
import { requiredTitleGapPt } from './title-gap.js'
import { contrastRatio } from './component-template-fit.js'
import { effectiveBackgroundUnder } from './terminal-slot-style.js'

export const HIT_ENGINE = 'unit-hit-test'
export const HIT_TOLERANCE_PT = 2
export const MIN_GAP_PT = 6
export const UNIT_SCALE_FLOOR = 0.6
export const MIN_FONT_PT = 8
const CHART_MIN_HEIGHT_PT = 120
const DEFAULT_SIZE = { width: 960, height: 540 }
const BOUNDS_TOLERANCE = 0.008
const MAX_ITERATIONS = 6
const PLATE_MAX_AREA = 0.35
const FULL_BLEED = 0.92
const STRICT_BACKDROP_AREA = 0.8
const CONTAINER_SHARE = 0.85
const MIN_OBSTACLE_AREA = 0.002
const IMAGE_HIT_SHARE = 0.1
const PLATE_OVERLAP_SHARE = 0.1
const FLOW_OVERLAP = 0.3
const LOW_CONTRAST = 3
const INVISIBLE_CONTRAST = 1.6
const MAX_DYNAMIC_ELEMENTS = 500
const SAFE_SLOT_ROLES = new Set(['title', 'ctrTitle', 'subtitle', 'subTitle', 'body', 'content'])
const BODY_SLOT_ROLES = new Set(['subtitle', 'subTitle', 'body', 'content'])
// Widest a text box is widened to (share of the slide width) unless it
// already was wider: a comfortable line length.
const WIDEN_CAP = 0.6
const HEX_RE = /^#?[0-9a-f]{6}$/i

function slideSizeOf(report, slide) {
  return slide?.render?.slide_size_pt || report?.typography?.visibility?.slide_size_pt || DEFAULT_SIZE
}

function finiteBox(value) {
  if (!value) return null
  const box = { x: Number(value.x), y: Number(value.y), width: Number(value.width), height: Number(value.height) }
  if (![box.x, box.y, box.width, box.height].every(Number.isFinite)) return null
  return box.width > 0 && box.height > 0 ? box : null
}

function elementBox(element, size) {
  const norm = finiteBox(element?.geometry_norm)
  if (norm) return norm
  const pt = element?.geometry_pt
  if (!pt) return null
  return finiteBox({
    x: Number(pt.x_pt) / size.width,
    y: Number(pt.y_pt) / size.height,
    width: Number(pt.width_pt) / size.width,
    height: Number(pt.height_pt) / size.height,
  })
}

const rightOf = (box) => box.x + box.width
const bottomOf = (box) => box.y + box.height
const areaOf = (box) => (box ? Math.max(0, box.width) * Math.max(0, box.height) : 0)

function unionBox(boxes) {
  const list = boxes.filter(Boolean)
  if (!list.length) return null
  const x = Math.min(...list.map((box) => box.x))
  const y = Math.min(...list.map((box) => box.y))
  return {
    x,
    y,
    width: Math.max(...list.map(rightOf)) - x,
    height: Math.max(...list.map(bottomOf)) - y,
  }
}

function overlapExtent(left, right) {
  return {
    width: Math.min(rightOf(left), rightOf(right)) - Math.max(left.x, right.x),
    height: Math.min(bottomOf(left), bottomOf(right)) - Math.max(left.y, right.y),
  }
}

function hits(left, right, size, tolerancePt = HIT_TOLERANCE_PT) {
  const extent = overlapExtent(left, right)
  return extent.width * size.width > tolerancePt && extent.height * size.height > tolerancePt
}

function sharedArea(left, right) {
  const extent = overlapExtent(left, right)
  return Math.max(0, extent.width) * Math.max(0, extent.height)
}

function spanShare(startA, endA, startB, endB) {
  const shared = Math.min(endA, endB) - Math.max(startA, startB)
  const narrower = Math.min(endA - startA, endB - startB)
  return narrower > 0 ? Math.max(0, shared) / narrower : 0
}

function hasText(element) {
  return element?.kind === 'text' && Boolean(String(element.text || '').trim())
}

export function isDynamicElement(element) {
  return /__repeat_|__metric_/.test(String(element?.element_id || ''))
    || /(^|[_-])metric([_-]|$)|__metric_/.test(String(element?.text_group_id || ''))
    || Boolean(element?.synthetic || element?.component_data || element?.baseline_preview || element?.placement_content)
}

function itemKey(element) {
  const match = String(element?.element_id || '').match(/__(repeat|metric)_(\d+)/)
  return match ? `${match[1]}:${match[2]}` : null
}

function isTitleElement(element, titleIds) {
  const role = String(element.role || element.text_role || element.name || '').toLowerCase()
  return titleIds.has(element.element_id)
    || role.includes('title')
    || ['title', 'ctrTitle'].includes(element.placeholder_type)
    || /(^|_)slide_title(_|$)/.test(String(element.element_id || ''))
}

function isTitleCandidateUnit(unit) {
  if (unit.title) return true
  if (!unit.text || unit.dynamic || !unit.occ) return false
  const texts = unit.items.filter((item) => item.text)
  if (!texts.length) return false
  const largest = Math.max(...texts.map((item) => Number(item.element.typography?.size_pt) || 0))
  return largest >= 24 && unit.occ.width >= 0.32 && unit.occ.y <= 0.45
}

// Visible text extent inside (or beyond) its box: the effective text rect
// (text-rect.js) — lines inside the body insets, stacked from the resolved
// vertical anchor (bottom grows up past the frame top, middle both ways), a
// too-wide / wrap="none" line sticking out by alignment. overflowPt counts
// the insets too (the renderer pads the box with them).
export function measureTextInk(element, box, size = DEFAULT_SIZE) {
  const font = Number(element?.typography?.size_pt)
  if (!hasText(element) || !(font > 0)) return { ...box, overflowPt: 0 }
  const rect = effectiveTextRect(element, box, size)
  return {
    x: rect.x,
    y: rect.y,
    width: rect.width,
    height: rect.height,
    overflowPt: rect.overflowPt,
    padTop: rect.padTop,
    padBottom: rect.padBottom,
    ...rect.words,
  }
}

// Horizontal ink of a text in a frame (widest line, by alignment) plus the
// wrap checks.
function inkSpan(element, frame, size) {
  return horizontalTextSpan(element, frame, size)
}

function clip01(box) {
  const x = Math.max(0, box.x)
  const y = Math.max(0, box.y)
  return { x, y, width: Math.min(1, rightOf(box)) - x, height: Math.min(1, bottomOf(box)) - y }
}

// Per-layout safe area: deck content margins united with the layout's own
// text placeholders (a cover title slot may legitimately sit lower/wider).
export function safeAreaFor(report, slide) {
  const margins = report?.layout?.content_margins || {}
  const keys = ['left_norm', 'right_norm', 'top_norm', 'bottom_norm']
  const hasMargins = keys.every((key) => margins[key] != null && Number.isFinite(Number(margins[key])))
  const template = (report?.slide_templates?.templates || []).find((item) => (
    (slide?.layout_source && item.layout_source === slide.layout_source)
    || (slide?.template_id && item.template_id === slide.template_id)
  ))
  const slots = (template?.editable_slots || [])
    .filter((slot) => SAFE_SLOT_ROLES.has(slot.role) || SAFE_SLOT_ROLES.has(slot.placeholder_type))
    .map((slot) => finiteBox(slot.geometry_norm))
    .filter((box) => box && areaOf(box) < 0.6)
  const slotBox = unionBox(slots)
  const marginBox = hasMargins ? {
    x: Number(margins.left_norm),
    y: Number(margins.top_norm),
    width: 1 - Number(margins.right_norm) - Number(margins.left_norm),
    height: 1 - Number(margins.bottom_norm) - Number(margins.top_norm),
  } : null
  const base = marginBox || slotBox || { x: 0.04, y: 0.04, width: 0.92, height: 0.92 }
  const safe = clip01(slotBox && marginBox ? unionBox([marginBox, slotBox]) : base)
  return {
    ...safe,
    source: marginBox ? (slotBox ? 'margins+slots' : 'margins') : (slotBox ? 'slots' : 'default'),
  }
}

// Safe area for body text (everything but titles): the deck content margins
// united with the layout's body/subtitle placeholders only. Title slots are
// left out: a full-height title slot must not let a paragraph run to the edge.
export function bodySafeAreaFor(report, slide) {
  const margins = report?.layout?.content_margins || {}
  const keys = ['left_norm', 'right_norm', 'top_norm', 'bottom_norm']
  if (!keys.every((key) => margins[key] != null && Number.isFinite(Number(margins[key])))) return safeAreaFor(report, slide)
  const marginBox = {
    x: Number(margins.left_norm),
    y: Number(margins.top_norm),
    width: 1 - Number(margins.right_norm) - Number(margins.left_norm),
    height: 1 - Number(margins.bottom_norm) - Number(margins.top_norm),
  }
  const template = (report?.slide_templates?.templates || []).find((item) => (
    (slide?.layout_source && item.layout_source === slide.layout_source)
    || (slide?.template_id && item.template_id === slide.template_id)
  ))
  const slots = (template?.editable_slots || [])
    .filter((slot) => BODY_SLOT_ROLES.has(slot.role) || BODY_SLOT_ROLES.has(slot.placeholder_type))
    .map((slot) => finiteBox(slot.geometry_norm))
    .filter((box) => box && areaOf(box) < 0.6)
  return { ...clip01(unionBox([marginBox, ...slots])), source: slots.length ? 'margins+body_slots' : 'margins' }
}

function slideBounds() {
  return { x: 0, y: 0, width: 1, height: 1, source: 'slide' }
}

// strictImages (covers/endings): decorative art that is not a backdrop is a
// picture too; text may still sit fully inside it (its own container).
function fixedObstacles(slide, strictImages = false) {
  return (slide?.render?.layers || []).flatMap((layer) => {
    if (layer.kind !== 'image') return []
    const box = finiteBox(layer.geometry_norm)
    if (!box || areaOf(box) < MIN_OBSTACLE_AREA) return []
    if (box.width >= FULL_BLEED && box.height >= FULL_BLEED) return []
    const strict = strictImages && layer.decorative === true && areaOf(box) < STRICT_BACKDROP_AREA
    return [{
      box,
      kind: layer.decorative === true && !strict ? 'art' : 'picture',
      strict,
      id: layer.layer_id || layer.asset || layer.name || 'image',
    }]
  })
}

function fontFloor(item) {
  const font = Number(item.element.typography?.size_pt) || 0
  const base = Number(item.element.__original_size_pt) || font
  if (!base) return font
  let floor
  if (item.title) floor = Math.max(16, base * 0.7)
  else if (item.element.component_data && base >= 28) floor = base * 0.55
  else if (base >= 12) floor = Math.max(10, base * 0.75)
  else floor = Math.max(MIN_FONT_PT, base * 0.85)
  return Math.min(base, floor)
}

export function buildLayoutUnits(slide, report = null, { titleIds = [] } = {}) {
  const size = slideSizeOf(report, slide)
  const titles = new Set(titleIds)
  const items = (slide?.content_elements || []).map((element, index) => {
    const box = elementBox(element, size)
    if (!box) return null
    const text = hasText(element)
    if (element.kind === 'text' && !text) return null
    return {
      element,
      index,
      box,
      text,
      dynamic: isDynamicElement(element),
      key: itemKey(element),
      title: text && isTitleElement(element, titles),
      ink: { ...box, overflowPt: 0 },
    }
  }).filter(Boolean)
  const entities = buildTextEntities(items, size)
  const parent = items.map((_, index) => index)
  const find = (index) => (parent[index] === index ? index : (parent[index] = find(parent[index])))
  const join = (left, right) => { parent[find(left)] = find(right) }
  const byKey = new Map()
  const byGroup = new Map()
  items.forEach((item, index) => {
    if (item.key) {
      if (byKey.has(item.key)) join(index, byKey.get(item.key))
      else byKey.set(item.key, index)
    }
    const group = item.element.text_group_id
    if (group) {
      if (byGroup.has(group)) join(index, byGroup.get(group))
      else byGroup.set(group, index)
    }
  })
  items.forEach((plate, plateIndex) => {
    if (plate.text || areaOf(plate.box) > PLATE_MAX_AREA) return
    items.forEach((text, textIndex) => {
      if (!text.text || plate.dynamic !== text.dynamic) return
      if (plate.dynamic && plate.key !== text.key) return
      if (areaOf(text.box) >= areaOf(plate.box)) return
      const cx = text.box.x + text.box.width / 2
      const cy = text.box.y + text.box.height / 2
      if (cx >= plate.box.x && cx <= rightOf(plate.box) && cy >= plate.box.y && cy <= bottomOf(plate.box)) {
        join(plateIndex, textIndex)
      }
    })
  })
  const groups = new Map()
  items.forEach((item, index) => {
    const root = find(index)
    if (!groups.has(root)) groups.set(root, [])
    groups.get(root).push(item)
  })
  const units = [...groups.values()].map((members, index) => {
    const dynamic = members.some((item) => item.dynamic)
    const title = members.some((item) => item.title)
    const text = members.some((item) => item.text)
    const unit = {
      id: `u${index}`,
      items: members,
      dynamic,
      title,
      text,
      movable: text || dynamic,
      priority: title ? 3 : dynamic ? 1 : 2,
      kind: members.map((item) => item.key || item.element.text_group_id).find(Boolean)?.replace(/[:_]\d+$/, '')
        || (members.some((item) => item.element.component_data) ? 'component' : text ? 'text' : 'decor'),
    }
    for (const item of members) item.unit = unit
    unit.occ = unionBox(members.map((item) => (item.text ? item.ink : item.box)))
    return unit
  })
  return { size, items, units, entities }
}

function centreInside(box, frame) {
  const cx = box.x + box.width / 2
  const cy = box.y + box.height / 2
  return cx >= frame.x - 0.002 && cx <= rightOf(frame) + 0.002 && cy >= frame.y - 0.002 && cy <= bottomOf(frame) + 0.002
}

function lineGapPt(element, direction) {
  const spacing = element?.text_group_spacing_pt || {}
  return Math.max(0, Number(direction === 'row' ? spacing.item_gap_pt : spacing.line_gap_pt) || 0)
}

function alignedInk(element, frame, heightNorm, y, size) {
  const { x, width, words } = inkSpan(element, frame, size)
  return { x, y, width, height: heightNorm, overflowPt: 0, ...words }
}

// Lays a text entity out like the renderer: single text in its box, groups as
// a flex stack in the group box (column: stacked with line gap, anchored by
// the first member's vertical anchor; row: side by side).
export function layoutTextEntity(entity, size) {
  const { box, members } = entity
  if (entity.single) {
    const ink = measureTextInk(members[0].element, box, size)
    members[0].ink = ink
    entity.overflowPt = ink.overflowPt
    return entity
  }
  if (entity.direction === 'row') {
    let tallest = 0
    for (const member of members) {
      const frame = { x: member.box.x, y: box.y, width: member.box.width, height: box.height }
      member.ink = measureTextInk(member.element, frame, size)
      tallest = Math.max(tallest, member.ink.height)
    }
    entity.overflowPt = (tallest - box.height) * size.height
    return entity
  }
  const widthPt = box.width * size.width
  const heights = members.map((member) => (
    estimateTextInkHeightPt(member.element, widthPt) ?? member.box.height * size.height
  ))
  const gapPt = entity.gapPt
  const totalPt = heights.reduce((sum, value) => sum + value, 0) + gapPt * Math.max(0, heights.length - 1)
  const total = totalPt / size.height
  const anchor = normalizeVerticalAnchor(entity.anchor)
  let cursor = anchor === 'b' ? bottomOf(box) - total : anchor === 'ctr' ? box.y + (box.height - total) / 2 : box.y
  members.forEach((member, index) => {
    member.ink = alignedInk(member.element, box, heights[index] / size.height, cursor, size)
    cursor += (heights[index] + gapPt) / size.height
  })
  entity.overflowPt = totalPt - box.height * size.height
  return entity
}

function buildTextEntities(items, size) {
  const groups = new Map()
  const entities = []
  for (const item of items) {
    if (!item.text) continue
    const group = item.element.text_group_id
    if (!group) {
      item.entity = { id: item.element.element_id, single: true, members: [item], box: item.box }
      entities.push(layoutTextEntity(item.entity, size))
      continue
    }
    if (!groups.has(group)) groups.set(group, [])
    groups.get(group).push(item)
  }
  for (const [group, members] of groups) {
    const byZ = [...members].sort((left, right) => (Number(left.element.z_index) || 0) - (Number(right.element.z_index) || 0)
      || left.index - right.index)
    const ordered = [...byZ].sort((left, right) => (left.element.text_line_index ?? 0) - (right.element.text_line_index ?? 0))
    const anchorItem = byZ[0]
    const declared = finiteBox(anchorItem.element.text_group_geometry_norm)
    const union = unionBox(members.map((member) => member.box))
    // The renderer draws the group at the declared box; members that are not
    // inside it mean someone moved the elements but not the group.
    const stale = Boolean(declared) && (outside(union, declared, 0.01) || !members.some((member) => centreInside(member.box, declared)))
    const direction = anchorItem.element.text_group_spacing_pt?.flex_stack_direction === 'row' ? 'row' : 'column'
    const entity = {
      id: group,
      single: false,
      grouped: Boolean(declared),
      members: ordered,
      box: stale || !declared ? union : declared,
      stale,
      direction,
      gapPt: lineGapPt(anchorItem.element, direction),
      anchor: anchorItem.element.vertical_anchor,
    }
    for (const member of members) member.entity = entity
    entities.push(layoutTextEntity(entity, size))
  }
  return entities
}

// Conflicts between two items of different units (or text/text in one unit).
function itemConflict(left, right, size) {
  if (left.element === right.element) return null
  const sameUnit = left.unit === right.unit
  if (left.text && right.text) {
    if (left.entity && left.entity === right.entity) return null
    return hits(left.ink, right.ink, size) ? 'text_overlap' : null
  }
  if (sameUnit) return null
  if (left.text || right.text) {
    const text = left.text ? left : right
    const plate = left.text ? right : left
    if (!text.dynamic && !plate.dynamic) return null
    return hits(text.ink, plate.box, size) ? 'text_overlap' : null
  }
  if (!left.dynamic && !right.dynamic) return null
  if (!hits(left.box, right.box, size)) return null
  const share = sharedArea(left.box, right.box) / Math.min(areaOf(left.box), areaOf(right.box))
  return share >= PLATE_OVERLAP_SHARE ? 'unit_overlap' : null
}

function obstacleConflict(item, obstacle, size) {
  if (item.text) {
    if (obstacle.kind !== 'picture') return null
    const share = sharedArea(item.ink, obstacle.box) / Math.max(areaOf(item.ink), 1e-9)
    if (share < IMAGE_HIT_SHARE || !hits(item.ink, obstacle.box, size)) return null
    if (obstacle.strict && share >= CONTAINER_SHARE) return null
    return { code: 'text_over_image', severity: item.dynamic ? 'error' : 'warning' }
  }
  if (!item.dynamic || !hits(item.box, obstacle.box, size)) return null
  const share = sharedArea(item.box, obstacle.box) / Math.min(areaOf(item.box), areaOf(obstacle.box))
  if (share < IMAGE_HIT_SHARE) return null
  return { code: 'content_over_image', severity: obstacle.kind === 'picture' ? 'error' : 'warning' }
}

function outside(box, bounds, tolerance = BOUNDS_TOLERANCE) {
  return box.x < bounds.x - tolerance || box.y < bounds.y - tolerance
    || rightOf(box) > rightOf(bounds) + tolerance || bottomOf(box) > bottomOf(bounds) + tolerance
}

function normalizeHex(value) {
  const text = String(value || '').trim()
  if (!HEX_RE.test(text)) return null
  return (text.startsWith('#') ? text : `#${text}`).toUpperCase()
}

function contrastIssue(slide, item, items, size) {
  const color = normalizeHex(item.element.typography?.color)
  if (!color) return null
  const photo = items.some((other) => other !== item && other.element.kind === 'image'
    && Number(other.element.z_index || 0) <= Number(item.element.z_index || 0)
    && sharedArea(other.box, item.ink) >= 0.5 * areaOf(item.ink))
  const background = photo ? { reliable: false } : effectiveBackgroundUnder(slide, item.ink)
  if (!background.reliable) {
    return item.dynamic ? { code: 'contrast_unknown', severity: 'warning', element_id: item.element.element_id } : null
  }
  const ratio = contrastRatio(color, background.color)
  if (ratio >= LOW_CONTRAST) return null
  return {
    code: 'low_contrast',
    severity: ratio < INVISIBLE_CONTRAST ? 'error' : 'warning',
    element_id: item.element.element_id,
    ratio: Number(ratio.toFixed(2)),
    background: background.color,
    color,
  }
}

export function detectLayoutIssues(report, slide, { titleIds = [], safe = null, strictImages = false } = {}) {
  const issues = []
  const elements = slide?.content_elements || []
  const dynamicCount = elements.filter(isDynamicElement).length
  if (dynamicCount > MAX_DYNAMIC_ELEMENTS) {
    return {
      issues: [{ code: 'dynamic_element_limit', severity: 'error', count: dynamicCount, limit: MAX_DYNAMIC_ELEMENTS }],
      units: [],
      safe: safe || safeAreaFor(report, slide),
    }
  }
  const { size, items, units, entities } = buildLayoutUnits(slide, report, { titleIds })
  const area = safe || safeAreaFor(report, slide)
  const obstacles = fixedObstacles(slide, strictImages)
  // Text that has content but a collapsed box is invisible, not "fine".
  for (const element of elements) {
    if (!hasText(element) || elementBox(element, size)) continue
    if (!element.geometry_norm && !element.geometry_pt) continue
    issues.push({ code: 'collapsed_text_box', severity: isDynamicElement(element) ? 'error' : 'warning', element_id: element.element_id })
  }
  for (const entity of entities) {
    if (entity.stale) {
      issues.push({ code: 'stale_group_geometry', severity: 'error', element_id: entity.members[0].element.element_id, group: entity.id })
    }
    if (entity.overflowPt > HIT_TOLERANCE_PT) {
      issues.push({
        code: 'text_overflow',
        severity: 'error',
        element_id: entity.members[0].element.element_id,
        overflow_pt: Number(entity.overflowPt.toFixed(1)),
      })
    }
  }
  for (let left = 0; left < items.length; left += 1) {
    for (let right = left + 1; right < items.length; right += 1) {
      const code = itemConflict(items[left], items[right], size)
      if (!code) continue
      issues.push({
        code,
        severity: 'error',
        element_ids: [items[left].element.element_id, items[right].element.element_id],
        units: [items[left].unit.id, items[right].unit.id],
      })
    }
    for (const obstacle of obstacles) {
      const conflict = obstacleConflict(items[left], obstacle, size)
      if (conflict) issues.push({ ...conflict, element_id: items[left].element.element_id, obstacle: obstacle.id })
    }
  }
  for (const unit of units) {
    if (!unit.movable || !unit.occ) continue
    const ids = unit.items.map((item) => item.element.element_id)
    if (outside(unit.occ, slideBounds())) {
      issues.push({ code: 'outside_slide', severity: 'error', element_id: ids[0], element_ids: ids })
    } else if (outside(unit.occ, area)) {
      issues.push({
        code: 'outside_safe_area',
        severity: unit.dynamic ? 'error' : 'warning',
        element_id: ids[0],
        element_ids: ids,
      })
    }
  }
  for (const item of items) {
    if (!item.text) continue
    if (item.ink.wordTooWide) {
      issues.push({ code: 'word_too_wide', severity: 'error', element_id: item.element.element_id, word: item.ink.widePiece })
    }
    if (item.ink.orphan != null) {
      issues.push({ code: 'text_orphan', severity: 'error', element_id: item.element.element_id, line: item.ink.orphan })
    }
    const issue = contrastIssue(slide, item, items, size)
    if (issue) issues.push(issue)
  }
  // Titles by their effective text rect: text that grew (or overflows) out of
  // the safe area / its original frame, or onto layout art or template text
  // its original frame did not touch, is rejected.
  const layers = titleLayerObstacles(slide, size)
  const graphicObstacles = titleGraphicObstacles(items)
  const titleBodySafe = bodySafeAreaFor(report, slide)
  for (const item of items) {
    if (!item.text || !item.title || item.dynamic) continue
    const frame0 = frame0Of(item)
    const beyond = beyondPt(item.ink, titleGrowBounds(item, area, titleBodySafe), size)
    if (beyond > HIT_TOLERANCE_PT) {
      issues.push({
        code: 'title_outside_safe_area',
        severity: 'error',
        element_id: item.element.element_id,
        anchor: resolveVerticalAnchor(item.element),
        overflow_pt: Number(beyond.toFixed(1)),
      })
    }
    const layer = newLayerObstacles(layers, frame0, size).find((candidate) => hits(item.ink, candidate.box, size))
    if (layer) {
      issues.push({ code: 'title_over_layer', severity: 'error', element_id: item.element.element_id, obstacle: layer.id })
    }
    const graphic = graphicObstacles.find((candidate) => hits(item.ink, candidate.box, size))
    if (graphic) {
      issues.push({
        code: 'title_over_graphic',
        severity: 'error',
        element_id: item.element.element_id,
        obstacle: graphic.id,
        obstacle_kind: graphic.kind,
      })
    }
  }
  // A generated (synthetic) title has no template frame to excuse it: its
  // whole frame must stay off template pictures, since the browser may wrap
  // the text wider than the ink estimate.
  for (const item of items) {
    if (!item.text || !item.title || !item.element?.synthetic) continue
    const picture = layers.find((candidate) => candidate.kind === 'image'
      && hits(unionBox([item.box, item.ink]), candidate.box, size))
    if (picture) {
      issues.push({ code: 'title_over_layer', severity: 'error', element_id: item.element.element_id, obstacle: picture.id })
    }
  }
  // Body text by its effective text rect: inside the body safe area (or its
  // own original frame).
  const bodySafe = bodySafeAreaFor(report, slide)
  for (const item of items) {
    if (!item.text || item.title) continue
    const beyond = beyondPt(item.ink, itemTextBounds(item, bodySafe), size)
    if (beyond > HIT_TOLERANCE_PT) {
      issues.push({ code: 'text_outside_safe_area', severity: 'error', element_id: item.element.element_id, overflow_pt: Number(beyond.toFixed(1)) })
    }
  }
  const gap = titleGapInfo(report, slide, items, units, size, titleIds)
  if (gap && gap.gapPt < gap.requiredPt - HIT_TOLERANCE_PT) {
    issues.push({
      code: 'title_gap',
      severity: 'error',
      element_id: gap.titleItems[0].element.element_id,
      element_ids: gap.below.items.map((item) => item.element.element_id),
      gap_pt: Number(gap.gapPt.toFixed(1)),
      required_pt: Number(gap.requiredPt.toFixed(1)),
    })
  }
  return { issues, units, safe: area }
}

// Title ink and the nearest content unit below it (text or dynamic content in
// the title's column), with the gap the template asks for.
// The explicit title ids win over role-based guesses (a KPI value may carry
// role "title" inside its metric stack).
function titleGapInfo(report, slide, items, units, size, titleIds = []) {
  const explicit = new Set(titleIds)
  const named = items.filter((item) => item.text && explicit.has(item.element.element_id))
  const titleItems = named.length ? named : items.filter((item) => item.title && item.text && !item.dynamic)
  if (!titleItems.length) return null
  const band = unionBox(titleItems.map((item) => item.ink))
  const title = titleItems[0].unit
  const tolerance = HIT_TOLERANCE_PT / size.height
  let below = null
  for (const unit of units) {
    if (unit === title || !unit.occ || !(unit.text || unit.dynamic)) continue
    if (unit.items.some((item) => titleItems.includes(item))) continue
    if (unit.occ.y < bottomOf(band) - tolerance) continue
    if (spanShare(unit.occ.x, rightOf(unit.occ), band.x, rightOf(band)) < 0.3) continue
    if (!below || unit.occ.y < below.occ.y) below = unit
  }
  if (!below) return null
  return {
    title,
    titleItems,
    band,
    below,
    gapPt: (below.occ.y - bottomOf(band)) * size.height,
    requiredPt: requiredTitleGapPt(report, slide, titleItems[0].element),
  }
}

function writeBox(element, box, size) {
  element.geometry_norm = { ...(element.geometry_norm || {}), x: box.x, y: box.y, width: box.width, height: box.height }
  element.geometry_pt = {
    ...(element.geometry_pt || {}),
    x_pt: box.x * size.width,
    y_pt: box.y * size.height,
    width_pt: box.width * size.width,
    height_pt: box.height * size.height,
  }
}

function writeGroupBox(element, box, size) {
  element.text_group_geometry_norm = { ...(element.text_group_geometry_norm || {}), x: box.x, y: box.y, width: box.width, height: box.height }
  element.text_group_geometry_pt = {
    ...(element.text_group_geometry_pt || {}),
    x_pt: box.x * size.width,
    y_pt: box.y * size.height,
    width_pt: box.width * size.width,
    height_pt: box.height * size.height,
  }
}

function sameBox(left, right) {
  return Math.abs(left.x - right.x) < 0.002 && Math.abs(left.y - right.y) < 0.002
    && Math.abs(left.width - right.width) < 0.002 && Math.abs(left.height - right.height) < 0.002
}

// Writes a new frame for a text entity: the element box for a single text,
// the group box (plus members that mirror it) for a flex-stack group.
function setEntityBox(entity, box, size) {
  if (entity.single) {
    entity.members[0].box = box
    writeBox(entity.members[0].element, box, size)
  } else {
    for (const member of entity.members) {
      if (sameBox(member.box, entity.box)) {
        member.box = { ...box }
        writeBox(member.element, box, size)
      }
      if (entity.grouped) writeGroupBox(member.element, box, size)
    }
  }
  entity.box = box
  layoutTextEntity(entity, size)
}

function setFont(element, font) {
  const current = Number(element.typography?.size_pt)
  if (!(current > 0) || Math.abs(current - font) < 0.01) return
  if (element.__original_size_pt == null) element.__original_size_pt = current
  const typography = { ...element.typography, size_pt: Number(font.toFixed(2)) }
  if (Number(typography.line_height_pt) > 0) {
    typography.line_height_pt = Number((typography.line_height_pt * font / current).toFixed(2))
  }
  element.typography = typography
}

function unitEntities(unit) {
  return [...new Set(unit.items.map((item) => item.entity).filter(Boolean))]
}

function moveUnit(unit, dx, dy, size) {
  for (const item of unit.items) {
    item.box = { ...item.box, x: item.box.x + dx, y: item.box.y + dy }
    item.ink = { ...item.ink, x: item.ink.x + dx, y: item.ink.y + dy }
    writeBox(item.element, item.box, size)
  }
  for (const entity of unitEntities(unit)) {
    entity.box = { ...entity.box, x: entity.box.x + dx, y: entity.box.y + dy }
    if (entity.grouped) for (const member of entity.members) writeGroupBox(member.element, entity.box, size)
  }
  unit.occ = { ...unit.occ, x: unit.occ.x + dx, y: unit.occ.y + dy }
}

function unitScaleFloor(unit) {
  const fonts = unit.items.filter((item) => item.text)
    .map((item) => Number(item.element.typography?.size_pt)).filter((font) => font > 0)
  const smallest = fonts.length ? Math.min(...fonts) : null
  if (!smallest) return UNIT_SCALE_FLOOR
  const byFont = smallest > MIN_FONT_PT ? MIN_FONT_PT / smallest : 1
  return Math.min(1, Math.max(UNIT_SCALE_FLOOR, smallest && smallest <= MIN_FONT_PT ? 1 : byFont))
}


function scaleUnitAround(unit, factor, origin, size) {
  for (const item of unit.items) {
    const box = {
      x: origin.x + (item.box.x - origin.x) * factor,
      y: origin.y + (item.box.y - origin.y) * factor,
      width: item.box.width * factor,
      height: item.box.height * factor,
    }
    item.box = box
    writeBox(item.element, box, size)
    if (item.text) setFont(item.element, Number(item.element.typography.size_pt) * factor)
    else item.ink = { ...box, overflowPt: 0 }
  }
  for (const entity of unitEntities(unit)) {
    entity.box = {
      x: origin.x + (entity.box.x - origin.x) * factor,
      y: origin.y + (entity.box.y - origin.y) * factor,
      width: entity.box.width * factor,
      height: entity.box.height * factor,
    }
    if (entity.grouped) for (const member of entity.members) writeGroupBox(member.element, entity.box, size)
    layoutTextEntity(entity, size)
  }
  unit.occ = unionBox(unit.items.map((item) => (item.text ? item.ink : item.box)))
}

function scaleUnit(unit, factor, size) {
  const origin = { x: unit.occ.x, y: unit.occ.y }
  for (const item of unit.items) {
    const box = {
      x: origin.x + (item.box.x - origin.x) * factor,
      y: origin.y + (item.box.y - origin.y) * factor,
      width: item.box.width * factor,
      height: item.box.height * factor,
    }
    item.box = box
    writeBox(item.element, box, size)
    if (item.text) setFont(item.element, Number(item.element.typography.size_pt) * factor)
    else item.ink = { ...box, overflowPt: 0 }
  }
  for (const entity of unitEntities(unit)) {
    entity.box = {
      x: origin.x + (entity.box.x - origin.x) * factor,
      y: origin.y + (entity.box.y - origin.y) * factor,
      width: entity.box.width * factor,
      height: entity.box.height * factor,
    }
    if (entity.grouped) for (const member of entity.members) writeGroupBox(member.element, entity.box, size)
    layoutTextEntity(entity, size)
  }
  unit.occ = unionBox(unit.items.map((item) => (item.text ? item.ink : item.box)))
}

function boundsFor(unit, safe) {
  return unit.dynamic ? safe : slideBounds()
}

// a) Fit text into its box: grow into free space, then shrink to a floor.
function fitTexts(slide, report, safe, titleIds, corrections, strictImages = false) {
  const { size, items, entities } = buildLayoutUnits(slide, report, { titleIds })
  const obstacles = fixedObstacles(slide, strictImages).filter((obstacle) => obstacle.kind === 'picture')
  const layers = titleLayerObstacles(slide, size)
  const bodySafe = bodySafeAreaFor(report, slide)
  const gap = MIN_GAP_PT / size.height
  const tolerance = HIT_TOLERANCE_PT / size.height
  let changed = false
  for (const entity of entities) {
    if (entity.stale) {
      setEntityBox(entity, entity.box, size)
      for (const member of entity.members) writeGroupBox(member.element, entity.box, size)
      corrections.push({ op: 'sync_group', group: entity.id })
      changed = true
    }
    if (fitWords(entity, items, safe, obstacles, size, corrections, bodySafe)) changed = true
    if (regrowTitleFont(entity, size, corrections)) changed = true
    const lead = entity.members[0]
    const dynamic = entity.members.some((member) => member.dynamic)
    // Every text stays inside its safe area: a template title inside the safe
    // area (or its own original frame when the template puts it outside),
    // body text inside the margins + body placeholders (or its own original
    // frame; generated text: no excuse) — never up to the bare slide edge.
    const titleEntity = !dynamic && entity.members.some((member) => member.title)
    const bounds = titleEntity ? titleGrowBounds(lead, safe, bodySafe) : textBoundsFor(entity, bodySafe)
    const outsideBy = () => Math.max(...entity.members.map((member) => beyondPt(member.ink, bounds, size)))
    if (entity.overflowPt <= HIT_TOLERANCE_PT && outsideBy() <= HIT_TOLERANCE_PT) continue
    // Correction order: widen sideways into free space, then grow toward the
    // anchor inside the bounds, then shrink the font.
    if (entity.single || entity.direction !== 'row') {
      if (widenTextEntity(entity, items, bounds, obstacles, layers, size, corrections)) changed = true
      if (entity.overflowPt <= HIT_TOLERANCE_PT && outsideBy() <= HIT_TOLERANCE_PT) continue
    }
    const box = entity.box
    // The plate behind the text is its background, not a neighbour.
    const behind = (other) => !other.text && centreInside(box, other.box)
    const others = [
      ...items.filter((other) => other.entity !== entity && !behind(other)
        && overlapExtent(box, other.text ? other.ink : other.box).width * size.width > HIT_TOLERANCE_PT)
        .map((other) => (other.text ? other.ink : other.box)),
      ...pictureBlockers(obstacles, box),
      // Layout art, shapes, lines and template text a title did not touch in
      // its original frame: growing (e.g. a bottom-anchored title upwards)
      // must stop before them.
      ...newLayerObstacles(layers, entityFrame0(entity) || box, size).map((layer) => layer.box)
        .filter((other) => overlapExtent(box, other).width * size.width > HIT_TOLERANCE_PT),
    ]
    // Neighbours limit the band on the side of their centre, including ones
    // that already intrude into the box (the text must not grow over them).
    const centre = box.y + box.height / 2
    const isBelow = (other) => other.y >= bottomOf(box) - tolerance
      || (bottomOf(other) > box.y + tolerance && other.y + other.height / 2 >= centre)
    const below = others.filter(isBelow).map((other) => other.y - gap)
    const above = others.filter((other) => !isBelow(other)).map((other) => bottomOf(other) + gap)
    const limitBottom = Math.min(bottomOf(bounds), ...below)
    const limitTop = Math.max(bounds.y, ...above)
    const anchor = entity.single ? resolveVerticalAnchor(lead.element) : normalizeVerticalAnchor(entity.anchor)
    // Free band around the box (neighbours' ink + min gap); the box grows from
    // its anchor edge and only slides inside the band when that side is blocked.
    const regionTop = limitTop
    const regionBottom = Math.max(limitTop, limitBottom)
    const available = regionBottom - regionTop
    const place = (height) => {
      const preferred = anchor === 'b' ? bottomOf(box) - height
        : anchor === 'ctr' ? box.y - (height - box.height) / 2
          : box.y
      const y = Math.min(Math.max(preferred, regionTop), regionBottom - height)
      return { ...box, y, height }
    }
    const needed = box.height + entity.overflowPt / size.height
    if (needed <= available + tolerance / 2) {
      // A box taller than its band (sticking out of the bounds) is cut to it.
      setEntityBox(entity, place(Math.max(Math.min(box.height, available), needed)), size)
      corrections.push({ op: 'grow', element_id: lead.element.element_id, height_pt: Number((needed * size.height).toFixed(1)) })
      changed = true
      continue
    }
    // Shrink every member by one factor, each down to its role floor.
    const originals = entity.members.map((member) => Number(member.element.typography?.size_pt) || 0)
    const leadInsets = bodyInsetsPt(lead.element)
    const singlePadPt = entity.single ? leadInsets.top + leadInsets.bottom : 0
    const floors = entity.members.map((member) => fontFloor(member))
    // Not even one line at the floor fits in the band: leave it to unit
    // separation (step b) instead of collapsing the box.
    const oneLinePt = Math.max(...floors.map((floor) => floor * 1.1))
    if (available * size.height < oneLinePt) continue
    const heightAt = (factor) => {
      const probes = entity.members.map((member, index) => {
        const font = Math.max(floors[index], originals[index] * factor)
        const typography = { ...member.element.typography, size_pt: font }
        if (Number(member.element.typography?.line_height_pt) > 0 && originals[index] > 0) {
          typography.line_height_pt = member.element.typography.line_height_pt * font / originals[index]
        }
        return { ...member.element, typography }
      })
      const widthPt = box.width * size.width
      const heights = probes.map((probe) => estimateTextInkHeightPt(probe, widthPt) ?? 0)
      if (entity.single) return heights[0] + singlePadPt
      return entity.direction === 'row'
        ? Math.max(...heights)
        : heights.reduce((sum, value) => sum + value, 0) + entity.gapPt * Math.max(0, heights.length - 1)
    }
    let factor = null
    const minFactor = Math.min(...originals.map((font, index) => (font > 0 ? floors[index] / font : 1)))
    for (let probe = 0.97; probe >= minFactor - 0.001; probe -= 0.03) {
      if (heightAt(probe) <= available * size.height + HIT_TOLERANCE_PT) {
        factor = probe
        break
      }
    }
    const applied = factor ?? minFactor
    if (applied < 0.999) {
      entity.members.forEach((member, index) => {
        if (originals[index] > 0) setFont(member.element, Math.max(floors[index], originals[index] * applied))
      })
      const height = Math.min(available, Math.max(box.height, heightAt(applied) / size.height))
      setEntityBox(entity, place(height), size)
      corrections.push({ op: 'shrink', element_id: lead.element.element_id, factor: Number(applied.toFixed(3)), fits: factor != null })
      changed = true
    } else if (available > box.height + tolerance) {
      setEntityBox(entity, place(available), size)
      changed = true
    }
  }
  return changed
}

// A title shrunk earlier (its band was short before the content below moved
// or the frame grew) gets its font back, up to the original size, as far as
// its current frame allows: shrinking is the last resort, not a leftover.
function regrowTitleFont(entity, size, corrections) {
  if (!entity.single) return false
  const item = entity.members[0]
  const element = item.element
  if (!item.title || item.dynamic || String(element.wrap ?? '').toLowerCase() === 'none') return false
  const original = Number(element.__original_size_pt)
  const font = Number(element.typography?.size_pt)
  if (!(original > font + 0.05) || entity.overflowPt > -HIT_TOLERANCE_PT) return false
  const insets = bodyInsetsPt(element)
  const widthPt = entity.box.width * size.width
  const roomPt = entity.box.height * size.height - insets.top - insets.bottom
  const areaPt = textAreaWidthPt(element, widthPt)
  let best = null
  for (let factor = 1; original * factor > font + 0.05; factor -= 0.03) {
    const next = original * factor
    const typography = { ...element.typography, size_pt: next }
    if (Number(element.typography?.line_height_pt) > 0) typography.line_height_pt = element.typography.line_height_pt * next / font
    const heightPt = estimateTextInkHeightPt({ ...element, typography }, widthPt)
    if (heightPt == null || heightPt > roomPt - 0.5) continue
    const wrap = wrapText(String(element.text), areaPt, next, typography)
    if (wrap.overflowWord || wrap.orphans.length) continue
    best = next
    break
  }
  if (best == null) return false
  setFont(element, best)
  layoutTextEntity(entity, size)
  corrections.push({ op: 'regrow_font', element_id: element.element_id, font_pt: Number(best.toFixed(2)) })
  return true
}

// Word-level fixes for one text entity: glue 1–2 character last lines with a
// no-break space, then make the widest word fit: widen the frame into free
// horizontal space (alignment kept, inside the card plate / bounds, clear of
// neighbours), then shrink the font of the member down to its role floor.
function fitWords(entity, items, safe, obstacles, size, corrections, bodySafe = null) {
  let changed = false
  const frameWidthPt = (member) => (entity.single || entity.direction !== 'row' ? entity.box.width : member.box.width) * size.width
  for (const member of entity.members) {
    if (member.ink.orphan == null) continue
    const font = Number(member.element.typography?.size_pt) || 0
    const areaPt = textAreaWidthPt(member.element, frameWidthPt(member))
    const glued = font > 0 ? glueOrphans(member.element.text, areaPt, font, member.element.typography || {}, { allowOverflow: true }) : null
    if (glued == null) continue
    member.element.text = glued
    corrections.push({ op: 'glue_orphan', element_id: member.element.element_id })
    changed = true
  }
  if (changed) layoutTextEntity(entity, size)
  // A word wider than the frame, or a wrap="none" line wider than it.
  const tooWide = (member) => member.ink.wordTooWide || member.ink.noWrapOverflow
  const wide = entity.members.filter(tooWide)
  if (!wide.length) return changed
  const box = entity.box
  const lead = entity.members[0]
  const insetPt = (member) => frameWidthPt(member) - textAreaWidthPt(member.element, frameWidthPt(member))
  if (entity.single || entity.direction !== 'row') {
    const neededPt = Math.max(...wide.map((member) => member.ink.widePt + insetPt(member))) + 1
    const needed = neededPt / size.width
    const gapX = MIN_GAP_PT / size.width
    const titleEntity = !entity.members.some((member) => member.dynamic) && entity.members.some((member) => member.title)
    const bounds = titleEntity ? titleGrowBounds(lead, safe, bodySafe) : boundsFor(lead.unit, safe)
    let left = bounds.x
    let right = rightOf(bounds)
    // A card plate behind the text is its container.
    for (const plate of lead.unit.items) {
      if (plate.text || !centreInside(box, plate.box)) continue
      left = Math.max(left, plate.box.x + gapX / 2)
      right = Math.min(right, rightOf(plate.box) - gapX / 2)
    }
    const centreX = box.x + box.width / 2
    const neighbours = [
      ...items.filter((other) => other.entity !== entity && other.unit !== lead.unit)
        .map((other) => (other.text ? other.ink : other.box)),
      ...pictureBlockers(obstacles, box),
    ].filter((other) => overlapExtent(box, other).height * size.height > HIT_TOLERANCE_PT)
    for (const other of neighbours) {
      if (other.x + other.width / 2 < centreX) left = Math.max(left, Math.min(box.x, rightOf(other) + gapX))
      else right = Math.min(right, Math.max(rightOf(box), other.x - gapX))
    }
    const room = right - left
    const width = Math.min(needed, room)
    if (width > box.width + 0.001) {
      const align = String(lead.element.typography?.alignment || 'l').toLowerCase()
      const preferred = ['ctr', 'center', 'c'].includes(align) ? centreX - width / 2
        : ['r', 'right'].includes(align) ? rightOf(box) - width : box.x
      const x = Math.min(Math.max(preferred, left), right - width)
      setEntityBox(entity, { ...box, x, width }, size)
      corrections.push({ op: 'widen', element_id: lead.element.element_id, width_pt: Number((width * size.width).toFixed(1)) })
      changed = true
    }
  }
  for (const member of entity.members) {
    if (!tooWide(member)) continue
    const font = Number(member.element.typography?.size_pt) || 0
    if (!(font > 0)) continue
    const areaPt = textAreaWidthPt(member.element, frameWidthPt(member))
    const target = font * (areaPt / member.ink.widePt) * 0.995
    const floor = fontFloor(member)
    if (target < floor - 0.01) continue
    setFont(member.element, target)
    corrections.push({ op: 'shrink_word', element_id: member.element.element_id, font_pt: Number(target.toFixed(2)) })
    changed = true
  }
  if (changed) layoutTextEntity(entity, size)
  return changed
}

function layoutLayerBlockers(slide) {
  return (slide?.render?.layers || []).flatMap((layer) => {
    const box = finiteBox(layer.geometry_norm)
    if (!box || areaOf(box) < MIN_OBSTACLE_AREA || areaOf(box) >= STRICT_BACKDROP_AREA) return []
    return [{ box, kind: 'layer', id: layer.layer_id || layer.name || 'layer' }]
  })
}

const FRAME0_KEY = '__frame0_norm'

// The frame a text had when the hit-test started (before any grow/move).
function frame0Of(item) {
  return finiteBox(item.element?.[FRAME0_KEY]) || item.box
}

const GROUP_FRAME0_KEY = '__group_frame0_norm'

// Original frames of a text entity (members and their group box).
function entityFrame0(entity) {
  return unionBox(entity.members.flatMap((member) => [frame0Of(member), finiteBox(member.element?.[GROUP_FRAME0_KEY])]))
}

// Body text stays inside the body safe area, or its own original frame when
// the template put it outside; generated text (synthetic boxes) has no such
// excuse.
function textBoundsFor(entity, bodySafe) {
  if (entity.members.some((member) => member.element?.synthetic)) return bodySafe
  return { ...clip01(unionBox([bodySafe, entityFrame0(entity)])), source: 'text' }
}

function itemTextBounds(item, bodySafe) {
  if (item.element?.synthetic) return bodySafe
  return unionBox([bodySafe, frame0Of(item), finiteBox(item.element?.[GROUP_FRAME0_KEY])])
}

function entityNeedPt(entity, width, size) {
  const widthPt = width * size.width
  const heights = entity.members.map((member) => estimateTextInkHeightPt(member.element, widthPt) ?? member.box.height * size.height)
  if (entity.single) {
    const insets = bodyInsetsPt(entity.members[0].element)
    return heights[0] + insets.top + insets.bottom
  }
  return heights.reduce((sum, value) => sum + value, 0) + entity.gapPt * Math.max(0, heights.length - 1)
}

// Step a1: widen a text sideways into free space inside its bounds (card
// plate, neighbours, pictures, layout art/lines/text it did not touch), just
// enough to fit its current height (clipped into the bounds), keeping the
// alignment side; a box sticking out of its bounds is brought inside.
function widenTextEntity(entity, items, bounds, obstacles, layers, size, corrections) {
  const lead = entity.members[0]
  const box = entity.box
  const gapX = MIN_GAP_PT / size.width
  let left = bounds.x
  let right = rightOf(bounds)
  for (const plate of lead.unit.items) {
    if (plate.text || !centreInside(box, plate.box)) continue
    left = Math.max(left, plate.box.x + gapX / 2)
    right = Math.min(right, rightOf(plate.box) - gapX / 2)
  }
  const centreX = box.x + box.width / 2
  // Layout art/lines/text: a layer holding the text is its container (stay
  // inside it); any other layer beside it is never widened into further, even
  // one the template frame already touched (e.g. a photo edge).
  const layerBoxes = []
  for (const layer of layers) {
    if (sharedArea(layer.box, box) >= CONTAINER_SHARE * areaOf(box)) {
      left = Math.max(left, Math.min(box.x, layer.box.x + gapX / 2))
      right = Math.min(right, Math.max(rightOf(box), rightOf(layer.box) - gapX / 2))
    } else layerBoxes.push(layer.box)
  }
  const neighbours = [
    ...items.filter((other) => other.entity !== entity && other.unit !== lead.unit && !(!other.text && centreInside(box, other.box)))
      .map((other) => (other.text ? other.ink : other.box)),
    ...pictureBlockers(obstacles, box),
    ...layerBoxes,
  ].filter((other) => overlapExtent(box, other).height * size.height > HIT_TOLERANCE_PT)
  for (const other of neighbours) {
    if (other.x + other.width / 2 < centreX) left = Math.max(left, Math.min(box.x, rightOf(other) + gapX))
    else right = Math.min(right, Math.max(rightOf(box), other.x - gapX))
  }
  const room = right - left
  if (room <= 0.01) return false
  const current = Math.min(box.width, room)
  const targetPt = (Math.min(bottomOf(box), bottomOf(bounds)) - Math.max(box.y, bounds.y)) * size.height
  const fitsAt = (width) => entityNeedPt(entity, width, size) <= targetPt + HIT_TOLERANCE_PT
  const inside = box.x >= left - 1e-6 && rightOf(box) <= right + 1e-6
  const canWrapVertically = entity.members.every((member) => (
      String(member.element?.wrap ?? '').trim().toLowerCase() !== 'none'
      && !member.ink.wordTooWide
      && !member.ink.noWrapOverflow
    ))
  const verticalRoomPt = Math.max(0, (bottomOf(bounds) - Math.max(bounds.y, box.y)) * size.height)
  if (inside && canWrapVertically && entityNeedPt(entity, current, size) <= verticalRoomPt + HIT_TOLERANCE_PT) {
    return false
  }

  const cap = Math.min(room, Math.max(current, WIDEN_CAP))
  let width = current
  if (!fitsAt(current) && cap > current + 0.002) {
    if (fitsAt(cap)) {
      let lo = current
      let hi = cap
      for (let step = 0; step < 10; step += 1) {
        const mid = (lo + hi) / 2
        if (fitsAt(mid)) hi = mid
        else lo = mid
      }
      width = hi
    } else if (entityNeedPt(entity, cap, size) < entityNeedPt(entity, current, size) - 0.5) {
      width = cap
    }
  }
  if (Math.abs(width - box.width) < 0.002 && inside) return false
  const align = normalizeAlignment(lead.element.typography?.alignment)
  const preferred = align === 'ctr' ? centreX - width / 2 : align === 'r' ? rightOf(box) - width : box.x
  const x = Math.min(Math.max(preferred, left), right - width)
  setEntityBox(entity, { ...box, x, width }, size)
  corrections.push({
    op: width > box.width + 1e-6 ? 'widen_text' : 'fit_into_safe',
    element_id: lead.element.element_id,
    width_pt: Number((width * size.width).toFixed(1)),
  })
  return true
}

// Titles may use their template slot / original frame vertically, but
// sideways they stay inside the body safe area (content margins + body
// slots): a full-width title slot must not carry right-aligned ink to the
// slide edge.
function titleGrowBounds(item, safe, bodySafe = null) {
  const vertical = clip01(unionBox([safe, frame0Of(item)]))
  if (!bodySafe) return { ...vertical, source: 'title' }
  return { x: bodySafe.x, width: bodySafe.width, y: vertical.y, height: vertical.height, source: 'title' }
}

// Layout layers a title must not grow or overflow into: art, shapes, lines
// and template text that are not the backdrop. Lines get a 1pt thickness so a
// divider above/below a title counts.
function titleLayerObstacles(slide, size) {
  return (slide?.render?.layers || []).flatMap((layer) => {
    const raw = layer.geometry_norm
    if (!raw) return []
    const box = {
      x: Number(raw.x),
      y: Number(raw.y),
      width: Math.max(Number(raw.width), 1 / size.width),
      height: Math.max(Number(raw.height), 1 / size.height),
    }
    if (![box.x, box.y, box.width, box.height].every(Number.isFinite)) return []
    const area = areaOf(box)
    if (area >= STRICT_BACKDROP_AREA || (box.width >= FULL_BLEED && box.height >= FULL_BLEED)) return []
    const thin = layer.kind === 'line' || Math.min(box.width * size.width, box.height * size.height) <= 3
    const keep = area >= MIN_OBSTACLE_AREA || layer.kind === 'text' || (thin && Math.max(box.width, box.height) >= 0.05)
    if (!keep) return []
    return [{ box, kind: layer.kind, id: layer.layer_id || layer.name || layer.kind || 'layer' }]
  })
}

// Layers the original frame did not touch (a title that already sits on a
// shape by design keeps it).
function newLayerObstacles(layers, frame0, size) {
  return layers.filter((layer) => !hits(frame0, layer.box, size))
}

function beyondPt(box, bounds, size) {
  return Math.max(
    (bounds.x - box.x) * size.width,
    (bounds.y - box.y) * size.height,
    (rightOf(box) - rightOf(bounds)) * size.width,
    (bottomOf(box) - bottomOf(bounds)) * size.height,
  )
}

// Pictures a box must not grow or move into (one that already holds the box
// is its container, not an obstacle).
function pictureBlockers(obstacles, box) {
  return obstacles.filter((obstacle) => sharedArea(obstacle.box, box) < CONTAINER_SHARE * areaOf(box))
    .map((obstacle) => obstacle.box)
}

function titleGraphicObstacles(items) {
  return items
    .filter((item) => ['chart', 'table', 'diagram', 'image'].includes(item.element?.kind))
    .map((item) => ({ box: item.box, id: item.element.element_id || item.element.kind, kind: item.element.kind }))
}

// Keep the template's gap below the title: move the content below down (all
// movable units under the title line), else the title up, else both.
function enforceTitleGap(slide, report, safe, titleIds, corrections, strictImages = false) {
  const { size, items, units } = buildLayoutUnits(slide, report, { titleIds })
  const info = titleGapInfo(report, slide, items, units, size, titleIds)
  if (!info || info.gapPt >= info.requiredPt - HIT_TOLERANCE_PT) return false
  const deficit = (info.requiredPt - info.gapPt) / size.height
  const tolerance = HIT_TOLERANCE_PT / size.height
  const gapY = MIN_GAP_PT / size.height
  // Moving text onto any layout art/shape (not a backdrop) is never an improvement.
  const obstacles = layoutLayerBlockers(slide)
  const chain = units.filter((unit) => unit.movable && unit !== info.title && unit.occ
    && unit.occ.y >= bottomOf(info.band) - tolerance)
  let roomDown = Infinity
  for (const unit of chain) {
    roomDown = Math.min(roomDown, bottomOf(boundsFor(unit, safe)) - bottomOf(unit.occ))
    const blockers = [
      // Decoration counts too: a shape the unit does not overlap yet must not
      // end up under it (plates/backdrops already behind it start above it).
      ...units.filter((other) => other !== unit && !chain.includes(other) && other.occ && other !== info.title)
        .map((other) => other.occ),
      ...pictureBlockers(obstacles, unit.occ),
    ]
    for (const other of blockers) {
      if (other.y < bottomOf(unit.occ) - tolerance) continue
      if (overlapExtent(unit.occ, other).width * size.width <= HIT_TOLERANCE_PT) continue
      roomDown = Math.min(roomDown, other.y - gapY - bottomOf(unit.occ))
    }
  }
  const down = Math.max(0, Math.min(deficit, Number.isFinite(roomDown) ? roomDown : 0))
  let up = 0
  let rest = deficit - down
  // A chart is drawn into any box: give up the missing gap from its top
  // (the title keeps its template position) while it stays readable.
  let trim = 0
  const charts = chain.filter((unit) => unit.items.length === 1 && unit.items[0].element?.kind === 'chart'
    && unit.occ.y < bottomOf(info.band) + info.requiredPt / size.height + tolerance)
  if (rest > 1e-4 && charts.length) {
    const room = Math.min(...charts.map((unit) => unit.items[0].box.height - CHART_MIN_HEIGHT_PT / size.height))
    trim = Math.max(0, Math.min(rest, room))
    rest -= trim
  }
  if (rest > 1e-4 && info.title.movable && info.title.occ) {
    const occ = info.title.occ
    let top = Math.max(slideBounds().y, Math.min(safe.y, occ.y))
    for (const other of units) {
      if (other === info.title || !other.occ || chain.includes(other)) continue
      if (bottomOf(other.occ) > occ.y + tolerance) continue
      if (overlapExtent(occ, other.occ).width * size.width <= HIT_TOLERANCE_PT) continue
      top = Math.max(top, bottomOf(other.occ) + gapY)
    }
    for (const other of pictureBlockers(obstacles, occ)) {
      if (bottomOf(other) > occ.y + tolerance) continue
      if (overlapExtent(occ, other).width * size.width <= HIT_TOLERANCE_PT) continue
      top = Math.max(top, bottomOf(other) + gapY)
    }
    up = Math.max(0, Math.min(rest, occ.y - top))
  }
  if (down < 1e-4 && up < 1e-4 && trim < 1e-4) return false
  if (down >= 1e-4) for (const unit of chain) moveUnit(unit, 0, down, size)
  if (trim >= 1e-4) {
    for (const unit of charts) {
      const item = unit.items[0]
      item.box = { ...item.box, y: item.box.y + trim, height: item.box.height - trim }
      item.ink = { ...item.box }
      writeBox(item.element, item.box, size)
      unit.occ = { ...unit.occ, y: unit.occ.y + trim, height: unit.occ.height - trim }
    }
  }
  if (up >= 1e-4) moveUnit(info.title, 0, -up, size)
  corrections.push({
    op: 'title_gap',
    down_pt: Number((down * size.height).toFixed(1)),
    ...(trim >= 1e-4 ? { chart_trim_pt: Number((trim * size.height).toFixed(1)) } : {}),
    up_pt: Number((up * size.height).toFixed(1)),
    required_pt: Number(info.requiredPt.toFixed(1)),
  })
  return true
}

function unitsConflict(left, right, size) {
  for (const a of left.items) {
    for (const b of right.items) {
      if (itemConflict(a, b, size)) return true
    }
  }
  return false
}


function liftTitleAboveInitialComponents(slide, report, safe, titleIds, corrections) {
  const { size, units } = buildLayoutUnits(slide, report, { titleIds })
  const titles = units.filter((unit) => isTitleCandidateUnit(unit) && unit.movable && unit.occ)
  const components = units.filter((unit) => unit.dynamic && !unit.title && unit.occ)
  let changed = false
  const top = Math.max(0, safe?.y ?? 0)
  const bottom = Math.min(1, (safe?.y ?? 0) + (safe?.height ?? 1))
  const gapY = MIN_GAP_PT / size.height
  for (const title of titles) {
    const hasHit = components.some((component) => unitsConflict(title, component, size))
    if (!hasHit) continue
    const dy = top - title.occ.y
    if (dy < -1e-4) {
      moveUnit(title, 0, dy, size)
      corrections.push({
        op: 'lift_title',
        units: [title.id],
        dy: Number(dy.toFixed(4)),
        reason: 'title_component_overlap',
      })
      changed = true
    }

    const targetY = bottomOf(title.occ) + gapY
    const availableHeight = bottom - targetY
    const group = unionBox(components.map((component) => component.occ))
    if (!group || !(availableHeight > 0.04)) continue

    const maxScale = Math.min(1, availableHeight / group.height)
    if (maxScale < 0.999) {
      const floor = Math.max(...components.map(unitScaleFloor))
      const factor = Math.max(floor, maxScale)
      for (const component of components) scaleUnitAround(component, factor, group, size)
      corrections.push({
        op: 'scale_group',
        units: components.map((component) => component.id),
        factor: Number(factor.toFixed(3)),
        reason: 'below_lifted_title',
      })
      changed = true
    }

    const scaledGroup = unionBox(components.map((component) => component.occ))
    const moveY = targetY - scaledGroup.y
    if (Math.abs(moveY) > 1e-4) {
      for (const component of components) moveUnit(component, 0, moveY, size)
      corrections.push({
        op: 'move_group',
        units: components.map((component) => component.id),
        dx: 0,
        dy: Number(moveY.toFixed(4)),
        away_from: title.id,
        reason: 'below_lifted_title',
      })
      changed = true
    }
  }
  return changed
}

function textRowSignature(unit) {
  if (!unit?.text || unit.title || unit.dynamic || !unit.occ) return null
  const textItems = unit.items.filter((item) => item.text)
  if (textItems.length !== unit.items.length || textItems.length !== 1) return null
  const frame = textItems[0].box || unit.occ
  const typography = textItems[0].element.typography || {}
  const font = Number(typography.size_pt) || 0
  if (!(font > 0)) return null
  return [
    unit.kind,
    font.toFixed(1),
    String(typography.family || ''),
    String(typography.color || ''),
    (frame.width * 100).toFixed(1),
    (frame.height * 100).toFixed(1),
  ].join('|')
}

function alignRepeatedTextRows(slide, report, safe, titleIds, corrections) {
  const { size, units } = buildLayoutUnits(slide, report, { titleIds })
  const groups = new Map()
  for (const unit of units) {
    const signature = textRowSignature(unit)
    if (!signature) continue
    if (!groups.has(signature)) groups.set(signature, [])
    groups.get(signature).push(unit)
  }
  let changed = false
  const yTolerance = 36 / size.height
  for (const group of groups.values()) {
    if (group.length < 2) continue
    const sorted = [...group].sort((left, right) => left.occ.x - right.occ.x)
    const rows = []
    for (const unit of sorted) {
      const center = unit.occ.y + unit.occ.height / 2
      const row = rows.find((candidate) => Math.abs(candidate.center - center) <= yTolerance)
      if (row) {
        row.units.push(unit)
        row.center = row.units.reduce((sum, item) => sum + item.occ.y + item.occ.height / 2, 0) / row.units.length
      } else {
        rows.push({ center, units: [unit] })
      }
    }
    for (const row of rows) {
      if (row.units.length < 2) continue
      const targetY = Math.max(...row.units.map((unit) => unit.occ.y))
      const bounds = boundsFor(row.units[0], safe)
      const moved = []
      for (const unit of row.units) {
        const dy = targetY - unit.occ.y
        if (dy <= 1e-4) continue
        const box = { ...unit.occ, y: unit.occ.y + dy }
        if (outside(box, bounds, 0.002)) continue
        moveUnit(unit, 0, dy, size)
        moved.push(unit.id)
        changed = true
      }
      if (moved.length) {
        corrections.push({
          op: 'align_text_row',
          units: row.units.map((unit) => unit.id),
          moved,
          y: Number(targetY.toFixed(4)),
        })
      }
    }
  }
  return changed
}

function unitObstacleConflict(unit, obstacles, size) {
  return obstacles.find((obstacle) => unit.items.some((item) => (
    obstacleConflict(item, obstacle, size)?.severity === 'error'
  ))) || null
}

function occupiedByOthers(units, mover, obstacles) {
  return [
    ...units.filter((unit) => unit !== mover && unit.occ).map((unit) => unit.occ),
    ...(mover.dynamic ? obstacles.map((obstacle) => obstacle.box) : []),
  ]
}

function placementFree(box, units, mover, obstacles, size, bounds) {
  if (outside(box, bounds, 0.002)) return false
  return !occupiedByOthers(units, mover, obstacles).some((other) => hits(box, other, size))
}

function similarTextRowPeers(units, mover, size) {
  if (!mover?.text || mover.title || mover.dynamic || !mover.occ) return [mover]
  const yTolerance = Math.max(8 / size.height, mover.occ.height * 0.65)
  const heightTolerance = Math.max(4 / size.height, mover.occ.height * 0.45)
  const centerY = mover.occ.y + mover.occ.height / 2
  return units.filter((unit) => {
    if (unit === mover) return true
    if (!unit.movable || !unit.text || unit.title || unit.dynamic || !unit.occ) return false
    if (unit.kind !== mover.kind || unit.priority !== mover.priority) return false
    if (Math.abs(unit.occ.height - mover.occ.height) > heightTolerance) return false
    const unitCenterY = unit.occ.y + unit.occ.height / 2
    return Math.abs(unitCenterY - centerY) <= yTolerance
  }).sort((left, right) => left.occ.x - right.occ.x)
}

function placementFreeForGroup(group, mover, dx, dy, units, obstacles, size, bounds) {
  for (const unit of group) {
    const moved = { ...unit.occ, x: unit.occ.x + dx, y: unit.occ.y + dy }
    if (outside(moved, bounds, 0.002)) return false
    const occupied = [
      ...units.filter((other) => !group.includes(other) && other !== mover && other.occ).map((other) => other.occ),
      ...(mover.dynamic ? obstacles.map((obstacle) => obstacle.box) : []),
    ]
    if (occupied.some((other) => hits(moved, other, size))) return false
  }
  return true
}

// Column/row of same-kind units around `anchor`, restacked with a min gap
// inside the free region, uniformly scaled to a floor when needed.
function restackChain(units, anchor, mover, axis, size, safe, obstacles, corrections) {
  const vertical = axis === 'y'
  const start = (box) => (vertical ? box.y : box.x)
  const end = (box) => (vertical ? bottomOf(box) : rightOf(box))
  const crossStart = (box) => (vertical ? box.x : box.y)
  const crossEnd = (box) => (vertical ? rightOf(box) : bottomOf(box))
  const inFlow = (unit) => unit.movable && unit.occ && unit.priority === mover.priority && unit.kind === mover.kind
    && spanShare(crossStart(unit.occ), crossEnd(unit.occ), crossStart(mover.occ), crossEnd(mover.occ)) >= FLOW_OVERLAP
  const chain = units.filter((unit) => unit === mover || (unit === anchor && inFlow(unit)) || (unit !== anchor && inFlow(unit)))
    .sort((left, right) => start(left.occ) - start(right.occ))
  if (!chain.includes(mover)) chain.push(mover)
  const bounds = boundsFor(mover, safe)
  const gap = MIN_GAP_PT / (vertical ? size.height : size.width)
  const fixed = [
    ...units.filter((unit) => !chain.includes(unit) && unit.occ).map((unit) => unit.occ),
    ...(mover.dynamic ? obstacles.map((obstacle) => obstacle.box) : []),
  ].filter((box) => spanShare(crossStart(box), crossEnd(box),
    Math.min(...chain.map((unit) => crossStart(unit.occ))), Math.max(...chain.map((unit) => crossEnd(unit.occ)))) > 0)
  const firstStart = start(chain[0].occ)
  const regionStart = Math.max(vertical ? bounds.y : bounds.x,
    ...fixed.filter((box) => end(box) <= firstStart + gap).map((box) => end(box) + gap))
  const regionEnd = Math.min(vertical ? bottomOf(bounds) : rightOf(bounds),
    ...fixed.filter((box) => start(box) >= regionStart && !chain.some((unit) => hits(box, unit.occ, size)))
      .filter((box) => start(box) > firstStart).map((box) => start(box) - gap))
  const lengths = chain.map((unit) => end(unit.occ) - start(unit.occ))
  const gaps = chain.slice(1).map((unit, index) => Math.max(gap, start(unit.occ) - end(chain[index].occ)))
  let total = lengths.reduce((sum, value) => sum + value, 0) + gaps.reduce((sum, value) => sum + value, 0)
  if (total > regionEnd - Math.max(regionStart, firstStart)) {
    gaps.fill(gap)
    total = lengths.reduce((sum, value) => sum + value, 0) + gap * gaps.length
  }
  let factor = 1
  const room = regionEnd - regionStart
  if (total > room) {
    factor = (room - gap * gaps.length) / lengths.reduce((sum, value) => sum + value, 0)
    const floor = Math.max(...chain.map(unitScaleFloor))
    if (!(factor >= floor)) return false
  }
  if (factor < 0.999) {
    for (const unit of chain) scaleUnit(unit, factor, size)
    total = chain.reduce((sum, unit) => sum + end(unit.occ) - start(unit.occ), 0) + gap * gaps.length
    gaps.fill(gap)
  }
  let cursor = Math.min(Math.max(firstStart, regionStart), regionEnd - total)
  chain.forEach((unit, index) => {
    const delta = cursor - start(unit.occ)
    if (Math.abs(delta) > 1e-6) moveUnit(unit, vertical ? 0 : delta, vertical ? delta : 0, size)
    cursor = end(unit.occ) + (gaps[index] ?? gap)
  })
  corrections.push({ op: 'restack', axis, units: chain.length, scale: Number(factor.toFixed(3)) })
  return true
}

// A lone text box that cannot move is narrowed/shortened away from the
// obstacle (text then reflows; step a grows or shrinks it next round).
function cropTextAway(mover, anchor, size, corrections) {
  const item = mover.items[0]
  const box = item.box
  const other = anchor.occ
  const gapX = MIN_GAP_PT / size.width
  const gapY = MIN_GAP_PT / size.height
  const options = [
    { ...box, width: other.x - gapX - box.x },
    { ...box, x: rightOf(other) + gapX, width: rightOf(box) - rightOf(other) - gapX },
    { ...box, height: other.y - gapY - box.y },
    { ...box, y: bottomOf(other) + gapY, height: bottomOf(box) - bottomOf(other) - gapY },
  ].filter((candidate) => candidate.width >= box.width * 0.4 && candidate.height > 0
    && candidate.width * size.width >= 40 && candidate.height * size.height >= 12)
    .sort((left, right) => areaOf(right) - areaOf(left))
  const chosen = options[0]
  if (!chosen) return false
  setEntityBox(item.entity, chosen, size)
  corrections.push({ op: 'crop', element_id: item.element.element_id, width: Number(chosen.width.toFixed(4)), height: Number(chosen.height.toFixed(4)) })
  return true
}

// b) Resolve overlaps by moving whole units along the layout flow.
function separateUnits(slide, report, safe, titleIds, corrections, strictImages = false) {
  const { size, units } = buildLayoutUnits(slide, report, { titleIds })
  const obstacles = fixedObstacles(slide, strictImages).filter((obstacle) => obstacle.kind === 'picture')
  let changed = false
  const ordered = [...units].sort((left, right) => right.priority - left.priority || left.occ.y - right.occ.y)
  for (const first of ordered) {
    for (const second of ordered) {
      if (first === second || !first.occ || !second.occ) continue
      if (!unitsConflict(first, second, size)) continue
      let mover
      if (!first.movable && !second.movable) continue
      if (!first.movable) mover = second
      else if (!second.movable) mover = first
      else if (first.priority !== second.priority) mover = first.priority < second.priority ? first : second
      else {
        const later = (unit) => unit.occ.y + unit.occ.height / 2 + (unit.occ.x + unit.occ.width / 2) * 0.01
        mover = later(first) >= later(second) ? first : second
      }
      const anchor = mover === first ? second : first
      const bounds = boundsFor(mover, safe)
      const gapY = MIN_GAP_PT / size.height
      const gapX = MIN_GAP_PT / size.width
      const below = mover.occ.y + mover.occ.height / 2 >= anchor.occ.y + anchor.occ.height / 2
      const rightSide = mover.occ.x + mover.occ.width / 2 >= anchor.occ.x + anchor.occ.width / 2
      const sameColumn = spanShare(mover.occ.x, rightOf(mover.occ), anchor.occ.x, rightOf(anchor.occ)) >= FLOW_OVERLAP
      const options = [
        { dx: 0, dy: below ? bottomOf(anchor.occ) + gapY - mover.occ.y : anchor.occ.y - gapY - bottomOf(mover.occ), axis: 'y' },
        { dx: rightSide ? rightOf(anchor.occ) + gapX - mover.occ.x : anchor.occ.x - gapX - rightOf(mover.occ), dy: 0, axis: 'x' },
      ].sort((left, right) => (
        (Math.abs(left.dx) + Math.abs(left.dy)) - (Math.abs(right.dx) + Math.abs(right.dy))
        || (left.axis === 'y' ? -1 : 1)
      ))
      if (sameColumn) options.sort((left) => (left.axis === 'y' ? -1 : 1))
      const sameFlow = anchor.movable && anchor.priority === mover.priority && anchor.kind === mover.kind
      let done = false
      if (!sameFlow) {
        for (const option of options) {
          const peers = anchor.title && mover.text && option.dy > 0
            ? similarTextRowPeers(units, mover, size)
            : [mover]
          if (!placementFreeForGroup(peers, mover, option.dx, option.dy, units, obstacles, size, bounds)) continue
          for (const peer of peers) moveUnit(peer, option.dx, option.dy, size)
          corrections.push({
            op: peers.length > 1 ? 'move_row' : 'move',
            units: peers.map((unit) => unit.id),
            dx: Number(option.dx.toFixed(4)),
            dy: Number(option.dy.toFixed(4)),
            away_from: anchor.id,
          })
          done = true
          break
        }
      }
      if (!done && mover.items.length === 1 && mover.items[0].entity?.single) {
        done = cropTextAway(mover, anchor, size, corrections)
      }
      if (!done) {
        const axis = sameColumn || !sameFlow ? 'y' : 'x'
        done = restackChain(units, anchor, mover, axis, size, safe, obstacles, corrections)
          || restackChain(units, anchor, mover, axis === 'y' ? 'x' : 'y', size, safe, obstacles, corrections)
      }
      if (done) changed = true
    }
    const blocked = first.movable && first.dynamic ? unitObstacleConflict(first, obstacles, size) : null
    if (blocked) {
      const gapY = MIN_GAP_PT / size.height
      const bounds = boundsFor(first, safe)
      const options = [
        { dx: 0, dy: bottomOf(blocked.box) + gapY - first.occ.y },
        { dx: 0, dy: blocked.box.y - gapY - bottomOf(first.occ) },
        { dx: rightOf(blocked.box) + gapY - first.occ.x, dy: 0 },
        { dx: blocked.box.x - gapY - rightOf(first.occ), dy: 0 },
      ].sort((left, right) => (Math.abs(left.dx) + Math.abs(left.dy)) - (Math.abs(right.dx) + Math.abs(right.dy)))
      for (const option of options) {
        const moved = { ...first.occ, x: first.occ.x + option.dx, y: first.occ.y + option.dy }
        if (!placementFree(moved, units, first, obstacles, size, bounds)) continue
        moveUnit(first, option.dx, option.dy, size)
        corrections.push({ op: 'move', units: [first.id], dx: option.dx, dy: option.dy, away_from: blocked.id })
        changed = true
        break
      }
    }
  }
  return changed
}

// c) Clamp units into their bounds, scaling uniformly down to a floor.
function clampUnits(slide, report, safe, titleIds, corrections) {
  const { size, units } = buildLayoutUnits(slide, report, { titleIds })
  let changed = false
  for (const unit of units) {
    if (!unit.movable || !unit.occ) continue
    // A template title whose text still overflows its frame (it did not fit
    // even at the font floor) is not shoved across the slide: moving cannot
    // fix it, the candidate is rejected instead.
    if (unit.title && !unit.dynamic && unit.items.some((item) => item.text && item.entity?.overflowPt > HIT_TOLERANCE_PT)) continue
    const bounds = boundsFor(unit, safe)
    if (!outside(unit.occ, bounds, 0.002)) continue
    if (unit.occ.width > bounds.width + 0.002 || unit.occ.height > bounds.height + 0.002) {
      const factor = Math.max(unitScaleFloor(unit), Math.min(bounds.width / unit.occ.width, bounds.height / unit.occ.height))
      if (factor < 0.999) {
        scaleUnit(unit, factor, size)
        corrections.push({ op: 'scale', units: [unit.id], scale: Number(factor.toFixed(3)) })
        changed = true
      }
    }
    const dx = unit.occ.x < bounds.x ? bounds.x - unit.occ.x
      : rightOf(unit.occ) > rightOf(bounds) ? Math.max(bounds.x - unit.occ.x, rightOf(bounds) - rightOf(unit.occ)) : 0
    const dy = unit.occ.y < bounds.y ? bounds.y - unit.occ.y
      : bottomOf(unit.occ) > bottomOf(bounds) ? Math.max(bounds.y - unit.occ.y, bottomOf(bounds) - bottomOf(unit.occ)) : 0
    if (Math.abs(dx) > 1e-4 || Math.abs(dy) > 1e-4) {
      moveUnit(unit, dx, dy, size)
      corrections.push({ op: 'clamp', units: [unit.id], dx: Number(dx.toFixed(4)), dy: Number(dy.toFixed(4)), bounds: bounds.source })
      changed = true
    }
  }
  return changed
}

// Text boxes may be wider than their ink; keep the box itself on the slide.
function keepBoxesOnSlide(slide, size) {
  for (const element of slide.content_elements || []) {
    if (element.kind !== 'text' || element.text_group_id) continue
    const box = elementBox(element, size)
    if (!box || !outside(box, slideBounds(), 0.0005)) continue
    const ink = measureTextInk(element, box, size)
    let next = clip01(box)
    if (next.width < ink.width || next.height < Math.min(box.height, ink.height)) {
      next = {
        ...box,
        x: Math.min(Math.max(0, box.x), 1 - box.width),
        y: Math.min(Math.max(0, box.y), 1 - box.height),
      }
      next = clip01(next)
    }
    writeBox(element, next, size)
  }
}

function tightenTextBoxes(slide, report, titleIds) {
  const { size, items } = buildLayoutUnits(slide, report, { titleIds })
  for (const item of items) {
    if (!item.text || !item.entity?.single || item.element.text_area_normalized) continue
    // The renderer pads the box with the vertical insets again.
    const top = Math.max(0, item.ink.y - (item.ink.padTop || 0))
    const height = Math.min(1 - top, item.ink.height + (item.ink.padTop || 0) + (item.ink.padBottom || 0))
    if (height > 0) writeBox(item.element, { ...item.box, y: top, height }, size)
  }
}

export function summarizeLayoutIssues(issues, extra = {}) {
  const errors = issues.filter((issue) => issue.severity === 'error')
  const warnings = issues.filter((issue) => issue.severity !== 'error')
  return {
    engine: HIT_ENGINE,
    valid: errors.length === 0,
    errors,
    warnings,
    issues: [...errors, ...warnings],
    reject_reason: errors.length ? [...new Set(errors.map((issue) => issue.code))].join(',') : null,
    ...extra,
  }
}

export function resolveSlideLayout(report, slide, {
  titleIds = [],
  tightenText = false,
  strictImages = false,
  maxIterations = MAX_ITERATIONS,
} = {}) {
  if (!slide) return { slide, validation: summarizeLayoutIssues([{ code: 'missing_slide', severity: 'error' }]) }
  const next = JSON.parse(JSON.stringify(slide))
  inheritVerticalAnchors(report, next)
  const size = slideSizeOf(report, next)
  const safe = safeAreaFor(report, next)
  for (const element of next.content_elements || []) {
    if (element?.kind !== 'text') continue
    const box = elementBox(element, size)
    if (box) element[FRAME0_KEY] = box
    const group = element.text_group_id ? finiteBox(element.text_group_geometry_norm) : null
    if (group) element[GROUP_FRAME0_KEY] = group
  }
  const corrections = []
  const tooMany = (next.content_elements || []).filter(isDynamicElement).length > MAX_DYNAMIC_ELEMENTS
  let iterations = 0
  if (!tooMany) {
    liftTitleAboveInitialComponents(next, report, safe, titleIds, corrections)
    for (; iterations < maxIterations; iterations += 1) {
      let changed = fitTexts(next, report, safe, titleIds, corrections, strictImages)
      changed = separateUnits(next, report, safe, titleIds, corrections, strictImages) || changed
      changed = enforceTitleGap(next, report, safe, titleIds, corrections, strictImages) || changed
      changed = alignRepeatedTextRows(next, report, safe, titleIds, corrections) || changed
      changed = clampUnits(next, report, safe, titleIds, corrections) || changed
      if (!changed) break
    }
    keepBoxesOnSlide(next, size)
    if (tightenText) tightenTextBoxes(next, report, titleIds)
  }
  for (const element of next.content_elements || []) delete element.__original_size_pt
  const detected = detectLayoutIssues(report, next, { titleIds, safe, strictImages })
  for (const element of next.content_elements || []) {
    delete element[FRAME0_KEY]
    delete element[GROUP_FRAME0_KEY]
  }
  const validation = summarizeLayoutIssues(detected.issues, {
    corrections,
    iterations,
    safe_area: {
      x: Number(safe.x.toFixed(4)),
      y: Number(safe.y.toFixed(4)),
      width: Number(safe.width.toFixed(4)),
      height: Number(safe.height.toFixed(4)),
      source: safe.source,
    },
  })
  return { slide: { ...next, layout_validation: validation }, validation }
}
