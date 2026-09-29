import { findSlideTitleElements } from '../slides/slide-title-detect.js'

const titlePositionIndexCache = new WeakMap()

// Strict match: title origin and width must sit on the same spot.
// A few percent of the slide is enough for placeholder rounding, not for a different column.
export const TITLE_POSITION_TOLERANCE = {
  x: 0.02,
  y: 0.015,
  width: 0.04,
}

export const SIMILAR_TEMPLATE_SCORE_GAP = 20

function median(values) {
  const sorted = values.filter(Number.isFinite).sort((left, right) => left - right)
  if (!sorted.length) return null
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

function finiteBox(box) {
  if (!box || !(Number(box.width) > 0)) return null
  return {
    x: Number(box.x) || 0,
    y: Number(box.y) || 0,
    width: Number(box.width) || 0,
    height: Number(box.height) || 0,
  }
}

export function titlesSharePosition(left, right, tolerance = TITLE_POSITION_TOLERANCE) {
  const a = finiteBox(left)
  const b = finiteBox(right)
  if (!a || !b) return false
  return Math.abs(a.x - b.x) <= tolerance.x
    && Math.abs(a.y - b.y) <= tolerance.y
    && Math.abs(a.width - b.width) <= tolerance.width
}

export function titlePositionKey(box) {
  const normalized = finiteBox(box)
  if (!normalized) return null
  const round = (value) => (Math.round(value * 1000) / 1000).toFixed(3)
  return `title:${round(normalized.x)}:${round(normalized.y)}:${round(normalized.width)}`
}

function titleSlotBox(template) {
  const slot = (template?.editable_slots || []).find((item) => (
    item.role === 'title'
    || item.placeholder_type === 'title'
    || item.placeholder_type === 'ctrTitle'
  ))
  return finiteBox(slot?.geometry_norm)
}

function medianDetectedTitleBox(report, template) {
  const slideNumbers = new Set(template?.slide_numbers || [])
  const boxes = []
  for (const slide of report?.slides?.slides || []) {
    const sameTemplate = slide.template_id === template.template_id
      || (template.layout_source && slide.layout_source === template.layout_source)
    if (!sameTemplate && !slideNumbers.has(slide.slide_number)) continue
    const detected = findSlideTitleElements(slide, report)
    const box = finiteBox(detected.primary?.geometry_norm)
    if (box) boxes.push(box)
  }
  if (!boxes.length) return null
  return {
    x: median(boxes.map((box) => box.x)),
    y: median(boxes.map((box) => box.y)),
    width: median(boxes.map((box) => box.width)),
    height: median(boxes.map((box) => box.height)),
  }
}

function templateTitleBox(report, template) {
  return titleSlotBox(template) || medianDetectedTitleBox(report, template)
}

export function buildTitlePositionIndex(report) {
  if (report && titlePositionIndexCache.has(report)) {
    return titlePositionIndexCache.get(report)
  }
  const entries = []
  for (const template of report?.slide_templates?.templates || []) {
    const box = templateTitleBox(report, template)
    if (!box || !template.template_id) continue
    entries.push({
      templateId: template.template_id,
      layoutSource: template.layout_source || null,
      box,
      slideCount: template.slide_count || 0,
    })
  }

  entries.sort((left, right) => (
    right.slideCount - left.slideCount
    || String(left.templateId).localeCompare(String(right.templateId))
  ))

  const groups = []
  const keyByTemplateId = new Map()
  for (const entry of entries) {
    let group = groups.find((item) => titlesSharePosition(item.anchor, entry.box))
    if (!group) {
      group = {
        key: titlePositionKey(entry.box),
        anchor: entry.box,
        templateIds: [],
      }
      groups.push(group)
    }
    group.templateIds.push(entry.templateId)
    keyByTemplateId.set(entry.templateId, group.key)
    if (entry.layoutSource) keyByTemplateId.set(entry.layoutSource, group.key)
  }

  const result = {
    groups: groups
      .filter((group) => group.templateIds.length >= 2)
      .map((group) => ({
        key: group.key,
        anchor: group.anchor,
        templateIds: group.templateIds,
      })),
    keyByTemplateId,
  }
  if (report) titlePositionIndexCache.set(report, result)
  return result
}

export function titlePositionKeyForTemplate(index, templateId) {
  if (!templateId || !index?.keyByTemplateId) return null
  return index.keyByTemplateId.get(templateId) || null
}

export function similarTemplateIds(index, templateId) {
  if (!templateId || !index?.groups) return []
  const key = titlePositionKeyForTemplate(index, templateId)
  if (!key) return []
  const group = index.groups.find((item) => item.key === key)
  if (!group) return []
  return group.templateIds.filter((id) => id !== templateId)
}

export function resolveVariantTitlePositionKey(item, titlePositionByTemplate = null) {
  if (item?.titlePositionKey) return item.titlePositionKey
  const templateId = item?.templateId || item?.catalogSlide?.template_id || item?.catalogSlide?.layout_source
  if (!templateId || !titlePositionByTemplate) return null
  if (titlePositionByTemplate instanceof Map) return titlePositionByTemplate.get(templateId) || null
  return titlePositionByTemplate[templateId] || null
}

export function orderByTemplateDiversity(candidates, {
  limit = candidates.length,
  templateUsage = null,
  lastTemplateByComponent = null,
  componentIdOf = (item) => item.componentId || '',
  titleKeyOf = (item) => item.titlePositionKey,
  templateIdOf = (item) => item.templateId || (item.slideNumber != null ? `slide:${item.slideNumber}` : ''),
  scoreOf = (item) => Number.isFinite(item?.score) ? item.score : 0,
} = {}) {
  const usageOf = (item) => {
    const id = templateIdOf(item)
    if (!id || !templateUsage) return 0
    return Number(templateUsage[id]) || 0
  }
  const lastTemplateOf = (item) => {
    const componentId = componentIdOf(item)
    if (!componentId || !lastTemplateByComponent) return ''
    if (lastTemplateByComponent instanceof Map) return lastTemplateByComponent.get(componentId) || ''
    return lastTemplateByComponent[componentId] || ''
  }
  const adjustedScore = (item) => {
    const templateId = templateIdOf(item)
    const repeated = templateId && templateId === lastTemplateOf(item) ? 16 : 0
    return scoreOf(item) - repeated - usageOf(item) * 4
  }
  const ranked = [...candidates].sort((left, right) => (
    adjustedScore(right) - adjustedScore(left)
  ))
  const selected = []
  const usedTemplates = new Set()
  const usedTitleKeys = new Set()
  const take = (item, { requireNewTitle = false } = {}) => {
    const id = templateIdOf(item)
    if (!id || usedTemplates.has(id)) return false
    const titleKey = titleKeyOf(item)
    if (requireNewTitle && titleKey && usedTitleKeys.has(titleKey)) return false
    usedTemplates.add(id)
    if (titleKey) usedTitleKeys.add(titleKey)
    selected.push(item)
    return true
  }

  for (const item of ranked) {
    if (selected.length >= limit) break
    take(item, { requireNewTitle: true })
  }
  for (const item of ranked) {
    if (selected.length >= limit) break
    take(item)
  }
  return selected
}

export function scoresAreClose(lead, item, gap = SIMILAR_TEMPLATE_SCORE_GAP) {
  if (!Number.isFinite(lead?.score) || !Number.isFinite(item?.score)) return true
  return lead.score - item.score <= gap
}

export function orderBySimilarTemplates(candidates, {
  limit = candidates.length,
  titleKeyOf = (item) => item.titlePositionKey,
  templateIdOf = (item) => item.templateId || (item.slideNumber != null ? `slide:${item.slideNumber}` : ''),
} = {}) {
  const selected = []
  const used = new Set()
  const take = (item) => {
    const id = templateIdOf(item)
    if (!id || used.has(id)) return false
    used.add(id)
    selected.push(item)
    return true
  }

  const best = candidates[0]
  if (!best) return []
  take(best)

  const key = titleKeyOf(best)
  const hasOtherKeys = key && candidates.some((item) => titleKeyOf(item) && titleKeyOf(item) !== key)
  const similarBudget = hasOtherKeys && limit > 1 ? limit - 1 : limit
  if (key) {
    for (const item of candidates) {
      if (selected.length >= similarBudget) break
      if (titleKeyOf(item) !== key || !scoresAreClose(best, item)) continue
      take(item)
    }
  }

  for (const item of candidates) {
    if (selected.length >= limit) break
    take(item)
  }
  return selected
}
