import { detectSlideVgroups } from './vgroup-detect.js'
import { detectSlideSingletons, SINGLETON_PATTERNS } from './singleton-detect.js'
import { findSlideTitleElements } from './slide-title-detect.js'
import { listAllComponents } from '../components/catalog.js'
import { isIterableRepeatComponent } from '../components/container-catalog.js'

export const METRIC_PATTERNS = {
  hero: 'metric_hero',
  repeat: 'metric_repeat',
  combo: 'metric_combo',
  split: 'metric_split',
}

export const METRIC_PATTERN_LABELS = {
  metric_hero: 'KPI-карточка',
  metric_repeat: 'Ряд KPI',
  metric_combo: 'Hero + ряд KPI',
  metric_split: 'KPI + вторичный блок',
}

const MIN_VALUE_SIZE_PT = 28
const MIN_VALUE_CAPTION_RATIO = 1.55
const TITLE_ZONE_MAX_Y = 0.14

function elementText(element) {
  return String(element?.text || element?.text_sample || '').trim()
}

function typographySize(element) {
  return element?.typography?.size_pt || 0
}

function sortTextBySize(elements) {
  return [...elements].sort((left, right) => (
    typographySize(right) - typographySize(left)
    || String(left.element_id || '').localeCompare(String(right.element_id || ''))
  ))
}

function metricValueStrength(element) {
  if (element?.metric?.value != null) return element.metric.unit ? 4 : 2
  const text = elementText(element)
  const line = String(text || '').trim().split('\n')[0]
  if (!line) return 0
  if (/^[\d\s.,+\-/]+(%|°|℃|℉|‰|[₽$€£]|[×xX]|×)$/.test(line)) return 3
  if (/^[\d\s.,+\-/]+[A-Za-z\u0400-\u04FF]{1,6}$/.test(line)) return 3
  if (/^\d{4}$/.test(line) && Number(line) >= 1900 && Number(line) <= 2099) return 0
  if (typographySize(element) >= MIN_VALUE_SIZE_PT && /^[\d\s.,+\-/]+$/.test(line)) return 2
  return 0
}

function looksLikeMetricValue(element) {
  return metricValueStrength(element) > 0
}

function metricUnit(element) {
  const structured = String(element?.metric?.unit || '').trim()
  if (structured) return structured
  const line = elementText(element).split('\n')[0].trim()
  const suffix = line.match(/^[\d\s.,+\-/]+\s*(%|°|℃|℉|‰|[₽$€£]|[×xX]|[A-Za-z\u0400-\u04FF]{1,6})$/u)
  if (suffix) return suffix[1]
  const prefix = line.match(/^([₽$€£])\s*[\d\s.,+\-/]+$/u)
  return prefix?.[1] || ''
}

function elementCenter(element, axis) {
  const geometry = element?.geometry_norm || {}
  const start = Number(geometry[axis]) || 0
  const size = Number(geometry[axis === 'x' ? 'width' : 'height']) || 0
  return start + size / 2
}

function captionAffinity(valueEl, captionEl) {
  if (!elementText(captionEl) || captionEl.element_id === valueEl.element_id) return -Infinity
  if (metricValueStrength(captionEl) >= 3) return -Infinity

  let score = 0
  if (valueEl.text_group_id && valueEl.text_group_id === captionEl.text_group_id) score += 100

  const valueGeometry = valueEl.geometry_norm || {}
  const captionGeometry = captionEl.geometry_norm || {}
  const dx = Math.abs(elementCenter(valueEl, 'x') - elementCenter(captionEl, 'x'))
  const dy = (captionGeometry.y || 0) - ((valueGeometry.y || 0) + (valueGeometry.height || 0))
  score -= dx * 20
  score -= Math.abs(dy) * 12
  if (dy >= -0.02 && dy <= 0.12) score += 12
  if (typographySize(captionEl) <= typographySize(valueEl)) score += 4
  return score
}

export function extractMetricPair(textElements) {
  const texts = sortTextBySize((textElements || []).filter((element) => element.kind === 'text'))
  if (!texts.length) return null

  const valueEl = [...texts].sort((left, right) => (
    metricValueStrength(right) - metricValueStrength(left)
    || typographySize(right) - typographySize(left)
    || String(left.element_id || '').localeCompare(String(right.element_id || ''))
  ))[0]
  if (!looksLikeMetricValue(valueEl)) return null

  const captionEl = texts
    .filter((element) => element.element_id !== valueEl.element_id)
    .sort((left, right) => (
      captionAffinity(valueEl, right) - captionAffinity(valueEl, left)
      || typographySize(right) - typographySize(left)
    ))[0] || null

  if (!captionEl || captionAffinity(valueEl, captionEl) === -Infinity) return null

  const valueSize = typographySize(valueEl)
  const captionSize = typographySize(captionEl)
  const hasSemanticSignal = Boolean(valueEl.metric || (
    valueEl.text_group_id && valueEl.text_group_id === captionEl.text_group_id
  ))
  if (!hasSemanticSignal && valueSize / Math.max(captionSize, 1) < MIN_VALUE_CAPTION_RATIO) return null

  return {
    valueElementId: valueEl.element_id,
    captionElementId: captionEl.element_id,
    valueRole: 'heading',
    captionRole: 'body',
    unitPresent: Boolean(metricUnit(valueEl)),
    unitSample: metricUnit(valueEl) || null,
  }
}

function buildLayoutBase(slide, pattern, {
  vgroupId = null,
  elementIds = [],
  containerNorm = null,
  itemCapacity = 1,
  detectionMethod = null,
  repeatComponentId = null,
  repeatInstance = null,
  secondary = null,
  hero = null,
  repeat = null,
  metricSlots = null,
  expandableCapacity = null,
  layoutDirection = null,
} = {}) {
  const unitSignals = (metricSlots || (hero ? [hero] : []))
    .map((slot) => slot?.pair?.unitPresent)
    .filter((value) => value != null)
  const unitMode = unitSignals.length && unitSignals.every(Boolean)
    ? 'explicit'
    : unitSignals.some(Boolean) ? 'mixed' : 'none'
  return {
    pattern,
    slide_number: slide.slide_number,
    template_id: slide.template_id || null,
    vgroup_id: vgroupId,
    element_ids: [...elementIds],
    container_norm: containerNorm ? { ...containerNorm } : null,
    item_capacity: itemCapacity,
    capacity_visible: itemCapacity,
    capacity_expandable: expandableCapacity ?? itemCapacity,
    detection_method: detectionMethod,
    repeat_component_id: repeatComponentId,
    repeat_instance: repeatInstance,
    secondary_region: secondary,
    hero_region: hero,
    repeat_region: repeat,
    metric_slots: metricSlots,
    layout_direction: layoutDirection,
    unit_mode: unitMode,
    has_units: unitMode !== 'none',
    label: METRIC_PATTERN_LABELS[pattern] || pattern,
  }
}

function buildHeroRegion(group, pair, elementIds) {
  return {
    vgroup_id: group.id,
    element_ids: elementIds,
    pair,
    container_norm: group.bboxNorm ? { ...group.bboxNorm } : null,
  }
}

function isTitleLikeGroup(group, titleElementIds) {
  const texts = (group.elements || []).filter((element) => element.kind === 'text')
  if (texts.some((element) => titleElementIds.has(element.element_id))) return true
  if ((group.bboxNorm?.y ?? 1) >= TITLE_ZONE_MAX_Y) return false
  if (texts.length === 1 && typographySize(texts[0]) <= 28) return true
  return false
}

function groupHasMetricPair(group, titleElementIds) {
  const metricTexts = (group.elements || []).filter((element) => (
    element.kind === 'text' && !titleElementIds.has(element.element_id)
  ))
  return Boolean(extractMetricPair(metricTexts))
}

function detectMetricHeroInGroup(slide, group, titleElementIds, groups = []) {
  if (!group || isTitleLikeGroup(group, titleElementIds)) return null

  const allowedLayouts = new Set(['column', 'stack', 'single', 'row'])
  if (!allowedLayouts.has(group.layout)) return null

  if (group.layout === 'row') {
    const childGroups = groups.filter((item) => item.parentId === group.id)
    if (childGroups.some((child) => groupHasMetricPair(child, titleElementIds))) return null
  }

  const metricTexts = (group.elements || []).filter((element) => (
    element.kind === 'text' && !titleElementIds.has(element.element_id)
  ))
  const pair = extractMetricPair(metricTexts)
  if (!pair) return null

  // Row-labeled groups are KPI columns only when they contain a value/caption pair.
  if (group.layout === 'row' && !pair.captionElementId) return null

  const metricElementIds = [pair.valueElementId, pair.captionElementId].filter(Boolean)
  const pairElements = metricTexts.filter((element) => metricElementIds.includes(element.element_id))
  const pairBox = unionElementNorm(pairElements) || group.bboxNorm
  const hero = buildHeroRegion({ ...group, bboxNorm: pairBox }, pair, metricElementIds)

  return buildLayoutBase(slide, METRIC_PATTERNS.hero, {
    vgroupId: group.id,
    elementIds: metricElementIds,
    containerNorm: pairBox,
    itemCapacity: 1,
    detectionMethod: 'vgroup_metric_column',
    hero,
    metricSlots: [hero],
  })
}

function normalizeHeroLayout(slide, singleton) {
  const texts = singleton.element_ids
    .map((id) => (slide.content_elements || []).find((element) => element.element_id === id))
    .filter(Boolean)
  const pair = extractMetricPair(texts.filter((element) => element.kind === 'text'))
  const hero = buildHeroRegion(
    { id: singleton.vgroup_id, bboxNorm: singleton.container_norm },
    pair,
    [pair?.valueElementId, pair?.captionElementId].filter(Boolean),
  )

  if (!pair?.valueElementId || !pair?.captionElementId) return null

  return buildLayoutBase(slide, METRIC_PATTERNS.hero, {
    vgroupId: singleton.vgroup_id,
    elementIds: hero.element_ids,
    containerNorm: unionElementNorm(texts.filter((element) => hero.element_ids.includes(element.element_id)))
      || singleton.container_norm,
    itemCapacity: 1,
    detectionMethod: singleton.detection_method,
    hero,
    metricSlots: [hero],
  })
}

function findRepeatComponentForGroup(report, slideNumber, vgroupId) {
  const components = listAllComponents(report, { skipMetrics: true }).filter((component) => isIterableRepeatComponent(component))
  for (const component of components) {
    const instance = (component.instances || []).find((item) => (
      item.slide_number === slideNumber && item.vgroup_id === vgroupId
    ))
    if (instance) return { component, instance }
  }
  return null
}

function partitionRepeatTexts(group, textElements, repeatCount) {
  const axis = group.partition?.axis === 'y' ? 'y' : 'x'
  const sorted = [...textElements].sort((left, right) => (
    elementCenter(left, axis) - elementCenter(right, axis)
    || elementCenter(left, axis === 'x' ? 'y' : 'x') - elementCenter(right, axis === 'x' ? 'y' : 'x')
    || String(left.element_id || '').localeCompare(String(right.element_id || ''))
  ))
  const baseSize = Math.floor(sorted.length / repeatCount)
  const remainder = sorted.length % repeatCount
  const slots = []
  let offset = 0

  for (let index = 0; index < repeatCount; index += 1) {
    const size = baseSize + (index < remainder ? 1 : 0)
    slots.push(sorted.slice(offset, offset + size))
    offset += size
  }
  return slots
}

function detectMetricRepeatFromVgroupRepeat(slide, group, report) {
  const repeatCount = Number(group.repeat?.count) || 0
  if (repeatCount < 2) return null

  const elements = group.elements || []
  const textElements = elements.filter((element) => element.kind === 'text')
  if (textElements.length < repeatCount * 2) return null

  const textSlots = partitionRepeatTexts(group, textElements, repeatCount)
  let validItems = 0
  for (const slice of textSlots) {
    if (extractMetricPair(slice)) validItems += 1
  }
  if (validItems < 2) return null

  const resolved = findRepeatComponentForGroup(report, slide.slide_number, group.id)
  const slots = []
  for (let index = 0; index < repeatCount; index += 1) {
    const slice = textSlots[index] || []
    const pair = extractMetricPair(slice)
    if (!pair) continue
    const pairIds = [pair.valueElementId, pair.captionElementId].filter(Boolean)
    const pairElements = slice.filter((element) => pairIds.includes(element.element_id))
    slots.push(buildHeroRegion(
      { id: `${group.id}#${index + 1}`, bboxNorm: unionElementNorm(pairElements) || group.bboxNorm },
      pair,
      pairIds,
    ))
  }

  return buildLayoutBase(slide, METRIC_PATTERNS.repeat, {
    vgroupId: group.id,
    elementIds: elements.map((element) => element.element_id),
    containerNorm: group.bboxNorm,
    itemCapacity: slots.length,
    detectionMethod: 'vgroup_metric_repeat',
    repeatComponentId: resolved?.component?.id || null,
    repeatInstance: resolved?.instance || null,
    metricSlots: slots,
    layoutDirection: group.partition?.axis === 'y' || group.layout === 'column' ? 'column' : 'row',
    repeat: {
      vgroup_id: group.id,
      element_ids: elements.map((element) => element.element_id),
      repeat_count: repeatCount,
    },
  })
}

function detectMetricFlexRow(slide, groups, titleElementIds, report) {
  const layouts = []

  for (const parent of groups) {
    if (parent.layout !== 'row') continue

    const children = groups.filter((group) => group.parentId === parent.id)
    const heroLayouts = children
      .map((child) => detectMetricHeroInGroup(slide, child, titleElementIds, groups))
      .filter(Boolean)

    if (heroLayouts.length < 2) continue

    const slots = heroLayouts.map((layout) => layout.hero_region)
    const resolved = findRepeatComponentForGroup(report, slide.slide_number, parent.id)
      || children.map((child) => findRepeatComponentForGroup(report, slide.slide_number, child.id))
        .find(Boolean)

    layouts.push(buildLayoutBase(slide, METRIC_PATTERNS.repeat, {
      vgroupId: parent.id,
      elementIds: slots.flatMap((slot) => slot.element_ids || []),
      containerNorm: parent.bboxNorm,
      itemCapacity: slots.length,
      detectionMethod: 'vgroup_metric_flex_row',
      repeatComponentId: resolved?.component?.id || null,
      repeatInstance: resolved?.instance || null,
      metricSlots: slots,
      layoutDirection: 'row',
    }))
  }

  return layouts
}

function unionElementNorm(elements) {
  const items = (elements || []).filter((element) => element?.geometry_norm?.width)
  if (!items.length) return null
  const x = Math.min(...items.map((element) => element.geometry_norm.x || 0))
  const y = Math.min(...items.map((element) => element.geometry_norm.y || 0))
  const right = Math.max(...items.map((element) => (
    (element.geometry_norm.x || 0) + (element.geometry_norm.width || 0)
  )))
  const bottom = Math.max(...items.map((element) => (
    (element.geometry_norm.y || 0) + (element.geometry_norm.height || 0)
  )))
  return {
    x,
    y,
    width: right - x,
    height: bottom - y,
  }
}

function findRowParentGroup(groups, heroVgroupId) {
  const heroGroup = groups.find((group) => group.id === heroVgroupId)
  if (!heroGroup?.parentId) return null
  const parent = groups.find((group) => group.id === heroGroup.parentId)
  return parent?.layout === 'row' ? parent : null
}

function collectSiblingElementIds(groups, rowParent, heroVgroupId) {
  if (!rowParent) return new Set()
  return new Set(
    groups
      .filter((group) => group.parentId === rowParent.id && group.id !== heroVgroupId)
      .flatMap((group) => (group.elements || []).map((element) => element.element_id)),
  )
}

function findSlideSecondaryRegion(slide, heroLayout, titleElementIds, groups = []) {
  const heroBox = heroLayout.container_norm
    || heroLayout.hero_region?.container_norm
    || null
  if (!heroBox) return null

  const rowParent = findRowParentGroup(groups, heroLayout.vgroup_id)
  const overlapBox = rowParent?.bboxNorm || heroBox
  const heroRight = (heroBox.x || 0) + (heroBox.width || 0) * 0.85
  const heroElementIds = new Set(heroLayout.element_ids || heroLayout.hero_region?.element_ids || [])
  const siblingElementIds = collectSiblingElementIds(groups, rowParent, heroLayout.vgroup_id)
  const groupedElementIds = new Set(
    groups.flatMap((group) => (group.elements || []).map((element) => element.element_id)),
  )

  const secondaryElements = (slide.content_elements || []).filter((element) => {
    if (titleElementIds.has(element.element_id)) return false
    if (heroElementIds.has(element.element_id)) return false
    if (siblingElementIds.has(element.element_id)) return false

    const x = element.geometry_norm?.x ?? 0
    const y = element.geometry_norm?.y ?? 0
    const bottom = y + (element.geometry_norm?.height || 0)
    const overlapTop = (overlapBox.y || 0) - 0.05
    const overlapBottom = (overlapBox.y || 0) + (overlapBox.height || 0) + 0.05
    if (bottom < overlapTop || y > overlapBottom) return false

    if (element.kind === 'table' || String(element.element_id || '').includes('inferred_table')) {
      return x >= heroRight - 0.08
    }

    if (element.kind === 'image' && x >= heroRight - 0.08) {
      return !groupedElementIds.has(element.element_id)
        || !groups.some((group) => (
          group.parentId === rowParent?.id
          && (group.elements || []).some((item) => item.element_id === element.element_id)
        ))
    }

    return false
  })

  if (!secondaryElements.length) return null

  const secondaryBox = unionElementNorm(secondaryElements)
  const heroWidth = Math.max(heroBox.width || 0.2, 0.15)
  const secondaryWidth = secondaryBox?.width || 0
  const expandableExtra = Math.max(1, Math.floor(secondaryWidth / heroWidth))

  return {
    element_ids: secondaryElements.map((element) => element.element_id),
    kind: secondaryElements.some((element) => (
      element.kind === 'table' || String(element.element_id || '').includes('inferred_table')
    )) ? 'pseudo_table' : 'media',
    container_norm: secondaryBox,
    expandable_extra: expandableExtra,
  }
}

function heroBelongsToFlexRow(layout, flexRowLayouts) {
  return flexRowLayouts.some((flexRow) => (
    flexRow.vgroup_id === layout.vgroup_id
    || (flexRow.metric_slots || []).some((slot) => slot.vgroup_id === layout.vgroup_id)
  ))
}

function detectMetricSplitLayouts(slide, heroLayouts, titleElementIds, groups = [], flexRowLayouts = []) {
  const splits = []

  for (const heroLayout of heroLayouts.filter((layout) => layout.pattern === METRIC_PATTERNS.hero)) {
    if (heroBelongsToFlexRow(heroLayout, flexRowLayouts)) continue

    const secondary = findSlideSecondaryRegion(slide, heroLayout, titleElementIds, groups)
    if (!secondary) continue

    const expandable = 1 + (secondary.expandable_extra || 1)

    splits.push(buildLayoutBase(slide, METRIC_PATTERNS.split, {
      vgroupId: heroLayout.vgroup_id,
      elementIds: [
        ...(heroLayout.element_ids || []),
        ...secondary.element_ids,
      ],
      containerNorm: heroLayout.container_norm,
      itemCapacity: 1,
      expandableCapacity: Math.min(expandable, 4),
      detectionMethod: secondary.kind === 'pseudo_table' ? 'metric_split_pseudo_table' : 'metric_split_media',
      hero: heroLayout.hero_region,
      metricSlots: heroLayout.metric_slots,
      secondary,
    }))
  }

  return splits
}

function detectMetricComboLayouts(slide, layouts) {
  const hero = layouts.find((layout) => layout.pattern === METRIC_PATTERNS.hero)
  const repeat = layouts.find((layout) => (
    layout.pattern === METRIC_PATTERNS.repeat
    && layout.vgroup_id !== hero?.vgroup_id
    && layout.detection_method !== 'vgroup_metric_flex_row'
    && !(layout.metric_slots || []).some((slot) => (
      slot.vgroup_id === hero?.vgroup_id
      || (slot.element_ids || []).some((elementId) => (hero?.element_ids || []).includes(elementId))
    ))
  ))
  if (!hero || !repeat) return []

  return [buildLayoutBase(slide, METRIC_PATTERNS.combo, {
    vgroupId: hero.vgroup_id,
    elementIds: [...new Set([...(hero.element_ids || []), ...(repeat.element_ids || [])])],
    containerNorm: hero.container_norm,
    itemCapacity: (hero.item_capacity || 1) + (repeat.item_capacity || 0),
    detectionMethod: 'metric_combo',
    hero: hero.hero_region,
    repeat: repeat.repeat_region || repeat,
    metricSlots: [
      ...(hero.metric_slots || []),
      ...(repeat.metric_slots || []),
    ],
    repeatComponentId: repeat.repeat_component_id,
    repeatInstance: repeat.repeat_instance,
    layoutDirection: repeat.layout_direction || 'row',
  })]
}

function suppressFlexRowChildHeroes(layouts) {
  const flexRows = layouts.filter((layout) => (
    layout.pattern === METRIC_PATTERNS.repeat
    && layout.detection_method === 'vgroup_metric_flex_row'
  ))
  if (!flexRows.length) return layouts

  const coveredVgroupIds = new Set(
    flexRows.flatMap((layout) => (layout.metric_slots || []).map((slot) => slot.vgroup_id)),
  )

  return layouts.filter((layout) => (
    layout.pattern !== METRIC_PATTERNS.hero || !coveredVgroupIds.has(layout.vgroup_id)
  ))
}

function dedupeLayouts(layouts) {
  const seen = new Set()
  const deduped = []

  for (const layout of layouts) {
    const key = [
      layout.pattern,
      layout.slide_number,
      layout.vgroup_id,
      layout.item_capacity,
      layout.capacity_expandable,
      layout.detection_method,
    ].join('|')
    if (seen.has(key)) continue
    seen.add(key)
    deduped.push(layout)
  }

  return deduped
}

export function detectSlideMetricLayouts(slide, report, options = {}) {
  const vgroupResult = options.vgroupResult || detectSlideVgroups(slide, { report })
  const titleResult = options.titleResult || findSlideTitleElements(slide, report)
  const titleElementIds = new Set(titleResult.elementIds || [])
  const singletonResult = options.singletonResult || detectSlideSingletons(slide, report, {
    repeatElementIds: options.repeatElementIds || [],
    vgroupResult,
    titleResult,
  })

  const layouts = []
  const groups = vgroupResult.groups || []

  for (const singleton of singletonResult.singletons || []) {
    if (singleton.pattern !== SINGLETON_PATTERNS.metric_card) continue
    const hero = normalizeHeroLayout(slide, singleton)
    if (hero) layouts.push(hero)
  }

  for (const group of groups) {
    if (layouts.some((layout) => layout.vgroup_id === group.id)) continue
    const hero = detectMetricHeroInGroup(slide, group, titleElementIds, groups)
    if (hero) layouts.push(hero)
  }

  for (const group of groups) {
    const repeatLayout = detectMetricRepeatFromVgroupRepeat(slide, group, report)
    if (repeatLayout) layouts.push(repeatLayout)
  }

  const flexRowLayouts = detectMetricFlexRow(slide, groups, titleElementIds, report)
  layouts.push(...flexRowLayouts)
  layouts.push(...detectMetricComboLayouts(slide, layouts))
  layouts.push(...detectMetricSplitLayouts(slide, layouts, titleElementIds, groups, flexRowLayouts))

  return {
    layouts: dedupeLayouts(suppressFlexRowChildHeroes(layouts)),
    vgroupResult,
    singletonResult,
    titleResult,
  }
}

export function listSlideMetricLayouts(slide, report, options = {}) {
  return detectSlideMetricLayouts(slide, report, options).layouts
}
