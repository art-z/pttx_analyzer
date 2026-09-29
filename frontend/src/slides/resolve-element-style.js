import { buildTokensForTemplate, extractDesignTokens, pickBodyTypography, pickTitleTypography } from '../constructor/tokens.js'
import {
  findSlideTemplate,
  getEditableSlot,
  getRoleColorOptions,
  normalizeSlotRole,
  resolveRoleTextColor,
  typographyFromTemplateSlot,
} from '../constructor/templates.js'
import { resolveMetric } from './text-list.js'

/**
 * Typography trust model for slide catalog render:
 * 1. Observed slide content (what the user sees in PPTX) is the primary signal for size and weight.
 * 2. Design system type scale snaps size only; weight is a separate axis (typography.styles), not scale levels.
 * 3. Mixed inline styles at line breaks become separate catalog text elements (backend), not DOM spans.
 */

const TITLE_PLACEHOLDER_TYPES = new Set(['title', 'ctrTitle'])
const BODY_PLACEHOLDER_TYPES = new Set(['body', 'obj', 'content'])

export function createSlideRenderContext(report) {
  const baseTokens = extractDesignTokens(report)
  const tokenCache = new Map()

  return {
    report,
    baseTokens,
    templateForSlide(slide) {
      return findSlideTemplate(report, slide?.layout_source)
    },
    tokensForSlide(slide) {
      const key = slide?.layout_source || '__none__'
      if (!tokenCache.has(key)) {
        const template = findSlideTemplate(report, slide?.layout_source)
        tokenCache.set(key, buildTokensForTemplate(baseTokens, template))
      }
      return tokenCache.get(key)
    },
  }
}

function matchTypographyBySize(sizePt, role, tokens) {
  if (!sizePt) return null
  const candidates = []
  for (const scale of tokens.typeScales || []) {
    for (const level of scale.levels || []) {
      candidates.push({
        family: scale.family,
        sizePt: level.sizePt,
        lineHeightRatio: level.lineHeightRatio || 1.2,
        scaleLevel: level.scaleLevel,
      })
    }
  }
  if (!candidates.length) return null
  candidates.sort((left, right) => Math.abs(left.sizePt - sizePt) - Math.abs(right.sizePt - sizePt))
  const best = candidates[0]
  if (Math.abs(best.sizePt - sizePt) > 8) return null
  const color = role === 'title'
    ? (tokens.titleColors?.[0] || tokens.defaultTextColor)
    : tokens.defaultTextColor
  return {
    family: best.family,
    sizePt: best.sizePt,
    lineHeightRatio: best.lineHeightRatio,
    scaleLevel: best.scaleLevel,
    bold: false,
    color,
    role,
  }
}

/** Map observed pt to nearest design-system type-scale step (e.g. 48 → Play L12). */
export function snapSizeToTypeScale(sizePt, role, tokens) {
  return matchTypographyBySize(sizePt, role, tokens)
}

function observedSizePt(element) {
  if (element.typography?.size_pt) return element.typography.size_pt
  if (!element.text_runs?.length) return null
  const weighted = new Map()
  for (const run of element.text_runs) {
    if (run.break || !run.text) continue
    const size = run.size_pt ?? run.sizePt
    if (!size) continue
    weighted.set(size, (weighted.get(size) || 0) + run.text.length)
  }
  if (!weighted.size) return null
  return [...weighted.entries()].sort((left, right) => right[1] - left[1])[0][0]
}

function applyObservedTypeScale(typography, element, role, tokens, source) {
  const observed = observedSizePt(element)
  const sizeMatch = snapSizeToTypeScale(observed, role, tokens)
  if (!sizeMatch || observed == null) return { typography, source }
  const ratio = sizeMatch.lineHeightRatio ?? typography.lineHeightRatio ?? 1.1
  return {
    typography: {
      ...typography,
      family: element.typography?.family || sizeMatch.family || typography.family,
      sizePt: observed,
      lineHeightRatio: ratio,
      lineHeightPt: ratio ? Math.round(observed * ratio * 100) / 100 : null,
      scaleLevel: sizeMatch.scaleLevel,
    },
    source: `${source}+type_scale`,
  }
}

function isSyntheticTitleElement(element, role) {
  if (!element?.synthetic || role !== 'title') return false
  if (element.role === 'title' || element.typography?.role === 'title') return true
  return /(^|_)slide_title(_|$)|(^|_)synthetic_slide_title(_|$)/.test(String(element.element_id || ''))
}

export function inferTextRole(element, tokens) {
  if (resolveMetric(element)) {
    return 'metric'
  }
  const placeholder = element.placeholder_type
  if (placeholder) {
    const role = normalizeSlotRole(placeholder)
    if (role !== 'content' || BODY_PLACEHOLDER_TYPES.has(placeholder) || TITLE_PLACEHOLDER_TYPES.has(placeholder)) {
      return role
    }
  }

  const sizePt = element.typography?.size_pt || 14
  const y = element.geometry_norm?.y ?? 0.5
  const titleSize = tokens.titleTypographyOptions?.[0]?.sizePt || 28

  if (TITLE_PLACEHOLDER_TYPES.has(placeholder) || (y < 0.2 && sizePt >= titleSize * 0.65)) {
    return 'title'
  }
  if (placeholder === 'subTitle' || (y < 0.28 && sizePt >= titleSize * 0.45 && sizePt < titleSize * 0.95)) {
    return 'subtitle'
  }
  return 'body'
}

export function resolveCatalogTextStyle(element, slide, context) {
  const template = context.templateForSlide(slide)
  const tokens = context.tokensForSlide(slide)
  const role = inferTextRole(element, tokens)
  const slot = template ? getEditableSlot(template, role) : null

  let typography
  let source = 'tokens'

  if (role === 'metric') {
    const metric = resolveMetric(element)
    typography = {
      ...pickBodyTypography(tokens),
      ...(metric?.value_typography || element.typography || {}),
      role: 'metric',
    }
    source = 'metric_value'
  } else if (slot) {
    typography = typographyFromTemplateSlot(slot, template, tokens, role)
    source = 'template_slot'
    ;({ typography, source } = applyObservedTypeScale(typography, element, role, tokens, source))
  } else if (role === 'title') {
    typography = pickTitleTypography(tokens)
    source = 'title_tokens'
  } else if (role === 'subtitle') {
    const titleTypo = pickTitleTypography(tokens)
    typography = {
      ...titleTypo,
      sizePt: Math.round((titleTypo.sizePt || 28) * 0.72),
      role: 'subtitle',
    }
    source = 'subtitle_tokens'
  } else {
    typography = pickBodyTypography(tokens)
    source = 'body_tokens'
  }

  // Without a layout slot, map observed size → nearest type-scale step (still design-system).
  const sizeMatch = matchTypographyBySize(element.typography?.size_pt, role, tokens)
  if (sizeMatch && !slot) {
    typography = {
      ...sizeMatch,
      family: element.typography?.family || sizeMatch.family,
      sizePt: element.typography?.size_pt ?? sizeMatch.sizePt,
      lineHeightRatio: sizeMatch.lineHeightRatio,
      lineHeightPt: element.typography?.size_pt
        ? Math.round(element.typography.size_pt * sizeMatch.lineHeightRatio * 100) / 100
        : null,
      color: typography.color,
      role: typography.role,
    }
    source = 'type_scale_match'
  }

  if (!typography.sizePt && element.typography?.size_pt) {
    typography = { ...typography, sizePt: element.typography.size_pt }
    source = `${source}+observed_fallback`
  }

  const roleColors = template ? getRoleColorOptions(template, role, tokens) : tokens.titleColors
  const resolvedColor = element.typography?.color
    || resolveRoleTextColor(template, role, tokens, slot)
    || roleColors?.[0]
    || typography.color
    || tokens.defaultTextColor

  const observedTypo = element.typography || {}
  const observedSize = observedTypo.size_pt || typography.sizePt
  let lineHeightRatio = typography.lineHeightRatio
  let lineHeightPt = typography.lineHeightPt
  const forceDesignSystemLineHeight = isSyntheticTitleElement(element, role)
  if (forceDesignSystemLineHeight && observedSize && lineHeightRatio != null) {
    lineHeightPt = Math.round(observedSize * lineHeightRatio * 100) / 100
    source = `${source}+ds_line_height`
  } else if (observedTypo.line_height_applicable === false) {
    lineHeightRatio = undefined
    lineHeightPt = undefined
  } else if (observedTypo.line_height_ratio != null) {
    lineHeightRatio = observedTypo.line_height_ratio
    lineHeightPt = observedTypo.line_height_pt
      ?? (observedSize ? Math.round(observedSize * observedTypo.line_height_ratio * 100) / 100 : null)
  } else if (lineHeightRatio != null && observedSize && !lineHeightPt) {
    lineHeightPt = Math.round(observedSize * lineHeightRatio * 100) / 100
  }

  return {
    role,
    source,
    typography: {
      ...typography,
      color: resolvedColor,
      bold: element.typography?.bold ?? typography.bold ?? false,
      italic: element.typography?.italic ?? typography.italic ?? false,
      alignment: element.typography?.alignment || typography.alignment || 'l',
      sizePt: observedSize || typography.sizePt,
      lineHeightRatio,
      lineHeightPt,
      line_height_applicable: observedTypo.line_height_applicable ?? typography.line_height_applicable,
      ...(element.typography?.alpha != null && element.typography.alpha < 0.999
        ? { alpha: element.typography.alpha }
        : {}),
    },
  }
}

/** Font size as % of slide width — scales with preview container (like PPTX pt on slide). */
export function ptToCqw(sizePt, slideWidthPt) {
  if (!slideWidthPt) return `${Math.max(8, sizePt || 14)}px`
  return `${((sizePt || 14) / slideWidthPt) * 100}cqw`
}

export function ptToPx(sizePt, slideWidthPx, slideWidthPt) {
  if (!slideWidthPt) return Math.max(8, sizePt || 14)
  return (sizePt * slideWidthPx) / slideWidthPt
}
