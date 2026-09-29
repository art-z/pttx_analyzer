import { findSlideTitleElements } from './slide-title-detect.js'
import {
  collectGraphicExcludedElementIds,
  filterElementsForVgroups,
} from './graphic-region-exclude.js'
import { prepareUnits } from './vgroup-structure.js'
import {
  assignGroupIds,
  attachFloatingUnits,
  collectGroupNodes,
  collectNodeElements,
  normalizePartitionTree,
  partitionRegion,
  walkTree,
} from './vgroup-partition.js'

export const MIN_GROUP_SIZE = 2
export const DEFAULT_SLIDE_ASPECT = 9 / 16

export function inferGroupLayout(elements) {
  if (!elements || elements.length < 2) return 'single'
  const xs = elements.map((element) => {
    const geometry = element.geometry_norm || {}
    return geometry.x + geometry.width / 2
  })
  const ys = elements.map((element) => {
    const geometry = element.geometry_norm || {}
    return geometry.y + geometry.height / 2
  })
  const xSpread = Math.max(...xs) - Math.min(...xs)
  const ySpread = Math.max(...ys) - Math.min(...ys)
  if (ySpread > xSpread * 1.2) return 'column'
  if (xSpread > ySpread * 1.2) return 'row'
  return 'grid'
}

export function boxesNear(left, right, gap = 0.04) {
  const overlap = !(
    left.x + left.width <= right.x
    || right.x + right.width <= left.x
    || left.y + left.height <= right.y
    || right.y + right.height <= left.y
  )
  if (overlap) return true
  const horizontalGap = Math.max(0, Math.max(left.x, right.x) - Math.min(left.x + left.width, right.x + right.width))
  const verticalGap = Math.max(0, Math.max(left.y, right.y) - Math.min(left.y + left.height, right.y + right.height))
  const minSide = Math.min(left.width, left.height, right.width, right.height)
  const threshold = Math.max(gap, minSide * 0.35)
  return horizontalGap <= threshold && verticalGap <= threshold
}

export function resolveSlideAspect(slide) {
  const size = slide?.render?.slide_size_pt
  if (size?.width > 0 && size?.height > 0) return size.height / size.width
  const sample = (slide?.content_elements || []).find((element) => (
    element.geometry_pt?.width_pt > 0 && element.geometry_norm?.width > 0
    && element.geometry_pt?.height_pt > 0 && element.geometry_norm?.height > 0
  ))
  if (sample) {
    const slideWidth = sample.geometry_pt.width_pt / sample.geometry_norm.width
    const slideHeight = sample.geometry_pt.height_pt / sample.geometry_norm.height
    if (slideWidth > 0 && slideHeight > 0) return slideHeight / slideWidth
  }
  return DEFAULT_SLIDE_ASPECT
}

function bboxPtFromElements(elements) {
  const pts = elements.map((element) => element.geometry_pt || {}).filter(Boolean)
  const ptX = pts.map((item) => item.x_pt).filter((value) => Number.isFinite(value))
  const ptY = pts.map((item) => item.y_pt).filter((value) => Number.isFinite(value))
  const ptXe = pts.map((item) => (item.x_pt || 0) + (item.width_pt || 0))
  const ptYe = pts.map((item) => (item.y_pt || 0) + (item.height_pt || 0))
  if (!ptX.length || !ptY.length) return null
  return {
    x_pt: Math.min(...ptX),
    y_pt: Math.min(...ptY),
    width_pt: Math.max(...ptXe) - Math.min(...ptX),
    height_pt: Math.max(...ptYe) - Math.min(...ptY),
  }
}

export function nodeLayoutLabel(node) {
  if (!node) return 'single'
  if (node.kind === 'container') return 'container'
  if (node.kind === 'branch') {
    if (node.repeat?.grid) return 'grid'
    return node.layout?.direction || (node.axis === 'x' ? 'row' : 'column')
  }
  return node.units.length > 1 ? 'stack' : 'single'
}

function nodeToGroup(node) {
  const elements = collectNodeElements(node)
  return {
    id: node.id,
    depth: node.depth || 1,
    parentId: node.id.includes('.') ? node.id.slice(0, node.id.lastIndexOf('.')) : null,
    bboxNorm: node.bboxNorm,
    bboxPt: bboxPtFromElements(elements),
    layout: nodeLayoutLabel(node),
    flex: node.kind === 'branch' ? Boolean(node.layout?.flex) : false,
    direction: node.layout?.direction || null,
    alignCross: node.layout?.alignCross || null,
    uniformGap: node.layout?.uniformGap ?? null,
    repeat: node.repeat,
    signature: node.sig,
    elements,
    unitCount: node.units.length,
    elementCount: elements.length,
    kindCounts: node.kindCounts,
    partition: node.split ? {
      axis: node.split.axis,
      score: node.split.score,
      method: node.split.method,
      repetition: node.split.repetition,
    } : null,
    kind: node.kind,
  }
}

// Template (donor) slides never change while a presentation is assembled, yet
// several catalogs (metrics, singletons, descriptions, repeats, pagination)
// each re-run the vgroup partition on the same slide. Cache the result per
// report for slides that belong to the report's own deck; anything else (built
// or edited slides) is always recomputed. Callers treat the result as
// read-only.
const vgroupResultCache = new WeakMap()

function deckSlideCache(report, slide) {
  const deckSlides = report?.slides?.slides
  if (!slide || typeof slide !== 'object' || !Array.isArray(deckSlides)) return null
  let entry = vgroupResultCache.get(report)
  if (!entry || entry.deckSlides !== deckSlides || entry.count !== deckSlides.length) {
    entry = { deckSlides, count: deckSlides.length, members: new Set(deckSlides), results: new WeakMap() }
    vgroupResultCache.set(report, entry)
  }
  return entry.members.has(slide) ? entry.results : null
}

export function detectSlideVgroups(slide, options = {}) {
  const onlyReport = Object.keys(options).every((key) => key === 'report')
  const results = onlyReport ? deckSlideCache(options.report, slide) : null
  const cached = results?.get(slide)
  if (cached && cached.elements === slide.content_elements) return cached.result
  const result = computeSlideVgroups(slide, options)
  if (results) results.set(slide, { elements: slide.content_elements, result: result })
  return result
}

function computeSlideVgroups(slide, options = {}) {
  const report = options.report || null
  const contentElements = slide?.content_elements || []
  const aspect = resolveSlideAspect(slide)
  const excludedGraphicIds = collectGraphicExcludedElementIds(slide)

  const slideTitle = findSlideTitleElements(slide, report, contentElements)
  const partitionElements = filterElementsForVgroups(contentElements, excludedGraphicIds)
  const { units, topLevel, floating } = prepareUnits(partitionElements)
  const context = {
    aspect,
    pinned: new Set(slideTitle.elementIds || []),
    separators: floating.filter((unit) => unit.role === 'separator'),
    excludedGraphicIds,
  }

  let tree = normalizePartitionTree(partitionRegion(topLevel, context), context)
  if (!tree && floating.length) {
    tree = normalizePartitionTree(partitionRegion(floating.map((unit) => ({ ...unit, role: 'content' })), context), context)
  } else {
    tree = attachFloatingUnits(tree, floating)
  }
  assignGroupIds(tree, null, 1, 1)

  const groupNodes = collectGroupNodes(tree)
  const groups = groupNodes.map(nodeToGroup)
  const groupedElementIds = new Set(
    groups.flatMap((group) => group.elements.map((element) => element.element_id)).filter(Boolean),
  )
  const ungroupedElements = contentElements.filter((element) => (
    element.element_id && !groupedElementIds.has(element.element_id)
  ))

  let containerCount = 0
  let repeatCount = 0
  let flexCount = 0
  walkTree(tree, (node) => {
    if (node.kind === 'container') containerCount += 1
    if (node.repeat) repeatCount += 1
    if (node.kind === 'branch' && node.layout?.flex) flexCount += 1
  })

  return {
    slideNumber: slide?.slide_number ?? null,
    aspect,
    tree,
    groups,
    ungroupedElements,
    slideTitle: {
      elementIds: [...slideTitle.elementIds],
      method: slideTitle.method,
      score: slideTitle.score,
      text: slideTitle.primary?.text || slideTitle.primary?.text_sample || '',
    },
    summary: {
      groupCount: groups.length,
      rootGroupCount: groups.filter((group) => group.depth === 1).length,
      groupedElementCount: groupedElementIds.size,
      ungroupedElementCount: ungroupedElements.length,
      totalElements: contentElements.length,
      unitCount: units.length,
      contentUnits: topLevel.length,
      separators: context.separators.length,
      excludedGraphicElements: excludedGraphicIds.size,
      containers: containerCount,
      repeats: repeatCount,
      flexNodes: flexCount,
      maxDepth: groups.reduce((max, group) => Math.max(max, group.depth), 0),
    },
  }
}

export function detectDeckVgroups(catalog, report = null) {
  const slides = catalog?.slides || []
  const perSlide = slides.map((slide) => detectSlideVgroups(slide, { report }))
  const totalGroups = perSlide.reduce((sum, item) => sum + item.summary.groupCount, 0)
  return {
    perSlide,
    summary: {
      slideCount: slides.length,
      totalGroups,
      slidesWithGroups: perSlide.filter((item) => item.summary.groupCount > 0).length,
      totalRepeats: perSlide.reduce((sum, item) => sum + item.summary.repeats, 0),
    },
  }
}

export { findBestSplit, projectionGaps } from './vgroup-partition.js'
export { buildClusterUnits, prepareUnits, unitSignature } from './vgroup-structure.js'
