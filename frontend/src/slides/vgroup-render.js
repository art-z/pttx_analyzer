/**
 * Nested slide DOM built from the vgroup tree.
 *
 * Every tree node becomes an element. Branch nodes are real flex containers (row / column) whose
 * children are flex items with explicit size and margins; containers hold a background plate plus
 * their inner tree; leaves wrap the original catalog renderers. All sizes are percentages derived
 * from the same normalized geometry the flat renderer uses, so the result is pixel-identical to
 * the flat absolute layout while exposing the hierarchy.
 */
import { renderLayer } from '../templates/slide-render.js'
import {
  ensurePresentationFonts,
  renderDesignSystemContentElements,
} from './design-system-render.js'
import { resolveSlideMetrics } from './slide-metrics.js'
import { filterSlideRenderLayers } from './slide-layer-filter.js'
import { detectSlideVgroups, nodeLayoutLabel } from './vgroup-detect.js'
import { relativizeElements, relativizeGeometryNorm } from './vgroup-geometry.js'

/** Kinds whose renderers derive box size from pt metadata; they keep slide-space coordinates. */
const SLIDE_SPACE_KINDS = new Set(['table', 'chart', 'diagram', 'graphic'])

function pct(value) {
  return `${Number((value * 100).toFixed(4))}%`
}

function maxZIndex(elements) {
  return Math.max(0, ...(elements || []).map((element) => element.z_index || 0))
}

function nodeElements(node) {
  if (node.kind === 'container') return [...node.background.members, ...(node.content?.elements || [])]
  return node.elements
}

function placeAbsolute(element, box, parentBox) {
  const relative = parentBox ? relativizeGeometryNorm(box, parentBox) : box
  element.style.position = 'absolute'
  element.style.left = pct(relative.x)
  element.style.top = pct(relative.y)
  element.style.width = pct(relative.width)
  element.style.height = pct(relative.height)
}

/**
 * Flex item geometry: size in % of the container, main-axis offset as margin from the previous
 * sibling, cross-axis offset as margin from the container edge. Vertical margins resolve against
 * the container width, hence the aspect correction.
 */
function placeFlexItem(element, box, parentNode, previousEnd, aspect) {
  const parent = parentNode.bboxNorm
  element.style.position = 'relative'
  element.style.flex = '0 0 auto'
  element.style.minWidth = '0'
  element.style.minHeight = '0'
  element.style.width = pct(box.width / parent.width)
  element.style.height = pct(box.height / parent.height)
  if (parentNode.axis === 'x') {
    element.style.marginLeft = pct((box.x - previousEnd) / parent.width)
    element.style.marginTop = pct(((box.y - parent.y) * aspect) / parent.width)
    return box.x + box.width
  }
  element.style.marginTop = pct(((box.y - previousEnd) * aspect) / parent.width)
  element.style.marginLeft = pct((box.x - parent.x) / parent.width)
  return box.y + box.height
}

function canUseFlex(node) {
  return node.kind === 'branch'
    && node.layout?.flex
    && node.bboxNorm.width > 0
    && node.bboxNorm.height > 0
}

function createNodeElement(node, showBounds) {
  const element = document.createElement('div')
  const layout = nodeLayoutLabel(node)
  element.className = `vgroup-node vgroup-node--${node.kind} vgroup-node--${layout}`
  element.dataset.vgroup = node.id || ''
  element.dataset.layout = layout
  element.dataset.depth = String(node.depth || 0)
  if (node.repeat) element.dataset.repeat = String(node.repeat.count)
  if (node.repeat?.grid) element.dataset.grid = `${node.repeat.grid.rows}x${node.repeat.grid.cols}`
  if (node.sig) element.dataset.signature = node.sig
  element.style.boxSizing = 'border-box'
  element.style.pointerEvents = 'none'
  element.style.overflow = 'visible'
  element.style.zIndex = String(maxZIndex(nodeElements(node)))

  if (canUseFlex(node)) {
    element.style.display = 'flex'
    element.style.flexDirection = node.layout.direction
    element.style.flexWrap = 'nowrap'
    element.style.alignItems = 'flex-start'
    element.style.justifyContent = 'flex-start'
  }

  if (showBounds) {
    element.style.outline = node.kind === 'container'
      ? '1px dashed rgba(255, 128, 0, 0.6)'
      : '1px dashed rgba(0, 119, 255, 0.55)'
    element.style.outlineOffset = '-1px'
    element.style.background = 'rgba(0, 119, 255, 0.03)'
  }
  return element
}

function renderElementsInto(parent, elements, box, renderContext) {
  const { slide, context, metrics, jobId } = renderContext
  const local = elements.filter((element) => !SLIDE_SPACE_KINDS.has(element.kind))
  const slideSpace = elements.filter((element) => SLIDE_SPACE_KINDS.has(element.kind))

  if (local.length) {
    renderDesignSystemContentElements(parent, relativizeElements(local, { bboxNorm: box }), slide, context, metrics, jobId)
  }
  if (slideSpace.length && box.width > 0 && box.height > 0) {
    // A virtual slide-sized frame keeps pt-derived geometry (tables, charts) exact inside the wrapper.
    const frame = document.createElement('div')
    frame.className = 'vgroup-slide-space'
    frame.style.position = 'absolute'
    frame.style.left = pct(-box.x / box.width)
    frame.style.top = pct(-box.y / box.height)
    frame.style.width = pct(1 / box.width)
    frame.style.height = pct(1 / box.height)
    frame.style.pointerEvents = 'none'
    renderDesignSystemContentElements(frame, slideSpace, slide, context, metrics, jobId)
    parent.append(frame)
  }
}

function renderFloating(parent, node, renderContext) {
  for (const unit of node.floating || []) {
    const wrapper = document.createElement('div')
    wrapper.className = `vgroup-floating vgroup-floating--${unit.role}`
    wrapper.dataset.unit = unit.unit_id
    wrapper.style.pointerEvents = 'none'
    wrapper.style.zIndex = String(maxZIndex(unit.members))
    placeAbsolute(wrapper, unit.geometry_norm, node.bboxNorm)
    renderElementsInto(wrapper, unit.members, unit.geometry_norm, renderContext)
    parent.append(wrapper)
  }
}

function renderLeafContent(element, node, renderContext) {
  if (node.units.length === 1) {
    element.classList.add('vgroup-leaf')
    element.dataset.unit = node.units[0].unit_id
    element.dataset.unitKind = node.units[0].kind
    renderElementsInto(element, node.units[0].members, node.bboxNorm, renderContext)
    return
  }
  element.classList.add('vgroup-stack')
  for (const unit of node.units) {
    const wrapper = document.createElement('div')
    wrapper.className = 'vgroup-leaf'
    wrapper.dataset.unit = unit.unit_id
    wrapper.dataset.unitKind = unit.kind
    wrapper.style.pointerEvents = 'none'
    wrapper.style.zIndex = String(maxZIndex(unit.members))
    placeAbsolute(wrapper, unit.geometry_norm, node.bboxNorm)
    renderElementsInto(wrapper, unit.members, unit.geometry_norm, renderContext)
    element.append(wrapper)
  }
}

function renderContainerContent(element, node, renderContext) {
  const plate = document.createElement('div')
  plate.className = 'vgroup-leaf vgroup-container-plate'
  plate.dataset.unit = node.background.unit_id
  plate.dataset.unitKind = node.background.kind
  plate.style.pointerEvents = 'none'
  plate.style.zIndex = String(maxZIndex(node.background.members))
  placeAbsolute(plate, node.background.geometry_norm, node.bboxNorm)
  renderElementsInto(plate, node.background.members, node.background.geometry_norm, renderContext)
  element.append(plate)

  if (node.content) {
    renderNode(element, node.content, node, null, renderContext)
  }
}

/**
 * Mount `node` into `parent`. When `parentNode` is a flex branch the node becomes a flex item,
 * otherwise it is absolutely positioned inside `parentNode` (or the slide when null).
 */
function renderNode(parent, node, parentNode, flexState, renderContext) {
  if (!node) return
  const element = createNodeElement(node, renderContext.showBounds)
  // Single-unit leaves are not groups: keep them out of the highlight/outline machinery.
  if (node.kind === 'leaf' && node.units.length === 1) {
    element.classList.remove('vgroup-node')
    if (renderContext.showBounds) {
      element.style.outline = ''
      element.style.background = ''
    }
  }

  if (flexState) {
    flexState.previousEnd = placeFlexItem(element, node.bboxNorm, parentNode, flexState.previousEnd, renderContext.aspect)
  } else {
    placeAbsolute(element, node.bboxNorm, parentNode?.bboxNorm || null)
  }

  if (node.kind === 'branch') {
    const childFlex = canUseFlex(node)
      ? { previousEnd: node.axis === 'x' ? node.bboxNorm.x : node.bboxNorm.y }
      : null
    for (const child of node.children) {
      renderNode(element, child, node, childFlex, renderContext)
    }
  } else if (node.kind === 'container') {
    renderContainerContent(element, node, renderContext)
  } else {
    renderLeafContent(element, node, renderContext)
  }

  renderFloating(element, node, renderContext)
  parent.append(element)
}

export function mountVgroupSlide(container, slide, jobId, context, options = {}) {
  ensurePresentationFonts()
  container.replaceChildren()

  const vgroupResult = options.vgroupResult || detectSlideVgroups(slide, options)
  const showBounds = Boolean(options.showBounds)
  const metrics = resolveSlideMetrics(slide, context.baseTokens)
  const tokens = context.tokensForSlide(slide)
  const background = slide.render?.background_color || tokens.defaultBackground || '#FFFFFF'

  const frame = document.createElement('div')
  frame.className = 'catalog-slide-frame ds-slide-frame vgroup-slide-frame'

  const slideNode = document.createElement('div')
  slideNode.className = 'catalog-slide ds-slide vgroup-slide'
  slideNode.style.aspectRatio = metrics.aspectRatio
  slideNode.dataset.slideMetrics = `${metrics.widthPt}×${metrics.heightPt}pt`
  slideNode.style.backgroundColor = background
  slideNode.style.position = 'relative'
  slideNode.style.overflow = 'hidden'
  slideNode.style.containerType = 'size'

  const slideSizePt = { width: metrics.widthPt, height: metrics.heightPt }
  for (const layer of filterSlideRenderLayers(slide.render?.layers, slide)) {
    const node = renderLayer(layer, jobId, slideSizePt)
    if (node) slideNode.append(node)
  }

  const renderContext = {
    slide,
    context,
    metrics,
    jobId,
    showBounds,
    aspect: vgroupResult.aspect || (metrics.heightPt && metrics.widthPt ? metrics.heightPt / metrics.widthPt : 9 / 16),
  }

  if (vgroupResult.tree) {
    renderNode(slideNode, vgroupResult.tree, null, null, renderContext)
  }

  for (const element of vgroupResult.ungroupedElements || []) {
    renderDesignSystemContentElements(slideNode, [element], slide, context, metrics, jobId)
  }

  frame.append(slideNode)
  container.append(frame)
  return { frame, slideNode, vgroupResult }
}

export function setVgroupHighlight(container, groupId, { dimOthers = true } = {}) {
  const scope = container.querySelector('.vgroup-slide-frame') || container
  scope.querySelectorAll('.vgroup-node').forEach((node) => {
    const nodeId = node.dataset.vgroup || ''
    const match = Boolean(groupId && (nodeId === groupId || nodeId.startsWith(`${groupId}.`)))
    node.classList.toggle('vgroup-node--highlighted', nodeId === groupId)
    node.classList.toggle('vgroup-node--highlight-descendant', Boolean(groupId && nodeId.startsWith(`${groupId}.`) && nodeId !== groupId))
    node.classList.toggle('vgroup-node--dimmed', Boolean(groupId && dimOthers && !match))
  })
}

/** Serializable description of the nested layout (for export / inspection). */
export function describeVgroupTree(node) {
  if (!node) return null
  const base = {
    id: node.id,
    kind: node.kind,
    layout: nodeLayoutLabel(node),
    bbox: node.bboxNorm,
    signature: node.sig,
  }
  if (node.kind === 'branch') {
    return {
      ...base,
      direction: node.layout?.direction,
      flex: Boolean(node.layout?.flex),
      alignCross: node.layout?.alignCross,
      uniformGap: node.layout?.uniformGap,
      gaps: node.layout?.gaps,
      repeat: node.repeat,
      children: node.children.map(describeVgroupTree),
      floating: node.floating.map((unit) => unit.unit_id),
    }
  }
  if (node.kind === 'container') {
    return {
      ...base,
      background: node.background.unit_id,
      content: describeVgroupTree(node.content),
      floating: node.floating.map((unit) => unit.unit_id),
    }
  }
  return {
    ...base,
    units: node.units.map((unit) => ({ id: unit.unit_id, kind: unit.kind, bbox: unit.geometry_norm })),
    floating: node.floating.map((unit) => unit.unit_id),
  }
}
