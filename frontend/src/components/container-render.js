import { resolvePlaygroundInstances, splitInstanceIntoItems, getPlaygroundInstanceBBox } from './container-catalog.js'
import { clearTextElementContent, isolateSlideTextContent, replaceTextElementContent } from '../slides/text-content-patch.js'

function cloneValue(value) {
  if (typeof structuredClone === 'function') return structuredClone(value)
  return JSON.parse(JSON.stringify(value))
}

function elementBBoxPt(element) {
  const geometry = element?.geometry_pt || {}
  if (!geometry.width_pt || !geometry.height_pt) return null
  return {
    x_pt: geometry.x_pt || 0,
    y_pt: geometry.y_pt || 0,
    width_pt: geometry.width_pt,
    height_pt: geometry.height_pt,
  }
}

export function unionBBoxPt(boxes) {
  const items = (boxes || []).filter(Boolean)
  if (!items.length) return null
  const x = Math.min(...items.map((box) => box.x_pt))
  const y = Math.min(...items.map((box) => box.y_pt))
  const right = Math.max(...items.map((box) => box.x_pt + box.width_pt))
  const bottom = Math.max(...items.map((box) => box.y_pt + box.height_pt))
  return {
    x_pt: x,
    y_pt: y,
    width_pt: right - x,
    height_pt: bottom - y,
  }
}

function bboxNormFromPt(bboxPt, slideSizePt) {
  const width = slideSizePt?.width || 960
  const height = slideSizePt?.height || 540
  return {
    x: bboxPt.x_pt / width,
    y: bboxPt.y_pt / height,
    width: bboxPt.width_pt / width,
    height: bboxPt.height_pt / height,
  }
}

function translateGeometryPt(geometryPt, dxPt, dyPt) {
  if (!geometryPt) return null
  return {
    ...geometryPt,
    x_pt: (geometryPt.x_pt || 0) + dxPt,
    y_pt: (geometryPt.y_pt || 0) + dyPt,
  }
}

function translateElement(element, dxPt, dyPt, slideSizePt, suffix) {
  const next = cloneValue(element)
  next.element_id = `${element.element_id}__repeat_${suffix}`

  if (next.text_group_id) {
    next.text_group_id = `${next.text_group_id}__repeat_${suffix}`
  }

  const geometryPt = translateGeometryPt(next.geometry_pt, dxPt, dyPt)
  if (geometryPt) {
    next.geometry_pt = geometryPt
    next.geometry_norm = bboxNormFromPt(geometryPt, slideSizePt)
  }

  const textGroupGeometryPt = translateGeometryPt(next.text_group_geometry_pt, dxPt, dyPt)
  if (textGroupGeometryPt) {
    next.text_group_geometry_pt = textGroupGeometryPt
    next.text_group_geometry_norm = bboxNormFromPt(textGroupGeometryPt, slideSizePt)
  }

  return next
}

export function sortItemBoxesLtr(itemBoxes = []) {
  if (!itemBoxes.length) return []
  const rowTol = Math.max(...itemBoxes.map((box) => box.height_pt), 1) * 0.45
  return [...itemBoxes].sort((left, right) => {
    const rowLeft = Math.round(left.y_pt / rowTol)
    const rowRight = Math.round(right.y_pt / rowTol)
    if (rowLeft !== rowRight) return rowLeft - rowRight
    return left.x_pt - right.x_pt
  })
}

export function topRowItemBoxes(itemBoxes = []) {
  const sorted = sortItemBoxesLtr(itemBoxes)
  if (!sorted.length) return []
  const rowTol = Math.max(...sorted.map((box) => box.height_pt), 1) * 0.45
  const topY = sorted[0].y_pt
  return sorted.filter((box) => Math.abs(box.y_pt - topY) <= rowTol)
}

export function topRowLayoutAnchor(itemBoxes = [], playgroundBBox = null) {
  const topRow = topRowItemBoxes(itemBoxes)
  if (topRow.length) {
    return {
      x_pt: Math.min(...topRow.map((box) => box.x_pt)),
      y_pt: Math.min(...topRow.map((box) => box.y_pt)),
    }
  }
  if (playgroundBBox) {
    return { x_pt: playgroundBBox.x_pt, y_pt: playgroundBBox.y_pt }
  }
  return { x_pt: 0, y_pt: 0 }
}

function rowToleranceForBoxes(itemBoxes = []) {
  return Math.max(...itemBoxes.map((box) => box.height_pt), 1) * 0.45
}

function median(values) {
  const sorted = values.filter((value) => Number.isFinite(value)).sort((left, right) => left - right)
  if (!sorted.length) return null
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

function inferColsFromItemBoxes(sortedBoxes) {
  return Math.max(1, topRowItemBoxes(sortedBoxes).length)
}

function isVerticalColumnRepeat(sortedBoxes = []) {
  const sorted = sortItemBoxesLtr(sortedBoxes)
  if (sorted.length < 2) return false
  const topRow = topRowItemBoxes(sorted)
  const rowTol = rowToleranceForBoxes(sorted)
  const anchorX = topRow[0]?.x_pt ?? sorted[0].x_pt
  const firstColumn = sorted
    .filter((box) => Math.abs(box.x_pt - anchorX) <= rowTol)
    .sort((left, right) => left.y_pt - right.y_pt)
  return topRow.length <= 1 && firstColumn.length >= 2
}

export function measureRepeatPitch(itemBoxes, layout, grid) {
  const sorted = sortItemBoxesLtr(itemBoxes)
  const topRow = topRowItemBoxes(sorted)
  const itemSize = topRow[0] || sorted[0] || { width_pt: 0, height_pt: 0 }

  if (sorted.length < 2) {
    return {
      stepX: itemSize.width_pt || 0,
      stepY: itemSize.height_pt || 0,
      cols: 1,
      itemWidth: itemSize.width_pt || 0,
      itemHeight: itemSize.height_pt || 0,
    }
  }

  const rowTol = rowToleranceForBoxes(sorted)
  const horizontalSteps = []
  for (let index = 1; index < topRow.length; index += 1) {
    horizontalSteps.push(topRow[index].x_pt - topRow[index - 1].x_pt)
  }

  const anchorX = topRow[0]?.x_pt ?? sorted[0].x_pt
  const firstColumn = sorted
    .filter((box) => Math.abs(box.x_pt - anchorX) <= rowTol)
    .sort((left, right) => left.y_pt - right.y_pt)
  const verticalSteps = []
  for (let index = 1; index < firstColumn.length; index += 1) {
    verticalSteps.push(firstColumn[index].y_pt - firstColumn[index - 1].y_pt)
  }

  const stepX = Math.max(
    median(horizontalSteps) || 0,
    itemSize.width_pt * 1.02,
  )
  const stepY = Math.max(
    median(verticalSteps) || 0,
    itemSize.height_pt * 1.05,
  )

  let cols = 1
  if (layout === 'column' && isVerticalColumnRepeat(sorted)) cols = 1
  else if (layout === 'column') cols = inferColsFromItemBoxes(sorted)
  else if (grid?.cols) cols = grid.cols
  else cols = inferColsFromItemBoxes(sorted)

  return {
    stepX,
    stepY,
    cols,
    itemWidth: itemSize.width_pt,
    itemHeight: itemSize.height_pt,
  }
}

export function resolveAlignCrossHint(instances = []) {
  const values = instances
    .map((instance) => instance.align_cross)
    .filter((value) => value && value !== 'mixed' && value !== 'stretch')
  if (!values.length) return null
  if (values.every((value) => value === 'center')) return 'center'
  return null
}

export function detectRepeatAlignment(itemBoxes, playgroundBBox, alignCrossHint = null) {
  if (alignCrossHint !== 'center') return 'start'
  if (!playgroundBBox || itemBoxes.length < 2) return 'start'

  const topRow = topRowItemBoxes(itemBoxes)
  const sample = topRow.length ? topRow : itemBoxes
  const leftEdge = Math.min(...sample.map((box) => box.x_pt))
  const rightEdge = Math.max(...sample.map((box) => box.x_pt + box.width_pt))
  const leftMargin = leftEdge - playgroundBBox.x_pt
  const rightMargin = (playgroundBBox.x_pt + playgroundBBox.width_pt) - rightEdge
  const tol = Math.max(4, playgroundBBox.width_pt * 0.04)

  if (Math.abs(leftMargin - rightMargin) <= tol && leftMargin >= 0) return 'center'
  return 'start'
}

export function resolveRepeatShape(itemCount, pitch, layout, grid, { layoutSplit = false, splitMode = null } = {}) {
  if (splitMode === 'horizontal_series') {
    return { rows: 1, cols: Math.max(1, itemCount) }
  }
  if (splitMode === 'row_card') {
    return { rows: itemCount, cols: 1 }
  }
  if (layout === 'column') {
    if (pitch.cols > 1 || layoutSplit) {
      const cols = Math.max(1, pitch.cols || 1)
      return { cols, rows: Math.ceil(itemCount / cols) }
    }
    return { rows: itemCount, cols: 1 }
  }
  if (!layoutSplit && layout === 'grid' && grid?.cols) {
    return { rows: Math.ceil(itemCount / grid.cols), cols: grid.cols }
  }
  if (!layoutSplit && layout === 'grid' && grid?.rows) {
    return { rows: grid.rows, cols: Math.ceil(itemCount / grid.rows) }
  }

  const cols = Math.max(1, pitch.cols || itemCount)
  return {
    cols,
    rows: Math.ceil(itemCount / cols),
  }
}

export function layoutItemOriginsInBBox({
  itemCount,
  playgroundBBox,
  pitch,
  shape,
  alignment = 'start',
  anchor = null,
}) {
  if (!playgroundBBox || !itemCount) return []

  const itemWidth = pitch.itemWidth || pitch.stepX
  const itemHeight = pitch.itemHeight || pitch.stepY
  const gridWidth = itemWidth + Math.max(0, shape.cols - 1) * pitch.stepX
  const gridHeight = itemHeight + Math.max(0, shape.rows - 1) * pitch.stepY

  const origin = anchor || { x_pt: playgroundBBox.x_pt, y_pt: playgroundBBox.y_pt }
  let startX = origin.x_pt
  let startY = origin.y_pt

  if (alignment === 'center') {
    startX += Math.max(0, (playgroundBBox.width_pt - gridWidth) / 2)
    startY = origin.y_pt + Math.max(0, (playgroundBBox.height_pt - gridHeight) / 2)
  }

  const origins = []
  for (let index = 0; index < itemCount; index += 1) {
    const row = Math.floor(index / shape.cols)
    const col = index % shape.cols
    origins.push({
      x_pt: startX + col * pitch.stepX,
      y_pt: startY + row * pitch.stepY,
    })
  }
  return origins
}

export function resolveFieldValue(slot, fields) {
  if (!slot || !fields) return null
  const headingRoles = new Set(['heading', 'title', 'subtitle', 'label', 'name'])
  const bodyRoles = new Set(['body', 'description', 'caption', 'content', 'list'])
  const keys = [
    slot.slot_id,
    slot.role ? `${slot.kind || 'field'}:${slot.role}` : null,
    slot.role,
  ].filter(Boolean)
  if (headingRoles.has(slot.role)) {
    keys.push('heading', 'title', 'name', 'label')
  } else if (bodyRoles.has(slot.role)) {
    keys.push('body', 'text', 'description', 'bio', 'caption')
  } else if (slot.role === 'text') {
    keys.push('body', 'text', 'description', 'heading', 'title')
  }
  for (const key of keys) {
    if (fields[key] != null) return fields[key]
  }
  return null
}

export function repeatItemHasData(item) {
  const fields = item?.fields || {}
  return Object.values(fields).some((value) => value != null && String(value).trim() !== '')
}

export function normalizeRepeatModelData(modelData) {
  if (!modelData) return null

  const items = (modelData.items || []).filter(repeatItemHasData)
  if (!items.length) {
    return { ...modelData, item_count: 0, items: [] }
  }

  const itemCount = Math.min(
    Number(modelData.item_count) || items.length,
    items.length,
  )

  return {
    ...modelData,
    item_count: itemCount,
    items: items.slice(0, itemCount).map((item, index) => ({
      ...item,
      index: index + 1,
    })),
  }
}

export function normalizeRepeatModelForRender(modelData) {
  if (!modelData) return null

  const layout = modelData.layout
  const isGrid = layout === 'grid' || Boolean(modelData.grid?.cols)
  if (!isGrid) return normalizeRepeatModelData(modelData)

  const itemCount = Math.max(0, Number(modelData.item_count) || 0)
  if (!itemCount) return { ...modelData, item_count: 0, items: [] }

  const sourceItems = modelData.items || []
  const template = sourceItems.find(repeatItemHasData) || sourceItems[0] || { fields: {} }

  return {
    ...modelData,
    item_count: itemCount,
    items: Array.from({ length: itemCount }, (_, index) => {
      const existing = sourceItems[index]
      return {
        ...(existing || sourceItems[sourceItems.length - 1] || template),
        index: index + 1,
        fields: { ...(existing?.fields || template.fields || {}) },
      }
    }),
  }
}

const HEADING_SLOT_ROLES = new Set(['heading', 'title', 'subtitle', 'label', 'name'])

// A metric item must show its value. Some templates tag the value box of one
// item (e.g. a highlighted card) as body, which would put the description
// there and drop the number. Then the largest text slot becomes the heading,
// the same rule the flex metric path uses.
export function promoteMetricValueSlot(elements, slots, fields) {
  if (!Object.hasOwn(fields || {}, 'metric_value') || !slots?.length) return slots
  if (slots.some((slot) => HEADING_SLOT_ROLES.has(slot?.role))) return slots
  const textIndexes = elements
    .map((element, index) => (element?.kind === 'text' && slots[index] ? index : -1))
    .filter((index) => index >= 0)
  if (textIndexes.length < 2) return slots
  const valueIndex = textIndexes.reduce((best, index) => (
    (elements[index].typography?.size_pt || 0) > (elements[best].typography?.size_pt || 0) ? index : best
  ))
  return slots.map((slot, index) => (index === valueIndex ? { ...slot, role: 'heading' } : slot))
}

// Donor text split into lines (one text group, several line elements with the
// same slot role) must get the value once: the renderer stacks group members,
// so every line carrying the full value would show it two or three times.
export function applyItemFieldsToElements(elements, itemSlots, fields) {
  const slots = promoteMetricValueSlot(elements, itemSlots, fields)
  const order = elements
    .map((element, index) => ({ element, index }))
    .sort((left, right) => (
      String(left.element.text_group_id || '').localeCompare(String(right.element.text_group_id || ''))
      || (Number(left.element.text_line_index) || 0) - (Number(right.element.text_line_index) || 0)
      || left.index - right.index
    ))
  const firstInGroup = new Map()
  const duplicateLine = new Set()
  for (const { element, index } of order) {
    if (!element.text_group_id || (element.kind !== 'text' && element.kind !== 'badge')) continue
    const value = slots?.[index] ? resolveFieldValue(slots[index], fields) : null
    if (value == null || String(value).trim() === '') continue
    const key = `${element.text_group_id}|${String(value)}`
    if (firstInGroup.has(key)) duplicateLine.add(index)
    else firstInGroup.set(key, index)
  }
  return elements.map((element, index) => {
    const slot = slots?.[index]
    if (element.kind !== 'text' && element.kind !== 'badge') return element
    if (duplicateLine.has(index)) return null

    const value = slot ? resolveFieldValue(slot, fields) : null
    if (value == null || String(value).trim() === '') {
      return clearTextElementContent(element)
    }

    const next = replaceTextElementContent(element, value)
    if (
      element.metric
      && Object.hasOwn(fields, 'metric_value')
      && ['heading', 'title', 'text'].includes(slot?.role)
    ) {
      next.metric = {
        ...element.metric,
        value: String(fields.metric_value ?? ''),
        unit: String(fields.metric_unit ?? ''),
      }
    }
    return next
  }).filter(Boolean)
}

export function buildContainerRepeatPreviewSlide(report, component, instance, { modelData = null } = {}) {
  const normalizedModel = normalizeRepeatModelForRender(modelData)
  if (!normalizedModel?.item_count) return null

  const slide = report?.slides?.slides?.find((item) => item.slide_number === instance.slide_number)
  if (!slide) return null

  const nextSlide = cloneValue(slide)
  const slideSizePt = nextSlide.render?.slide_size_pt || report?.typography?.visibility?.slide_size_pt || { width: 960, height: 540 }
  const elementsById = new Map((nextSlide.content_elements || []).map((element) => [element.element_id, element]))
  const playgroundInstances = resolvePlaygroundInstances(component, instance)
  const sourceItems = playgroundInstances.flatMap((entry) => splitInstanceIntoItems(entry))
  const repeatIds = new Set(sourceItems.flatMap((item) => item.element_ids || []))
  if (!sourceItems.length) return nextSlide

  const modelItems = normalizedModel.items || []
  const itemCount = normalizedModel.item_count

  const itemBoxes = sourceItems
    .map((item) => unionBBoxPt(item.element_ids.map((id) => elementBBoxPt(elementsById.get(id))).filter(Boolean)))
    .filter(Boolean)
  const sortedBoxes = sortItemBoxesLtr(itemBoxes)
  const splitMode = normalizedModel.split_mode || instance.repeat?.split_mode || null
  const layout = normalizedModel.layout || instance.layout
  const pageLayout = splitMode === 'row_card'
    ? 'column'
    : splitMode === 'horizontal_series'
      ? 'row'
      : layout
  const grid = normalizedModel.grid || instance.repeat?.grid
  const pitch = measureRepeatPitch(sortedBoxes, pageLayout, grid)
  const layoutSplit = Boolean(normalizedModel.layout_split || playgroundInstances.length > 1)
  const shape = resolveRepeatShape(itemCount, pitch, pageLayout, grid, { layoutSplit, splitMode })
  const playgroundBBox = getPlaygroundInstanceBBox(component, instance)
  const layoutAnchor = topRowLayoutAnchor(sortedBoxes, playgroundBBox)
  const relayout = itemCount !== sourceItems.length
  const alignment = detectRepeatAlignment(
    sortedBoxes,
    playgroundBBox,
    resolveAlignCrossHint(playgroundInstances),
  )

  const targetOrigins = relayout
    ? layoutItemOriginsInBBox({
      itemCount,
      playgroundBBox,
      pitch,
      shape,
      alignment,
      anchor: layoutAnchor,
    })
    : sortedBoxes.slice(0, itemCount).map((box) => ({ x_pt: box.x_pt, y_pt: box.y_pt }))

  nextSlide.content_elements = (nextSlide.content_elements || []).filter((element) => !repeatIds.has(element.element_id))

  const generated = []
  for (let index = 0; index < itemCount; index += 1) {
    const sourceItem = sourceItems[index % sourceItems.length]
    const templateElements = sourceItem.element_ids
      .map((id) => elementsById.get(id))
      .filter(Boolean)
    if (!templateElements.length) continue

    const templateOrigin = unionBBoxPt(templateElements.map(elementBBoxPt))
    const targetOrigin = targetOrigins[index] || targetOrigins[targetOrigins.length - 1] || templateOrigin
    const dx = targetOrigin.x_pt - templateOrigin.x_pt
    const dy = targetOrigin.y_pt - templateOrigin.y_pt
    const fields = modelItems[index]?.fields || {}
    const cloned = applyItemFieldsToElements(
      templateElements.map((element) => translateElement(element, dx, dy, slideSizePt, index + 1)),
      sourceItem.slots,
      fields,
    )
    generated.push(...cloned)
  }

  nextSlide.content_elements = [...nextSlide.content_elements, ...generated]
  return isolateSlideTextContent(nextSlide, {
    keepElementIds: generated.map((element) => element.element_id),
  })
}
