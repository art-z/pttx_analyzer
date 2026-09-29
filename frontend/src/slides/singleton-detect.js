import { detectSlideVgroups } from './vgroup-detect.js'
import { findSlideTitleElements } from './slide-title-detect.js'
import { collectGraphicExcludedElementIds } from './graphic-region-exclude.js'
import { DESCRIPTION_MEDIA_ROW_MIN_Y } from './slide-description-detect.js'

export const SINGLETON_PATTERNS = {
  speaker_card: 'speaker_card',
  metric_card: 'metric_card',
  text_list: 'text_list',
  text_block: 'text_block',
}

export const SINGLETON_PATTERN_LABELS = {
  speaker_card: 'Карточка спикера',
  metric_card: 'KPI-карточка',
  text_list: 'Текстовый список',
  text_block: 'Текстовый блок',
}

const MIN_LIST_ITEMS = 3
const MIN_TEXT_BLOCK_CHARS = 12
const MAX_ROOT_LIST_GROUP_ELEMENTS = 8
const MIN_METRIC_HEADING_BODY_RATIO = 1.8
const MIN_METRIC_VALUE_SIZE_PT = 48
const METRIC_VALUE_WITH_UNIT_RE = /^[\d\s.,+\-/]+(?:%|°|℃|℉|‰|[₽$€£]|[×xX]|[A-Za-z\u0400-\u04FF]{1,6})$/u
const BARE_METRIC_VALUE_RE = /^[\d\s.,+\-/]+$/u

function elementText(element) {
  return String(element?.text || element?.text_sample || '').trim()
}

function typographyKey(element) {
  const size = element?.typography?.size_pt
  const family = element?.typography?.family || ''
  return `${family}:${size != null ? Math.round(size) : '?'}`
}

function isRepeatGroup(group) {
  return Number(group.repeat?.count) >= 2 || Boolean(group.repeat?.grid)
}

function buildTextFieldsFromElements(elements) {
  const texts = elements.filter((element) => element.kind === 'text')
  const sorted = [...texts].sort((left, right) => (
    (right.typography?.size_pt || 0) - (left.typography?.size_pt || 0)
    || String(left.element_id || '').localeCompare(String(right.element_id || ''))
  ))

  return sorted.map((element, index) => {
    let role = 'text'
    if (sorted.length > 1 && index === 0) role = 'heading'
    else if (sorted.length > 1 && index === 1) role = 'body'

    return {
      field_id: role === 'text' ? `text_${index + 1}` : role,
      role,
      required: true,
      sample_text: elementText(element),
      typography: {
        dominant_family: element.typography?.family || null,
        dominant_size_pt: element.typography?.size_pt || null,
      },
    }
  })
}

function buildSingletonBase(group, pattern, elementIds, textElements, detectionMethod) {
  return {
    kind: 'singleton',
    pattern,
    vgroup_id: group?.id || null,
    layout: group?.layout || 'single',
    element_ids: elementIds,
    container_norm: group?.bboxNorm || null,
    text_fields: buildTextFieldsFromElements(textElements),
    detection_method: detectionMethod,
    label: SINGLETON_PATTERN_LABELS[pattern] || pattern,
  }
}

function detectSpeakerCard(group, reservedIds) {
  if (group.layout !== 'row' || !group.flex) return null
  if ((group.kindCounts?.image || 0) === 0) return null
  if ((group.bboxNorm?.y ?? 0) < DESCRIPTION_MEDIA_ROW_MIN_Y) return null
  if (isRepeatGroup(group)) return null

  const elements = (group.elements || []).filter((element) => (
    element?.element_id && !reservedIds.has(element.element_id)
  ))
  const textElements = elements.filter((element) => element.kind === 'text')
  if (!textElements.length) return null

  const elementIds = elements.map((element) => element.element_id)
  if (elementIds.some((id) => reservedIds.has(id))) return null

  return buildSingletonBase(group, SINGLETON_PATTERNS.speaker_card, elementIds, textElements, 'vgroup_media_row')
}

function detectMetricCard(group, reservedIds) {
  if (group.layout !== 'column') return null
  if (isRepeatGroup(group)) return null
  if ((group.kindCounts?.fill || 0) === 0) return null
  if ((group.kindCounts?.image || 0) > 0) return null

  const elements = (group.elements || []).filter((element) => (
    element?.element_id && !reservedIds.has(element.element_id)
  ))
  const textElements = elements.filter((element) => element.kind === 'text')
  const fillElements = elements.filter((element) => element.kind === 'fill')

  if (!fillElements.length || !textElements.length) return null
  if (textElements.length < 2) return null
  if (textElements.length > 3) return null
  if (elements.length !== fillElements.length + textElements.length) return null

  const metricValue = textElements.find((element) => (
    Boolean(element?.metric?.value != null)
    || METRIC_VALUE_WITH_UNIT_RE.test(elementText(element))
    || (
      (element.typography?.size_pt || 0) >= MIN_METRIC_VALUE_SIZE_PT
      && BARE_METRIC_VALUE_RE.test(elementText(element))
      && !(/^\d{4}$/.test(elementText(element)) && Number(elementText(element)) >= 1900 && Number(elementText(element)) <= 2099)
    )
  ))
  if (!metricValue) return null
  if (!textElements.some((element) => (
    element.element_id !== metricValue.element_id && elementText(element)
  ))) return null

  const sizes = textElements
    .map((element) => element.typography?.size_pt || 0)
    .filter((value) => value > 0)
  if (!sizes.length) return null

  const maxSize = Math.max(...sizes)
  const minSize = Math.min(...sizes)
  if (maxSize / Math.max(minSize, 1) < MIN_METRIC_HEADING_BODY_RATIO) return null

  const elementIds = elements.map((element) => element.element_id)
  return buildSingletonBase(group, SINGLETON_PATTERNS.metric_card, elementIds, textElements, 'vgroup_filled_metric')
}

function detectTextList(group, reservedIds) {
  if (group.layout !== 'column' && group.layout !== 'stack') return null
  if (isRepeatGroup(group)) return null
  if ((group.kindCounts?.image || 0) > 0 || (group.kindCounts?.fill || 0) > 0) return null
  if (group.depth === 1 && (group.elementCount || 0) > MAX_ROOT_LIST_GROUP_ELEMENTS) return null

  const textElements = (group.elements || []).filter((element) => (
    element.kind === 'text' && element.element_id && !reservedIds.has(element.element_id)
  ))
  if (textElements.length < MIN_LIST_ITEMS) return null
  if (textElements.length !== (group.elements || []).filter((element) => element?.element_id).length) return null

  const styleKeys = textElements.map(typographyKey)
  if (new Set(styleKeys).size !== 1) return null

  const elementIds = textElements.map((element) => element.element_id)
  return buildSingletonBase(group, SINGLETON_PATTERNS.text_list, elementIds, textElements, 'vgroup_text_column')
}

function detectTextBlock(element, reservedIds) {
  if (element?.kind !== 'text' || !element.element_id) return null
  if (reservedIds.has(element.element_id)) return null

  const text = elementText(element)
  if (text.length < MIN_TEXT_BLOCK_CHARS) return null

  const geometry = element.geometry_norm || {}
  return {
    kind: 'singleton',
    pattern: SINGLETON_PATTERNS.text_block,
    vgroup_id: null,
    layout: 'single',
    element_ids: [element.element_id],
    container_norm: geometry.width && geometry.height ? {
      x: geometry.x || 0,
      y: geometry.y || 0,
      width: geometry.width,
      height: geometry.height,
    } : null,
    text_fields: buildTextFieldsFromElements([element]),
    detection_method: 'ungrouped_text',
    label: SINGLETON_PATTERN_LABELS.text_block,
  }
}

function claimSingleton(singleton, claimed) {
  singleton.element_ids.forEach((id) => claimed.add(id))
}

export function detectSlideSingletons(slide, report, options = {}) {
  const vgroupResult = options.vgroupResult || detectSlideVgroups(slide, { report })
  const titleResult = options.titleResult || findSlideTitleElements(slide, report)

  const reservedIds = new Set([
    ...(titleResult.elementIds || []),
    ...(options.repeatElementIds || []),
    ...(options.reservedElementIds || []),
    ...collectGraphicExcludedElementIds(slide),
  ])

  const singletons = []
  const claimed = new Set(reservedIds)
  const groups = [...(vgroupResult.groups || [])].sort((left, right) => (
    (right.depth || 0) - (left.depth || 0)
    || (left.id || '').localeCompare(right.id || '')
  ))

  for (const group of groups) {
    const speaker = detectSpeakerCard(group, claimed)
    if (speaker) {
      singletons.push(speaker)
      claimSingleton(speaker, claimed)
      continue
    }

    const metric = detectMetricCard(group, claimed)
    if (metric) {
      singletons.push(metric)
      claimSingleton(metric, claimed)
      continue
    }

    const list = detectTextList(group, claimed)
    if (list) {
      singletons.push(list)
      claimSingleton(list, claimed)
    }
  }

  for (const element of vgroupResult.ungroupedElements || []) {
    const block = detectTextBlock(element, claimed)
    if (!block) continue
    singletons.push(block)
    claimSingleton(block, claimed)
  }

  return {
    singletons,
    claimedElementIds: claimed,
    vgroupResult,
    titleResult,
  }
}
