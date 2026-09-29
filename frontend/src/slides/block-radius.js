import { ptToSlideCqw } from './slide-metrics.js'
import { applyLayerStroke } from './shape-stroke.js'

/**
 * OOXML roundRect: radius = adj × min(width, height).
 * Render as border-radius in cqw when absolute pt is known.
 */
const ROUND_CORNER_KINDS = new Set(['roundRect', 'round1Rect', 'round2SameRect', 'round2DiagRect'])

function applyCornerRadiiPt(node, radiiPt, slideSizePt) {
  if (!Array.isArray(radiiPt) || radiiPt.length !== 4 || !slideSizePt?.width) return false
  if (!radiiPt.some((value) => Number(value) > 0)) return false
  node.style.borderRadius = radiiPt
    .map((value) => ptToSlideCqw(Number(value) || 0, slideSizePt.width))
    .join(' ')
  return true
}

export function applyBlockCornerRadius(node, layer, slideSizePt) {
  const mask = layer?.mask
  if (!mask || mask.kind === 'rect') return false

  if (mask.kind === 'ellipse') {
    node.style.borderRadius = '50%'
    return true
  }

  if (applyCornerRadiiPt(node, layer.corner_radii_pt ?? mask.corner_radii_pt, slideSizePt)) {
    return true
  }

  if (ROUND_CORNER_KINDS.has(mask.kind)) {
    const radiusPt = layer.corner_radius_pt ?? mask.corner_radius_pt
    if (radiusPt && slideSizePt?.width) {
      node.style.borderRadius = ptToSlideCqw(radiusPt, slideSizePt.width)
      return true
    }
    const radiusPct = Number(mask.radius_pct)
    if (Number.isFinite(radiusPct) && radiusPct > 0) {
      node.style.clipPath = `inset(0 round ${radiusPct}%)`
      return true
    }
  }

  return false
}

export function applyLayerShapeAppearance(content, layer, slideSizePt, applyLayerMaskFn) {
  applyBlockCornerRadius(content, layer, slideSizePt)
  applyLayerStroke(content, layer, slideSizePt)
  if (content.style.borderRadius || content.style.clipPath) return
  applyLayerMaskFn(content, layer?.mask, layer?.layer_id ?? layer?.element_id)
}
