// Effective text rect: where the renderer actually draws the lines of a text
// box, which is what hit-tests, the title gap and safe-area checks must use
// (never the nominal frame alone).
//
// Renderer model (templates/slide-render.js renderCatalogTextLine / text
// layers, slides/flex-layout.js applyTextBoxLayout):
// - the box is a border-box with the body insets as padding; the renderer
//   drops all insets when lIns=0 and rIns>0 (shouldApplyBodyInsetsPt), see
//   bodyInsetsPt in text-measure.js;
// - lines stack from the vertical anchor edge of the padded area with
//   overflow visible and unsafe flex alignment: top grows down, bottom grows
//   UP past the frame top, middle grows both ways;
// - a line wider than the text area sticks out by alignment: left → to the
//   right, right → to the left, centre → both sides;
// - wrap="none" never wraps: explicit lines only, width = widest line.
// Anchors are resolved element → typography → donor/layout placeholder, so an
// element that only inherits its anchor is measured (and rendered) the same.
import { estimateTextInkHeightPt } from './separate-vertical-text.js'
import { bodyInsetsPt, textAreaWidthPt, wrapText } from './text-measure.js'

const DEFAULT_SIZE = { width: 960, height: 540 }
const NO_WRAP_WIDTH_PT = 1e7

export function normalizeVerticalAnchor(value) {
  const anchor = String(value ?? '').trim().toLowerCase()
  if (['b', 'bottom'].includes(anchor)) return 'b'
  if (['ctr', 'middle', 'center', 'centre', 'c', 'm', 'mid'].includes(anchor)) return 'ctr'
  return 't'
}

export function resolveVerticalAnchor(element) {
  return normalizeVerticalAnchor(element?.vertical_anchor || element?.typography?.vertical_anchor || 't')
}

export function normalizeAlignment(value) {
  const align = String(value ?? '').trim().toLowerCase()
  if (['ctr', 'center', 'centre', 'c'].includes(align)) return 'ctr'
  if (['r', 'right'].includes(align)) return 'r'
  return 'l'
}

export function isNoWrap(element) {
  return String(element?.wrap ?? '').trim().toLowerCase() === 'none'
}

// Writes the effective anchor onto text elements that only inherit it (from
// their typography, or from the same element / placeholder on the donor
// slide), so the renderer draws what the hit-test measures.
export function inheritVerticalAnchors(report, slide) {
  const elements = slide?.content_elements || []
  let donorElements = null
  for (const element of elements) {
    if (element?.kind !== 'text') continue
    let value = element.vertical_anchor || element.typography?.vertical_anchor
    if (!value) {
      if (!donorElements) {
        const donor = (report?.slides?.slides || []).find((item) => item.slide_number === slide?.slide_number)
        donorElements = donor?.content_elements || []
      }
      const base = String(element.element_id || '').replace(/__.*$/, '')
      const source = donorElements.find((item) => item.vertical_anchor && (item.element_id === element.element_id || item.element_id === base))
        || (element.placeholder_type
          ? donorElements.find((item) => item.vertical_anchor && item.placeholder_type === element.placeholder_type)
          : null)
      value = source?.vertical_anchor
    }
    if (!value) continue
    const anchor = normalizeVerticalAnchor(value)
    if (element.vertical_anchor !== anchor) element.vertical_anchor = anchor
  }
  return slide
}

// Horizontal ink of a text in a frame (normalized): widest line plus the
// horizontal insets, placed by alignment; wrap checks for the hit-test.
export function horizontalTextSpan(element, frame, size = DEFAULT_SIZE) {
  const typography = element?.typography || {}
  const font = Number(typography.size_pt) || 12
  const boxPt = frame.width * size.width
  const areaPt = textAreaWidthPt(element, boxPt)
  const text = String(element?.text ?? '')
  const noWrap = isNoWrap(element)
  let widestPt
  let words
  if (noWrap) {
    widestPt = Math.max(0, ...text.split('\n').map((line) => wrapText(line, NO_WRAP_WIDTH_PT, font, typography).widestPt || 0))
    words = { wordTooWide: false, widePiece: null, widePt: widestPt, areaPt, orphan: null, noWrapOverflow: widestPt > areaPt + 0.5 }
  } else {
    const wrap = wrapText(text, areaPt, font, typography)
    widestPt = Math.max(wrap.widestPt, wrap.longestPiecePt)
    words = {
      wordTooWide: wrap.overflowWord,
      widePiece: wrap.overflowWord ? wrap.longestPiece : null,
      widePt: wrap.longestPiecePt,
      areaPt,
      orphan: wrap.orphans[0]?.text ?? null,
      noWrapOverflow: false,
    }
  }
  const insetPt = Math.max(0, boxPt - areaPt)
  const width = Math.max(font * 0.3, widestPt + insetPt) / size.width
  const align = normalizeAlignment(typography.alignment)
  const x = align === 'ctr' ? frame.x + (frame.width - width) / 2
    : align === 'r' ? frame.x + frame.width - width : frame.x
  return { x, width, words }
}

// Visible text lines of an element drawn in `box` (normalized). overflowPt is
// the text height beyond the padded text area (> 0: the text leaves its frame
// on the anchor's growth side(s)). padTop/padBottom: vertical insets
// (normalized) around the text area.
export function effectiveTextRect(element, box, size = DEFAULT_SIZE) {
  const anchor = resolveVerticalAnchor(element)
  const font = Number(element?.typography?.size_pt)
  if (!String(element?.text ?? '').trim() || !(font > 0)) {
    return { ...box, overflowPt: 0, padTop: 0, padBottom: 0, anchor, words: {} }
  }
  const insets = bodyInsetsPt(element)
  const contentPt = Math.max(0, box.height * size.height - insets.top - insets.bottom)
  const heightPt = estimateTextInkHeightPt(element, box.width * size.width) ?? contentPt
  const height = heightPt / size.height
  const padTop = insets.top / size.height
  const padBottom = insets.bottom / size.height
  const contentTop = box.y + padTop
  const contentBottom = Math.max(contentTop, box.y + box.height - padBottom)
  const y = anchor === 'b' ? contentBottom - height
    : anchor === 'ctr' ? (contentTop + contentBottom - height) / 2
      : contentTop
  const span = horizontalTextSpan(element, box, size)
  return { x: span.x, y, width: span.width, height, overflowPt: heightPt - contentPt, padTop, padBottom, anchor, words: span.words }
}
