import { ptToSlideCqw } from './slide-metrics.js'
import { strokeColorCss } from './fill-styles.js'

const DASH_TO_CSS = {
  solid: 'solid',
  dash: 'dashed',
  dashDot: 'dashed',
  lgDash: 'dashed',
  lgDashDot: 'dashed',
  lgDashDotDot: 'dashed',
  sysDash: 'dashed',
  sysDashDot: 'dashed',
  sysDashDotDot: 'dashed',
  sysDot: 'dotted',
  dot: 'dotted',
}

export function strokeDashToCss(dash) {
  return DASH_TO_CSS[dash] || 'solid'
}

export function applyLayerStroke(node, layer, slideSizePt) {
  const stroke = layer?.stroke
  const color = strokeColorCss(stroke)
  if (!node || !stroke || !color) return false

  const widthPt = stroke.width_pt || 0.75
  node.style.boxSizing = 'border-box'
  node.style.borderStyle = strokeDashToCss(stroke.dash)
  node.style.borderColor = color
  if (slideSizePt?.width) {
    node.style.borderWidth = ptToSlideCqw(widthPt, slideSizePt.width)
  } else {
    node.style.borderWidth = `${Math.max(1, widthPt)}px`
  }
  return true
}
