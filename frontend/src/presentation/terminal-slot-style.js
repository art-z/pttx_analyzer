// Style inference for empty text slots of cover/ending templates.
//
// Empty placeholders in a .pptx template carry whatever formatting the layout
// author left there (often black-on-black, 60pt defaults, code fonts). They are
// never trusted directly for templates the analyzer did not approve. Instead the
// style is taken from same-role text on the most similar filled slide (same
// layout, same base layout name, same background class, similar geometry), then
// the colour is checked against the real background under the box. Design tokens
// are the fallback; if nothing reaches the minimum contrast the slot is unusable.
import { contrastRatio } from './component-template-fit.js'
import { findSlideTitleElements } from '../slides/slide-title-detect.js'
import { extractDesignTokens, pickTitleTypography } from '../constructor/tokens.js'

export const MIN_TERMINAL_TEXT_CONTRAST = 3
export const TERMINAL_REFERENCE_MIN_SCORE = 35
const IMAGE_COVER_LIMIT = 0.35
const HEX_RE = /^#[0-9a-f]{6}$/i
const CODE_FONT_RE = /consolas|courier|menlo|monaco|mono\b|monospace|source code|fira code/i
const TITLE_PLACEHOLDERS = new Set(['title', 'ctrTitle'])
const SUBTITLE_PLACEHOLDERS = new Set(['subTitle', 'body'])

const referenceCache = new WeakMap()
const tokenCache = new WeakMap()

function normalizeHex(value) {
  const text = String(value || '').trim()
  const hex = text.startsWith('#') ? text : `#${text}`
  return HEX_RE.test(hex) ? hex.toUpperCase() : null
}

function validBox(box) {
  return box && Number(box.width) > 0 && Number(box.height) > 0
}

function boxArea(box) {
  return validBox(box) ? Number(box.width) * Number(box.height) : 0
}

function intersectionArea(left, right) {
  if (!validBox(left) || !validBox(right)) return 0
  const x = Math.max(0, Math.min(left.x + left.width, right.x + right.width) - Math.max(left.x, right.x))
  const y = Math.max(0, Math.min(left.y + left.height, right.y + right.height) - Math.max(left.y, right.y))
  return x * y
}

export function boxIou(left, right) {
  const shared = intersectionArea(left, right)
  const union = boxArea(left) + boxArea(right) - shared
  return union > 0 ? shared / union : 0
}

export function layoutBaseName(name) {
  return String(name || '').replace(/^\s*\d+\s*[_.\-\s]\s*/, '').trim().toLowerCase()
}

function luminance(hex) {
  const value = normalizeHex(hex)
  if (!value) return null
  const channel = (index) => {
    const c = parseInt(value.slice(index, index + 2), 16) / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5)
}

export function backgroundClass(hex) {
  const value = luminance(hex)
  if (value == null) return 'unknown'
  return value < 0.4 ? 'dark' : 'light'
}

function paintColor(item) {
  const fill = item?.fill
  if (!fill || fill.kind === 'none') return null
  const alpha = Number(fill.alpha ?? item.alpha ?? 1)
  if (Number.isFinite(alpha) && alpha < 0.5) return null
  return normalizeHex(fill.color)
}

// The colour actually visible under a text box: the topmost opaque fill that
// covers most of the box, plus how much of the box is hidden under images of
// unknown colour stacked above that fill. Content images are not counted: the
// terminal preview drops donor content and keeps only layout art and fills.
export function effectiveBackgroundUnder(slide, box) {
  const items = [
    ...(slide?.render?.layers || []).filter((layer) => layer.kind === 'fill' || layer.kind === 'image'),
    ...(slide?.content_elements || []).filter((element) => element.kind === 'fill'),
  ].map((item, order) => ({
    color: item.kind === 'fill' ? paintColor(item) : null,
    isImage: item.kind === 'image',
    decorativeArt: item.kind === 'image' && item.decorative === true
      && ['layout', 'master'].includes(String(item.source_scope || '')),
    box: item.geometry_norm,
    z: Number(item.z_index) || 0,
    order,
  })).filter((item) => validBox(item.box))
    .sort((left, right) => left.z - right.z || left.order - right.order)
  let color = normalizeHex(slide?.render?.background_color) || '#FFFFFF'
  let imageCover = 0
  let decorativeOnly = true
  const area = boxArea(box)
  if (!area) return { color, imageCover: 0, reliable: false, decorativeOnly: false, darkness: backgroundClass(color) }
  for (const item of items) {
    const cover = intersectionArea(item.box, box) / area
    if (item.color && cover >= 0.5) {
      color = item.color
      imageCover = 0
      decorativeOnly = true
    } else if (item.isImage && cover > 0.02) {
      imageCover = Math.min(1, imageCover + cover)
      if (!item.decorativeArt) decorativeOnly = false
    }
  }
  return {
    color,
    imageCover: Number(imageCover.toFixed(3)),
    reliable: imageCover <= IMAGE_COVER_LIMIT,
    decorativeOnly: imageCover > 0 && decorativeOnly,
    darkness: backgroundClass(color),
  }
}

function elementText(element) {
  return String(element?.text || element?.text_sample || '').trim()
}

function isCodeLike(element) {
  const typography = element?.typography || {}
  return CODE_FONT_RE.test(String(typography.family || ''))
    || /code|snippet|terminal/i.test(String(element?.role || element?.text_role || ''))
}

function referenceTexts(report, role) {
  let cache = referenceCache.get(report)
  if (!cache) {
    cache = {}
    referenceCache.set(report, cache)
  }
  if (cache[role]) return cache[role]
  const refs = []
  for (const slide of report?.slides?.slides || []) {
    const title = findSlideTitleElements(slide, report)
    const titleIds = title.elementIds || new Set()
    for (const element of slide.content_elements || []) {
      if (element.kind !== 'text' || !validBox(element.geometry_norm)) continue
      const text = elementText(element)
      const typography = element.typography || {}
      const size = Number(typography.size_pt) || 0
      if (!text || !normalizeHex(typography.color) || !typography.family || isCodeLike(element)) continue
      const isTitle = titleIds.has(element.element_id) || TITLE_PLACEHOLDERS.has(element.placeholder_type)
      if (role === 'title') {
        if (!isTitle || size < 20 || size > 96) continue
      } else {
        if (isTitle || !SUBTITLE_PLACEHOLDERS.has(element.placeholder_type)) continue
        if (size < 10 || size > 40 || text.length > 200) continue
      }
      refs.push({
        slide,
        element,
        box: element.geometry_norm,
        layout_source: slide.layout_source,
        base: layoutBaseName(slide.layout_name),
        background: effectiveBackgroundUnder(slide, element.geometry_norm),
      })
    }
  }
  cache[role] = refs
  return refs
}

function designTokens(report, tokens) {
  if (tokens) return tokens
  if (!tokenCache.has(report)) {
    let value = {}
    try {
      value = extractDesignTokens(report) || {}
    } catch {
      value = {}
    }
    tokenCache.set(report, value)
  }
  return tokenCache.get(report)
}

function tokenTypography(tokens, role) {
  if (role === 'title') {
    if (!tokens.titleTypographyOptions?.length && !tokens.defaultFontFamily) return null
    const title = pickTitleTypography(tokens)
    if (!title?.family || !title?.sizePt) return null
    return {
      family: title.family,
      size_pt: title.sizePt,
      bold: Boolean(title.bold),
      line_height_ratio: title.lineHeightRatio || 1.1,
    }
  }
  const body = (tokens.bodyTypographyOptions || [])
    .find((item) => item.family && item.sizePt >= 12 && item.sizePt <= 28 && !CODE_FONT_RE.test(item.family))
  const family = body?.family || tokens.defaultFontFamily
  if (!family || CODE_FONT_RE.test(family)) return null
  return { family, size_pt: body?.sizePt || 18, bold: false, line_height_ratio: 1.15 }
}

function tokenColors(tokens, role) {
  const theme = tokens.themeColors || {}
  const values = role === 'title'
    ? [...(tokens.titleColors || []), theme.dk1, theme.lt1, theme.dk2, theme.lt2, tokens.defaultTextColor]
    : [tokens.defaultTextColor, theme.dk1, theme.lt1, theme.dk2, theme.lt2]
  return [...new Set(values.map(normalizeHex).filter(Boolean))]
}

// Colours the deck itself uses for text on this background class (both roles),
// most frequent first. This is the design-system palette for the background.
function paletteForBackground(report, darkness) {
  const counts = new Map()
  for (const role of ['title', 'subtitle']) {
    for (const ref of referenceTexts(report, role)) {
      if (!ref.background.reliable || ref.background.darkness !== darkness) continue
      const color = normalizeHex(ref.element.typography?.color)
      if (color) counts.set(color, (counts.get(color) || 0) + 1)
    }
  }
  return [...counts.entries()].sort((left, right) => right[1] - left[1]).map(([color]) => color)
}

function scoreReference(ref, slide, box, background) {
  const base = layoutBaseName(slide?.layout_name)
  const centre = (item) => Number(item.y) + Number(item.height) / 2
  return (ref.layout_source && ref.layout_source === slide?.layout_source ? 50 : 0)
    + (base && ref.base === base ? 25 : 0)
    + (ref.background.darkness === background.darkness ? 20 : 0)
    + boxIou(ref.box, box) * 30
    + (1 - Math.min(1, Math.abs(centre(ref.box) - centre(box)) * 2)) * 10
}

function pickTypography(typography) {
  const result = {}
  for (const key of ['family', 'size_pt', 'bold', 'italic', 'alignment', 'line_height_ratio']) {
    if (typography?.[key] != null) result[key] = typography[key]
  }
  return result
}

// Validates a template's own slot style against the real background. Unknown
// backgrounds (image under the box) are not treated as a failure here: this is
// used to keep analyzer-approved templates exactly as they were.
export function validateTerminalSlotStyle(slide, box, typography) {
  if (!validBox(box)) return { ok: false, reason: 'no_box' }
  if (CODE_FONT_RE.test(String(typography?.family || ''))) return { ok: false, reason: 'code_font' }
  const color = normalizeHex(typography?.color)
  if (!color) return { ok: true, reason: 'no_color' }
  const background = effectiveBackgroundUnder(slide, box)
  if (!background.reliable) return { ok: true, reason: 'unknown_background' }
  const ratio = contrastRatio(color, background.color)
  return ratio >= MIN_TERMINAL_TEXT_CONTRAST
    ? { ok: true, contrast: ratio }
    : { ok: false, reason: 'low_contrast', contrast: ratio, background: background.color }
}

export function inferTerminalSlotStyle(report, slide, {
  box, role = 'title', tokens = null, slotTypography = null,
} = {}) {
  const slotRole = role === 'title' ? 'title' : 'subtitle'
  if (!validBox(box)) return { ok: false, reason: 'no_box' }
  const background = effectiveBackgroundUnder(slide, box)
  const scored = referenceTexts(report, slotRole)
    .filter((ref) => ref.slide.slide_number !== slide?.slide_number)
    .map((ref) => ({ ref, score: scoreReference(ref, slide, box, background) }))
    .sort((left, right) => right.score - left.score
      || left.ref.slide.slide_number - right.ref.slide.slide_number)
  const best = scored[0]?.score >= TERMINAL_REFERENCE_MIN_SCORE ? scored[0] : null
  const designSystem = designTokens(report, tokens)
  let typography = null
  let fontSource = null
  if (best) {
    typography = pickTypography(best.ref.element.typography)
    fontSource = `slide:${best.ref.slide.slide_number}`
  } else {
    typography = tokenTypography(designSystem, slotRole)
    fontSource = 'tokens'
  }
  if (!typography?.family || !(Number(typography.size_pt) > 0)) {
    return { ok: false, reason: 'no_reliable_style' }
  }

  let color = null
  let colorSource = null
  let contrast = null
  const candidates = [
    ...(best ? [{ color: best.ref.element.typography?.color, source: fontSource }] : []),
    ...paletteForBackground(report, background.darkness).map((value) => ({ color: value, source: 'deck_palette' })),
    ...tokenColors(designSystem, slotRole).map((value) => ({ color: value, source: 'tokens' })),
  ]
  const firstContrasting = (accept = () => true) => {
    for (const item of candidates) {
      const value = normalizeHex(item.color)
      if (!value || !accept(value)) continue
      const ratio = contrastRatio(value, background.color)
      if (ratio >= MIN_TERMINAL_TEXT_CONTRAST) {
        return { color: value, source: item.source, contrast: Number(ratio.toFixed(2)) }
      }
    }
    return null
  }
  let art = null
  if (!background.reliable) {
    const sameArt = best && best.ref.layout_source === slide?.layout_source
      && boxIou(best.ref.box, box) >= 0.5
    const slotColor = normalizeHex(slotTypography?.color)
    if (sameArt) {
      // Same layout placing text at the same place: same art underneath.
      color = normalizeHex(best.ref.element.typography?.color)
      colorSource = fontSource
      art = 'same_layout_reference'
    } else if (background.decorativeOnly && slotColor) {
      // Decorative layout art the layout author put under their own title
      // placeholder. The colour must still contrast with the fill under the
      // art and agree with the author's light/dark text choice for that art.
      const picked = firstContrasting((value) => backgroundClass(value) === backgroundClass(slotColor))
      if (!picked) return { ok: false, reason: 'unknown_background', background }
      ;({ color, source: colorSource, contrast } = picked)
      art = 'decorative_layout_art'
    } else {
      return { ok: false, reason: 'unknown_background', background }
    }
    if (!color) return { ok: false, reason: 'unknown_background', background }
  } else {
    const picked = firstContrasting()
    if (!picked) return { ok: false, reason: 'low_contrast', background }
    ;({ color, source: colorSource, contrast } = picked)
  }

  return {
    ok: true,
    typography: { ...typography, color },
    style_source: fontSource === 'tokens' && colorSource === 'tokens' ? 'tokens' : 'inferred',
    evidence: {
      role: slotRole,
      font: fontSource,
      color: colorSource,
      reference_score: best ? Number(best.score.toFixed(1)) : null,
      background: background.color,
      background_reliable: background.reliable,
      ...(art ? { art, image_cover: background.imageCover } : {}),
      contrast,
    },
  }
}
