import { ptToSlideCqw, slideWidthPt } from './slide-metrics.js'
import { snapSizeToTypeScale } from './resolve-element-style.js'

function normalizeTypography(typography) {
  if (!typography) return {}
  return {
    family: typography.family,
    sizePt: typography.sizePt ?? typography.size_pt,
    bold: typography.bold,
    italic: typography.italic,
    strike: typography.strike,
    underline: typography.underline,
    color: typography.color,
    alignment: typography.alignment,
  }
}

function runStrikeEnabled(run, fallback) {
  const strike = run.strike ?? fallback.strike
  if (strike === true) return true
  if (typeof strike === 'string') {
    const value = strike.toLowerCase()
    return value === 'sngstrike' || value === 'dblstrike' || value === 'true' || value === '1'
  }
  return false
}

function runUnderlineEnabled(run, fallback) {
  const underline = run.underline ?? fallback.underline
  if (!underline) return false
  if (underline === true) return true
  if (typeof underline === 'string') {
    const value = underline.toLowerCase()
    return value !== 'none' && value !== 'false' && value !== '0'
  }
  return false
}

function applyRunDecorations(node, run, fallback) {
  const decorations = []
  if (runUnderlineEnabled(run, fallback)) decorations.push('underline')
  if (runStrikeEnabled(run, fallback)) decorations.push('line-through')
  if (decorations.length) node.style.textDecoration = decorations.join(' ')
}

function applyRunStyles(node, run, fallback, widthPt, options = {}) {
  const useResolved = options.useResolvedTypography
  const role = options.role
  const tokens = options.tokens
  const family = useResolved ? (fallback.family || run.family || 'Arial') : (run.family || fallback.family || 'Arial')
  const rawSize = run.size_pt ?? run.sizePt ?? fallback.sizePt ?? 14
  const snapped = useResolved && tokens ? snapSizeToTypeScale(rawSize, role, tokens) : null
  const sizePt = useResolved
    ? (snapped?.sizePt ?? rawSize)
    : rawSize
  node.style.fontFamily = `"${family}", Arial, sans-serif`
  node.style.fontSize = ptToSlideCqw(sizePt, widthPt)
  node.style.fontWeight = (run.bold ?? fallback.bold) ? '700' : '400'
  if (run.italic ?? fallback.italic) node.style.fontStyle = 'italic'
  const color = useResolved ? (fallback.color || run.color) : (run.color || fallback.color)
  if (color) node.style.color = color
  applyRunDecorations(node, run, fallback)
}

/** Split flat text_runs export into one group per PPTX paragraph. */
export function groupTextRunsByParagraph(textRuns) {
  const groups = []
  let current = []
  for (const run of textRuns || []) {
    if (run.break === 'paragraph') {
      if (current.length) groups.push(current)
      current = []
      continue
    }
    if (run.break === 'line' || run.text) current.push(run)
  }
  if (current.length) groups.push(current)
  return groups
}

/** Append mixed-style runs into an existing container (spans + optional br). */
export function appendTextRuns(container, textRuns, typography, slideSizePt, options = {}) {
  const widthPt = slideWidthPt(slideSizePt)
  const fallback = normalizeTypography(typography)
  const runs = Array.isArray(textRuns) && textRuns.length
    ? textRuns
    : [{ text: container.dataset?.fallbackText || '' }]

  for (const run of runs) {
    if (run.break === 'line' || run.break === 'paragraph') {
      container.append(document.createElement('br'))
      continue
    }
    const text = run.text || ''
    if (!text) continue
    const span = document.createElement('span')
    span.className = 'ds-text-run catalog-text-run'
    span.textContent = text
    applyRunStyles(span, run, fallback, widthPt, options)
    container.append(span)
  }
}

/** Render mixed-style PPTX text runs into a container (spans + br). */
export function mountTextRuns(container, textRuns, typography, slideSizePt, options = {}) {
  container.replaceChildren()
  appendTextRuns(container, textRuns, typography, slideSizePt, options)
}
