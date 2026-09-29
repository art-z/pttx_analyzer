/** Fallback only when report has no slide_size_pt (standard 16:9). */
export const FALLBACK_SLIDE_SIZE_PT = { width: 720, height: 405 }

/**
 * Single source for slide dimensions in DOM render.
 * Backend reads ppt/presentation.xml sldSz → report.typography.visibility.slide_size_pt
 * and copies into each slide.render.slide_size_pt.
 */
export function resolveSlideMetrics(slide, baseTokens) {
  const fromSlide = slide?.render?.slide_size_pt
  const fromReport = baseTokens?.slideSize
  const widthPt = fromSlide?.width || fromReport?.width || FALLBACK_SLIDE_SIZE_PT.width
  const heightPt = fromSlide?.height || fromReport?.height || FALLBACK_SLIDE_SIZE_PT.height
  return {
    widthPt,
    heightPt,
    aspectRatio: `${widthPt} / ${heightPt}`,
    ratio: heightPt ? widthPt / heightPt : 16 / 9,
    source: fromSlide?.width ? 'slide.render' : fromReport?.width ? 'report.tokens' : 'fallback',
  }
}

/** PPTX pt → % of slide frame width (cqw). Correct when aspect-ratio matches widthPt/heightPt. */
export function ptToSlideCqw(sizePt, widthPt) {
  if (!widthPt) return `${Math.max(8, sizePt || 14)}px`
  return `${((sizePt || 14) / widthPt) * 100}cqw`
}

/** PPTX pt → % of slide frame height (cqh). Requires container-type: size on slide root. */
export function ptToSlideCqh(sizePt, heightPt) {
  if (!heightPt) return `${Math.max(8, sizePt || 14)}px`
  return `${((sizePt || 14) / heightPt) * 100}cqh`
}

/** Accept slideSizePt objects from catalog ({ width }) or DS ({ widthPt }). */
export function slideWidthPt(slideSizePt) {
  if (!slideSizePt) return null
  if (typeof slideSizePt === 'number') return slideSizePt
  return slideSizePt.width ?? slideSizePt.widthPt ?? null
}

export function slideHeightPt(slideSizePt) {
  if (!slideSizePt) return null
  if (typeof slideSizePt === 'number') return slideSizePt
  return slideSizePt.height ?? slideSizePt.heightPt ?? null
}

export function typographySizePt(typography) {
  return typography?.size_pt ?? typography?.sizePt ?? 14
}

/** PPTX pt → % of slide frame width for padding/margins (use cqw — % is wrong inside nested boxes). */
export function ptToSlidePadding(sizePt, widthPt) {
  return ptToSlideCqw(sizePt, widthPt)
}

/** Google Slides often exports lIns=0 with rIns/tIns/bIns still set on body placeholders. */
export function shouldApplyBodyInsetsPt(insets) {
  if (!insets) return false
  const left = Number(insets.left || 0)
  const right = Number(insets.right || 0)
  if (left === 0 && right > 0) return false
  return Boolean(left || right || insets.top || insets.bottom)
}

export function applyBodyInsetsPt(node, insets, widthPt) {
  if (!node || !widthPt || !shouldApplyBodyInsetsPt(insets)) return

  const leftPt = Number(insets.left || 0)
  const right = insets.right ? ptToSlidePadding(insets.right, widthPt) : undefined
  const top = insets.top ? ptToSlidePadding(insets.top, widthPt) : undefined
  const bottom = insets.bottom ? ptToSlidePadding(insets.bottom, widthPt) : undefined

  if (leftPt) node.style.paddingLeft = ptToSlidePadding(leftPt, widthPt)
  if (right) node.style.paddingRight = right
  if (top) node.style.paddingTop = top
  if (bottom) node.style.paddingBottom = bottom
}

export function applyParagraphSpacingPt(node, spacing, widthPt, options = {}) {
  if (!node || !spacing || !widthPt) return
  const spaceBefore = Number(spacing.space_before || 0)
  const spaceAfter = Number(spacing.space_after || 0)
  if (!options.skipHangingIndent) {
    const marginLeft = Number(spacing.margin_left || 0)
    const indent = Number(spacing.indent || 0)
    if (marginLeft) node.style.paddingLeft = ptToSlidePadding(marginLeft, widthPt)
    if (indent) node.style.textIndent = ptToSlidePadding(indent, widthPt)
  } else {
    node.style.textIndent = '0'
  }
  if (spaceBefore) node.style.marginTop = ptToSlidePadding(spaceBefore, widthPt)
  if (spaceAfter) node.style.marginBottom = ptToSlidePadding(spaceAfter, widthPt)
}
