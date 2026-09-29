const GRID_SIZE = 0.125
const MAX_DYNAMIC_ELEMENTS = 500
const MIN_OVERLAP_RATIO = 0.18
const BOUNDS_TOLERANCE = 0.008

function normalizedBox(element, slideSize) {
  const normalized = element?.geometry_norm
  if (
    normalized
    && Number.isFinite(normalized.x)
    && Number.isFinite(normalized.y)
    && Number.isFinite(normalized.width)
    && Number.isFinite(normalized.height)
  ) {
    return { ...normalized }
  }

  const points = element?.geometry_pt
  if (!points || !slideSize?.width || !slideSize?.height) return null
  return {
    x: (points.x_pt || 0) / slideSize.width,
    y: (points.y_pt || 0) / slideSize.height,
    width: (points.width_pt || 0) / slideSize.width,
    height: (points.height_pt || 0) / slideSize.height,
  }
}

function isDynamicElement(element) {
  const id = String(element?.element_id || '')
  return id.includes('__repeat_')
    || Boolean(element?.synthetic)
    || Boolean(element?.component_data)
    || Boolean(element?.baseline_preview)
}

function repeatItemKey(element) {
  return String(element?.element_id || '').match(/__repeat_(\d+)/u)?.[1] || null
}

function boxArea(box) {
  return Math.max(0, box.width) * Math.max(0, box.height)
}

function intersectionArea(left, right) {
  const width = Math.max(0, Math.min(left.x + left.width, right.x + right.width) - Math.max(left.x, right.x))
  const height = Math.max(0, Math.min(left.y + left.height, right.y + right.height) - Math.max(left.y, right.y))
  return width * height
}

function overlapRatio(left, right) {
  const minimumArea = Math.min(boxArea(left), boxArea(right))
  return minimumArea > 0 ? intersectionArea(left, right) / minimumArea : 0
}

function safeBounds(report) {
  const margins = report?.layout?.content_margins || {}
  return {
    left: Number.isFinite(margins.left_norm) ? margins.left_norm : 0,
    right: 1 - (Number.isFinite(margins.right_norm) ? margins.right_norm : 0),
    top: Number.isFinite(margins.top_norm) ? margins.top_norm : 0,
    bottom: 1 - (Number.isFinite(margins.bottom_norm) ? margins.bottom_norm : 0),
  }
}

function isOutside(box, bounds) {
  return box.x < bounds.left - BOUNDS_TOLERANCE
    || box.y < bounds.top - BOUNDS_TOLERANCE
    || box.x + box.width > bounds.right + BOUNDS_TOLERANCE
    || box.y + box.height > bounds.bottom + BOUNDS_TOLERANCE
}

function isOutsideSlide(box) {
  return box.x + box.width < -BOUNDS_TOLERANCE
    || box.y + box.height < -BOUNDS_TOLERANCE
    || box.x > 1 + BOUNDS_TOLERANCE
    || box.y > 1 + BOUNDS_TOLERANCE
}

function cellKeys(box) {
  const minX = Math.floor(Math.max(0, box.x) / GRID_SIZE)
  const maxX = Math.floor(Math.min(0.999, box.x + box.width) / GRID_SIZE)
  const minY = Math.floor(Math.max(0, box.y) / GRID_SIZE)
  const maxY = Math.floor(Math.min(0.999, box.y + box.height) / GRID_SIZE)
  const keys = []
  for (let y = minY; y <= maxY; y += 1) {
    for (let x = minX; x <= maxX; x += 1) keys.push(`${x}:${y}`)
  }
  return keys
}

function canCompareText(left, right) {
  if (left.element.text_group_id && left.element.text_group_id === right.element.text_group_id) return false
  const leftRepeat = repeatItemKey(left.element)
  const rightRepeat = repeatItemKey(right.element)
  if (leftRepeat && leftRepeat === rightRepeat) return false
  return left.dynamic || right.dynamic
}

function hasSevereTextOverflow(item, slideSize) {
  const fontSize = Number(item.element?.typography?.size_pt)
  if (!Number.isFinite(fontSize) || fontSize < 6) return false
  const widthPt = item.box.width * slideSize.width
  const heightPt = item.box.height * slideSize.height
  const charsPerLine = Math.max(1, Math.floor(widthPt / (fontSize * 0.48)))
  const availableLines = Math.max(1, Math.floor(heightPt / (fontSize * 1.15)))
  const neededLines = String(item.element.text || '').split('\n').reduce((
    total,
    line,
  ) => total + Math.max(1, Math.ceil(line.length / charsPerLine)), 0)
  return neededLines > availableLines + 1 && neededLines / availableLines > 1.6
}

export function validatePreviewLayout(report, slide) {
  if (!slide) return { valid: false, issues: [{ code: 'missing_slide' }] }
  const elements = slide.content_elements || []
  const slideSize = slide.render?.slide_size_pt
    || report?.typography?.visibility?.slide_size_pt
    || { width: 960, height: 540 }
  const boxes = elements.map((element) => ({
    element,
    box: normalizedBox(element, slideSize),
    dynamic: isDynamicElement(element),
  })).filter((item) => item.box && item.box.width > 0 && item.box.height > 0)
  const dynamic = boxes.filter((item) => item.dynamic)
  const errors = []
  const warnings = []

  if (dynamic.length > MAX_DYNAMIC_ELEMENTS) {
    return {
      valid: false,
      errors: [{ code: 'dynamic_element_limit', count: dynamic.length, limit: MAX_DYNAMIC_ELEMENTS }],
      warnings,
      issues: [{ code: 'dynamic_element_limit', count: dynamic.length, limit: MAX_DYNAMIC_ELEMENTS }],
    }
  }

  const bounds = safeBounds(report)
  for (const item of dynamic) {
    if (isOutsideSlide(item.box)) {
      errors.push({ code: 'outside_slide', element_id: item.element.element_id })
      continue
    }
    if (isOutside(item.box, bounds)) {
      warnings.push({ code: 'outside_safe_area', element_id: item.element.element_id })
    }
  }

  const textBoxes = boxes.filter((item) => (
    item.element.kind === 'text' && String(item.element.text || '').trim()
  ))
  for (const item of textBoxes) {
    if (hasSevereTextOverflow(item, slideSize)) {
      warnings.push({ code: 'text_overflow', element_id: item.element.element_id })
    }
  }
  const grid = new Map()
  const seenPairs = new Set()
  for (let index = 0; index < textBoxes.length; index += 1) {
    const item = textBoxes[index]
    const nearby = new Set()
    for (const key of cellKeys(item.box)) {
      for (const candidateIndex of grid.get(key) || []) nearby.add(candidateIndex)
    }
    for (const candidateIndex of nearby) {
      const pairKey = `${candidateIndex}:${index}`
      if (seenPairs.has(pairKey)) continue
      seenPairs.add(pairKey)
      const candidate = textBoxes[candidateIndex]
      if (!canCompareText(item, candidate)) continue
      const ratio = overlapRatio(item.box, candidate.box)
      if (ratio >= MIN_OVERLAP_RATIO) {
        warnings.push({
          code: 'text_overlap',
          element_ids: [candidate.element.element_id, item.element.element_id],
          ratio,
        })
      }
    }
    for (const key of cellKeys(item.box)) {
      if (!grid.has(key)) grid.set(key, [])
      grid.get(key).push(index)
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    issues: [...errors, ...warnings],
  }
}
