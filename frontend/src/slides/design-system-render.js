import { darkSurfaceFillColor } from '../presentation/component-template-fit.js'
import { renderCatalogNonTextElement, renderLayer } from '../templates/slide-render.js'
import { buildRenderQueue, mountFlexStack, resolveTextWhiteSpace, stackGeometryNorm, applyTextAlignment, applyTextBoxLayout, verticalAnchorToJustifyContent, resolveTextGroupLineGapPt, resolveFlexStackAlignItems, resolveFlexStackDirection, flexStackItemWidthPercent, applyFlexStackLineHeight, flexStackUsesCompactDisplayLayout, resolveFlexStackBodyInsetsPt } from './flex-layout.js'
import { resolveCatalogTextStyle, snapSizeToTypeScale } from './resolve-element-style.js'
import { typographyColorCss } from './fill-styles.js'
import { applyBodyInsetsPt, applyParagraphSpacingPt, ptToSlideCqw, resolveSlideMetrics } from './slide-metrics.js'
import { filterSlideRenderLayers } from './slide-layer-filter.js'
import { populateTextLineContent, usesBulletRowLayout, usesParagraphBlockLayout, applyLineHeight, usesMetricLayout, applyMetricTextLayout, usesTextRunsLayout, shouldApplyParagraphSpacingInFlexStack, paragraphSpacingForFlexStackItem } from './text-list.js'

let fontsLoadPromise = null

export function ensurePresentationFonts() {
  if (fontsLoadPromise) return fontsLoadPromise
  fontsLoadPromise = (async () => {
    try {
      const response = await fetch('/fonts/font-aliases.json')
      if (!response.ok) return
      const registry = await response.json()
      const rules = []
      for (const [aliasFamily, config] of Object.entries(registry.aliases || {})) {
        for (const [styleName, relativePath] of Object.entries(config.styles || {})) {
          const weight = styleName === 'bold' || styleName === 'demibold' ? 700 : styleName === 'medium' ? 500 : 400
          rules.push(`@font-face{font-family:"${config.family}";src:url("/fonts/${relativePath}") format("truetype");font-weight:${weight};font-style:normal;font-display:swap;}`)
          rules.push(`@font-face{font-family:"${aliasFamily}";src:url("/fonts/${relativePath}") format("truetype");font-weight:${weight};font-style:normal;font-display:swap;}`)
        }
      }
      if (rules.length) {
        const style = document.createElement('style')
        style.dataset.designSystemFonts = 'true'
        style.textContent = rules.join('')
        document.head.append(style)
      }
      await document.fonts.ready
    } catch {
      // optional local fonts
    }
  })()
  return fontsLoadPromise
}

function placeAbsoluteBox(node, geometry) {
  const geom = geometry || {}
  node.style.position = 'absolute'
  node.style.left = `${(geom.x || 0) * 100}%`
  node.style.top = `${(geom.y || 0) * 100}%`
  node.style.width = `${(geom.width || 0) * 100}%`
  node.style.maxWidth = `${(geom.width || 0) * 100}%`
  node.style.height = 'auto'
}

function applyDesignSystemTextStyles(node, typography, tokens, widthPt, text = '', spacing = {}) {
  const family = typography.family || tokens.defaultFontFamily
  node.style.fontFamily = `"${family}", ${tokens.themeFonts?.major?.latin || 'Arial'}, sans-serif`
  node.style.fontSize = ptToSlideCqw(typography.sizePt || 14, widthPt)
  node.style.fontWeight = typography.bold ? '700' : '400'
  node.style.fontStyle = typography.italic ? 'italic' : 'normal'
  node.style.textDecoration = typography.underline && typography.underline !== 'none' ? 'underline' : 'none'
  applyLineHeight(node, typography, spacing, { widthPt })
  node.style.color = typographyColorCss(typography) || typography.color || tokens.defaultTextColor
  node.style.overflow = 'visible'
  // Break only between words (the layout estimator in text-measure.js assumes the same).
  node.style.wordBreak = 'normal'
  node.style.overflowWrap = 'normal'
  node.style.hyphens = 'manual'
  node.style.whiteSpace = resolveTextWhiteSpace(text)
  applyTextAlignment(node, typography.alignment)
}

function renderDesignSystemTextLine(element, slide, context, metrics, { inFlexStack = false, skipMetric = false, skipParagraphSpacing = false, compactDisplayLayout = false, flexStackLineIndex = 0 } = {}) {
  const resolved = resolveCatalogTextStyle(element, slide, context)
  const tokens = context.tokensForSlide(slide)
  const node = document.createElement('div')
  node.className = `ds-element ds-element--text ds-text--${resolved.role}${inFlexStack ? ' ds-flex-stack__item' : ''}`
  node.dataset.styleSource = resolved.source
  if (!inFlexStack) {
    node.style.position = 'absolute'
    node.style.zIndex = String(element.z_index ?? 0)
    placeAbsoluteBox(node, element.geometry_norm)
    if (element.geometry_norm?.height) {
      node.style.height = `${element.geometry_norm.height * 100}%`
    }
  } else {
    node.style.position = 'static'
    node.style.left = 'auto'
    node.style.top = 'auto'
    node.style.width = '100%'
    node.style.maxWidth = '100%'
    node.style.height = 'auto'
    node.style.flex = '0 0 auto'
  }
  node.style.pointerEvents = 'none'
  node.style.boxSizing = 'border-box'
  const hasBulletRow = populateTextLineContent(node, element, resolved.typography, { width: metrics.widthPt }, {
    skipMetric: skipMetric || inFlexStack,
  })
  if (!hasBulletRow) {
    applyDesignSystemTextStyles(node, resolved.typography, tokens, metrics.widthPt, element.text, element.paragraph_spacing_pt || {})
    if (inFlexStack) {
      const scaleMatch = compactDisplayLayout
        ? snapSizeToTypeScale(element.typography?.size_pt, resolved.role, tokens)
        : null
      applyFlexStackLineHeight(node, element, {
        compactDisplayLayout,
        lineHeightRatio: scaleMatch?.lineHeightRatio,
      })
    }
  }
  let spacingOptions = {
    skipHangingIndent: usesBulletRowLayout(element) || usesParagraphBlockLayout(element) || usesTextRunsLayout(element),
  }
  if (!inFlexStack) {
    if (usesMetricLayout(element)) {
      applyMetricTextLayout(node, element, resolved.typography)
    } else {
      applyTextBoxLayout(node, element.vertical_anchor, resolved.typography.alignment)
    }
    applyBodyInsetsPt(node, element.body_insets_pt, metrics.widthPt)
    spacingOptions = { ...spacingOptions, skipHangingIndent: true }
  }
  const applyParagraphSpacing = !skipParagraphSpacing
    && (!inFlexStack || shouldApplyParagraphSpacingInFlexStack(element, { compactDisplayLayout }))
  if (applyParagraphSpacing) {
    const spacing = inFlexStack
      ? paragraphSpacingForFlexStackItem(element, flexStackLineIndex)
      : (element.paragraph_spacing_pt || {})
    applyParagraphSpacingPt(node, spacing, metrics.widthPt, spacingOptions)
  }
  return node
}

function renderDesignSystemTextGroup(members, slide, context, metrics, parent) {
  const anchor = members[0]
  const compactDisplayLayout = flexStackUsesCompactDisplayLayout(members)
  const geometry = stackGeometryNorm(members)
  const direction = resolveFlexStackDirection(members)
  const gapPt = resolveTextGroupLineGapPt(members)
  const stack = mountFlexStack(parent, geometry, {
    className: 'catalog-flex-stack ds-flex-stack ds-flex-stack--text',
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
    stack.style.gap = ptToSlideCqw(gapPt, metrics.widthPt)
  }
  const bodyInsets = resolveFlexStackBodyInsetsPt(members)
  if (bodyInsets) applyBodyInsetsPt(stack, bodyInsets, metrics.widthPt)

  for (const [index, member] of members.entries()) {
    const item = renderDesignSystemTextLine(member, slide, context, metrics, {
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
    } else {
      item.style.flex = '0 0 auto'
    }
    stack.append(item)
  }

  return stack
}

export function renderDesignSystemContentElements(parent, contentElements, slide, context, metrics, jobId) {
  const tokens = context.tokensForSlide(slide)
  const slideSizePt = { width: metrics.widthPt, height: metrics.heightPt }
  const surfaceColor = darkSurfaceFillColor(slide)

  for (const item of buildRenderQueue(contentElements || [])) {
    if (item.kind === 'flex_stack') {
      renderDesignSystemTextGroup(item.members, slide, context, metrics, parent)
      continue
    }
    const element = item.element
    const node = element.kind === 'text'
      ? renderDesignSystemTextLine(element, slide, context, metrics)
      : renderCatalogNonTextElement(element, jobId, slideSizePt, { tokens, surfaceColor })
    if (node) parent.append(node)
  }
}

export function mountDesignSystemSlide(container, slide, jobId, context) {
  ensurePresentationFonts()
  container.replaceChildren()

  const metrics = resolveSlideMetrics(slide, context.baseTokens)
  const tokens = context.tokensForSlide(slide)
  const background = slide.render?.background_color || tokens.defaultBackground || '#FFFFFF'

  const frame = document.createElement('div')
  frame.className = 'catalog-slide-frame ds-slide-frame'

  const slideNode = document.createElement('div')
  slideNode.className = 'catalog-slide ds-slide'
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

  renderDesignSystemContentElements(slideNode, slide.content_elements || [], slide, context, metrics, jobId)

  frame.append(slideNode)
  container.append(frame)
  return frame
}
