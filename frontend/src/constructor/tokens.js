import { boxFromGeometry, getEditableSlot, getRoleColorOptions } from './templates.js'

const themeHex = (entry) => {
  if (!entry?.value) return null
  return `#${String(entry.value).replace(/^#/, '').toUpperCase()}`
}

const TITLE_PROB_THRESHOLD = 0.25
const TITLE_PLACEHOLDER_TYPES = new Set(['title', 'ctrTitle'])

function hexLuminance(hex) {
  if (!/^#[0-9A-F]{6}$/i.test(hex)) return 0.5
  const r = parseInt(hex.slice(1, 3), 16) / 255
  const g = parseInt(hex.slice(3, 5), 16) / 255
  const b = parseInt(hex.slice(5, 7), 16) / 255
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

function isBackgroundLikeColor(color, background) {
  if (!color) return true
  if (background && color.toUpperCase() === background.toUpperCase()) return true
  return hexLuminance(color) > 0.88
}

function buildTypeScaleIndex(typeScales) {
  const index = new Map()
  for (const scale of typeScales || []) {
    for (const level of scale.levels || []) {
      index.set(`${scale.family}:${level.scale_level}`, level)
    }
  }
  return index
}

function buildStyleIndex(styles) {
  const index = new Map()
  for (const style of styles || []) {
    const key = `${style.family}:${Math.round((style.size_pt || 0) * 100)}`
    const current = index.get(key)
    if (!current || (style.occurrences || 0) > (current.occurrences || 0)) index.set(key, style)
  }
  return index
}

function collectTitlePlaceholderLevels(textSlots) {
  const entries = []
  for (const source of [textSlots?.templates, textSlots?.slide_instances]) {
    for (const slot of source || []) {
      if (!TITLE_PLACEHOLDER_TYPES.has(slot.placeholder_type)) continue
      const level = slot.levels?.[0]
      if (!level?.family || level.family === 'Наследуется' || !level.size_pt) continue
      entries.push({
        family: level.family,
        sizePt: level.size_pt,
        lineHeightPt: level.line_height_pt,
        lineHeightRatio: level.line_spacing ?? (level.line_height_pt && level.size_pt ? level.line_height_pt / level.size_pt : null),
        bold: Boolean(level.bold),
        alignment: level.alignment,
        source: 'title_placeholder',
      })
    }
  }
  return entries
}

function dominantPlaceholderLevel(entries) {
  const counts = new Map()
  for (const entry of entries) {
    const key = `${entry.family}:${entry.sizePt}`
    counts.set(key, (counts.get(key) || 0) + 1)
  }
  let best = null
  let bestCount = -1
  for (const entry of entries) {
    const key = `${entry.family}:${entry.sizePt}`
    const count = counts.get(key) || 0
    if (count > bestCount) {
      best = entry
      bestCount = count
    }
  }
  return best
}

function collectTitleScaleLevels(scaleRoles) {
  const levels = []
  for (const group of scaleRoles || []) {
    if (!group.family || group.family === 'Наследуется') continue
    for (const level of group.levels || []) {
      const titleProbability = level.slide_title_probability ?? 0
      if (level.role_hint !== 'slide_title' && titleProbability < TITLE_PROB_THRESHOLD) continue
      levels.push({
        family: group.family,
        scaleLevel: level.scale_level,
        sizePt: level.size_pt,
        titleProbability,
        roleHint: level.role_hint,
        source: 'scale_roles',
      })
    }
  }
  return levels.sort((a, b) => (
    (b.titleProbability - a.titleProbability)
    || (b.sizePt - a.sizePt)
    || a.family.localeCompare(b.family)
  ))
}

function normalizeLineHeightRatio(ratio, sizePt, lineHeightPt) {
  if (lineHeightPt && sizePt) {
    const computed = lineHeightPt / sizePt
    if (computed >= 0.5 && computed <= 1.8) return computed
  }
  if (ratio != null && ratio >= 0.5 && ratio <= 1.8) return ratio
  return 1.1
}

function enrichTitleLevel(level, typeScaleIndex, styleIndex, placeholderLevels) {
  const scaleStep = typeScaleIndex.get(`${level.family}:${level.scaleLevel}`)
  const style = styleIndex.get(`${level.family}:${Math.round((level.sizePt || 0) * 100)}`)
  const placeholder = placeholderLevels
    .filter((item) => item.family === level.family)
    .sort((a, b) => Math.abs(a.sizePt - level.sizePt) - Math.abs(b.sizePt - level.sizePt))[0]
  const rawRatio = scaleStep?.line_height_ratio
    ?? (level.lineHeightRatio ?? (level.lineHeightPt && level.sizePt ? level.lineHeightPt / level.sizePt : null))
  const lineHeightRatio = normalizeLineHeightRatio(
    placeholder?.lineHeightRatio ?? rawRatio,
    level.sizePt,
    scaleStep?.line_height_pt ?? level.lineHeightPt ?? placeholder?.lineHeightPt,
  )
  return {
    family: level.family,
    sizePt: level.sizePt,
    scaleLevel: level.scaleLevel,
    lineHeightPt: scaleStep?.line_height_pt ?? level.lineHeightPt ?? (lineHeightRatio * level.sizePt),
    lineHeightRatio,
    bold: style?.bold ?? level.bold ?? false,
    titleProbability: level.titleProbability ?? null,
    source: level.source,
  }
}

function buildTitleTypographyOptions(report) {
  const typography = report.typography || {}
  const typeScaleIndex = buildTypeScaleIndex(typography.type_scales)
  const styleIndex = buildStyleIndex(typography.styles)
  const placeholderLevels = collectTitlePlaceholderLevels(typography.text_slots)
  const placeholderDominant = dominantPlaceholderLevel(placeholderLevels)
  const minPlaceholderSize = placeholderLevels.length
    ? Math.min(...placeholderLevels.map((item) => item.sizePt))
    : 0

  const scaleLevels = collectTitleScaleLevels(typography.scale_usage?.scale_roles)
    .filter((level) => !minPlaceholderSize || level.sizePt >= minPlaceholderSize * 0.7)

  const merged = new Map()
  for (const level of scaleLevels) {
    const key = `${level.family}:${level.sizePt}`
    if (!merged.has(key)) merged.set(key, enrichTitleLevel(level, typeScaleIndex, styleIndex, placeholderLevels))
  }
  for (const level of placeholderLevels) {
    const key = `${level.family}:${level.sizePt}`
    if (!merged.has(key)) merged.set(key, enrichTitleLevel(level, typeScaleIndex, styleIndex, placeholderLevels))
  }

  let options = [...merged.values()].sort((a, b) => (
    (b.titleProbability ?? 0) - (a.titleProbability ?? 0)
    || b.sizePt - a.sizePt
  ))

  if (!options.length && placeholderDominant) {
    options = [enrichTitleLevel(placeholderDominant, typeScaleIndex, styleIndex, placeholderLevels)]
  }

  return options
}

function collectTitleTextColors(report, background) {
  const textEntries = report.colors?.context_palettes?.text
    || (report.colors?.resolved_palette || []).filter((item) => item.contexts?.text)

  const seen = new Set()
  const colors = []
  for (const entry of textEntries || []) {
    const color = entry.color
    if (!color || seen.has(color) || isBackgroundLikeColor(color, background)) continue
    seen.add(color)
    colors.push({ color, occurrences: entry.occurrences || 0 })
  }

  colors.sort((a, b) => b.occurrences - a.occurrences)
  return colors.map((item) => item.color)
}

function collectBodyScaleLevels(scaleRoles) {
  const levels = []
  for (const group of scaleRoles || []) {
    if (!group.family || group.family === 'Наследуется') continue
    for (const level of group.levels || []) {
      const bodyProbability = level.body_probability ?? 0
      if (level.role_hint !== 'body' && bodyProbability < 0.25) continue
      levels.push({
        family: group.family,
        scaleLevel: level.scale_level,
        sizePt: level.size_pt,
        bodyProbability,
      })
    }
  }
  return levels.sort((a, b) => (b.bodyProbability - a.bodyProbability) || (a.sizePt - b.sizePt))
}

export function buildTokensForTemplate(baseTokens, template) {
  if (!template) {
    return { ...baseTokens, activeTemplate: null }
  }

  const titleSlot = getEditableSlot(template, 'title')
  const bodyColor = getRoleColorOptions(template, 'body', baseTokens)[0]
  const titleColor = getRoleColorOptions(template, 'title', baseTokens)[0]
  return {
    ...baseTokens,
    activeTemplate: template,
    defaultBackground: template.render?.background_color || template.colors?.background || baseTokens.defaultBackground,
    titleColors: getRoleColorOptions(template, 'title', baseTokens),
    defaultTextColor: bodyColor || titleColor || baseTokens.defaultTextColor,
    slideTitleBox: titleSlot
      ? boxFromGeometry(titleSlot.geometry_norm)
      : baseTokens.slideTitleBox,
  }
}

export function extractDesignTokens(report) {
  const typography = report.typography || {}
  const slideSize = typography.visibility?.slide_size_pt || { width: 720, height: 405 }
  const theme = report.theme?.themes?.[0] || {}
  const themeColors = {}
  for (const [key, entry] of Object.entries(theme.colors || {})) {
    const hex = themeHex(entry)
    if (hex) themeColors[key] = hex
  }

  const typeScales = (typography.type_scales || []).map((scale) => ({
    family: scale.family,
    levels: (scale.levels || []).map((level) => ({
      scaleLevel: level.scale_level,
      sizePt: level.size_pt,
      lineHeightPt: level.line_height_pt,
      lineHeightRatio: level.line_height_ratio,
      confidence: level.size_confidence,
      bodyProbability: level.body_probability,
      titleProbability: level.slide_title_probability,
    })),
  }))

  const components = (typography.components?.components || []).map((component) => ({
    id: component.component_id,
    name: component.name,
    label: component.label || component.name,
    container: component.container || {},
    slots: {
      required: component.slots?.required || [],
      optional: component.slots?.optional || [],
    },
    frequency: component.frequency,
  }))

  const paletteEntries = (report.colors?.resolved_palette || [])
    .filter((item) => Number(item.alpha ?? 1) > 0)
    .slice(0, 24)
    .map((item) => ({
      color: item.color,
      alpha: Number(item.alpha ?? 1),
    }))

  const palette = paletteEntries.map((item) => item.color)
  const chartSeriesPalette = report.graphic_components?.chart_series_palette?.colors || []
  const chartSeriesFillVariants = report.graphic_components?.chart_series_palette?.fill_variants || []
  const gradientFills = (report.colors?.gradients || []).slice(0, 12)

  const mediaAssets = (report.assets?.media_files || []).map((item) => ({
    filename: item.filename,
    kind: item.kind,
    width: item.width,
    height: item.height,
    label: item.filename,
  }))

  const defaultBackground = themeColors.lt1 || themeColors.bg1 || '#FFFFFF'
  const titleTypographyOptions = buildTitleTypographyOptions(report)
  const titleColors = collectTitleTextColors(report, defaultBackground)
  const bodyTypographyOptions = collectBodyScaleLevels(typography.scale_usage?.scale_roles)

  const slideTitleRules = typography.spatial?.components
    ?.find((component) => component.id === 'slide_title')
    ?.spatial_rules

  return {
    slideSize,
    themeName: theme.name || 'Theme',
    themeColors,
    themeFonts: theme.fonts || {},
    typeScales,
    components,
    palette,
    chartSeriesPalette,
    chartSeriesFillVariants,
    paletteEntries,
    gradientFills,
    mediaAssets,
    defaultBackground,
    defaultTextColor: titleColors[0] || themeColors.dk1 || palette[0] || '#000000',
    defaultFontFamily: titleTypographyOptions[0]?.family || typeScales[0]?.family || theme.fonts?.major?.latin || 'Arial',
    titleTypographyOptions,
    titleColors,
    bodyTypographyOptions,
    slideTitleBox: slideTitleRules ? {
      x: slideTitleRules.x_norm?.median ?? 0.08,
      y: slideTitleRules.y_norm?.median ?? 0.08,
      width: slideTitleRules.width_norm?.median ?? 0.84,
      height: slideTitleRules.height_norm?.median ?? 0.12,
    } : { x: 0.08, y: 0.08, width: 0.84, height: 0.12 },
  }
}

export function pickTitleTypography(tokens) {
  const option = tokens.titleTypographyOptions?.[0]
  if (!option) {
    return {
      family: tokens.defaultFontFamily,
      sizePt: 32,
      lineHeightRatio: 1.1,
      bold: false,
      color: tokens.titleColors?.[0] || tokens.defaultTextColor,
      role: 'title',
    }
  }
  return {
    family: option.family,
    sizePt: option.sizePt,
    scaleLevel: option.scaleLevel,
    lineHeightPt: option.lineHeightPt,
    lineHeightRatio: option.lineHeightRatio || 1.1,
    bold: option.bold,
    color: tokens.titleColors?.[0] || tokens.defaultTextColor,
    role: 'title',
  }
}

export function pickBodyTypography(tokens) {
  const typeScaleIndex = new Map()
  for (const scale of tokens.typeScales || []) {
    for (const level of scale.levels || []) {
      typeScaleIndex.set(`${scale.family}:${level.scaleLevel}`, level)
    }
  }

  for (const level of tokens.bodyTypographyOptions || []) {
    const scaleStep = typeScaleIndex.get(`${level.family}:${level.scaleLevel}`)
    return {
      family: level.family,
      sizePt: level.sizePt,
      scaleLevel: level.scaleLevel,
      lineHeightPt: scaleStep?.lineHeightPt ?? null,
      lineHeightRatio: scaleStep?.lineHeightRatio || 1.2,
      bold: false,
      color: tokens.defaultTextColor,
      role: 'body',
    }
  }
  for (const scale of tokens.typeScales) {
    const body = scale.levels.find((level) => (level.bodyProbability ?? 0) >= 0.5)
    if (body) {
      return {
        family: scale.family,
        sizePt: body.sizePt,
        lineHeightPt: body.lineHeightPt,
        lineHeightRatio: body.lineHeightRatio,
        bold: false,
        color: tokens.defaultTextColor,
        role: 'body',
      }
    }
  }
  return {
    family: tokens.defaultFontFamily,
    sizePt: 14,
    lineHeightRatio: 1.2,
    bold: false,
    color: tokens.defaultTextColor,
    role: 'body',
  }
}

export function getTitleTypographyChoices(tokens, selected) {
  const family = selected?.typography?.family || tokens.titleTypographyOptions?.[0]?.family
  return (tokens.titleTypographyOptions || []).filter((item) => item.family === family)
}

export function isTitleTextElement(element) {
  return element?.role === 'title' || element?.typography?.role === 'title'
}
