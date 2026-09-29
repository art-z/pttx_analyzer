import { listAllComponents } from '../components/catalog.js'
import {
  getComponentTemplateRegistry,
  isRegistryComponent,
  lookupTemplateFit,
  probeComponentOnTemplate,
  templateAssetBoardPenalty,
} from './component-template-fit.js'

const placementRegistryCache = new WeakMap()
const titleProbeCache = new WeakMap()

function registryFor(report) {
  if (!report) return getComponentTemplateRegistry(report, [])
  const cached = placementRegistryCache.get(report)
  if (cached) return cached
  const registry = getComponentTemplateRegistry(report, listAllComponents(report))
  placementRegistryCache.set(report, registry)
  return registry
}

function templateRecord(report, templateId) {
  return (report?.slide_templates?.templates || []).find((item) => (
    item.template_id === templateId || item.layout_source === templateId
  )) || null
}

function fitForTitle(report, component, templateId, titleText) {
  const cached = lookupTemplateFit(registryFor(report), component?.id)
  const stored = cached?.templates?.find((item) => item.template_id === templateId) || null
  // A title can change available space, but it cannot repeal the registry's
  // shell restrictions (quote/snippet, full-bleed image, contrasting fill).
  if (!stored || stored.status !== 'fit') return stored
  const text = String(titleText || '').trim()
  if (!text || !cached?.unit_norm) return stored
  let probes = titleProbeCache.get(report)
  if (!probes) {
    probes = new Map()
    titleProbeCache.set(report, probes)
  }
  const key = `${component.id}|${templateId}|${text}`
  if (probes.has(key)) return probes.get(key)
  const template = templateRecord(report, templateId)
  if (!template) return stored
  const probe = probeComponentOnTemplate({
    x: cached.unit_norm.x,
    y: cached.unit_norm.y,
    width: cached.unit_norm.width,
    height: cached.unit_norm.height,
    axis: cached.axis,
    cols: cached.cols,
    repeatable: cached.repeatable,
    flexible: cached.flexible || null,
    chartType: cached.chart_type || null,
  }, template, report, { titleText: text })
  const fit = { template_id: templateId, template_label: stored?.template_label || templateId, ...probe }
  probes.set(key, fit)
  return fit
}

export function placementForTemplate(report, component, templateId, { titleText = '' } = {}) {
  if (!component || !templateId || !isRegistryComponent(component)) return null
  return fitForTitle(report, component, templateId, titleText)
}

export function placementMaxCount(report, component, templateId, { titleText = '' } = {}) {
  const fit = placementForTemplate(report, component, templateId, { titleText })
  if (!fit) return null
  return fit.status === 'fit' ? fit.max_count : 0
}


function chartFitWidth(component, fit) {
  if (component?.group !== 'charts' && component?.kind !== 'chart') return 0
  return Number(fit?.fit_width ?? fit?.box?.width ?? 0) || 0
}

function chartFitArea(component, fit) {
  if (component?.group !== 'charts' && component?.kind !== 'chart') return 0
  return Number(fit?.fit_area ?? ((fit?.box?.width || 0) * (fit?.box?.height || 0))) || 0
}

function rankFitting(report, component, templateIds, needed, titleText) {
  return templateIds
    .filter(Boolean)
    .map((templateId) => ({
      templateId,
      fit: fitForTitle(report, component, templateId, titleText),
    }))
    .filter((item) => item.fit?.status === 'fit' && item.fit.max_count >= 1)
    .sort((left, right) => {
      const leftEnough = left.fit.max_count >= needed ? 1 : 0
      const rightEnough = right.fit.max_count >= needed ? 1 : 0
      return rightEnough - leftEnough
        || templateAssetBoardPenalty(report, left.templateId) - templateAssetBoardPenalty(report, right.templateId)
        || chartFitWidth(component, right.fit) - chartFitWidth(component, left.fit)
        || chartFitArea(component, right.fit) - chartFitArea(component, left.fit)
        || right.fit.max_count - left.fit.max_count
    })
}

export function chooseFittingTemplate(report, component, templateIds = [], {
  needed = 1,
  preferredId = null,
  templateUsage = null,
  avoidTemplateId = null,
  titleText = '',
} = {}) {
  const ids = [...new Set(templateIds.filter(Boolean))]
  if (!isRegistryComponent(component)) return ids.includes(preferredId) ? preferredId : ids[0] || null

  const entry = lookupTemplateFit(registryFor(report), component.id)
  if (!entry) return preferredId || ids[0] || null

  const usageOf = (templateId) => Number(templateUsage?.[templateId]) || 0
  const ranked = rankFitting(report, component, ids, needed, titleText)
  if (!ranked.length) return null

  ranked.sort((left, right) => {
    const leftRepeat = avoidTemplateId && left.templateId === avoidTemplateId ? 1 : 0
    const rightRepeat = avoidTemplateId && right.templateId === avoidTemplateId ? 1 : 0
    const leftEnough = left.fit.max_count >= needed ? 1 : 0
    const rightEnough = right.fit.max_count >= needed ? 1 : 0
    return rightEnough - leftEnough
      || leftRepeat - rightRepeat
      || templateAssetBoardPenalty(report, left.templateId) - templateAssetBoardPenalty(report, right.templateId)
      || chartFitWidth(component, right.fit) - chartFitWidth(component, left.fit)
      || chartFitArea(component, right.fit) - chartFitArea(component, left.fit)
      || right.fit.max_count - left.fit.max_count
      || usageOf(left.templateId) - usageOf(right.templateId)
  })
  return ranked[0].templateId
}

export function fittingTemplateIds(report, component, { needed = 1, titleText = '' } = {}) {
  if (!isRegistryComponent(component)) return []
  const entry = lookupTemplateFit(registryFor(report), component.id)
  return rankFitting(
    report,
    component,
    (entry?.templates || []).map((item) => item.template_id),
    needed,
    titleText,
  ).map((item) => item.templateId)
}

export function allowedComponentTemplateIds(report, component, options = {}) {
  if (!component) return []
  if (isRegistryComponent(component)) return fittingTemplateIds(report, component, options)
  return [...new Set((component.templates || []).filter(Boolean))]
}

export function componentAllowsTemplate(report, component, templateId, options = {}) {
  return Boolean(templateId && allowedComponentTemplateIds(report, component, options).includes(templateId))
}

export function applyPlacementToMatch(report, match, {
  needed = 1,
  templateIds = null,
  allowAnyTemplate = false,
  templateUsage = null,
  avoidTemplateId = null,
  titleText = '',
} = {}) {
  const component = match?.component
  if (!component || !isRegistryComponent(component)) return match

  const entry = lookupTemplateFit(registryFor(report), component.id)
  if (!entry?.unit_norm || !entry.templates?.length) return match

  const known = (templateIds || (match.templates || []).map((item) => item.templateId || item))
    .filter(Boolean)
  let templateId = known.length
    ? chooseFittingTemplate(report, component, known, {
      needed,
      preferredId: match.templateId || null,
      templateUsage,
      avoidTemplateId,
      titleText,
    })
    : null
  if (!templateId && (allowAnyTemplate || !known.length)) {
    templateId = chooseFittingTemplate(report, component, fittingTemplateIds(report, component, { needed, titleText }), {
      needed,
      preferredId: match.templateId || null,
      templateUsage,
      avoidTemplateId,
      titleText,
    })
  }
  if (!templateId) return null

  const maxCount = placementMaxCount(report, component, templateId, { titleText })
  let score = match.score || 0
  const reasons = [...(match.reasons || [])]
  if (maxCount != null && needed > 0 && maxCount < needed) {
    score -= (needed - maxCount) * 2
    reasons.push(`placement:${maxCount}<${needed}`)
  } else if (maxCount != null) {
    score += 4
    reasons.push(`placement:${maxCount}`)
  }

  return {
    ...match,
    score,
    reasons,
    templateId,
    placementMax: maxCount,
  }
}

export function clampItemCount(count, placementMax) {
  const requested = Math.max(0, Number(count) || 0)
  if (!Number.isFinite(placementMax) || placementMax == null) return requested
  return Math.max(0, Math.min(requested, placementMax))
}
