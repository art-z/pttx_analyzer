import { detectDeckVgroups, detectSlideVgroups, MIN_GROUP_SIZE } from '../slides/vgroup-detect.js'
import { isGraphicStructuralElement } from '../slides/graphic-region-exclude.js'
import { instancesHaveTextSlots } from './container-catalog.js'
import { detectLayoutSplitsFromInstances, enrichRepeatMeta, findDeepInnerRepeatGroups, hasSameSignaturePeersOnDifferentBands, hasValidRepeatFlexAxis, instancesShareRepeatAxis, normalizeClusterSignature, resolveGridRepeatMeta, resolvePageGridCellSignature, resolveRepeatItemCount, resolveVerticalRepeatContainerBBox, shouldSkipAmbiguousGridRepeat, shouldSkipInconsistentRepeatSlotGeometry, shouldSkipOuterRepeatWithInnerRepeats, shouldSkipRepeatColumnSectionFragment, shouldSkipRepeatRowSegmentFragment } from './repeat-layout-analysis.js'

const REQUIRED_SLOT_RATIO = 0.75
const OPTIONAL_SLOT_RATIO = 0.25

function isGraphicElement(element, excludedIds = null) {
  return isGraphicStructuralElement(element, excludedIds)
}

function median(values) {
  const sorted = values.filter((value) => Number.isFinite(value)).sort((left, right) => left - right)
  if (!sorted.length) return null
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

function maxValue(values) {
  const filtered = values.filter((value) => Number.isFinite(value))
  return filtered.length ? Math.max(...filtered) : null
}

function minValue(values) {
  const filtered = values.filter((value) => Number.isFinite(value))
  return filtered.length ? Math.min(...filtered) : null
}

function roundNorm(value, step = 0.05) {
  if (!Number.isFinite(value)) return null
  return Math.round(value / step) * step
}

function containerFromInstances(instances, pick) {
  const boxes = instances
    .map((instance) => ({
      width_pt: instance.container?.width_pt,
      height_pt: instance.container?.height_pt,
      width_norm: instance.container_norm?.width,
      height_norm: instance.container_norm?.height,
      element_count: instance.slot_count || instance.element_ids?.length || 0,
    }))
    .filter((box) => box.width_pt > 0 && box.height_pt > 0)

  if (!boxes.length) return null

  return {
    width_pt: pick(boxes.map((box) => box.width_pt)),
    height_pt: pick(boxes.map((box) => box.height_pt)),
    width_norm: pick(boxes.map((box) => box.width_norm)),
    height_norm: pick(boxes.map((box) => box.height_norm)),
    element_count: pick(boxes.map((box) => box.element_count)),
  }
}

function clusterSignature(group, slideGroups = []) {
  return normalizeClusterSignature(
    resolvePageGridCellSignature(group, slideGroups)
    || group.repeat?.itemSig
    || group.signature
    || '',
  )
}

function inferRole(element, elements = [], elementIndex = 0, perItem = elements.length || 1) {
  if (element.kind === 'fill') return 'background'
  if (element.kind === 'image') return 'image'
  if (element.kind === 'icon') return 'icon'
  if (element.kind === 'badge') return 'heading'
  if (element.text_role) return element.text_role === 'text' ? 'body' : element.text_role
  if (element.role && element.role !== element.name) return element.role === 'text' ? 'body' : element.role

  if (element.kind === 'text') {
    const itemStart = Math.floor(elementIndex / perItem) * perItem
    const texts = elements.slice(itemStart, itemStart + perItem).filter((item) => item.kind === 'text')
    if (texts.length <= 1) return 'body'
    const sorted = [...texts].sort((left, right) => (
      (right.typography?.size_pt || 0) - (left.typography?.size_pt || 0)
      || String(left.element_id || '').localeCompare(String(right.element_id || ''))
    ))
    const rank = sorted.indexOf(element)
    if (rank === 0) return 'heading'
    if (rank === 1) return 'body'
    return 'body'
  }

  return element.kind || 'field'
}

function slotKey(slot) {
  if (slot?.role) return `${slot.kind || 'field'}:${slot.role}`
  return slot?.slot_id || `${slot?.kind || 'field'}:unknown`
}

function buildSlotsFromElements(elements, containerNorm, repeatCount = 1) {
  const count = Math.max(1, Number(repeatCount) || 1)
  const perItem = Math.max(1, Math.ceil(elements.length / count))

  if (!containerNorm?.width || !containerNorm?.height) {
    return elements.map((element, index) => ({
      slot_id: `slot_${element.kind}_${String((index % perItem) + 1).padStart(2, '0')}`,
      role: inferRole(element, elements, index, perItem),
      kind: element.kind,
      presence_ratio: 1,
      position: { cx_norm: 0.5, cy_norm: 0.5, width_norm: 1, height_norm: 1 },
      text: element.text || element.text_sample || null,
      label: element.text_sample || element.name || null,
      family: element.typography?.family || null,
      size_pt: element.typography?.size_pt || null,
      color: element.typography?.color || null,
    }))
  }

  return elements.map((element, index) => {
    const geometry = element.geometry_norm || {}
    return {
      slot_id: `slot_${element.kind}_${String((index % perItem) + 1).padStart(2, '0')}`,
      role: inferRole(element, elements, index, perItem),
      kind: element.kind,
      presence_ratio: 1,
      position: {
        cx_norm: ((geometry.x || 0) + (geometry.width || 0) / 2 - containerNorm.x) / containerNorm.width,
        cy_norm: ((geometry.y || 0) + (geometry.height || 0) / 2 - containerNorm.y) / containerNorm.height,
        width_norm: (geometry.width || 0) / containerNorm.width,
        height_norm: (geometry.height || 0) / containerNorm.height,
      },
      text: element.text || element.text_sample || null,
      label: element.text_sample || element.name || null,
      family: element.typography?.family || null,
      size_pt: element.typography?.size_pt || null,
      scale_level: element.typography?.scale_level ?? null,
      color: element.typography?.color || null,
    }
  })
}

function aggregateSlots(instances) {
  const counts = new Map()
  for (const instance of instances) {
    for (const slot of instance.slots || []) {
      const key = slotKey(slot)
      if (!counts.has(key)) counts.set(key, { slot, count: 0 })
      counts.get(key).count += 1
    }
  }

  const total = instances.length || 1
  const required = []
  const optional = []
  for (const { slot, count } of counts.values()) {
    const ratio = count / total
    const normalized = {
      slot_id: slot.slot_id,
      role: slot.role,
      kind: slot.kind,
      presence_ratio: ratio,
      position: {
        cx_norm: slot.position?.cx_norm ?? slot.cx_norm ?? 0.5,
        cy_norm: slot.position?.cy_norm ?? slot.cy_norm ?? 0.5,
        width_norm: slot.position?.width_norm ?? slot.width_norm ?? 1,
        height_norm: slot.position?.height_norm ?? slot.height_norm ?? 1,
      },
      typography: {
        dominant_family: slot.family || null,
        dominant_size_pt: slot.size_pt || null,
        dominant_scale_level: slot.scale_level ?? null,
        color: slot.color || null,
      },
      synthetic: Boolean(slot.synthetic),
      source: slot.source || null,
    }
    if (ratio >= REQUIRED_SLOT_RATIO) required.push(normalized)
    else if (ratio >= OPTIONAL_SLOT_RATIO) optional.push(normalized)
  }

  required.sort((left, right) => left.role.localeCompare(right.role, 'ru'))
  optional.sort((left, right) => left.role.localeCompare(right.role, 'ru'))
  return { required, optional }
}

function typicalContainer(instances) {
  return containerFromInstances(instances, median) || {}
}

export function buildContainerBounds(instances) {
  const typical = containerFromInstances(instances, median)
  const max = containerFromInstances(instances, maxValue)
  const min = containerFromInstances(instances, minValue)

  return {
    typical: typical || {},
    max: max || {},
    min: min || {},
  }
}

function variantKey(instance) {
  const optionalRoles = (instance.slots || [])
    .map((slot) => slot.role)
    .sort()
    .join('+')
  return [
    instance.layout || 'single',
    instance.slot_count || 0,
    roundNorm(instance.container_norm?.width),
    roundNorm(instance.container_norm?.height),
    optionalRoles,
  ].join('|')
}

export function buildComponentVariants(instances) {
  const groups = new Map()

  instances.forEach((instance) => {
    const key = variantKey(instance)
    if (!groups.has(key)) {
      groups.set(key, {
        variant_id: null,
        layout: instance.layout || 'single',
        slot_count: instance.slot_count || 0,
        element_count: instance.slot_count || instance.element_ids?.length || 0,
        container: {
          width_pt: instance.container?.width_pt || null,
          height_pt: instance.container?.height_pt || null,
          width_norm: instance.container_norm?.width || null,
          height_norm: instance.container_norm?.height || null,
        },
        instance_count: 0,
        slide_numbers: new Set(),
        instances: [],
      })
    }

    const variant = groups.get(key)
    variant.instance_count += 1
    variant.slide_numbers.add(instance.slide_number)
    variant.instances.push(instance)
    variant.container.width_pt = Math.max(variant.container.width_pt || 0, instance.container?.width_pt || 0)
    variant.container.height_pt = Math.max(variant.container.height_pt || 0, instance.container?.height_pt || 0)
    variant.container.width_norm = Math.max(variant.container.width_norm || 0, instance.container_norm?.width || 0)
    variant.container.height_norm = Math.max(variant.container.height_norm || 0, instance.container_norm?.height || 0)
    variant.element_count = Math.max(variant.element_count, instance.slot_count || 0)
  })

  return [...groups.values()]
    .sort((left, right) => right.instance_count - left.instance_count || right.element_count - left.element_count)
    .map((variant, index) => ({
      ...variant,
      variant_id: `v${String(index + 1).padStart(2, '0')}`,
      slide_numbers: [...variant.slide_numbers].sort((left, right) => left - right),
      instances: undefined,
    }))
}

const TEXT_FIELD_ROLES = new Set(['title', 'subtitle', 'heading', 'body', 'description', 'text', 'content', 'list', 'caption', 'label'])

function isTextSlot(slot) {
  return slot?.kind === 'text' || TEXT_FIELD_ROLES.has(slot?.role)
}

function dominantValue(values) {
  const counts = new Map()
  values.filter(Boolean).forEach((value) => counts.set(value, (counts.get(value) || 0) + 1))
  return [...counts.entries()].sort((left, right) => right[1] - left[1])[0]?.[0] || null
}

export function buildTextFields(instances, slots = { required: [], optional: [] }) {
  const slotDefs = [...(slots.required || []), ...(slots.optional || [])].filter(isTextSlot)
  const fields = []

  for (const slot of slotDefs) {
    const matching = []
    for (const instance of instances) {
      const instanceSlot = (instance.slots || []).find((item) => slotKey(item) === slotKey(slot))
      if (instanceSlot) matching.push(instanceSlot)
    }

    fields.push({
      field_id: slot.slot_id || `field_${slot.role}`,
      role: slot.role,
      required: (slot.presence_ratio || 0) >= REQUIRED_SLOT_RATIO,
      presence_ratio: slot.presence_ratio || 0,
      typography: {
        dominant_family: slot.typography?.dominant_family || null,
        dominant_size_pt: slot.typography?.dominant_size_pt || null,
        dominant_scale_level: slot.typography?.dominant_scale_level ?? null,
        color: slot.typography?.color || null,
      },
      sample_text: dominantValue(matching.map((item) => item.text || item.label).filter(Boolean)),
      instance_count: matching.length,
      synthetic: Boolean(slot.synthetic),
      source: slot.source || undefined,
    })
  }

  for (const instance of instances) {
    for (const slot of instance.slots || []) {
      if (!isTextSlot(slot)) continue
    if (fields.some((field) => field.role === slot.role && field.field_id === (slot.slot_id || `field_${slot.role}`))) continue
      fields.push({
        field_id: slot.slot_id || `field_${slot.role}`,
        role: slot.role,
        required: false,
        presence_ratio: 1 / (instances.length || 1),
        typography: {
          dominant_family: slot.family || null,
          dominant_size_pt: slot.size_pt || null,
          dominant_scale_level: slot.scale_level ?? null,
          color: slot.color || null,
        },
        sample_text: slot.text || slot.label || null,
        instance_count: 1,
        synthetic: Boolean(slot.synthetic),
        source: slot.source || undefined,
      })
    }
  }

  return fields.sort((left, right) => (
    Number(right.required) - Number(left.required)
    || (right.presence_ratio || 0) - (left.presence_ratio || 0)
    || left.role.localeCompare(right.role, 'ru')
  ))
}

export function signatureHasStructuralMedia(signature = '') {
  const sig = normalizeClusterSignature(signature)
    .replace(/t\d+/g, '')
    .replace(/tg\[/g, '')
    .replace(/s\[/g, '')
    .replace(/[\[\],yx]/g, '')
  return /i|c\(\{i\}\)|f|c\(\{f\}\)/.test(sig)
}

export function extractTextScaleLevels(signature = '') {
  const sig = normalizeClusterSignature(signature)
  return [...sig.matchAll(/t(\d+)/g)].map((match) => Number(match[1]))
}

export function isUniformTextContentRepeat(signature = '', instances = []) {
  if (signatureHasStructuralMedia(signature)) return false

  const scales = extractTextScaleLevels(signature)
  if (!scales.length) return false
  if (new Set(scales).size > 1) return false

  const slotSizes = []
  for (const instance of instances) {
    for (const slot of instance.slots || []) {
      if (slot.kind === 'text' && Number.isFinite(slot.size_pt)) {
        slotSizes.push(Math.round(slot.size_pt))
      }
    }
  }
  if (slotSizes.length >= 2 && new Set(slotSizes).size > 1) return false

  return true
}

export function collectRepeatElementIds(report, slideNumber) {
  const slide = (report?.slides?.slides || []).find((item) => item.slide_number === slideNumber)
  if (!slide) return []

  const { groups } = detectSlideVgroups(slide, { report })
  const ids = new Set()

  for (const group of groups || []) {
    if (Number(group.repeat?.count) >= 2 || group.repeat?.grid) {
      (group.elements || []).forEach((element) => {
        if (element?.element_id) ids.add(element.element_id)
      })
    }
  }

  return [...ids]
}

export const MAX_REPEAT_GROUP_DEPTH = 5
const MIN_INNER_REPEAT_DEPTH_DELTA = 3
const MIN_INNER_REPEAT_CLUSTERS = 2
export const MIN_REPEAT_BRANCH_WIDTH_NORM = 0.16

export function vgroupDepth(group) {
  return group?.depth || group?.id?.split('.').length || 1
}

function findGroupById(slideGroups, groupId) {
  return slideGroups.find((group) => group.id === groupId) || null
}

function findParentGroup(group, slideGroups) {
  if (!group?.parentId) return null
  return findGroupById(slideGroups, group.parentId)
}

export function shouldSkipRepeatGridCell(group, slideGroups = []) {
  const parent = findParentGroup(group, slideGroups)
  return Boolean(parent?.repeat?.grid)
}

export function isRepeatInPeripheralBranch(group, slideGroups = []) {
  let current = group

  while (current) {
    const parent = findParentGroup(current, slideGroups)
    if (!parent) break

    if (parent.layout === 'row' || parent.layout === 'column') {
      const siblings = slideGroups.filter((item) => item.parentId === parent.id)
      if (siblings.length >= 2) {
        const host = siblings.find((item) => (
          current.id === item.id || current.id.startsWith(`${item.id}.`)
        ))
        if (host?.bboxNorm?.width) {
          const hostWidth = host.bboxNorm.width
          const maxOtherWidth = Math.max(
            ...siblings.filter((item) => item.id !== host.id).map((item) => item.bboxNorm?.width || 0),
            0,
          )
          const hostArea = hostWidth * (host.bboxNorm.height || 0)
          const otherArea = siblings
            .filter((item) => item.id !== host.id)
            .reduce((sum, item) => sum + (item.bboxNorm?.width || 0) * (item.bboxNorm?.height || 0), 0)
          const totalArea = hostArea + otherArea

          if (hostWidth < MIN_REPEAT_BRANCH_WIDTH_NORM && maxOtherWidth > hostWidth * 2) {
            return true
          }
          if (totalArea > 0 && hostArea / totalArea < 0.18 && hostWidth < MIN_REPEAT_BRANCH_WIDTH_NORM) {
            return true
          }
        }
      }
    }

    current = parent
  }

  return false
}

function buildChildRepeatUnits(group, slideGroups = [], splitMode = null) {
  if (splitMode !== 'horizontal_series' && splitMode !== 'row_card') return null
  const children = slideGroups.filter((item) => item.parentId === group.id)
  if (children.length < 2) return null

  return children.map((child) => ({
    vgroup_id: child.id,
    element_ids: candidateElements(child).map((element) => element.element_id),
  }))
}

export function assessRepeatGroupPlausibility(group, slideGroups = []) {
  const depth = vgroupDepth(group)
  const widthNorm = group?.bboxNorm?.width || 0
  const repeatGridCell = shouldSkipRepeatGridCell(group, slideGroups)
  const tooDeep = depth > MAX_REPEAT_GROUP_DEPTH
  const narrowStrip = depth >= 4 && widthNorm > 0 && widthNorm < MIN_REPEAT_BRANCH_WIDTH_NORM
  const peripheral = isRepeatInPeripheralBranch(group, slideGroups)
  const invalidFlexAxis = !hasValidRepeatFlexAxis(group)
  const pageGridFragment = hasSameSignaturePeersOnDifferentBands(group, slideGroups)
  const nestedInnerRepeat = shouldSkipOuterRepeatWithInnerRepeats(group, slideGroups)
  const ambiguousGridRepeat = shouldSkipAmbiguousGridRepeat(group, slideGroups)
  const rowSegmentFragment = shouldSkipRepeatRowSegmentFragment(group, slideGroups)
  const columnSectionFragment = shouldSkipRepeatColumnSectionFragment(group, slideGroups)
  const inconsistentSlotGeometry = shouldSkipInconsistentRepeatSlotGeometry(group, slideGroups)
  const plausible = !repeatGridCell
    && !tooDeep
    && !narrowStrip
    && !peripheral
    && !invalidFlexAxis
    && !pageGridFragment
    && !nestedInnerRepeat
    && !ambiguousGridRepeat
    && !rowSegmentFragment
    && !columnSectionFragment
    && !inconsistentSlotGeometry

  return {
    plausible,
    depth,
    width_norm: widthNorm,
    checks: {
      repeat_grid_cell: repeatGridCell,
      too_deep: tooDeep,
      narrow_strip: narrowStrip,
      peripheral_branch: peripheral,
      invalid_flex_axis: invalidFlexAxis,
      page_grid_fragment: pageGridFragment,
      nested_inner_repeat: nestedInnerRepeat,
      ambiguous_grid_repeat: ambiguousGridRepeat,
      row_segment_fragment: rowSegmentFragment,
      column_section_fragment: columnSectionFragment,
      inconsistent_slot_geometry: inconsistentSlotGeometry,
    },
    reject_reasons: [
      repeatGridCell ? 'ячейка repeat grid, не самостоятельный компонент' : null,
      tooDeep ? `глубина ${depth} > ${MAX_REPEAT_GROUP_DEPTH}` : null,
      narrowStrip ? `узкая полоса ${Math.round(widthNorm * 100)}% при depth ${depth}` : null,
      peripheral ? 'периферийная ветка рядом с основным контентом' : null,
      invalidFlexAxis ? 'repeat без одной flex-оси row/column' : null,
      pageGridFragment ? 'фрагмент page grid: один signature в разных flex-полосах' : null,
      nestedInnerRepeat ? 'внутри есть вложенные repeat-блоки (component-in-component)' : null,
      ambiguousGridRepeat ? 'grid metadata не совпадает с осью размножения' : null,
      rowSegmentFragment ? 'repeat только в одном сегменте row-ряда, не самостоятельный контейнер' : null,
      columnSectionFragment ? 'repeat-полоса внутри column рядом с page grid, не самостоятельный контейнер' : null,
      inconsistentSlotGeometry ? 'позиции text-слотов между items слишком разные, шаблон не определён' : null,
    ].filter(Boolean),
  }
}

export function groupHasSameSlideRepeat(group) {
  return Number(group?.repeat?.count) >= 2 || Boolean(group?.repeat?.grid)
}

export function instanceHasSameSlideRepeat(instance) {
  return Number(instance?.repeat?.count) >= 2 || Boolean(instance?.repeat?.grid)
}

export function hasSameSlideRepeat(instances = [], layoutSplits = []) {
  if (instances.some((instance) => instanceHasSameSlideRepeat(instance))) return true
  return (layoutSplits || []).some((split) => Number(split.item_count) >= 2)
}

export function assessComponentIterability(instances, signature, layoutSplits = []) {
  const slideNumbers = [...new Set(instances.map((instance) => instance.slide_number))]
  const repeatCounts = instances
    .map((instance) => instance.repeat?.count)
    .filter((value) => Number.isFinite(value) && value >= 2)
  const splitItemCounts = (layoutSplits || [])
    .map((split) => split.item_count)
    .filter((value) => Number.isFinite(value) && value >= 2)
  const hasGrid = instances.some((instance) => instance.repeat?.grid)
  const hasRepeatSeries = instances.some((instance) => Number(instance.repeat?.count) >= 2)
  const hasLayoutSplitRepeat = splitItemCounts.length > 0
  const sameSlideRepeat = hasSameSlideRepeat(instances, layoutSplits)
  const crossSlide = slideNumbers.length >= 2
  const deckRepeat = instances.length >= 2

  let method = 'none'
  if (sameSlideRepeat) {
    if (hasGrid || hasLayoutSplitRepeat) method = 'repeat_grid'
    else if (hasRepeatSeries) method = 'repeat_series'
  }

  const hasText = instancesHaveTextSlots(instances)
  const hasMedia = instances.some((instance) => (
    (instance.slots || []).some((slot) => slot.kind === 'image' || slot.kind === 'icon')
  ))
  const textContentOnly = isUniformTextContentRepeat(signature, instances)
  // A repeatable component must expose editable text. Pure image/icon series are
  // useful layout groups, but they are not content components on their own.
  const isIterable = sameSlideRepeat && hasText && !textContentOnly
  let confidence = 0.35
  if (hasGrid || hasLayoutSplitRepeat) confidence = 0.95
  else if (hasRepeatSeries) confidence = 0.9

  const maxRepeatCount = splitItemCounts.length
    ? Math.max(...splitItemCounts)
    : (repeatCounts.length ? Math.max(...repeatCounts) : null)

  return {
    is_iterable: isIterable,
    method,
    confidence,
    instance_count: instances.length,
    slide_count: slideNumbers.length,
    slide_numbers: slideNumbers.sort((left, right) => left - right),
    max_repeat_count: maxRepeatCount,
    layout_split_count: layoutSplits.length,
    min_instances_required: 2,
    signature,
    checks: {
      same_slide_repeat: sameSlideRepeat,
      deck_repeat: deckRepeat,
      cross_slide: crossSlide,
      repeat_series: hasRepeatSeries,
      repeat_grid: hasGrid || hasLayoutSplitRepeat,
      layout_split: layoutSplits.length > 0,
      has_text: hasText,
      has_media: hasMedia,
      text_content_only: textContentOnly,
    },
  }
}

function humanNameFromSignature(signature, layout) {
  const sig = String(signature || '')
  const hasImage = sig.includes('i{') || sig.includes('[i]') || sig.includes(',i')
  const hasFill = sig.includes('f{') || sig.includes('[f]') || sig.includes(',f')
  const hasText = /t\d+|s\[/.test(sig)
  const prefix = ({
    grid: 'GRID',
    row: 'ROW',
    column: 'COL',
    container: 'CARD',
  })[layout] || 'BLOCK'

  if (hasImage && hasText) return `${prefix}_MEDIA`
  if (hasFill && hasText) return `${prefix}_FILLED`
  if (hasText && hasFill) return `${prefix}_FILLED`
  if (hasText) return `${prefix}_TEXT`
  if (hasImage) return `${prefix}_IMAGE`
  return `${prefix}_ITEM`
}

function candidateElements(group) {
  return (group.elements || []).filter((element) => element?.element_id && !isGraphicElement(element))
}

function buildRepeatGridCoverage(slideResult) {
  const elementToGrid = new Map()
  const gridGroupIds = new Set()

  for (const group of slideResult.groups || []) {
    if (!group.repeat?.itemSig) continue
    gridGroupIds.add(group.id)
    candidateElements(group).forEach((element) => {
      elementToGrid.set(element.element_id, group.id)
    })
  }

  return { elementToGrid, gridGroupIds }
}

function isCandidateGroup(group, slideTitleIds) {
  if ((group.elementCount || 0) < MIN_GROUP_SIZE) return false

  const elements = candidateElements(group)
  if (elements.length < MIN_GROUP_SIZE) return false

  if (slideTitleIds?.size && elements.every((element) => slideTitleIds.has(element.element_id))) {
    return false
  }

  return true
}

function isDescendantGroupId(groupId, ancestorId) {
  return String(groupId).startsWith(`${ancestorId}.`)
}

function splitTopLevelCommaParts(inner) {
  const parts = []
  let depth = 0
  let start = 0
  for (let index = 0; index < inner.length; index += 1) {
    const char = inner[index]
    if (char === '[') depth += 1
    else if (char === ']') depth -= 1
    else if (char === ',' && depth === 0) {
      parts.push(inner.slice(start, index))
      start = index + 1
    }
  }
  parts.push(inner.slice(start))
  return parts.filter((part) => part.length > 0)
}

function parseUniformLayoutWrapper(signature) {
  const normalized = normalizeClusterSignature(signature)
  const match = normalized.match(/^([xy])\[(.+)\]$/)
  if (!match) return null
  const parts = splitTopLevelCommaParts(match[2]).map(normalizeClusterSignature)
  if (parts.length < 2) return null
  return { axis: match[1], parts }
}

export function isUniformLayoutWrapper(parentItemSig, childItemSig) {
  const wrapper = parseUniformLayoutWrapper(parentItemSig)
  if (!wrapper) return false
  const child = normalizeClusterSignature(childItemSig)
  return wrapper.parts.every((part) => part === child)
}

function shouldSkipLayoutWrapperRepeatGroup(group, slideGroups = []) {
  const itemSig = group.repeat?.itemSig
  if (!itemSig || Number(group.repeat?.count) < 2) return false
  if (resolveGridRepeatMeta(group, slideGroups).splitMode === 'page_grid') return false

  const childItemSigs = []
  for (const other of slideGroups) {
    if (other.id === group.id) continue
    if (!isDescendantGroupId(other.id, group.id)) continue
    const depthDelta = other.id.split('.').length - group.id.split('.').length
    if (depthDelta !== 1) continue
    if (!other.repeat?.itemSig || Number(other.repeat?.count) < 2) continue
    childItemSigs.push(normalizeClusterSignature(other.repeat.itemSig))
  }

  if (!childItemSigs.length) return false
  const uniqueChildSigs = [...new Set(childItemSigs)]
  if (uniqueChildSigs.length !== 1) return false
  return isUniformLayoutWrapper(itemSig, uniqueChildSigs[0])
}

function isNestedInRepeatParent(group, slideGroups = []) {
  if (!group.repeat?.itemSig) return false
  const elementIds = new Set(candidateElements(group).map((element) => element.element_id))
  if (!elementIds.size) return false

  for (const parent of slideGroups) {
    if (parent.id === group.id) continue
    if (!Number(parent.repeat?.count) || parent.repeat.count < 2) continue
    if (!isDescendantGroupId(group.id, parent.id)) continue
    const depthDelta = group.id.split('.').length - parent.id.split('.').length
    if (depthDelta <= 1) continue
    const parentIds = new Set(candidateElements(parent).map((element) => element.element_id))
    if (parentIds.size <= elementIds.size) continue
    if ([...elementIds].every((id) => parentIds.has(id))) return true
  }
  return false
}

function shouldSkipNestedRepeatItem(group, coverage, slideGroups = []) {
  if (isNestedInRepeatParent(group, slideGroups)) return true
  if (group.repeat?.itemSig) return false
  const elements = candidateElements(group)
  if (!elements.length) return false
  if (coverage.gridGroupIds.has(group.id)) return false
  return elements.every((element) => coverage.elementToGrid.has(element.element_id))
}

function dedupeSlideInstances(instances) {
  const picked = []

  for (const instance of instances) {
    const ids = new Set(instance.element_ids || [])
    let dominated = false

    for (let index = picked.length - 1; index >= 0; index -= 1) {
      const pickedIds = new Set(picked[index].element_ids || [])
      const instanceInsidePicked = [...ids].every((id) => pickedIds.has(id))
      const pickedInsideInstance = [...pickedIds].every((id) => ids.has(id))

      if (instanceInsidePicked && ids.size < pickedIds.size) {
        dominated = true
        break
      }
      if (pickedInsideInstance && pickedIds.size > ids.size) {
        picked.splice(index, 1)
      }
    }

    if (!dominated) picked.push(instance)
  }

  return picked
}

function meetsComponentInstanceThreshold(dedupedItems) {
  return dedupedItems.some((item) => groupHasSameSlideRepeat(item.group))
}

function buildInstance(group, slideNumber, groupIndex, slideGroups = [], slide = null) {
  const repeat = enrichRepeatMeta(group.repeat, group, slideGroups)
  const itemCount = resolveRepeatItemCount(repeat)
  const repeatUnits = buildChildRepeatUnits(group, slideGroups, repeat?.split_mode)
  const elements = (group.elements || []).filter((element) => element?.element_id && !isGraphicElement(element))
  const containerFallback = resolveVerticalRepeatContainerBBox(group, slideGroups, slide)
  const containerNorm = containerFallback?.bboxNorm || group.bboxNorm
  const slots = buildSlotsFromElements(elements, containerNorm, itemCount).map((slot) => ({
    ...slot,
    cx_norm: slot.position?.cx_norm ?? slot.cx_norm,
    cy_norm: slot.position?.cy_norm ?? slot.cy_norm,
    width_norm: slot.position?.width_norm ?? slot.width_norm,
    height_norm: slot.position?.height_norm ?? slot.height_norm,
  }))

  return {
    slide_number: slideNumber,
    layout: group.layout,
    group_index: groupIndex,
    vgroup_id: group.id,
    vgroup_depth: vgroupDepth(group),
    container: containerFallback?.bboxPt || (group.bboxPt ? { ...group.bboxPt } : null),
    container_norm: containerNorm ? { ...containerNorm } : null,
    element_ids: elements.map((element) => element.element_id),
    signature: group.signature,
    repeat,
    repeat_units: repeatUnits,
    align_cross: group.alignCross || null,
    slot_count: slots.length,
    slots,
  }
}

function collectCandidates(deck) {
  const candidates = []

  deck.perSlide.forEach((slideResult) => {
    const slideTitleIds = new Set(slideResult.slideTitle?.elementIds || [])
    const coverage = buildRepeatGridCoverage(slideResult)
    const counters = new Map()

    slideResult.groups.forEach((group) => {
      if (!isCandidateGroup(group, slideTitleIds)) return
      if (!groupHasSameSlideRepeat(group)) return
      if (shouldSkipRepeatGridCell(group, slideResult.groups)) return
      const plausibility = assessRepeatGroupPlausibility(group, slideResult.groups)
      if (!plausibility.plausible) return
      if (shouldSkipNestedRepeatItem(group, coverage, slideResult.groups)) return
      if (shouldSkipLayoutWrapperRepeatGroup(group, slideResult.groups)) return
      const signature = clusterSignature(group, slideResult.groups)
      if (!signature) return

      const groupIndex = (counters.get(signature) || 0) + 1
      counters.set(signature, groupIndex)

      candidates.push({
        signature,
        group,
        slideNumber: slideResult.slideNumber,
        groupIndex,
      })
    })
  })

  return candidates
}

function clusterCandidates(candidates) {
  const clusters = new Map()

  candidates.forEach((candidate) => {
    const key = candidate.signature
    if (!clusters.has(key)) clusters.set(key, [])
    clusters.get(key).push(candidate)
  })

  return clusters
}

function mergePlausibilityIntoIterability(iterability, rawInstances, instances, deck) {
  const summaries = rawInstances.map((item) => {
    const slide = deck?.perSlide?.find((entry) => entry.slideNumber === item.slideNumber)
    return assessRepeatGroupPlausibility(item.group, slide?.groups || [])
  })
  const shareAxis = instancesShareRepeatAxis(instances)
  const plausible = summaries.every((item) => item.plausible) && shareAxis
  const checks = {
    ...iterability.checks,
    repeat_grid_cell: summaries.some((item) => item.checks.repeat_grid_cell),
    too_deep: summaries.some((item) => item.checks.too_deep),
    narrow_strip: summaries.some((item) => item.checks.narrow_strip),
    peripheral_branch: summaries.some((item) => item.checks.peripheral_branch),
    invalid_flex_axis: summaries.some((item) => item.checks.invalid_flex_axis),
    page_grid_fragment: summaries.some((item) => item.checks.page_grid_fragment),
    nested_inner_repeat: summaries.some((item) => item.checks.nested_inner_repeat),
    ambiguous_grid_repeat: summaries.some((item) => item.checks.ambiguous_grid_repeat),
    row_segment_fragment: summaries.some((item) => item.checks.row_segment_fragment),
    column_section_fragment: summaries.some((item) => item.checks.column_section_fragment),
    inconsistent_slot_geometry: summaries.some((item) => item.checks.inconsistent_slot_geometry),
    split_axis_mismatch: !shareAxis,
  }

  return {
    ...iterability,
    is_iterable: iterability.is_iterable && plausible,
    checks,
    reject_reasons: [
      ...new Set([
        ...summaries.flatMap((item) => item.reject_reasons),
        ...(shareAxis ? [] : ['layout split не лежит на одной flex-оси']),
      ]),
    ],
  }
}

function buildComponentDefinition(signature, rawInstances, index, deck, report = null) {
  const instances = rawInstances.map((item) => {
    const slideEntry = deck?.perSlide?.find((entry) => entry.slideNumber === item.slideNumber)
    const slide = report?.slides?.slides?.find((entry) => entry.slide_number === item.slideNumber)
    return buildInstance(item.group, item.slideNumber, item.groupIndex, slideEntry?.groups || [], slide)
  })
  const layoutCounts = {}
  instances.forEach((instance) => {
    layoutCounts[instance.layout] = (layoutCounts[instance.layout] || 0) + 1
  })
  const layout = Object.entries(layoutCounts).sort((left, right) => right[1] - left[1])[0]?.[0] || 'single'
  const slideNumbers = [...new Set(instances.map((instance) => instance.slide_number))].sort((left, right) => left - right)
  const name = humanNameFromSignature(signature, layout)
  const containerBounds = buildContainerBounds(instances)
  const slots = aggregateSlots(instances)
  const variants = buildComponentVariants(instances)
  const textFields = buildTextFields(instances, slots)
  const layoutSplits = detectLayoutSplitsFromInstances(instances, signature)
  const iterability = mergePlausibilityIntoIterability(
    assessComponentIterability(instances, signature, layoutSplits),
    rawInstances,
    instances,
    deck,
  )

  return {
    component_id: `vg_${String(index + 1).padStart(3, '0')}`,
    name,
    label: name,
    source: 'vgroups',
    container: containerBounds.typical,
    container_bounds: containerBounds,
    container_max: containerBounds.max,
    layout,
    layout_counts: layoutCounts,
    slots,
    text_fields: textFields,
    iterability,
    variants,
    frequency: {
      instance_count: instances.length,
      slide_count: slideNumbers.length,
      slide_numbers: slideNumbers,
    },
    instances,
    variant_signature: signature,
    signature,
    repeat_item_sig: instances.find((instance) => instance.repeat?.itemSig)?.repeat?.itemSig || null,
    layout_splits: layoutSplits,
  }
}

export function detectComponentsFromVgroups(report, deck = null) {
  const resolvedDeck = deck || detectDeckVgroups(report?.slides, report)
  const candidates = collectCandidates(resolvedDeck)
  const clusters = clusterCandidates(candidates)

  const components = []
  let index = 0

  for (const [signature, clusterItems] of [...clusters.entries()].sort((left, right) => right[1].length - left[1].length)) {
    const bySlide = new Map()
    clusterItems.forEach((item) => {
      if (!bySlide.has(item.slideNumber)) bySlide.set(item.slideNumber, [])
      bySlide.get(item.slideNumber).push(item)
    })

    const dedupedItems = []
    bySlide.forEach((slideItems) => {
      const slideInstances = slideItems.map((item) => ({
        element_ids: (item.group.elements || [])
          .filter((element) => element?.element_id && !isGraphicElement(element))
          .map((element) => element.element_id),
        group: item.group,
        slideNumber: item.slideNumber,
        groupIndex: item.groupIndex,
      }))
      const kept = dedupeSlideInstances(slideInstances)
      kept.forEach((instance) => {
        dedupedItems.push({
          group: instance.group,
          slideNumber: instance.slideNumber,
          groupIndex: instance.groupIndex,
        })
      })
    })

    if (!meetsComponentInstanceThreshold(dedupedItems)) continue
    components.push(buildComponentDefinition(signature, dedupedItems, index, resolvedDeck, report))
    index += 1
  }

  const instanceCount = components.reduce((sum, component) => sum + (component.frequency?.instance_count || 0), 0)

  return {
    components,
    summary: {
      component_count: components.length,
      instance_count: instanceCount,
      slide_count: resolvedDeck.summary?.slideCount || 0,
      source: 'vgroups',
    },
    deck: resolvedDeck,
  }
}
