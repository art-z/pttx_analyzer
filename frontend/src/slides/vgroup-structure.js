/**
 * Stage 1 of visual grouping: turn flat `content_elements` into layout units.
 *
 * - text_group lines and "fill + own text" of one shape collapse into a single unit,
 * - thin lines / hairline fills become separators (layout hints, not layout participants),
 * - plates and pictures that fully contain other units become containers (natural DOM nesting).
 */
import { stackGeometryNorm, unionGeometryNorm } from './flex-layout.js'

export const GEOMETRY_EPS = 0.0015
export const SEPARATOR_MAX_THICKNESS = 0.012
export const HAIRLINE_FILL_THICKNESS = 0.006
export const HAIRLINE_FILL_MIN_LENGTH = 0.05
export const DECORATION_MAX_THICKNESS = 0.022
export const DECORATION_MIN_ASPECT = 8
export const NOISE_MAX_AREA = 0.00002
export const CONTAINMENT_MIN_COVER = 0.9
export const CONTAINER_KINDS = new Set(['fill', 'image', 'shape'])

export function unitArea(unit) {
  const geometry = unit?.geometry_norm || {}
  return Math.max(0, geometry.width || 0) * Math.max(0, geometry.height || 0)
}

export function boxArea(box) {
  return Math.max(0, box?.width || 0) * Math.max(0, box?.height || 0)
}

export function intersectionArea(left, right) {
  if (!left || !right) return 0
  const xOverlap = Math.max(0, Math.min(left.x + left.width, right.x + right.width) - Math.max(left.x, right.x))
  const yOverlap = Math.max(0, Math.min(left.y + left.height, right.y + right.height) - Math.max(left.y, right.y))
  return xOverlap * yOverlap
}

/** Share of `inner` area that lies inside `outer`. */
export function coverRatio(inner, outer) {
  const area = boxArea(inner)
  if (!area) {
    return centerInBox(boxCenter(inner), outer) ? 1 : 0
  }
  return intersectionArea(inner, outer) / area
}

export function boxCenter(box) {
  return {
    x: (box?.x || 0) + (box?.width || 0) / 2,
    y: (box?.y || 0) + (box?.height || 0) / 2,
  }
}

export function centerInBox(center, box) {
  return center.x >= box.x && center.x <= box.x + box.width && center.y >= box.y && center.y <= box.y + box.height
}

function sameGeometry(left, right, eps = GEOMETRY_EPS) {
  if (!left || !right) return false
  return Math.abs((left.x || 0) - (right.x || 0)) <= eps
    && Math.abs((left.y || 0) - (right.y || 0)) <= eps
    && Math.abs((left.width || 0) - (right.width || 0)) <= eps
    && Math.abs((left.height || 0) - (right.height || 0)) <= eps
}

function sizeClass(element) {
  const size = Number(element?.typography?.size_pt)
  if (!Number.isFinite(size) || size <= 0) return ''
  return String(Math.round(size / 2) * 2)
}

function textSignature(element) {
  return `t${sizeClass(element)}`
}

/** Structural signature of a unit; equal signatures mean "the same kind of thing" for repetition detection. */
export function unitSignature(unit) {
  const base = baseUnitSignature(unit)
  if (!unit.contained?.length) return base
  return `${base}{${unit.contained.map(unitSignature).sort().join(',')}}`
}

function baseUnitSignature(unit) {
  switch (unit.kind) {
    case 'text':
      return textSignature(unit.members[0])
    case 'textgroup':
      return `tg[${unit.members.map(textSignature).join(',')}]`
    case 'shape': {
      const texts = unit.members.filter((member) => member.kind === 'text')
      return `s[${texts.map(textSignature).join(',')}]`
    }
    case 'fill':
      return 'f'
    case 'image':
      return 'i'
    default:
      return unit.kind || 'g'
  }
}

function makeUnit(id, kind, members, geometry, order) {
  return {
    unit_id: id,
    kind,
    members,
    geometry_norm: geometry || { x: 0, y: 0, width: 0, height: 0 },
    z: members[0]?.z_index ?? 0,
    order,
    role: 'content',
    contained: [],
    container: null,
  }
}

/**
 * Collapse flat elements into layout units.
 * Elements are visited in z order; the unit `order` preserves paint order for later tie-breaks.
 */
export function buildClusterUnits(contentElements) {
  const sorted = [...contentElements]
    .map((element, index) => ({ element, index }))
    .sort((left, right) => ((left.element.z_index || 0) - (right.element.z_index || 0)) || (left.index - right.index))
    .map((item) => item.element)

  const seenGroups = new Set()
  const consumed = new Set()
  const units = []

  const textGroupMembers = (groupId) => sorted
    .filter((item) => item.text_group_id === groupId)
    .sort((left, right) => (left.text_line_index ?? 0) - (right.text_line_index ?? 0))

  for (const element of sorted) {
    if (consumed.has(element)) continue

    if (element.kind === 'fill') {
      // A shape with its own text arrives as fill + text (or fill + text_group) with identical geometry.
      const ownText = sorted.filter((item) => (
        item !== element
        && !consumed.has(item)
        && item.kind === 'text'
        && sameGeometry(item.geometry_norm, element.geometry_norm)
        && ((item.name && item.name === element.name) || (item.z_index ?? -1) === (element.z_index ?? -2))
      ))
      if (ownText.length) {
        const members = [element]
        for (const text of ownText) {
          if (text.text_group_id) {
            if (seenGroups.has(text.text_group_id)) continue
            seenGroups.add(text.text_group_id)
            const lines = textGroupMembers(text.text_group_id)
            lines.forEach((line) => consumed.add(line))
            members.push(...lines)
          } else {
            consumed.add(text)
            members.push(text)
          }
        }
        consumed.add(element)
        units.push(makeUnit(`shape:${element.element_id || units.length}`, 'shape', members, element.geometry_norm, units.length))
        continue
      }
    }

    const groupId = element.text_group_id
    if (groupId) {
      if (seenGroups.has(groupId)) continue
      seenGroups.add(groupId)
      const members = textGroupMembers(groupId)
      members.forEach((member) => consumed.add(member))
      units.push(makeUnit(`text_group:${groupId}`, 'textgroup', members, stackGeometryNorm(members), units.length))
      continue
    }

    consumed.add(element)
    units.push(makeUnit(
      element.element_id || `element:${units.length}`,
      element.kind || 'graphic',
      [element],
      element.geometry_norm,
      units.length,
    ))
  }

  return units
}

export function isHairlineDecoration(unit) {
  const geometry = unit?.geometry_norm || {}
  const width = geometry.width || 0
  const height = geometry.height || 0
  const thickness = Math.min(width, height)
  const length = Math.max(width, height)
  if (length < HAIRLINE_FILL_MIN_LENGTH) return false
  if (thickness > DECORATION_MAX_THICKNESS) return false
  return length / Math.max(thickness, GEOMETRY_EPS) >= DECORATION_MIN_ASPECT
}

export function classifyUnitRole(unit) {
  const geometry = unit.geometry_norm || {}
  const width = geometry.width || 0
  const height = geometry.height || 0
  const thickness = Math.min(width, height)
  const length = Math.max(width, height)

  if (unit.kind === 'line') {
    return thickness <= SEPARATOR_MAX_THICKNESS ? 'separator' : 'content'
  }
  if (unit.kind === 'fill' && thickness <= HAIRLINE_FILL_THICKNESS && length >= HAIRLINE_FILL_MIN_LENGTH) {
    return 'separator'
  }
  if (unit.kind === 'image' && isHairlineDecoration(unit)) {
    return 'separator'
  }
  if (unit.kind !== 'text' && unit.kind !== 'textgroup' && unitArea(unit) < NOISE_MAX_AREA) {
    return 'noise'
  }
  return 'content'
}

export function annotateUnitRoles(units) {
  for (const unit of units) unit.role = classifyUnitRole(unit)
  return units
}

/**
 * Attach every content unit to the smallest plate/picture painted beneath it that covers it almost fully.
 * Returns the top-level units; nested ones live in `unit.contained` of their container.
 */
export function buildContainment(units) {
  const content = units.filter((unit) => unit.role === 'content')
  // Smallest container wins; among coincident plates the one painted last is the innermost.
  const candidates = content
    .filter((unit) => CONTAINER_KINDS.has(unit.kind) && unitArea(unit) > 0)
    .sort((left, right) => (unitArea(left) - unitArea(right)) || (right.order - left.order))

  for (const unit of content) {
    const area = unitArea(unit)
    for (const candidate of candidates) {
      if (candidate === unit) continue
      if (unitArea(candidate) < area * 0.98) continue
      if (candidate.order > unit.order) continue
      if (coverRatio(unit.geometry_norm, candidate.geometry_norm) < CONTAINMENT_MIN_COVER) continue
      unit.container = candidate
      candidate.contained.push(unit)
      break
    }
  }

  return content.filter((unit) => !unit.container)
}

export function prepareUnits(contentElements) {
  const units = annotateUnitRoles(buildClusterUnits(contentElements))
  const topLevel = buildContainment(units)
  return {
    units,
    topLevel,
    floating: units.filter((unit) => unit.role !== 'content'),
  }
}

export function leafFromUnits(units) {
  const elements = units.flatMap((unit) => unit.members)
  const bboxNorm = unionGeometryNorm(units.map((unit) => unit.geometry_norm))
  return { units, elements, bboxNorm, kindCounts: countKinds(elements) }
}

export function countKinds(elements) {
  return elements.reduce((counts, element) => {
    const kind = element.kind || 'graphic'
    counts[kind] = (counts[kind] || 0) + 1
    return counts
  }, {})
}
