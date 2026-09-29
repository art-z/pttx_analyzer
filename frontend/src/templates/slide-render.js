import { buildRenderQueue, mountFlexStack, resolveTextWhiteSpace, stackGeometryNorm, applyTextAlignment, applyTextBoxLayout, applyVerticalTextAnchor, verticalAnchorToJustifyContent, resolveTextGroupLineGapPt, resolveFlexStackAlignItems, resolveFlexStackDirection, flexStackItemWidthPercent, applyFlexStackLineHeight, flexStackUsesCompactDisplayLayout, resolveFlexStackBodyInsetsPt } from '../slides/flex-layout.js'
import { applyFillStyle, typographyColorCss } from '../slides/fill-styles.js'
import { applyLayerShapeAppearance } from '../slides/block-radius.js'
import { applyBodyInsetsPt, applyParagraphSpacingPt, ptToSlideCqw, slideWidthPt } from '../slides/slide-metrics.js'
import { filterSlideRenderLayers } from '../slides/slide-layer-filter.js'
import { populateTextLineContent, usesBulletRowLayout, usesParagraphBlockLayout, applyLineHeight, usesMetricLayout, applyMetricTextLayout, usesTextRunsLayout, shouldApplyParagraphSpacingInFlexStack, paragraphSpacingForFlexStackItem } from '../slides/text-list.js'
import { mountStyledTable, resolveTableGeometryNorm } from '../slides/table-render.js'
import { mountChart } from '../slides/chart-render.js'
import { darkSurfaceFillColor } from '../presentation/component-template-fit.js'
import { mountDiagram } from '../slides/diagram-render.js'
import { mountLine } from '../slides/line-render.js'

const ROLE_LABELS = {
  title: 'Заголовок',
  subtitle: 'Подзаголовок',
  body: 'Текст',
  content: 'Контент',
}

function assetUrl(jobId, filename) {
  return `/jobs/${encodeURIComponent(jobId)}/assets/${encodeURIComponent(filename)}`
}

function placeBox(node, geometry) {
  const geom = geometry || {}
  node.style.position = 'absolute'
  node.style.left = `${(geom.x || 0) * 100}%`
  node.style.top = `${(geom.y || 0) * 100}%`
  node.style.width = `${(geom.width || 0) * 100}%`
  if (geom.height != null && geom.height > 0) {
    node.style.height = `${geom.height * 100}%`
  } else {
    node.style.height = 'auto'
  }
}

let maskClipCounter = 0

function applyLayerMask(node, mask, layerId) {
  if (!mask || mask.kind === 'rect') return

  if (mask.kind === 'ellipse') {
    node.style.clipPath = 'ellipse(50% 50% at 50% 50%)'
    return
  }

  if (mask.kind === 'roundRect') {
    const radius = Number(mask.radius_pct)
    if (Number.isFinite(radius) && radius > 0) {
      node.style.clipPath = `inset(0 round ${radius}%)`
    }
    return
  }

  if (mask.kind === 'path' && mask.path) {
    maskClipCounter += 1
    const safeId = String(layerId || maskClipCounter).replace(/[^a-zA-Z0-9_-]/g, '-')
    const clipId = `template-mask-${safeId}`
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    svg.setAttribute('width', '0')
    svg.setAttribute('height', '0')
    svg.setAttribute('aria-hidden', 'true')
    svg.style.position = 'absolute'

    const defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs')
    const clipPath = document.createElementNS('http://www.w3.org/2000/svg', 'clipPath')
    clipPath.setAttribute('id', clipId)
    clipPath.setAttribute('clipPathUnits', 'objectBoundingBox')

    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
    path.setAttribute('d', mask.path)
    clipPath.append(path)
    defs.append(clipPath)
    svg.append(defs)
    node.append(svg)
    node.style.clipPath = `url(#${clipId})`
  }
}

function applyLayerTransform(node, flip, rotate) {
  const parts = []
  const deg = Number(rotate?.deg)
  if (flip?.h || flip?.v) {
    parts.push(`scale(${flip.h ? -1 : 1}, ${flip.v ? -1 : 1})`)
  }
  if (Number.isFinite(deg) && Math.abs(deg) > 0.001) {
    parts.push(`rotate(${deg}deg)`)
  }
  if (!parts.length) return false
  node.style.transform = parts.join(' ')
  node.style.transformOrigin = 'center center'
  return true
}

function createLayerShell(layer) {
  const shell = document.createElement('div')
  shell.className = 'template-layer-shell'
  shell.style.width = '100%'
  shell.style.height = '100%'

  const transformed = document.createElement('div')
  transformed.className = 'template-layer-transform'
  transformed.style.width = '100%'
  transformed.style.height = '100%'
  applyLayerTransform(transformed, layer.flip, layer.rotate)

  const content = document.createElement('div')
  content.className = 'template-layer-content'
  content.style.position = 'relative'
  content.style.width = '100%'
  content.style.height = '100%'
  content.style.overflow = 'hidden'

  transformed.append(content)
  shell.append(transformed)
  return { shell, content }
}

function applyImageCrop(img, crop, fillMode) {
  const l = crop?.l || 0
  const t = crop?.t || 0
  const r = crop?.r || 0
  const b = crop?.b || 0
  const hasCrop = l > 0 || t > 0 || r > 0 || b > 0

  img.style.display = 'block'
  img.draggable = false

  if (!hasCrop) {
    img.classList.remove('template-layer-img--cropped')
    img.style.position = ''
    img.style.left = ''
    img.style.top = ''
    img.style.maxWidth = ''
    img.style.width = '100%'
    img.style.height = '100%'
    img.style.objectFit = fillMode === 'tile' ? 'none' : 'fill'
    return
  }

  const visibleW = 1 - l - r
  const visibleH = 1 - t - b
  if (visibleW <= 0 || visibleH <= 0) {
    img.classList.remove('template-layer-img--cropped')
    img.style.width = '100%'
    img.style.height = '100%'
    img.style.objectFit = 'fill'
    return
  }

  img.classList.add('template-layer-img--cropped')
  img.style.position = 'absolute'
  img.style.maxWidth = 'none'
  img.style.objectFit = 'fill'
  img.style.width = `${100 / visibleW}%`
  img.style.height = `${100 / visibleH}%`
  img.style.left = `${(-100 * l) / visibleW}%`
  img.style.top = `${(-100 * t) / visibleH}%`
}

export function renderLayer(layer, jobId, slideSizePt = null) {
  const node = document.createElement('div')
  node.className = `template-layer template-layer--${layer.kind}`
  node.style.zIndex = String(layer.z_index ?? 0)
  if (layer.name) node.title = layer.name
  placeBox(node, layer.geometry_norm)

  const { shell, content } = createLayerShell(layer)
  node.append(shell)

  if (layer.kind === 'fill') {
    applyFillStyle(content, layer.fill) || (content.style.backgroundColor = layer.fill?.color || '#FFFFFF')
    applyLayerShapeAppearance(content, layer, slideSizePt, applyLayerMask)
    return node
  }

  if (layer.kind === 'image' && layer.asset && jobId) {
    applyLayerShapeAppearance(content, layer, slideSizePt, applyLayerMask)
    const img = document.createElement('img')
    img.src = assetUrl(jobId, layer.asset)
    img.alt = layer.name || layer.asset
    applyImageCrop(img, layer.crop, layer.fill_mode)
    content.append(img)
    return node
  }

  if (layer.kind === 'line') {
    content.style.overflow = 'visible'
    mountLine(content, layer, slideSizePt)
    return node
  }

  if (layer.kind === 'text') {
    const typography = layer.typography || {}
    const widthPt = slideWidthPt(slideSizePt)
    content.style.fontFamily = `"${typography.family || 'Arial'}", sans-serif`
    content.style.fontSize = ptToSlideCqw(typography.size_pt || 14, widthPt)
    content.style.fontWeight = typography.bold ? '700' : '400'
    content.style.fontStyle = typography.italic ? 'italic' : 'normal'
    content.style.textDecoration = typography.underline && typography.underline !== 'none' ? 'underline' : 'none'
    applyLineHeight(content, typography, layer.paragraph_spacing_pt || {}, slideSizePt)
    content.style.color = typographyColorCss(typography) || typography.color || '#000000'
    content.style.overflow = 'visible'
    // Break only between words (the layout estimator in text-measure.js assumes the same).
    content.style.wordBreak = 'normal'
    content.style.overflowWrap = 'normal'
    content.style.hyphens = 'manual'
    content.style.whiteSpace = resolveTextWhiteSpace(layer.text, layer.wrap)
    applyTextAlignment(content, typography.alignment)
    applyVerticalTextAnchor(content, layer.vertical_anchor)
    applyBodyInsetsPt(content, layer.body_insets_pt, widthPt)
    applyParagraphSpacingPt(content, layer.paragraph_spacing_pt, widthPt)
    content.textContent = layer.text || ''
    return node
  }

  return null
}

export function mountTemplateBackground(container, template, jobId) {
  container.replaceChildren()
  const render = template.render || {}
  const slideSize = render.slide_size_pt || {}

  const slide = document.createElement('div')
  slide.className = 'template-preview-slide constructor-template-bg'
  slide.style.width = '100%'
  slide.style.height = '100%'
  slide.style.backgroundColor = render.background_color || template.colors?.background || '#FFFFFF'
  slide.style.position = 'absolute'
  slide.style.inset = '0'
  slide.style.overflow = 'hidden'

  for (const layer of render.layers || []) {
    const node = renderLayer(layer, jobId, slideSize)
    if (node) slide.append(node)
  }

  container.append(slide)
  return slide
}

export function renderCatalogNonTextElement(element, jobId, slideSizePt, { tokens = null, surfaceColor = null } = {}) {
  const node = document.createElement('div')
  node.className = `catalog-element catalog-element--${element.kind}`
  node.style.zIndex = String(element.z_index ?? 0)
  if (element.name) node.title = element.name
  const geometry = element.kind === 'table'
    ? resolveTableGeometryNorm(element, slideSizePt)
    : element.geometry_norm
  placeBox(node, geometry)

  if (element.kind === 'table') {
    return mountStyledTable(node, element, slideSizePt, { tokens })
  }

  if (element.kind === 'chart') {
    return mountChart(node, element, slideSizePt, { tokens, surfaceColor })
  }

  if (element.kind === 'diagram') {
    return mountDiagram(node, element, slideSizePt, { tokens })
  }

  if (element.kind === 'line') {
    return mountLine(node, element, slideSizePt)
  }

  if (element.kind === 'graphic') {
    node.classList.add('catalog-placeholder')
    node.append(Object.assign(document.createElement('span'), {
      className: 'catalog-placeholder-label',
      textContent: 'Graphic',
    }))
    return node
  }

  const layerNode = renderLayer({
    ...element,
    layer_id: element.element_id,
    kind: element.kind,
  }, jobId, slideSizePt)
  return layerNode
}

function renderCatalogTextLine(element, slideSizePt, { inFlexStack = false, skipMetric = false, skipParagraphSpacing = false, compactDisplayLayout = false, flexStackLineIndex = 0 } = {}) {
  const node = document.createElement('div')
  node.className = `catalog-element catalog-element--text${inFlexStack ? ' catalog-flex-stack__item' : ''}`
  if (!inFlexStack) {
    node.style.zIndex = String(element.z_index ?? 0)
    placeBox(node, element.geometry_norm)
  } else {
    node.style.position = 'static'
    node.style.left = 'auto'
    node.style.top = 'auto'
    node.style.width = '100%'
    node.style.maxWidth = '100%'
    node.style.height = 'auto'
    node.style.flex = '0 0 auto'
  }
  if (element.name && !inFlexStack) node.title = element.name
  const typo = element.typography || {}
  node.classList.add('catalog-text')
  const hasBulletRow = populateTextLineContent(node, element, typo, slideSizePt, {
    skipMetric: skipMetric || inFlexStack,
  })
  if (!hasBulletRow) {
    node.style.fontFamily = `"${typo.family || 'Arial'}", sans-serif`
    if (slideSizePt?.width && typo.size_pt) {
      node.style.fontSize = `${((typo.size_pt || 14) / slideSizePt.width) * 100}cqw`
    } else {
      node.style.fontSize = `${Math.max(8, (typo.size_pt || 14) * 0.85)}px`
    }
    node.style.fontWeight = typo.bold ? '700' : '400'
    node.style.fontStyle = typo.italic ? 'italic' : 'normal'
    node.style.textDecoration = typo.underline && typo.underline !== 'none' ? 'underline' : 'none'
    if (inFlexStack) {
      applyFlexStackLineHeight(node, element, { compactDisplayLayout })
    } else {
      applyLineHeight(node, typo, element.paragraph_spacing_pt || {}, slideSizePt)
    }
    node.style.color = typographyColorCss(typo) || typo.color || '#000000'
    // Break only between words (the layout estimator in text-measure.js assumes the same).
    node.style.wordBreak = 'normal'
    node.style.overflowWrap = 'normal'
    node.style.hyphens = 'manual'
    node.style.whiteSpace = resolveTextWhiteSpace(element.text, element.wrap)
    applyTextAlignment(node, typo.alignment)
  } else {
    node.style.overflow = 'visible'
  }
  node.style.boxSizing = 'border-box'
  let spacingOptions = {
    skipHangingIndent: usesBulletRowLayout(element) || usesParagraphBlockLayout(element) || usesTextRunsLayout(element),
  }
  if (!inFlexStack) {
    if (usesMetricLayout(element)) {
      applyMetricTextLayout(node, element, typo)
    } else {
      applyTextBoxLayout(node, element.vertical_anchor, typo.alignment)
    }
    applyBodyInsetsPt(node, element.body_insets_pt, slideSizePt?.width)
    spacingOptions = { ...spacingOptions, skipHangingIndent: true }
  }
  const applyParagraphSpacing = !skipParagraphSpacing
    && (!inFlexStack || shouldApplyParagraphSpacingInFlexStack(element, { compactDisplayLayout }))
  if (applyParagraphSpacing) {
    const spacing = inFlexStack
      ? paragraphSpacingForFlexStackItem(element, flexStackLineIndex)
      : (element.paragraph_spacing_pt || {})
    applyParagraphSpacingPt(node, spacing, slideSizePt?.width, spacingOptions)
  }
  return node
}

function renderCatalogTextGroup(members, slideSizePt, parent) {
  const anchor = members[0]
  const compactDisplayLayout = flexStackUsesCompactDisplayLayout(members)
  const geometry = stackGeometryNorm(members)
  const direction = resolveFlexStackDirection(members)
  const gapPt = resolveTextGroupLineGapPt(members)
  const stack = mountFlexStack(parent, geometry, {
    className: 'catalog-flex-stack catalog-flex-stack--text',
    zIndex: anchor.z_index ?? 0,
    direction,
    alignItems: resolveFlexStackAlignItems(members),
    justifyContent: direction === 'row' ? 'flex-start' : verticalAnchorToJustifyContent(anchor.vertical_anchor),
    fillHeight: true,
    title: anchor.name,
    dataset: { textGroupId: anchor.text_group_id || '' },
  })
  stack.style.boxSizing = 'border-box'
  if (gapPt > 0) {
    stack.style.gap = ptToSlideCqw(gapPt, slideSizePt?.width)
  }
  const bodyInsets = resolveFlexStackBodyInsetsPt(members)
  if (bodyInsets) applyBodyInsetsPt(stack, bodyInsets, slideSizePt?.width)
  for (const [index, member] of members.entries()) {
    const item = renderCatalogTextLine(member, slideSizePt, {
      inFlexStack: true,
      skipMetric: true,
      flexStackLineIndex: index,
      compactDisplayLayout,
    })
    if (direction === 'row') {
      const width = flexStackItemWidthPercent(member, geometry, direction)
      item.style.width = `${width}%`
      item.style.maxWidth = `${width}%`
      item.style.flex = `0 0 ${width}%`
    }
    stack.append(item)
  }
  return stack
}

function renderContentElement(element, jobId, slideSizePt, surfaceColor = null) {
  if (element.kind === 'text') {
    return renderCatalogTextLine(element, slideSizePt)
  }
  return renderCatalogNonTextElement(element, jobId, slideSizePt, { surfaceColor })
}

export function mountCatalogSlide(container, slide, jobId) {
  container.replaceChildren()
  const render = slide.render || {}
  const slideSize = render.slide_size_pt || {}

  const frame = document.createElement('div')
  frame.className = 'catalog-slide-frame'

  const slideNode = document.createElement('div')
  slideNode.className = 'catalog-slide'
  if (slideSize.width && slideSize.height) {
    slideNode.style.aspectRatio = `${slideSize.width} / ${slideSize.height}`
  }
  slideNode.style.backgroundColor = render.background_color || '#FFFFFF'
  slideNode.style.position = 'relative'
  slideNode.style.overflow = 'hidden'
  slideNode.style.containerType = 'size'

  for (const layer of filterSlideRenderLayers(render.layers, slide)) {
    const node = renderLayer(layer, jobId, slideSize)
    if (node) slideNode.append(node)
  }

  const content = [...(slide.content_elements || [])].sort((a, b) => (a.z_index || 0) - (b.z_index || 0))
  const surfaceColor = darkSurfaceFillColor(slide)
  for (const item of buildRenderQueue(content)) {
    if (item.kind === 'flex_stack') {
      renderCatalogTextGroup(item.members, slideSize, slideNode)
      continue
    }
    const node = renderContentElement(item.element, jobId, slideSize, surfaceColor)
    if (node) slideNode.append(node)
  }

  frame.append(slideNode)
  container.append(frame)
  return frame
}

export function mountTemplateSlide(container, template, jobId) {
  container.replaceChildren()
  const render = template.render || {}
  const slideSize = render.slide_size_pt || {}

  const frame = document.createElement('div')
  frame.className = 'template-preview-frame'

  const slide = document.createElement('div')
  slide.className = 'template-preview-slide'
  if (slideSize.width && slideSize.height) {
    slide.style.aspectRatio = `${slideSize.width} / ${slideSize.height}`
  }
  slide.style.backgroundColor = render.background_color || template.colors?.background || '#FFFFFF'
  slide.style.position = 'relative'
  slide.style.overflow = 'hidden'

  for (const layer of render.layers || []) {
    const node = renderLayer(layer, jobId, slideSize)
    if (node) slide.append(node)
  }

  for (const slot of template.editable_slots || []) {
    const box = document.createElement('div')
    box.className = 'template-preview-slot'
    box.style.zIndex = '100'
    placeBox(box, slot.geometry_norm)
    const label = document.createElement('span')
    label.className = 'template-preview-slot-label'
    label.textContent = ROLE_LABELS[slot.role] || slot.role || 'slot'
    box.append(label)
    slide.append(box)
  }

  frame.append(slide)
  container.append(frame)
  return frame
}
