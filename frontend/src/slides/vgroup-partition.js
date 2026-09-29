/**
 * Stage 2 of visual grouping: recursive XY-cut over exact occupancy intervals.
 *
 * Top-down: on every region we collect the empty gaps of the x and y projections (interval
 * union, no binning), keep the dominant gaps of each axis and choose the axis by physical gap
 * size *and* by how repetitive the resulting segments are (identical card signatures beat a
 * slightly larger gap). Separators lying inside a gap reinforce it; the slide title is pinned
 * as its own top-level block.
 *
 * Bottom-up: single-child collapse, period detection (A,B,A,B → [A,B]×2), repeated-run and
 * proximity regrouping, then every branch gets a flex layout description (direction, gaps,
 * cross alignment, repeat / grid flags).
 */
import { unionGeometryNorm } from './flex-layout.js'
import { boxCenter, coverRatio, countKinds, unitSignature } from './vgroup-structure.js'

export const OVERLAP_TOLERANCE = 0.002
export const DOMINANT_GAP_RATIO = 0.6
export const PROXIMITY_GAP_RATIO = 0.5
export const PERIOD_GAP_RATIO = 1.5
export const MIN_GAP_CONTRAST = 0.004
export const NEAR_TIE_SCORE = 0.015
export const MAX_PARTITION_DEPTH = 14
export const REPEAT_BONUS = 0.05
export const SEPARATOR_MIN_SPAN = 0.5
export const MAX_CROSSING_RATIO = 0.25

const AXIS = {
  x: { start: 'x', size: 'width', crossStart: 'y', crossSize: 'height' },
  y: { start: 'y', size: 'height', crossStart: 'x', crossSize: 'width' },
}

function toPhysical(size, axis, aspect) {
  return axis === 'y' ? size * aspect : size
}

function unitSpan(unit, axis) {
  const geometry = unit.geometry_norm || {}
  const start = geometry[AXIS[axis].start] || 0
  return [start, start + (geometry[AXIS[axis].size] || 0)]
}

/** Empty gaps of the projection of `units` onto `axis`, tolerant to hairline overlaps. */
export function projectionGaps(units, axis, tolerance = OVERLAP_TOLERANCE) {
  if (units.length < 2) return []
  const intervals = units
    .map((unit) => {
      const [start, end] = unitSpan(unit, axis)
      const shrunkStart = start + tolerance
      return [shrunkStart, Math.max(shrunkStart, end - tolerance)]
    })
    .sort((left, right) => left[0] - right[0])

  const runs = []
  let [runStart, runEnd] = intervals[0]
  for (let index = 1; index < intervals.length; index += 1) {
    const [start, end] = intervals[index]
    if (start > runEnd) {
      runs.push([runStart, runEnd])
      runStart = start
      runEnd = end
    } else if (end > runEnd) {
      runEnd = end
    }
  }
  runs.push([runStart, runEnd])

  const gaps = []
  for (let index = 1; index < runs.length; index += 1) {
    const start = runs[index - 1][1] + tolerance
    const end = runs[index][0] - tolerance
    gaps.push({
      axis,
      start,
      end,
      position: (start + end) / 2,
      size: Math.max(0, end - start),
      separator: false,
    })
  }
  return gaps
}

function markSeparatorGaps(gaps, separators, region, axis) {
  if (!separators?.length || !gaps.length) return gaps
  const crossSize = region[AXIS[axis].crossSize] || 0
  for (const separator of separators) {
    const [start, end] = unitSpan(separator, axis)
    const [crossStart, crossEnd] = unitSpan(separator, axis === 'x' ? 'y' : 'x')
    const span = Math.min(crossEnd, region[AXIS[axis].crossStart] + crossSize) - Math.max(crossStart, region[AXIS[axis].crossStart])
    if (!crossSize || span / crossSize < SEPARATOR_MIN_SPAN) continue
    for (const gap of gaps) {
      if (start >= gap.start - OVERLAP_TOLERANCE && end <= gap.end + OVERLAP_TOLERANCE) {
        gap.separator = true
      }
    }
  }
  return gaps
}

function splitByPositions(units, axis, positions) {
  const sorted = [...positions].sort((left, right) => left - right)
  const segments = sorted.map(() => []).concat([[]])
  for (const unit of units) {
    const center = boxCenter(unit.geometry_norm)[AXIS[axis].start]
    let index = 0
    while (index < sorted.length && center >= sorted[index]) index += 1
    segments[index].push(unit)
  }
  return segments.filter((segment) => segment.length)
}

function segmentSignature(units) {
  return units.map((unit) => unit.sig || unitSignature(unit)).sort().join('|')
}

function coefficientOfVariation(values) {
  if (values.length < 2) return 0
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length
  if (!mean) return 0
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length
  return Math.sqrt(variance) / mean
}

/** How much the segments look like repeated instances of one thing (0..1) plus whether they are compound. */
export function repetitionScore(segments, axis) {
  if (segments.length < 2) return { score: 0, compound: false }
  const signatures = segments.map(segmentSignature)
  const counts = new Map()
  for (const signature of signatures) counts.set(signature, (counts.get(signature) || 0) + 1)
  const majority = Math.max(...counts.values()) / segments.length
  const kindSets = new Set(segments.map((segment) => [...new Set(segment.map((unit) => unit.sig || unitSignature(unit)))].sort().join('|')))
  let match = 0
  if (counts.size === 1) match = 1
  else if (kindSets.size === 1) match = 0.7
  else if (majority >= 0.75 && segments.length >= 4) match = 0.6
  if (!match) return { score: 0, compound: false }

  const sizes = segments.map((segment) => unionGeometryNorm(segment.map((unit) => unit.geometry_norm))[AXIS[axis].size])
  const sizeSimilarity = Math.max(0, 1 - coefficientOfVariation(sizes) * 2)
  const compound = segments.every((segment) => segment.length >= 2)
  return { score: match * sizeSimilarity, compound }
}

function evaluateCandidate(units, axis, gaps, aspect) {
  const segments = splitByPositions(units, axis, gaps.map((gap) => gap.position))
  if (segments.length < 2) return null
  const repetition = repetitionScore(segments, axis)
  const strongest = Math.max(...gaps.map((gap) => toPhysical(gap.size, axis, aspect)))
  const separatorBonus = gaps.some((gap) => gap.separator) ? 0.04 : 0
  const score = strongest
    + separatorBonus
    + REPEAT_BONUS * repetition.score * (repetition.compound ? 2 : 1)
  return {
    axis,
    gaps,
    segments,
    score,
    gapPhysical: strongest,
    repetition: repetition.score,
    compound: repetition.compound,
    method: 'gap',
  }
}

/** Gaps comparable to the strongest one; differences below MIN_GAP_CONTRAST are noise. */
function dominantGaps(gaps) {
  const strongest = Math.max(...gaps.map((gap) => gap.size))
  return gaps.filter((gap) => (
    gap.separator
    || gap.size >= strongest * DOMINANT_GAP_RATIO
    || strongest - gap.size < MIN_GAP_CONTRAST
  ))
}

/** Last resort for regions without any empty gap: cut where the fewest units are crossed. */
function minCrossingCut(units, aspect) {
  let best = null
  const maxCrossing = Math.max(1, Math.floor(units.length * MAX_CROSSING_RATIO))
  for (const axis of ['x', 'y']) {
    const edges = [...new Set(units.flatMap((unit) => unitSpan(unit, axis)))].sort((left, right) => left - right)
    for (let index = 1; index < edges.length - 1; index += 1) {
      const position = edges[index]
      let crossing = 0
      for (const unit of units) {
        const [start, end] = unitSpan(unit, axis)
        if (start < position - OVERLAP_TOLERANCE && end > position + OVERLAP_TOLERANCE) crossing += 1
      }
      if (crossing > maxCrossing) continue
      const segments = splitByPositions(units, axis, [position])
      if (segments.length !== 2) continue
      const balance = Math.min(segments[0].length, segments[1].length) / Math.max(segments[0].length, segments[1].length)
      const score = (1 - crossing / units.length) * (0.5 + balance / 2)
      if (!best || score > best.score) {
        best = {
          axis,
          gaps: [{ axis, start: position, end: position, position, size: 0, separator: false }],
          segments,
          score,
          gapPhysical: 0,
          repetition: repetitionScore(segments, axis).score,
          compound: false,
          method: 'crossing',
          crossing,
        }
      }
    }
  }
  return best
}

function isPerfectRepetition(candidate) {
  return candidate.repetition >= 0.8 && candidate.compound
}

function isBetterCandidate(candidate, current) {
  const candidatePerfect = isPerfectRepetition(candidate)
  const currentPerfect = isPerfectRepetition(current)
  if (candidatePerfect !== currentPerfect) return candidatePerfect
  // Near-ties go to the coarser cut: fewer segments first keeps the hierarchy top-down.
  if (Math.abs(candidate.score - current.score) < NEAR_TIE_SCORE && candidate.segments.length !== current.segments.length) {
    return candidate.segments.length < current.segments.length
  }
  return candidate.score > current.score
}

/**
 * Pick the best cut of a unit set. Returns null when the region should stay a leaf.
 * `context`: { aspect, separators, region }.
 */
export function findBestSplit(units, region = null, context = {}) {
  if (units.length < 2) return null
  const aspect = context.aspect ?? 9 / 16
  const box = region || unionGeometryNorm(units.map((unit) => unit.geometry_norm))
  const candidates = []

  for (const axis of ['x', 'y']) {
    const gaps = markSeparatorGaps(projectionGaps(units, axis), context.separators, box, axis)
    if (!gaps.length) continue
    const dominant = dominantGaps(gaps)
    const seen = new Set()
    for (const gapSet of [dominant, gaps]) {
      const key = gapSet.map((gap) => gap.position.toFixed(5)).join(',')
      if (seen.has(key)) continue
      seen.add(key)
      const candidate = evaluateCandidate(units, axis, gapSet, aspect)
      if (candidate) candidates.push(candidate)
    }
  }

  if (!candidates.length) return minCrossingCut(units, aspect)

  let best = candidates[0]
  for (const candidate of candidates.slice(1)) {
    if (isBetterCandidate(candidate, best)) best = candidate
  }
  return {
    ...best,
    position: best.gaps[0]?.position ?? null,
    splitNorm: best.gaps[0]?.position ?? null,
  }
}

// ---------------------------------------------------------------------------
// Tree nodes

function baseNode(kind, units) {
  const elements = units.flatMap((unit) => unit.members)
  return {
    kind,
    units,
    elements,
    bboxNorm: unionGeometryNorm(units.map((unit) => unit.geometry_norm)),
    kindCounts: countKinds(elements),
    axis: null,
    children: [],
    background: null,
    content: null,
    floating: [],
    split: null,
    layout: null,
    repeat: null,
    pinned: false,
    sig: '',
    id: null,
    depth: 0,
  }
}

function leafNode(unit) {
  const node = baseNode('leaf', [unit])
  node.sig = unitSignature(unit)
  return node
}

function flattenUnit(unit, out = []) {
  out.push(unit)
  for (const child of unit.contained || []) flattenUnit(child, out)
  return out
}

/** Overlapping units that cannot be cut apart; rendered absolutely, so contained units are flattened in. */
function stackNode(units) {
  const flat = units.flatMap((unit) => flattenUnit(unit))
  const node = baseNode('leaf', flat)
  node.sig = `st{${segmentSignature(flat)}}`
  return node
}

function containerNode(unit, content) {
  const node = baseNode('container', [unit, ...(content?.units || [])])
  node.bboxNorm = { ...unit.geometry_norm }
  node.background = unit
  node.content = content
  node.sig = `c(${unitSignature(unit)})[${content?.sig || ''}]`
  return node
}

function branchNode(axis, children, split = null) {
  const node = baseNode('branch', children.flatMap((child) => child.units))
  node.axis = axis
  node.children = sortChildren(children, axis)
  node.split = split
  node.sig = `${axis}[${node.children.map((child) => child.sig).join(',')}]`
  return node
}

function sortChildren(children, axis) {
  const key = AXIS[axis].start
  return [...children].sort((left, right) => (
    (Number(Boolean(right.pinned)) - Number(Boolean(left.pinned)))
    || (left.bboxNorm[key] - right.bboxNorm[key])
  ))
}

function refreshBranch(node) {
  node.children = sortChildren(node.children, node.axis)
  node.units = node.children.flatMap((child) => child.units)
  node.elements = node.units.flatMap((unit) => unit.members)
  node.bboxNorm = unionGeometryNorm(node.children.map((child) => child.bboxNorm))
  node.kindCounts = countKinds(node.elements)
  node.sig = `${node.axis}[${node.children.map((child) => child.sig).join(',')}]`
  return node
}

function nodeForUnit(unit, context, depth) {
  if (unit.contained?.length) {
    const inner = partitionRegion(unit.contained, context, depth + 1)
    return containerNode(unit, inner)
  }
  return leafNode(unit)
}

function isPinned(unit, context) {
  return Boolean(context.pinned?.size && unit.members.some((member) => context.pinned.has(member.element_id)))
}

export function partitionRegion(units, context, depth = 0) {
  if (!units.length) return null
  if (units.length === 1) return nodeForUnit(units[0], context, depth)
  if (depth >= MAX_PARTITION_DEPTH) return stackNode(units)

  const pinned = units.filter((unit) => isPinned(unit, context))
  if (pinned.length && pinned.length < units.length) {
    const rest = partitionRegion(units.filter((unit) => !pinned.includes(unit)), context, depth + 1)
    const children = pinned.map((unit) => {
      const node = nodeForUnit(unit, context, depth + 1)
      node.pinned = true
      return node
    })
    if (rest?.kind === 'branch' && rest.axis === 'y') children.push(...rest.children)
    else if (rest) children.push(rest)
    return branchNode('y', children, { axis: 'y', method: 'title', score: 1, gapPhysical: 0, repetition: 0 })
  }

  const region = unionGeometryNorm(units.map((unit) => unit.geometry_norm))
  const split = findBestSplit(units, region, context)
  if (!split) return stackNode(units)

  const children = split.segments.map((segment) => partitionRegion(segment, context, depth + 1)).filter(Boolean)
  if (children.length < 2) return stackNode(units)
  return branchNode(split.axis, children, {
    axis: split.axis,
    method: split.method,
    score: split.score,
    gapPhysical: split.gapPhysical,
    repetition: split.repetition,
    compound: split.compound,
  })
}

// ---------------------------------------------------------------------------
// Bottom-up refinement

function gapBetween(left, right, axis) {
  const { start, size } = AXIS[axis]
  return right.bboxNorm[start] - (left.bboxNorm[start] + left.bboxNorm[size])
}

function similarSize(left, right, axis, ratio = 0.3) {
  const { size, crossSize } = AXIS[axis]
  const main = Math.abs(left.bboxNorm[size] - right.bboxNorm[size]) <= Math.max(left.bboxNorm[size], right.bboxNorm[size]) * ratio
  const cross = Math.abs(left.bboxNorm[crossSize] - right.bboxNorm[crossSize]) <= Math.max(left.bboxNorm[crossSize], right.bboxNorm[crossSize]) * ratio
  return main && cross
}

function wrapRun(node, from, to, reason) {
  const run = node.children.slice(from, to)
  const wrapped = branchNode(node.axis, run, { axis: node.axis, method: reason, score: 0, gapPhysical: 0, repetition: 1 })
  node.children.splice(from, to - from, wrapped)
  return wrapped
}

/** A,B,A,B,A,B → [A,B]×3 when the gaps inside a period are tighter than the gaps between periods. */
function regroupPeriodic(node, aspect) {
  const count = node.children.length
  if (count < 4) return false
  for (let period = 2; period <= count / 2; period += 1) {
    if (count % period) continue
    let matches = true
    for (let index = period; index < count && matches; index += 1) {
      if (node.children[index].sig !== node.children[index % period].sig) matches = false
    }
    if (!matches) continue

    let inner = 0
    let innerCount = 0
    let outer = 0
    let outerCount = 0
    for (let index = 1; index < count; index += 1) {
      const gap = toPhysical(gapBetween(node.children[index - 1], node.children[index], node.axis), node.axis, aspect)
      if (index % period === 0) {
        outer += gap
        outerCount += 1
      } else {
        inner += gap
        innerCount += 1
      }
    }
    const innerAvg = innerCount ? inner / innerCount : 0
    const outerAvg = outerCount ? outer / outerCount : 0
    if (outerCount && innerCount && outerAvg >= innerAvg * PERIOD_GAP_RATIO && outerAvg - innerAvg >= MIN_GAP_CONTRAST) {
      for (let start = count - period; start >= 0; start -= period) {
        wrapRun(node, start, start + period, 'period')
      }
      return true
    }
  }
  return false
}

/** Consecutive children with equal signature and size become one repeated block unless they already are the whole node. */
function regroupRepeatedRuns(node) {
  const count = node.children.length
  if (count < 3) return false
  let changed = false
  let index = 0
  while (index < node.children.length) {
    let end = index + 1
    while (
      end < node.children.length
      && node.children[end].sig === node.children[index].sig
      && similarSize(node.children[end], node.children[index], node.axis)
    ) end += 1
    if (end - index >= 2 && end - index < node.children.length) {
      wrapRun(node, index, end, 'repeat-run')
      changed = true
      index += 1
    } else {
      index = end
    }
  }
  return changed
}

/** Children joined by clearly smaller gaps than the dominant gap form their own sub-block. */
function regroupByProximity(node, aspect) {
  const count = node.children.length
  if (count < 3) return false
  const gaps = []
  for (let index = 1; index < count; index += 1) {
    gaps.push(Math.max(0, toPhysical(gapBetween(node.children[index - 1], node.children[index], node.axis), node.axis, aspect)))
  }
  const maxGap = Math.max(...gaps)
  if (maxGap <= 0) return false
  const tight = gaps.map((gap) => gap <= maxGap * PROXIMITY_GAP_RATIO && maxGap - gap >= MIN_GAP_CONTRAST)
  if (tight.every(Boolean)) return false

  let changed = false
  for (let index = tight.length - 1; index >= 0;) {
    if (!tight[index]) {
      index -= 1
      continue
    }
    let start = index
    while (start - 1 >= 0 && tight[start - 1]) start -= 1
    wrapRun(node, start, index + 2, 'proximity')
    changed = true
    index = start - 1
  }
  return changed
}

function markRepeat(node) {
  node.repeat = null
  if (node.kind !== 'branch' || node.children.length < 2) return
  const first = node.children[0].sig
  if (!node.children.every((child) => child.sig === first)) return
  node.repeat = { count: node.children.length, itemSig: first }

  const crossAxis = node.axis === 'x' ? 'y' : 'x'
  const rows = node.children
  if (rows.every((child) => child.kind === 'branch' && child.axis === crossAxis && child.children.length === rows[0].children.length)) {
    node.repeat.grid = node.axis === 'y'
      ? { rows: rows.length, cols: rows[0].children.length }
      : { rows: rows[0].children.length, cols: rows.length }
  }
}

function describeLayout(node, aspect) {
  if (node.kind !== 'branch') return null
  const { start, size, crossStart, crossSize } = AXIS[node.axis]
  const gaps = []
  let overlapping = false
  for (let index = 1; index < node.children.length; index += 1) {
    const gap = gapBetween(node.children[index - 1], node.children[index], node.axis)
    if (gap < -OVERLAP_TOLERANCE) overlapping = true
    gaps.push(gap)
  }
  const physicalGaps = gaps.map((gap) => toPhysical(gap, node.axis, aspect))
  const uniformGap = physicalGaps.length > 1
    ? coefficientOfVariation(physicalGaps.map((gap) => Math.max(0, gap))) < 0.12
    : true

  const box = node.bboxNorm
  const starts = node.children.map((child) => child.bboxNorm[crossStart] - box[crossStart])
  const ends = node.children.map((child) => (box[crossStart] + box[crossSize]) - (child.bboxNorm[crossStart] + child.bboxNorm[crossSize]))
  const centers = node.children.map((child) => Math.abs(
    (child.bboxNorm[crossStart] + child.bboxNorm[crossSize] / 2) - (box[crossStart] + box[crossSize] / 2),
  ))
  const eps = OVERLAP_TOLERANCE * 2
  let alignCross = 'mixed'
  if (starts.every((value) => value <= eps) && ends.every((value) => value <= eps)) alignCross = 'stretch'
  else if (starts.every((value) => value <= eps)) alignCross = 'start'
  else if (ends.every((value) => value <= eps)) alignCross = 'end'
  else if (centers.every((value) => value <= eps)) alignCross = 'center'

  return {
    direction: node.axis === 'x' ? 'row' : 'column',
    flex: !overlapping,
    gaps,
    gapPhysical: physicalGaps,
    uniformGap,
    alignCross,
    mainSize: box[size],
    mainStart: box[start],
  }
}

export function normalizePartitionTree(node, context = {}) {
  if (!node) return null
  const aspect = context.aspect ?? 9 / 16

  if (node.kind === 'container') {
    node.content = normalizePartitionTree(node.content, context)
    node.units = [node.background, ...(node.content?.units || [])]
    node.elements = node.units.flatMap((unit) => unit.members)
    node.kindCounts = countKinds(node.elements)
    node.sig = `c(${unitSignature(node.background)})[${node.content?.sig || ''}]`
    return node
  }
  if (node.kind !== 'branch') return node

  node.children = node.children.map((child) => normalizePartitionTree(child, context)).filter(Boolean)
  if (node.children.length === 1) return node.children[0]
  if (!node.children.length) return stackNode(node.units)

  refreshBranch(node)
  if (regroupPeriodic(node, aspect)) refreshBranch(node)
  if (regroupRepeatedRuns(node)) refreshBranch(node)
  if (regroupByProximity(node, aspect)) refreshBranch(node)
  return finalizeBranch(node, aspect)
}

/** Wrapped runs are fresh branches whose children are already normalized; they only need layout metadata. */
function finalizeBranch(node, aspect) {
  refreshBranch(node)
  for (const child of node.children) {
    if (child.kind === 'branch' && !child.layout) finalizeBranch(child, aspect)
  }
  markRepeat(node)
  node.layout = describeLayout(node, aspect)
  return node
}

/** Separators / noise are not layout participants; attach each to the deepest node that contains it. */
export function attachFloatingUnits(tree, floating) {
  if (!tree || !floating.length) return tree
  for (const unit of floating) {
    let node = tree
    let descended = true
    while (descended) {
      descended = false
      const candidates = node.kind === 'branch'
        ? node.children
        : node.kind === 'container' && node.content ? [node.content] : []
      for (const child of candidates) {
        if (coverRatio(unit.geometry_norm, child.bboxNorm) >= 0.9) {
          node = child
          descended = true
          break
        }
      }
    }
    node.floating.push(unit)
  }
  return tree
}

export function isGroupNode(node) {
  if (!node) return false
  if (node.kind === 'branch' || node.kind === 'container') return true
  return node.kind === 'leaf' && node.units.length >= 2
}

function childNodes(node) {
  if (node.kind === 'branch') return node.children
  if (node.kind === 'container' && node.content) return [node.content]
  return []
}

export function assignGroupIds(node, parentId = null, index = 1, depth = 1) {
  if (!node) return
  if (isGroupNode(node)) {
    node.id = parentId ? `${parentId}.${index}` : `g${index}`
    node.depth = depth
  }
  childNodes(node).forEach((child, childIndex) => {
    assignGroupIds(child, node.id ?? parentId, childIndex + 1, node.id ? depth + 1 : depth)
  })
}

export function collectGroupNodes(node, groups = []) {
  if (!node) return groups
  if (isGroupNode(node) && node.id) groups.push(node)
  childNodes(node).forEach((child) => collectGroupNodes(child, groups))
  return groups
}

/** Every element of the subtree, including floating separators, in paint order. */
export function collectNodeElements(node, elements = []) {
  if (!node) return elements
  if (node.kind === 'container') {
    elements.push(...node.background.members)
    collectNodeElements(node.content, elements)
  } else if (node.kind === 'branch') {
    node.children.forEach((child) => collectNodeElements(child, elements))
  } else {
    node.units.forEach((unit) => elements.push(...unit.members))
  }
  node.floating.forEach((unit) => elements.push(...unit.members))
  return elements
}

export function walkTree(node, visit, parent = null) {
  if (!node) return
  visit(node, parent)
  childNodes(node).forEach((child) => walkTree(child, visit, node))
}
