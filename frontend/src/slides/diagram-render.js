import { ptToSlideCqw, slideWidthPt } from './slide-metrics.js'

const SVG_NS = 'http://www.w3.org/2000/svg'

function resolveDiagramTexts(element) {
  const diagram = element.diagram || {}
  if (Array.isArray(diagram.preview_texts) && diagram.preview_texts.length) return diagram.preview_texts
  if (Array.isArray(element.preview_texts) && element.preview_texts.length) return element.preview_texts
  return ['Шаг 1', 'Шаг 2', 'Шаг 3']
}

function colorValue(value) {
  if (typeof value === 'string') return value
  return value?.color || null
}

export function resolveDiagramRenderStyle(element, tokens = null) {
  const styleTokens = element.diagram?.style_tokens || element.style_tokens || {}
  const useObservedStyle = !element.is_baseline || Boolean(element.deck_style_source)
  const effectiveTokens = useObservedStyle ? styleTokens : {}
  const body = tokens?.bodyTypographyOptions?.[0] || {}
  const connector = effectiveTokens.connector || {}
  const node = effectiveTokens.node || {}
  const typography = node.typography || {}
  const palette = tokens?.palette || []
  const connectorColor = colorValue(connector.color) || palette[0] || tokens?.defaultTextColor || '#0077FF'
  let headType = effectiveTokens.arrow?.head_type || connector.head?.type || 'none'
  let tailType = effectiveTokens.arrow?.tail_type || connector.tail?.type || 'triangle'
  const hasHead = headType !== 'none'
  const hasTail = tailType !== 'none'
  if (hasHead && hasTail && effectiveTokens.arrow?.bidirectional !== true) {
    // Older reports could combine independently aggregated ends into a fake
    // double arrow. Prefer the usual endpoint until an observed pair explicitly
    // marks the connector as bidirectional.
    headType = 'none'
  }
  return {
    connector: {
      color: connectorColor,
      widthPt: Number(connector.width_pt) || 1,
      dash: connector.dash || 'solid',
      cap: connector.cap || 'round',
      headType,
      tailType,
    },
    node: {
      fill: colorValue(node.fill) || tokens?.defaultBackground || '#FFFFFF',
      borderColor: colorValue(node.border?.color) || connectorColor,
      borderWidthPt: Number(node.border?.width_pt) || 1,
      borderDash: node.border?.dash || 'solid',
      radiusPt: node.radius_pt != null ? Math.max(0, Number(node.radius_pt) || 0) : 8,
    },
    typography: {
      family: typography.family || body.family || tokens?.defaultFontFamily || 'Arial, sans-serif',
      sizePt: Number(typography.size_pt || body.sizePt || body.size_pt) || 10,
      color: colorValue(typography.color) || body.color || tokens?.defaultTextColor || '#17212D',
      bold: typography.bold ?? body.bold ?? false,
      alignment: typography.alignment || 'ctr',
    },
  }
}

function dashArray(dash) {
  const normalized = String(dash || '').toLowerCase()
  if (normalized.includes('dashdot')) return '8 4 2 4'
  if (normalized.includes('dash')) return '8 5'
  if (normalized.includes('dot')) return '2 4'
  return null
}

function arrowPath(type, atStart, vertical) {
  const normalized = String(type || 'none').toLowerCase()
  if (normalized === 'none') return null
  if (normalized === 'oval') {
    return {
      kind: 'ellipse',
      cx: 6,
      cy: 6,
      rx: 3.2,
      ry: 3.2,
    }
  }
  if (normalized === 'diamond') {
    return {
      kind: 'path',
      d: 'M 6 1 L 11 6 L 6 11 L 1 6 Z',
      closed: true,
    }
  }
  // Triangle / filled arrow tip. At the start the tip points back along the shaft.
  if (vertical) {
    return {
      kind: 'path',
      d: atStart ? 'M 1 11 L 6 1 L 11 11 Z' : 'M 1 1 L 6 11 L 11 1 Z',
      closed: true,
    }
  }
  return {
    kind: 'path',
    d: atStart ? 'M 11 1 L 1 6 L 11 11 Z' : 'M 1 1 L 11 6 L 1 11 Z',
    closed: true,
  }
}

function appendArrowTip(parent, type, color, vertical, atStart) {
  const shape = arrowPath(type, atStart, vertical)
  if (!shape) return

  const svg = document.createElementNS(SVG_NS, 'svg')
  svg.setAttribute('class', 'catalog-diagram-arrow')
  svg.setAttribute('viewBox', '0 0 12 12')
  svg.setAttribute('preserveAspectRatio', 'xMidYMid meet')
  svg.setAttribute('aria-hidden', 'true')

  if (shape.kind === 'ellipse') {
    const node = document.createElementNS(SVG_NS, 'ellipse')
    node.setAttribute('cx', String(shape.cx))
    node.setAttribute('cy', String(shape.cy))
    node.setAttribute('rx', String(shape.rx))
    node.setAttribute('ry', String(shape.ry))
    node.setAttribute('fill', color)
    svg.append(node)
  } else {
    const node = document.createElementNS(SVG_NS, 'path')
    node.setAttribute('d', shape.d)
    node.setAttribute('fill', color)
    node.setAttribute('stroke', color)
    node.setAttribute('stroke-width', '0.5')
    node.setAttribute('stroke-linejoin', 'round')
    svg.append(node)
  }
  parent.append(svg)
}

function appendShaft(parent, style, vertical) {
  const svg = document.createElementNS(SVG_NS, 'svg')
  svg.setAttribute('class', 'catalog-diagram-connector-shaft')
  svg.setAttribute('viewBox', vertical ? '0 0 12 24' : '0 0 24 12')
  svg.setAttribute('preserveAspectRatio', 'none')
  svg.setAttribute('aria-hidden', 'true')

  const line = document.createElementNS(SVG_NS, 'line')
  line.setAttribute('x1', vertical ? '6' : '0')
  line.setAttribute('y1', vertical ? '0' : '6')
  line.setAttribute('x2', vertical ? '6' : '24')
  line.setAttribute('y2', vertical ? '24' : '6')
  line.setAttribute('stroke', style.color)
  line.setAttribute('stroke-width', String(Math.max(1.25, style.widthPt * (96 / 72))))
  line.setAttribute('stroke-linecap', String(style.cap).includes('round') ? 'round' : 'butt')
  line.setAttribute('vector-effect', 'non-scaling-stroke')
  const dash = dashArray(style.dash)
  if (dash) line.setAttribute('stroke-dasharray', dash)
  svg.append(line)
  parent.append(svg)
}

function appendConnector(parent, style, vertical = false) {
  const wrap = document.createElement('div')
  wrap.className = `catalog-diagram-connector${vertical ? ' catalog-diagram-connector--vertical' : ''}`
  appendArrowTip(wrap, style.headType, style.color, vertical, true)
  appendShaft(wrap, style, vertical)
  appendArrowTip(wrap, style.tailType, style.color, vertical, false)
  parent.append(wrap)
}

function nodeScale(stepCount) {
  if (stepCount >= 7) {
    return { fontScale: 0.82, padY: 6, padX: 6, radiusScale: 0.75 }
  }
  if (stepCount >= 5) {
    return { fontScale: 0.9, padY: 7, padX: 8, radiusScale: 0.85 }
  }
  return { fontScale: 1, padY: 10, padX: 12, radiusScale: 1 }
}

export function mountDiagram(node, element, slideSizePt, { tokens = null } = {}) {
  node.classList.add('catalog-diagram', 'catalog-diagram--rendered')
  node.style.overflow = 'hidden'
  node.style.boxSizing = 'border-box'
  node.style.background = 'transparent'

  const diagramType = String(element.diagram_type || element.diagram?.type || 'flow').toLowerCase()
  const texts = resolveDiagramTexts(element).slice(0, 8)
  const style = resolveDiagramRenderStyle(element, tokens)
  const widthPt = slideWidthPt(slideSizePt)
  const scale = nodeScale(texts.length)
  const vertical = diagramType === 'process'

  const track = document.createElement('div')
  track.className = `catalog-diagram-track catalog-diagram-track--${diagramType}`
  track.dataset.steps = String(texts.length)
  node.append(track)

  texts.forEach((label, index) => {
    if (index > 0) appendConnector(track, style.connector, vertical)
    const box = document.createElement('div')
    box.className = 'catalog-diagram-node'
    box.style.background = style.node.fill
    box.style.borderColor = style.node.borderColor
    box.style.borderWidth = ptToSlideCqw(style.node.borderWidthPt, widthPt)
    box.style.borderStyle = String(style.node.borderDash).includes('dash') ? 'dashed' : 'solid'
    box.style.borderRadius = ptToSlideCqw(style.node.radiusPt * scale.radiusScale, widthPt)
    box.style.color = style.typography.color
    box.style.fontFamily = `"${style.typography.family}", Arial, sans-serif`
    box.style.fontSize = ptToSlideCqw(style.typography.sizePt * scale.fontScale, widthPt)
    box.style.fontWeight = style.typography.bold ? '700' : '400'
    box.style.textAlign = style.typography.alignment === 'l'
      ? 'left'
      : style.typography.alignment === 'r'
        ? 'right'
        : 'center'
    box.style.padding = `${ptToSlideCqw(scale.padY, widthPt)} ${ptToSlideCqw(scale.padX, widthPt)}`
    box.textContent = label
    track.append(box)
  })

  return node
}
