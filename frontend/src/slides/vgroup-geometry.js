function cloneValue(value) {
  if (typeof structuredClone === 'function') return structuredClone(value)
  return JSON.parse(JSON.stringify(value))
}

export function relativizeGeometryNorm(geometry, container) {
  const source = geometry || {}
  const box = container || { x: 0, y: 0, width: 1, height: 1 }
  const width = box.width || 1
  const height = box.height || 1
  return {
    x: width ? (source.x - box.x) / width : source.x,
    y: height ? (source.y - box.y) / height : source.y,
    width: width ? source.width / width : source.width,
    height: height ? source.height / height : source.height,
  }
}

export function relativizeGeometryPt(geometry, container) {
  if (!geometry || !container) return geometry ? cloneValue(geometry) : null
  const width = container.width_pt || 1
  const height = container.height_pt || 1
  return {
    x_pt: geometry.x_pt - container.x_pt,
    y_pt: geometry.y_pt - container.y_pt,
    width_pt: geometry.width_pt,
    height_pt: geometry.height_pt,
  }
}

export function relativizeElement(element, groupBBox) {
  const next = cloneValue(element)
  const containerNorm = groupBBox?.bboxNorm || groupBBox
  next.geometry_norm = relativizeGeometryNorm(element.geometry_norm, containerNorm)
  if (element.geometry_pt && groupBBox?.bboxPt) {
    next.geometry_pt = relativizeGeometryPt(element.geometry_pt, groupBBox.bboxPt)
  }
  if (element.text_group_geometry_norm) {
    next.text_group_geometry_norm = relativizeGeometryNorm(element.text_group_geometry_norm, containerNorm)
  }
  if (element.text_group_geometry_pt && groupBBox?.bboxPt) {
    next.text_group_geometry_pt = relativizeGeometryPt(element.text_group_geometry_pt, groupBBox.bboxPt)
  }
  return next
}

export function relativizeElements(elements, groupBBox) {
  return (elements || []).map((element) => relativizeElement(element, groupBBox))
}
