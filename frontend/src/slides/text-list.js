import { applyParagraphSpacingPt, ptToSlideCqw, ptToSlidePadding, slideWidthPt, typographySizePt } from './slide-metrics.js'
import { applyTextBoxLayout, resolveTextWhiteSpace, textAlignToFlexAlign } from './flex-layout.js'
import { typographyColorCss } from './fill-styles.js'
import { appendTextRuns, groupTextRunsByParagraph, mountTextRuns } from './text-runs-render.js'

const BULLET_PLACEHOLDER_RE = /^[\u200b\ufeff\s]+/
const LINE_HEIGHT_RATIO_MIN = 0.5
const LINE_HEIGHT_RATIO_MAX = 2.5

export function stripBulletPlaceholder(text) {
  return (text || '').replace(BULLET_PLACEHOLDER_RE, '').trimStart()
}

export function usesBulletRowLayout(element) {
  const bullet = element?.bullet
  return Boolean(bullet && bullet.kind !== 'none' && stripBulletPlaceholder(element.text || ''))
}

/** Split txBody lines keep pPr spacing; compact metric stacks use flex centering instead. */
export function shouldApplyParagraphSpacingInFlexStack(element, { compactDisplayLayout = false } = {}) {
  if (compactDisplayLayout) return false
  return Boolean(element?.split_from_shape)
}

export function paragraphSpacingForFlexStackItem(element, lineIndex = 0) {
  const spacing = { ...(element?.paragraph_spacing_pt || {}) }
  if (lineIndex === 0) spacing.space_before = 0
  return spacing
}

export function usesParagraphBlockLayout(element) {
  return Boolean(
    element?.text_paragraphs?.length > 1
    && !usesBulletRowLayout(element),
  )
}

export function usesTextRunsLayout(element) {
  return Array.isArray(element?.text_runs)
    && element.text_runs.some((run) => run?.text || run?.break)
}

export function bulletHangWidthPt(spacing = {}) {
  const marginLeft = Number(spacing.margin_left || 0)
  const indent = Number(spacing.indent || 0)
  if (indent < 0) return -indent
  if (marginLeft > 0) return marginLeft
  return 0
}

export function applyBulletStyles(node, bullet, slideSizePt) {
  if (!node || !bullet) return
  const widthPt = slideWidthPt(slideSizePt)
  if (bullet.color) node.style.color = bullet.color
  if (bullet.font) node.style.fontFamily = `"${bullet.font}", sans-serif`
  node.style.fontSize = ptToSlideCqw(bullet.size_pt || 14, widthPt)
}

export function resolveLineHeightRatio(typography, spacing = {}) {
  return typography?.lineHeightRatio
    ?? typography?.line_height_ratio
    ?? spacing?.line_spacing_ratio
    ?? null
}

export function resolveLineHeightPt(typography, spacing = {}) {
  return typography?.lineHeightPt
    ?? typography?.line_height_pt
    ?? spacing?.line_height_pt
    ?? null
}

export function shouldApplyLineHeight(typography, spacing = {}) {
  if (typography?.line_height_applicable === false || spacing?.line_height_applicable === false) {
    return false
  }
  if (typography?.line_height_applicable === true || spacing?.line_height_applicable === true) {
    return true
  }
  const ratio = resolveLineHeightRatio(typography, spacing)
  if (ratio == null) return false
  return ratio >= LINE_HEIGHT_RATIO_MIN && ratio <= LINE_HEIGHT_RATIO_MAX
}

function lineHeightPtMatchesSize(lineHeightPt, sizePt, ratio) {
  if (!lineHeightPt || !sizePt) return false
  const impliedRatio = lineHeightPt / sizePt
  if (impliedRatio < LINE_HEIGHT_RATIO_MIN || impliedRatio > LINE_HEIGHT_RATIO_MAX) return false
  if (ratio == null) return true
  return Math.abs(impliedRatio - ratio) <= 0.06
}

export function applyLineHeight(node, typography, spacing = {}, slideSizePt) {
  if (!node) return
  if (!shouldApplyLineHeight(typography, spacing)) {
    node.style.lineHeight = 'normal'
    return
  }
  const sizePt = typographySizePt(typography)
  const ratio = resolveLineHeightRatio(typography, spacing)
  const lineHeightPt = resolveLineHeightPt(typography, spacing)
  const widthPt = slideWidthPt(slideSizePt)

  if (lineHeightPt != null && lineHeightPtMatchesSize(lineHeightPt, sizePt, ratio)) {
    node.style.lineHeight = ptToSlideCqw(lineHeightPt, widthPt) || `${lineHeightPt}pt`
    return
  }
  if (ratio != null) {
    node.style.lineHeight = String(ratio)
    return
  }
  node.style.lineHeight = 'normal'
}

export function applyTextTypography(node, typography, slideSizePt, text = '', spacing = {}) {
  if (!node || !typography) return
  const widthPt = slideWidthPt(slideSizePt)
  node.style.fontFamily = `"${typography.family || 'Arial'}", sans-serif`
  node.style.fontSize = ptToSlideCqw(typographySizePt(typography), widthPt)
  node.style.fontWeight = typography.bold ? '700' : '400'
  node.style.fontStyle = typography.italic ? 'italic' : 'normal'
  applyLineHeight(node, typography, spacing, slideSizePt)
  node.style.color = typography.color || '#000000'
  if (typography.alpha != null && typography.alpha < 0.999) {
    node.style.color = typographyColorCss(typography) || node.style.color
  }
  // Break only between words (the layout estimator in text-measure.js assumes the same).
  node.style.wordBreak = 'normal'
  node.style.overflowWrap = 'normal'
  node.style.hyphens = 'manual'
  node.style.whiteSpace = resolveTextWhiteSpace(text)
  if (typography.alignment === 'ctr') node.style.textAlign = 'center'
  else if (typography.alignment === 'r') node.style.textAlign = 'right'
  else node.style.textAlign = 'left'
  const decorations = []
  if (typography.underline && typography.underline !== 'none') decorations.push('underline')
  if (typography.strike) decorations.push('line-through')
  if (decorations.length) node.style.textDecoration = decorations.join(' ')
}

function bulletMarkerText(bullet) {
  if (bullet.kind === 'auto') return bullet.label ? `${bullet.label}` : ''
  return bullet.char || '•'
}

export function mountBulletRow(node, element, typography, slideSizePt) {
  const bullet = element.bullet
  const text = stripBulletPlaceholder(element.text || '')
  const spacing = element.paragraph_spacing_pt || {}
  const hangWidth = bulletHangWidthPt(spacing)

  node.replaceChildren()
  node.style.display = 'flex'
  node.style.flexDirection = 'row'
  node.style.alignItems = 'flex-start'
  node.style.width = '100%'
  node.style.boxSizing = 'border-box'
  node.style.paddingLeft = '0'
  node.style.textIndent = '0'

  const marker = document.createElement('span')
  marker.className = 'catalog-text-bullet'
  marker.textContent = bulletMarkerText(bullet)
  const widthPt = slideWidthPt(slideSizePt)
  const hangPadding = hangWidth ? ptToSlidePadding(hangWidth, widthPt) : null
  marker.style.flex = hangPadding ? `0 0 ${hangPadding}` : '0 0 1.2em'
  marker.style.textAlign = 'left'
  marker.style.alignSelf = 'flex-start'
  marker.style.userSelect = 'none'
  applyBulletStyles(marker, bullet, slideSizePt)
  applyLineHeight(marker, typography, spacing, slideSizePt)

  const body = document.createElement('span')
  body.className = 'catalog-text-body'
  body.style.flex = '1 1 auto'
  body.style.minWidth = '0'
  body.textContent = text
  applyTextTypography(body, typography, slideSizePt, text, spacing)

  node.append(marker, body)
}

function isMonospaceTextElement(element, typography) {
  const family = String(typography?.family || element?.typography?.family || '').toLowerCase()
  return /consolas|courier|mono|menlo|source code/i.test(family)
}

export function mountParagraphBlock(node, element, typography, slideSizePt, options = {}) {
  const widthPt = slideWidthPt(slideSizePt)
  const runGroups = element.text_runs?.length ? groupTextRunsByParagraph(element.text_runs) : []
  const monospace = isMonospaceTextElement(element, typography)
  node.replaceChildren()
  node.style.display = 'flex'
  node.style.flexDirection = 'column'
  node.style.width = '100%'
  node.style.boxSizing = 'border-box'
  node.style.paddingLeft = '0'
  node.style.textIndent = '0'
  if (monospace) {
    node.style.fontFamily = `"${typography?.family || element?.typography?.family || 'Consolas'}", monospace`
  }

  for (const [index, block] of (element.text_paragraphs || []).entries()) {
    const line = document.createElement('div')
    line.className = 'catalog-text-paragraph ds-text-paragraph'
    const runs = runGroups[index]
    if (runs?.length) {
      appendTextRuns(line, runs, typography, slideSizePt, options.textRuns || {})
    } else {
      line.textContent = stripBulletPlaceholder(block.text || '')
      applyTextTypography(line, typography, slideSizePt, block.text, block.paragraph_spacing_pt || {})
    }
    const spacing = { ...(block.paragraph_spacing_pt || {}) }
    if (index === 0) spacing.space_before = 0
    if (monospace) {
      const wrapEnabled = element?.wrap !== 'none'
      line.style.whiteSpace = wrapEnabled ? 'pre-wrap' : 'pre'
      line.style.wordBreak = wrapEnabled ? 'break-all' : 'normal'
      line.style.overflowWrap = wrapEnabled ? 'anywhere' : 'normal'
      // Inherited spcBef (often ~0.53 lines) inflates DOM gaps; code lines rely on line-height only.
      spacing.space_before = 0
      spacing.space_after = 0
      applyLineHeight(line, typography, spacing, slideSizePt)
    }
    applyParagraphSpacingPt(line, spacing, widthPt, { skipHangingIndent: true })
    node.append(line)
  }
}

const METRIC_TEXT_RE = /^([\d\s.,+\-/]+)(%|°|℃|℉|‰|[₽$€£]|[A-Za-z\u0400-\u04FF]{1,6})$/

function resolveMetric(element) {
  if (element?.metric?.value != null && element?.metric?.unit != null) {
    return element.metric
  }
  const line = (element?.text || '').trim().split('\n')[0]
  const match = line.match(METRIC_TEXT_RE)
  if (!match) return null
  const typography = element?.typography || {}
  return {
    value: match[1].trim(),
    unit: match[2],
    value_typography: typography,
    unit_typography: typography,
    split_source: 'text',
  }
}

export { resolveMetric }

export function usesMetricLayout(element) {
  return Boolean(resolveMetric(element))
}

function metricInlineRow(node) {
  return node.querySelector('.ds-metric-inline, .catalog-metric-inline')
}

function resolveTextAlignment(typography, element) {
  return typography?.alignment || element?.typography?.alignment || 'l'
}

function applyMetricRowAlignment(row, alignment) {
  if (!row) return
  row.classList.remove('ds-metric-inline--align-ctr', 'catalog-metric-inline--align-ctr')
  row.classList.remove('ds-metric-inline--align-r', 'catalog-metric-inline--align-r')
  if (alignment === 'ctr' || alignment === 'r') {
    row.style.width = '100%'
    row.style.justifyContent = textAlignToFlexAlign(alignment)
    row.classList.add(
      alignment === 'ctr' ? 'ds-metric-inline--align-ctr' : 'ds-metric-inline--align-r',
      alignment === 'ctr' ? 'catalog-metric-inline--align-ctr' : 'catalog-metric-inline--align-r',
    )
    return
  }
  row.style.width = ''
  row.style.justifyContent = ''
}

export function applyMetricTextLayout(node, element, typography = {}) {
  if (!node) return
  const alignment = resolveTextAlignment(typography, element)
  const verticalAnchor = element?.vertical_anchor || 't'

  applyTextBoxLayout(node, verticalAnchor, alignment)

  applyMetricRowAlignment(metricInlineRow(node), alignment)
}

export function mountMetricText(node, element, typography, slideSizePt) {
  const metric = resolveMetric(element) || {}
  const alignment = resolveTextAlignment(typography, element)
  const valueTypography = { ...typography, ...(metric.value_typography || {}) }
  const unitTypography = { ...typography, ...(metric.unit_typography || {}) }

  node.replaceChildren()
  node.style.paddingLeft = '0'
  node.style.textIndent = '0'

  const row = document.createElement('span')
  row.className = 'ds-metric-inline catalog-metric-inline'
  row.style.display = 'inline-flex'
  row.style.flexDirection = 'row'
  row.style.alignItems = 'baseline'
  row.style.flexWrap = 'nowrap'
  row.style.maxWidth = '100%'
  row.style.boxSizing = 'border-box'
  applyMetricRowAlignment(row, alignment)

  const value = document.createElement('span')
  value.className = 'ds-metric-value catalog-metric-value'
  value.textContent = metric.value || ''
  applyTextTypography(value, valueTypography, slideSizePt, metric.value, element.paragraph_spacing_pt || {})

  const unit = document.createElement('span')
  unit.className = 'ds-metric-unit catalog-metric-unit'
  unit.textContent = metric.unit || ''
  applyTextTypography(unit, unitTypography, slideSizePt, metric.unit, element.paragraph_spacing_pt || {})

  row.append(value, unit)
  node.append(row)
  applyMetricTextLayout(node, element, typography)
}

export function populateTextLineContent(node, element, typography, slideSizePt, options = {}) {
  if (!options.skipMetric && usesMetricLayout(element)) {
    mountMetricText(node, element, typography, slideSizePt)
    return true
  }
  if (usesBulletRowLayout(element)) {
    mountBulletRow(node, element, typography, slideSizePt)
    return true
  }
  if (usesParagraphBlockLayout(element)) {
    mountParagraphBlock(node, element, typography, slideSizePt, options)
    return true
  }
  if (usesTextRunsLayout(element)) {
    mountTextRuns(node, element.text_runs, typography, slideSizePt, options.textRuns || {})
    return true
  }

  node.textContent = stripBulletPlaceholder(element.text || '')
  return false
}
