import { instanceHasSameSlideRepeat } from './from-vgroups.js'
import { findLayoutSplitForInstance, resolveRepeatItemCount, unionInstanceContainersPt } from './repeat-layout-analysis.js'

function cloneValue(value) {
  if (typeof structuredClone === 'function') return structuredClone(value)
  return JSON.parse(JSON.stringify(value))
}

function slotValue(slot) {
  if (slot?.text != null && String(slot.text).trim() !== '') return slot.text
  if ((slot?.kind === 'text' || slot?.kind === 'badge') && slot?.label != null && String(slot.label).trim() !== '') {
    return slot.label
  }
  return null
}

function fieldKeyForSlot(slot) {
  return slot.slot_id || (slot.role ? `${slot.kind || 'field'}:${slot.role}` : null) || 'field'
}

function itemFieldsFromSlots(slots = []) {
  const fields = {}
  for (const slot of slots) {
    const value = slotValue(slot)
    if (value == null) continue
    const role = slot.role === 'text' ? 'body' : slot.role
    if (role && (role === 'image' || !role.startsWith('text_'))) {
      fields[role] = value
    }
  }
  return fields
}

export function instancesHaveTextSlots(instances = []) {
  return instances.some((instance) => (
    (instance.slots || []).some((slot) => slot.kind === 'text' || slot.kind === 'badge')
  ))
}

export function hasRepeatTextSlots(component) {
  const fields = component?.text_fields || component?.textFields || []
  if (fields.length > 0) return true
  return instancesHaveTextSlots(component?.instances || [])
}

export function isIterableRepeatComponent(component) {
  if (!hasRepeatTextSlots(component)) return false
  const iter = component?.iterability
  if (!iter?.is_iterable) return false
  if (iter.method !== 'repeat_series' && iter.method !== 'repeat_grid') return false
  if (!iter.checks?.same_slide_repeat) return false
  return (component.instances || []).some((instance) => instanceHasSameSlideRepeat(instance))
    || (component.raw?.layout_splits || component.layout_splits || []).some((split) => Number(split.item_count) >= 2)
}

export function repeatPlaygroundInstanceScore(instance) {
  const repeatCount = resolveRepeatItemCount(instance?.repeat)
  const hasGrid = instance?.repeat?.grid ? 1 : 0
  const area = (instance?.container?.width_pt || 0) * (instance?.container?.height_pt || 0)
  return repeatCount * 1e9 + hasGrid * 1e8 + area
}

export function sortInstancesForRepeatPreview(instances = []) {
  return [...instances].sort((left, right) => (
    repeatPlaygroundInstanceScore(right) - repeatPlaygroundInstanceScore(left)
    || (left.slide_number || 0) - (right.slide_number || 0)
    || (left.group_index || 0) - (right.group_index || 0)
  ))
}

export function pickBestRepeatInstance(instances = []) {
  const sorted = sortInstancesForRepeatPreview(instances)
  return sorted.find((instance) => resolveRepeatItemCount(instance?.repeat) >= 2) || sorted[0] || null
}

export function resolveRepeatPlaygroundAnchor(component, instance) {
  if (!instance) return null
  if (!isIterableRepeatComponent(component)) return instance

  const onSlide = (component.instances || []).filter((item) => item.slide_number === instance.slide_number)
  const slideBest = pickBestRepeatInstance(onSlide)
  if (resolveRepeatItemCount(slideBest?.repeat) >= 2) return slideBest

  const parentRepeat = onSlide.find((peer) => (
    resolveRepeatItemCount(peer.repeat) >= 2
    && (instance.element_ids || []).length > 0
    && (instance.element_ids || []).every((id) => (peer.element_ids || []).includes(id))
  ))
  if (parentRepeat) return parentRepeat

  return instance
}

export function resolvePlaygroundInstances(component, instance) {
  if (!instance) return []
  const split = findLayoutSplitForInstance(component, instance)
  if (!split) return [resolveRepeatPlaygroundAnchor(component, instance)]
  return (component.instances || []).filter((item) => (
    item.slide_number === split.slide_number
    && split.vgroup_ids.includes(item.vgroup_id)
  ))
}

export function getPlaygroundInstanceBBox(component, instance) {
  if (!instance) return null
  const split = findLayoutSplitForInstance(component, instance)
  if (split?.container?.width_pt) return { ...split.container }
  return unionInstanceContainersPt(resolvePlaygroundInstances(component, instance))
}

export function getPlaygroundInstanceBBoxNorm(component, instance, slideSizePt) {
  const split = findLayoutSplitForInstance(component, instance)
  if (split?.container_norm?.width) return { ...split.container_norm }
  const bboxPt = getPlaygroundInstanceBBox(component, instance)
  if (!bboxPt) return null
  const width = slideSizePt?.width || 960
  const height = slideSizePt?.height || 540
  return {
    x: bboxPt.x_pt / width,
    y: bboxPt.y_pt / height,
    width: bboxPt.width_pt / width,
    height: bboxPt.height_pt / height,
  }
}

export function buildContainerCapacity(component) {
  const layoutSplits = component.raw?.layout_splits || component.layout_splits || []
  const splitKnown = layoutSplits.length
    ? Math.max(...layoutSplits.map((split) => split.item_count || 0))
    : null
  const repeatCounts = (component.instances || [])
    .map((instance) => resolveRepeatItemCount(instance.repeat))
    .filter((value) => Number.isFinite(value) && value >= 1)
  const known = splitKnown
    ?? (repeatCounts.length ? Math.max(...repeatCounts) : 1)
  const iterMax = component.iterability?.max_repeat_count
  const maxFromDeck = repeatCounts.length ? Math.max(...repeatCounts) + 3 : known + 2

  return {
    item_count_min: 1,
    item_count_max: Math.max(iterMax || 0, maxFromDeck, known + 1, 4),
    item_count_typical: known,
    item_count_known: known,
    layout_split: layoutSplits.length > 0,
    layout_splits: layoutSplits,
    layout: component.layout || component.instances?.[0]?.layout || 'row',
    grid: component.instances?.find((instance) => instance.repeat?.grid)?.repeat?.grid || null,
  }
}

export function buildContainerCapacityForInstance(component, instance = null) {
  const base = buildContainerCapacity(component)
  if (!instance) return base

  const known = resolveRepeatItemCount(instance.repeat)
  return {
    ...base,
    item_count_known: known,
    item_count_typical: known,
    item_count_max: Math.max(known + 3, base.item_count_min + 1, 4),
    layout: instance.layout || base.layout,
    grid: instance.repeat?.grid || base.grid,
  }
}

function slotCoord(slot, axis) {
  if (axis === 'x') return slot?.cx_norm ?? slot?.position?.cx_norm ?? 0.5
  return slot?.cy_norm ?? slot?.position?.cy_norm ?? 0.5
}

function splitRowCardGridInstance(instance) {
  const byUnits = splitByRepeatUnits(instance)
  if (byUnits) return byUnits

  const count = resolveRepeatItemCount(instance?.repeat)
  const ids = instance?.element_ids || []
  const slots = instance?.slots || []
  const perItem = ids.length % count === 0
    ? ids.length / count
    : Math.max(1, Math.round(ids.length / count))
  const items = []

  for (let index = 0; index < count; index += 1) {
    const start = index * perItem
    const cellSlots = slots.slice(start, start + perItem)
    items.push({
      index: index + 1,
      element_ids: ids.slice(start, start + perItem),
      slots: cellSlots,
      fields: itemFieldsFromSlots(cellSlots),
    })
  }

  return items
}

function splitPageGridInstance(instance) {
  const grid = instance.repeat?.grid
  const rows = Math.max(1, Number(grid?.rows) || 1)
  const cols = Math.max(1, Number(grid?.cols) || 1)
  const ids = instance.element_ids || []
  const slots = instance.slots || []
  const indexed = ids.map((id, index) => ({
    id,
    slot: slots[index] || null,
    cx: slotCoord(slots[index], 'x'),
    cy: slotCoord(slots[index], 'y'),
  }))
  const perRow = Math.max(1, Math.round(indexed.length / rows))
  const sorted = [...indexed].sort((left, right) => left.cy - right.cy || left.cx - right.cx)
  const items = []

  for (let row = 0; row < rows; row += 1) {
    const rowItems = sorted.slice(row * perRow, (row + 1) * perRow)
    const perCol = Math.max(1, Math.round(rowItems.length / cols))
    const rowSorted = [...rowItems].sort((left, right) => left.cx - right.cx)
    for (let col = 0; col < cols; col += 1) {
      const cell = rowSorted.slice(col * perCol, (col + 1) * perCol)
      if (!cell.length) continue
      const cellSlots = cell.map((entry) => entry.slot).filter(Boolean)
      items.push({
        index: items.length + 1,
        element_ids: cell.map((entry) => entry.id),
        slots: cellSlots,
        fields: itemFieldsFromSlots(cellSlots),
      })
    }
  }

  return items.slice(0, rows * cols)
}

function splitByRepeatUnits(instance) {
  const units = instance?.repeat_units
  if (!units?.length) return null

  const ids = instance?.element_ids || []
  const slots = instance?.slots || []

  return units.map((unit, index) => {
    const unitIds = unit.element_ids || []
    const unitSlots = unitIds.map((id) => slots[ids.indexOf(id)]).filter(Boolean)
    return {
      index: index + 1,
      element_ids: [...unitIds],
      slots: unitSlots,
      fields: itemFieldsFromSlots(unitSlots),
    }
  })
}

function splitHorizontalSeriesGridInstance(instance) {
  const byUnits = splitByRepeatUnits(instance)
  if (byUnits) return byUnits
  return splitRowCardGridInstance(instance)
}

export function splitGridInstanceIntoItems(instance) {
  if (instance?.repeat?.split_mode === 'horizontal_series') return splitHorizontalSeriesGridInstance(instance)
  if (instance?.repeat?.split_mode === 'row_card') return splitRowCardGridInstance(instance)
  return splitPageGridInstance(instance)
}

export function splitInstanceIntoItems(instance) {
  if (instance?.repeat?.grid) return splitGridInstanceIntoItems(instance)

  const count = resolveRepeatItemCount(instance?.repeat)
  const ids = instance?.element_ids || []
  const slots = instance?.slots || []
  const perItem = ids.length % count === 0
    ? ids.length / count
    : Math.max(1, Math.floor(ids.length / count))
  const items = []

  for (let index = 0; index < count; index += 1) {
    const start = index * perItem
    items.push({
      index: index + 1,
      element_ids: ids.slice(start, start + perItem),
      slots: slots.slice(start, start + perItem),
      fields: itemFieldsFromSlots(slots.slice(start, start + perItem)),
    })
  }

  return items
}

export function adaptGridForItemCount(grid, itemCount, splitMode = null) {
  const count = Math.max(1, Number(itemCount) || 1)
  if (splitMode === 'horizontal_series') {
    return { rows: 1, cols: count }
  }
  if (splitMode === 'row_card') {
    return {
      rows: count,
      cols: Math.max(1, Number(grid?.cols) || Number(grid?.card_cols) || 2),
    }
  }
  if (!grid?.cols) return grid || null
  const cols = Math.max(1, Number(grid.cols) || 1)
  return {
    cols,
    rows: Math.max(1, Math.ceil(count / cols)),
  }
}

function resolveModelGrid(sample, capacity) {
  const splitMode = sample?.repeat?.split_mode
  if (splitMode === 'horizontal_series') {
    return {
      rows: 1,
      cols: sample.repeat?.layout_cols || resolveRepeatItemCount(sample.repeat),
    }
  }
  if (splitMode === 'row_card') {
    return {
      rows: sample.repeat?.layout_rows || resolveRepeatItemCount(sample.repeat),
      cols: Math.max(1, Number(sample.repeat?.card_cols) || Number(sample.repeat?.grid?.cols) || 1),
    }
  }
  return sample?.repeat?.grid || capacity.grid
}

export function defaultContainerModel(component, instance = null) {
  const sample = instance || component.instances?.[0] || null
  const capacity = buildContainerCapacityForInstance(component, sample)
  const playgroundInstances = sample ? resolvePlaygroundInstances(component, sample) : []
  const items = playgroundInstances.length
    ? playgroundInstances.flatMap((entry) => splitInstanceIntoItems(entry))
    : (sample ? splitInstanceIntoItems(sample) : [])
  const splitForSlide = sample ? findLayoutSplitForInstance(component, sample) : null
  const itemCount = splitForSlide?.item_count || items.length || capacity.item_count_typical

  return {
    component_id: component.id,
    item_count: itemCount,
    layout: sample?.layout || capacity.layout,
    grid: resolveModelGrid(sample, capacity),
    split_mode: sample?.repeat?.split_mode || null,
    items: items.slice(0, itemCount).map((item, index) => ({
      index: index + 1,
      fields: { ...item.fields },
    })),
    capacity: {
      min: capacity.item_count_min,
      max: capacity.item_count_max,
    },
    layout_split: capacity.layout_split || false,
  }
}

function modelItemHasFieldData(item) {
  return Object.values(item?.fields || {}).some((value) => value != null && String(value).trim() !== '')
}

function templateItemFromModel(model, index) {
  const existing = model.items?.[index]
  if (existing?.fields && modelItemHasFieldData(existing)) return cloneValue(existing.fields)
  const template = (model.items || []).find(modelItemHasFieldData)?.fields
    || model.items?.[0]?.fields
    || {}
  const fields = cloneValue(template)
  Object.keys(fields).forEach((role) => {
    if (/^\d+$/.test(String(fields[role] || '').trim())) {
      fields[role] = String(index + 1)
    }
  })
  return fields
}

export function resizeContainerModel(model, itemCount, component, instance = null) {
  const sample = instance || component.instances?.[0] || null
  const capacity = buildContainerCapacityForInstance(component, sample)
  const nextCount = Math.min(
    capacity.item_count_max,
    Math.max(capacity.item_count_min, Number(itemCount) || capacity.item_count_typical),
  )
  const base = sample ? defaultContainerModel(component, sample) : { ...model }
  const nextGrid = adaptGridForItemCount(model.grid || base.grid, nextCount, model.split_mode || base.split_mode)
  const items = Array.from({ length: nextCount }, (_, index) => ({
    index: index + 1,
    fields: templateItemFromModel({ ...base, ...model }, index),
  }))

  return {
    ...model,
    component_id: component.id,
    item_count: nextCount,
    layout: model.layout || base.layout,
    grid: nextGrid,
    split_mode: model.split_mode || base.split_mode || sample?.repeat?.split_mode || null,
    items,
    capacity: {
      min: capacity.item_count_min,
      max: capacity.item_count_max,
    },
  }
}

export function containerModelToDataPayload(component, instance = null) {
  return defaultContainerModel(component, instance)
}
