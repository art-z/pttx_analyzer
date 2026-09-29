import { strokeColorCss } from './fill-styles.js'
import { ptToSlideCqw, slideWidthPt } from './slide-metrics.js'

const SVG_NS = 'http://www.w3.org/2000/svg'

const ARROW_LENGTH_FACTOR = { sm: 2.5, med: 3.5, lg: 5.0 }
const ARROW_WIDTH_FACTOR = { sm: 2.0, med: 3.0, lg: 4.0 }
export const LINE_END_TYPES = ['triangle', 'stealth', 'diamond', 'oval', 'arrow']

function dashArray(dash) {
  if (!dash || dash === 'solid') return null
  if (dash === 'dash') return '8 6'
  if (dash === 'dot') return '2 4'
  if (dash === 'dashDot') return '8 4 2 4'
  return '6 4'
}

export function resolveArrowMarkerScale(end, lineWidthPt = 0.75) {
  const sizePt = end?.size_pt
  if (sizePt?.length_pt && sizePt?.width_pt && lineWidthPt > 0) {
    return {
      length: sizePt.length_pt / lineWidthPt,
      width: sizePt.width_pt / lineWidthPt,
    }
  }
  const lengthKey = end?.length || end?.width || 'med'
  const widthKey = end?.width || end?.length || lengthKey
  return {
    length: ARROW_LENGTH_FACTOR[lengthKey] || ARROW_LENGTH_FACTOR.med,
    width: ARROW_WIDTH_FACTOR[widthKey] || ARROW_WIDTH_FACTOR.med,
  }
}

export function resolveLineMarkerBase(element) {
  const sourcePart = String(element?.source_part || element?.source || '')
  const slideSlug = sourcePart.match(/slide(\d+)\.xml$/)?.[1]
    || sourcePart.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  const localId = element?.element_id || element?.layer_id || 'line'
  return [slideSlug, localId].filter(Boolean).join('-').replace(/[^a-zA-Z0-9_-]/g, '')
}

export function resolveLineRenderMode(element) {
  if (element?.outline_path || element?.line?.path) return 'path'
  if (element?.line?.outline === 'rect') return 'rect'
  return 'segment'
}

export function lineEndMarkerPath(type, length, width, { atStart = false } = {}) {
  const notch = length * 0.2
  switch (type) {
    case 'stealth':
      return atStart
        ? `M ${length} 0 L 0 ${width / 2} L ${length} ${width} L ${notch} ${width / 2} Z`
        : `M 0 0 L ${length} ${width / 2} L 0 ${width} L ${length - notch} ${width / 2} Z`
    case 'diamond':
      return atStart
        ? `M ${length} ${width / 2} L ${length / 2} 0 L 0 ${width / 2} L ${length / 2} ${width} Z`
        : `M 0 ${width / 2} L ${length / 2} 0 L ${length} ${width / 2} L ${length / 2} ${width} Z`
    case 'triangle':
    default:
      return atStart
        ? `M ${length} 0 L 0 ${width / 2} L ${length} ${width} Z`
        : `M 0 0 L ${length} ${width / 2} L 0 ${width} Z`
  }
}

function appendFilledLineEndMarker(defs, id, end, scale, { atStart = false } = {}) {
  const length = scale.length
  const width = scale.width
  const marker = document.createElementNS(SVG_NS, 'marker')
  marker.setAttribute('id', id)
  marker.setAttribute('markerUnits', 'strokeWidth')
  marker.setAttribute('viewBox', `0 0 ${length} ${width}`)
  marker.setAttribute('refX', atStart ? '0' : String(length))
  marker.setAttribute('refY', String(width / 2))
  marker.setAttribute('markerWidth', String(length))
  marker.setAttribute('markerHeight', String(width))
  marker.setAttribute('orient', 'auto')

  const path = document.createElementNS(SVG_NS, 'path')
  path.setAttribute('d', lineEndMarkerPath(end.type, length, width, { atStart }))
  path.setAttribute('fill', 'currentColor')
  marker.append(path)
  defs.append(marker)
  return `url(#${id})`
}

function appendOpenArrowMarker(defs, id, scale, { atStart = false } = {}) {
  const length = scale.length
  const width = scale.width
  const marker = document.createElementNS(SVG_NS, 'marker')
  marker.setAttribute('id', id)
  marker.setAttribute('markerUnits', 'strokeWidth')
  marker.setAttribute('viewBox', `0 0 ${length} ${width}`)
  marker.setAttribute('refX', atStart ? '0' : String(length))
  marker.setAttribute('refY', String(width / 2))
  marker.setAttribute('markerWidth', String(length))
  marker.setAttribute('markerHeight', String(width))
  marker.setAttribute('orient', 'auto')

  const path = document.createElementNS(SVG_NS, 'path')
  path.setAttribute(
    'd',
    atStart
      ? `M ${length} 0 L 0 ${width / 2} M ${length} ${width} L 0 ${width / 2}`
      : `M 0 0 L ${length} ${width / 2} M 0 ${width} L ${length} ${width / 2}`,
  )
  path.setAttribute('fill', 'none')
  path.setAttribute('stroke', 'currentColor')
  path.setAttribute('stroke-width', '1')
  path.setAttribute('stroke-linecap', 'round')
  path.setAttribute('stroke-linejoin', 'round')
  marker.append(path)
  defs.append(marker)
  return `url(#${id})`
}

function appendOvalMarker(defs, id, scale, { atStart = false } = {}) {
  const length = scale.length
  const width = scale.width
  const marker = document.createElementNS(SVG_NS, 'marker')
  marker.setAttribute('id', id)
  marker.setAttribute('markerUnits', 'strokeWidth')
  marker.setAttribute('viewBox', `0 0 ${length} ${width}`)
  marker.setAttribute('refX', atStart ? String(width / 2) : String(length - width / 2))
  marker.setAttribute('refY', String(width / 2))
  marker.setAttribute('markerWidth', String(length))
  marker.setAttribute('markerHeight', String(width))
  marker.setAttribute('orient', 'auto')

  const ellipse = document.createElementNS(SVG_NS, 'ellipse')
  ellipse.setAttribute('cx', atStart ? String(width / 2) : String(length - width / 2))
  ellipse.setAttribute('cy', String(width / 2))
  ellipse.setAttribute('rx', String(width / 2))
  ellipse.setAttribute('ry', String(width / 2))
  ellipse.setAttribute('fill', 'currentColor')
  marker.append(ellipse)
  defs.append(marker)
  return `url(#${id})`
}

function appendLineEndMarker(defs, id, end, scale, { atStart = false } = {}) {
  const type = end?.type
  if (!type || type === 'none') return null
  if (type === 'arrow') {
    return appendOpenArrowMarker(defs, id, scale, { atStart })
  }
  if (type === 'oval') {
    return appendOvalMarker(defs, id, scale, { atStart })
  }
  if (LINE_END_TYPES.includes(type) || type === 'triangle') {
    return appendFilledLineEndMarker(defs, id, end, scale, { atStart })
  }
  return appendFilledLineEndMarker(defs, id, { type: 'triangle' }, scale, { atStart })
}

function applyStrokeAttributes(node, stroke, widthPt, slideW) {
  node.setAttribute('stroke', 'currentColor')
  node.style.strokeWidth = ptToSlideCqw(widthPt, slideW)
  node.setAttribute('stroke-linecap', stroke.cap === 'flat' ? 'butt' : (stroke.cap || 'round'))
  node.setAttribute('stroke-linejoin', 'round')
  node.setAttribute('fill', 'none')

  const dash = dashArray(stroke.dash)
  if (dash) node.setAttribute('stroke-dasharray', dash)
}

function appendConnectorLine(defs, svg, element, stroke, widthPt, slideW, markerBase) {
  const coords = element.line || { x1: 0, y1: 0.5, x2: 1, y2: 0.5 }
  const lineNode = document.createElementNS(SVG_NS, 'line')
  lineNode.setAttribute('x1', `${coords.x1 * 100}%`)
  lineNode.setAttribute('y1', `${coords.y1 * 100}%`)
  lineNode.setAttribute('x2', `${coords.x2 * 100}%`)
  lineNode.setAttribute('y2', `${coords.y2 * 100}%`)
  applyStrokeAttributes(lineNode, stroke, widthPt, slideW)

  if (stroke.head?.type && stroke.head.type !== 'none') {
    const marker = appendLineEndMarker(
      defs,
      `${markerBase}-head`,
      stroke.head,
      resolveArrowMarkerScale(stroke.head, widthPt),
      { atStart: true },
    )
    if (marker) lineNode.setAttribute('marker-start', marker)
  }
  if (stroke.tail?.type && stroke.tail.type !== 'none') {
    const marker = appendLineEndMarker(
      defs,
      `${markerBase}-tail`,
      stroke.tail,
      resolveArrowMarkerScale(stroke.tail, widthPt),
      { atStart: false },
    )
    if (marker) lineNode.setAttribute('marker-end', marker)
  }

  svg.append(lineNode)
}

function appendRectOutline(svg, stroke, widthPt, slideW) {
  const rectNode = document.createElementNS(SVG_NS, 'rect')
  rectNode.setAttribute('x', '0')
  rectNode.setAttribute('y', '0')
  rectNode.setAttribute('width', '100%')
  rectNode.setAttribute('height', '100%')
  applyStrokeAttributes(rectNode, stroke, widthPt, slideW)
  svg.append(rectNode)
}

function appendPathOutline(svg, pathData, stroke, widthPt, slideW) {
  svg.setAttribute('viewBox', '0 0 1 1')
  svg.setAttribute('preserveAspectRatio', 'none')

  const pathNode = document.createElementNS(SVG_NS, 'path')
  pathNode.setAttribute('d', pathData)
  pathNode.setAttribute('vector-effect', 'non-scaling-stroke')
  applyStrokeAttributes(pathNode, stroke, widthPt, slideW)
  svg.append(pathNode)
}

export function mountLine(node, element, slideSizePt) {
  node.classList.add('catalog-line', 'catalog-element--line')
  node.style.overflow = 'visible'
  node.style.pointerEvents = 'none'

  const geometry = element.geometry_norm || {}
  if (geometry.height != null && geometry.height > 0) {
    node.style.height = `${geometry.height * 100}%`
  }

  const stroke = element.stroke || {}
  const color = strokeColorCss(stroke) || '#17212D'
  const widthPt = stroke.width_pt || 0.75
  const slideW = slideWidthPt(slideSizePt) || 960
  const renderMode = resolveLineRenderMode(element)

  const svg = document.createElementNS(SVG_NS, 'svg')
  svg.classList.add('catalog-line-svg')
  svg.style.position = 'absolute'
  svg.style.inset = '0'
  svg.style.width = '100%'
  svg.style.height = '100%'
  svg.style.overflow = 'visible'
  svg.style.color = color

  const defs = document.createElementNS(SVG_NS, 'defs')
  svg.append(defs)

  if (renderMode === 'path') {
    appendPathOutline(
      svg,
      element.outline_path || element.line?.path,
      stroke,
      widthPt,
      slideW,
    )
  } else if (renderMode === 'rect') {
    appendRectOutline(svg, stroke, widthPt, slideW)
  } else {
    appendConnectorLine(
      defs,
      svg,
      element,
      stroke,
      widthPt,
      slideW,
      resolveLineMarkerBase(element),
    )
  }

  node.append(svg)
  return node
}
