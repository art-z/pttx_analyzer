import { findSlide } from '../components/catalog.js'
import {
  listMetricLayoutCatalog,
  metricLayoutPlacementKey,
  metricLayoutPlacementLabel,
} from '../components/metric-catalog.js'
import { applyMetricsToLayout, metricLayoutMaxItems } from '../components/metric-render.js'
import { METRIC_PATTERNS } from '../slides/metric-detect.js'
import { patchSlideTextContent } from '../slides/text-content-patch.js'
import { resolveTitleElementIds } from './build-catalog-slide.js'
import { normalizeMetricItems, layoutAcceptsMetricUnits } from './metric-contract.js'
import { listMetricComponents } from '../components/metric-catalog.js'
import {
  buildTitlePositionIndex,
  orderBySimilarTemplates,
  titlePositionKeyForTemplate,
} from './similar-templates.js'

export const METRIC_TEMPLATE_VARIANT_LIMIT = 4

function templateLabel(report, templateId) {
  if (!templateId) return null
  const template = (report?.slide_templates?.templates || []).find((item) => item.template_id === templateId)
  return template?.layout_name || templateId
}

function scoreMetricLayout(layout, spec, { expanded = false, capacity: knownCapacity = null } = {}) {
  const needed = spec.metrics?.length || 0
  const capacity = knownCapacity ?? (expanded ? layout.capacity_expandable : layout.capacity_visible)
  let score = 28

  if (capacity >= needed) score += 42
  else score -= (needed - capacity) * 14

  if (layout.pattern === METRIC_PATTERNS.hero && needed === 1) score += 18
  if (layout.pattern === METRIC_PATTERNS.repeat && needed >= 2) score += 16
  if (layout.pattern === METRIC_PATTERNS.combo && needed >= 3) score += 20
  if (layout.pattern === METRIC_PATTERNS.split && expanded && needed >= 2) score += 12

  const maxTitleLen = Math.max(...(spec.metrics || []).map((item) => String(item.title || '').length), 0)
  const width = layout.container_norm?.width || 0
  if (maxTitleLen >= 6 && width >= 0.2) score += 6
  if (maxTitleLen <= 4 && layout.pattern === METRIC_PATTERNS.hero) score += 4

  return score
}

export function canBuildMetricCatalogSlide(report, spec) {
  const { metrics } = normalizeMetricItems(spec?.metrics)
  if (!metrics.length) return false
  return rankMetricLayoutCandidates(report, { ...spec, metrics }, { limit: 1 }).length > 0
}

function usageOf(usage, key) {
  if (!usage || !key) return 0
  if (usage instanceof Map) return Number(usage.get(key)) || 0
  return Number(usage[key]) || 0
}

// Metric contract at ranking time: a layout must show every metric
// (capacity >= metric count) unless allowPartial is set. Several layouts of
// one template stay available (a shared "free layout" template must not
// collapse all KPI donors into one); only near-identical placements of the
// same donor slide + pattern are merged.
export function rankMetricLayoutCandidates(report, spec, {
  limit = METRIC_TEMPLATE_VARIANT_LIMIT,
  templateUsage = null,
  lastTemplateByComponent = null,
  allowPartial = false,
} = {}) {
  const { layouts } = listMetricLayoutCatalog(report)
  const normalized = normalizeMetricItems(spec?.metrics)
  const metricSpec = { ...spec, metrics: normalized.metrics }
  const needed = metricSpec.metrics.length
  const candidates = []

  for (const layout of layouts) {
    const foldsUnitsIntoValue = layout.unit_mode === 'none'
      && metricSpec.metrics.some((metric) => metric.unit)
    const unitModePenalty = foldsUnitsIntoValue ? 24 : 0
    for (const expanded of [false, true]) {
      if (expanded && !(layout.capacity_expandable > layout.capacity_visible)
        && metricLayoutMaxItems(report, layout, { expanded: true }) <= (layout.capacity_visible || 1)) continue
      const capacity = metricLayoutMaxItems(report, layout, { expanded })
      if (!allowPartial && capacity < needed) continue
      candidates.push({
        layout,
        expanded,
        capacity,
        score: scoreMetricLayout(layout, metricSpec, { expanded, capacity }) - unitModePenalty,
        slideNumber: layout.slide_number,
        templateId: layout.template_id,
        templateLabel: templateLabel(report, layout.template_id),
        placementLabel: metricLayoutPlacementLabel(
          { ...layout, capacity_visible: expanded ? layout.capacity_visible : capacity, capacity_expandable: capacity },
          expanded ? { expanded: true } : undefined,
        ),
        selection: expanded ? `${layout.pattern}_expanded` : layout.pattern,
      })
    }
  }

  candidates.sort((left, right) => (
    right.score - left.score
    || left.slideNumber - right.slideNumber
  ))

  const placements = []
  const seenPlacements = new Set()
  const seenDonors = new Set()
  for (const item of candidates) {
    const key = metricLayoutPlacementKey(item.layout, { expanded: item.expanded })
    const expandedKey = item.layout?.pattern === METRIC_PATTERNS.hero ? '*' : (item.expanded ? 'x' : '-')
    const donorKey = `${item.slideNumber}|${item.layout?.pattern}|${expandedKey}`
    if (seenPlacements.has(key) || seenDonors.has(donorKey)) continue
    seenPlacements.add(key)
    seenDonors.add(donorKey)
    placements.push(item)
  }

  const titlePositions = buildTitlePositionIndex(report)
  for (const item of placements) {
    item.titlePositionKey = titlePositionKeyForTemplate(titlePositions, item.templateId)
  }

  if (templateUsage || lastTemplateByComponent) {
    const adjusted = (item) => {
      const componentId = item.layout?.component_id || ''
      const last = lastTemplateByComponent instanceof Map
        ? lastTemplateByComponent.get(componentId)
        : lastTemplateByComponent?.[componentId]
      return item.score
        - (item.templateId && last === item.templateId ? 16 : 0)
        - usageOf(templateUsage, item.templateId) * 4
    }
    return [...placements]
      .sort((left, right) => adjusted(right) - adjusted(left) || left.slideNumber - right.slideNumber)
      .slice(0, limit)
  }

  const diverse = orderBySimilarTemplates(placements, {
    limit,
    templateIdOf: (item) => item.templateId || item.layout?.layout_source || `slide:${item.slideNumber}`,
  })
  for (const item of placements) {
    if (diverse.length >= limit) break
    if (diverse.includes(item)) continue
    diverse.push(item)
  }
  return diverse
}

export function pickFirstMetricCatalogComponent(report, spec) {
  const { metrics } = normalizeMetricItems(spec?.metrics)
  if (!metrics.length) return null

  const components = listMetricComponents(report)
  if (!components.length) return null

  const needed = metrics.length
  const ranked = [...components].sort((left, right) => {
    const leftAcceptsUnits = layoutAcceptsMetricUnits(left.placement?.layout, metrics) ? 1 : 0
    const rightAcceptsUnits = layoutAcceptsMetricUnits(right.placement?.layout, metrics) ? 1 : 0
    return rightAcceptsUnits - leftAcceptsUnits
      || (right.capacity?.item_count_max || 1) - (left.capacity?.item_count_max || 1)
      || (left.placement?.slide_number || 0) - (right.placement?.slide_number || 0)
  })

  const component = ranked.find((item) => (item.capacity?.item_count_max || 1) >= needed) || ranked[0]
  const maxCount = component.capacity?.item_count_max
    || component.placement?.capacity_expandable
    || component.capacity?.item_count_known
    || 1
  const visibleCount = component.capacity?.item_count_known
    || component.placement?.capacity_visible
    || 1
  const slice = metrics.slice(0, maxCount)
  const layout = component.placement?.layout
  const expanded = layout?.pattern === METRIC_PATTERNS.split
    ? slice.length > visibleCount
    : slice.length > visibleCount

  return {
    component,
    metrics: slice,
    expanded,
    layout,
    requestedCount: needed,
    renderedCount: slice.length,
  }
}

export function buildMetricPickFromCatalog(pick) {
  if (!pick?.layout) return null
  return {
    layout: pick.layout,
    expanded: pick.expanded,
    slideNumber: pick.component?.placement?.slide_number || pick.layout.slide_number,
    templateId: pick.component?.placement?.template_id || pick.layout.template_id,
    templateLabel: pick.component?.label || null,
    placementLabel: pick.component?.label || null,
    selection: pick.layout.pattern,
  }
}

function appendMissingElements(catalogSlide, sourceSlide, elementIds) {
  if (!sourceSlide || !elementIds?.length) return catalogSlide

  const existingIds = new Set((catalogSlide.content_elements || []).map((element) => element.element_id))
  const missing = (sourceSlide.content_elements || [])
    .filter((element) => elementIds.includes(element.element_id) && !existingIds.has(element.element_id))
    .map((element) => JSON.parse(JSON.stringify(element)))

  if (!missing.length) return catalogSlide

  return {
    ...catalogSlide,
    content_elements: [...(catalogSlide.content_elements || []), ...missing],
  }
}

export function buildMetricCatalogSlideFromPick(report, spec, picked, relevantComponents = null) {
  const gaps = []
  const filled = []
  const normalized = normalizeMetricItems(spec.metrics)
  const issueCount = (spec.metric_issues?.length || 0) + normalized.issues.length

  let catalogSlide = applyMetricsToLayout(report, picked.layout, normalized.metrics, {
    expanded: picked.expanded,
    flexAssembly: true,
    allowPartial: Boolean(picked.allowPartial),
  })

  if (!catalogSlide) {
    gaps.push('metrics: не удалось собрать preview для выбранной KPI-раскладки')
    return { catalogSlide: null, filled, gaps }
  }

  catalogSlide = {
    ...catalogSlide,
    content_elements: (catalogSlide.content_elements || []).map((element) => ({
      ...element,
      component_data: true,
    })),
  }

  const sourceSlide = findSlide(report, catalogSlide.slide_number)

  if (issueCount) gaps.push(`metrics: отклонено неполных KPI — ${issueCount}`)

  if (spec.title) {
    const titleElementIds = resolveTitleElementIds(report, relevantComponents, catalogSlide.slide_number)
    if (titleElementIds?.length) {
      catalogSlide = appendMissingElements(catalogSlide, sourceSlide, titleElementIds)
      catalogSlide = patchSlideTextContent(catalogSlide, {
        elementIds: titleElementIds,
        text: spec.title,
      })
      filled.push('title')
    } else {
      gaps.push('title: компонент заголовка не найден на слайде KPI')
    }
  }

  filled.push('metrics')
  return { catalogSlide, filled: [...new Set(filled)], gaps }
}

function summarizeMetricPick(picked, spec) {
  return {
    componentId: picked.layout?.component_id
      || `metric:${metricLayoutPlacementKey(picked.layout, { expanded: picked.expanded })}`,
    slideNumber: picked.slideNumber,
    templateId: picked.templateId,
    templateLabel: picked.templateLabel,
    placementLabel: picked.placementLabel,
    selection: picked.selection,
    score: picked.score,
    titlePositionKey: picked.titlePositionKey || null,
    expanded: picked.expanded,
    capacity: picked.capacity ?? (picked.expanded
      ? picked.layout.capacity_expandable
      : picked.layout.capacity_visible),
    metricCount: spec.metrics?.length || 0,
  }
}

export function buildScenarioMetricCatalogSlide(report, spec, relevantComponents = null, options = {}) {
  const limit = options.limit || METRIC_TEMPLATE_VARIANT_LIMIT
  const normalized = normalizeMetricItems(spec?.metrics)
  const metricSpec = { ...spec, metrics: normalized.metrics }
  const issueCount = (spec?.metric_issues?.length || 0) + normalized.issues.length

  if (!metricSpec.metrics.length) {
    const gaps = issueCount
      ? [`metrics: нет валидных KPI; отклонено — ${issueCount}`]
      : []
    return { catalogSlide: null, filled: [], gaps, metricMeta: null, variants: [] }
  }

  const candidates = rankMetricLayoutCandidates(report, metricSpec, {
    limit,
    templateUsage: options.templateUsage || null,
    lastTemplateByComponent: options.lastTemplateByComponent || null,
  })
  if (!candidates.length) {
    return {
      catalogSlide: null,
      filled: [],
      gaps: ['metrics: KPI-раскладки в шаблоне не найдены'],
      metricMeta: null,
      variants: [],
    }
  }

  const variants = candidates.map((picked) => {
    const built = buildMetricCatalogSlideFromPick(report, metricSpec, picked, relevantComponents)
    return {
      ...summarizeMetricPick(picked, metricSpec),
      catalogSlide: built.catalogSlide,
      filled: built.filled,
      gaps: built.gaps,
    }
  }).filter((item) => item.catalogSlide)

  const best = variants[0]
  if (!best) {
    return {
      catalogSlide: null,
      filled: [],
      gaps: ['metrics: не удалось собрать ни один KPI-вариант'],
      metricMeta: null,
      variants: [],
    }
  }

  return {
    catalogSlide: best.catalogSlide,
    filled: best.filled,
    gaps: best.gaps,
    metricMeta: {
      ...summarizeMetricPick(candidates[0], metricSpec),
      templateLabel: best.templateLabel || templateLabel(report, best.templateId),
      selectionStrategy: 'metric_layout_first',
      alternatives: variants.slice(1, limit).map((item) => ({
        slideNumber: item.slideNumber,
        templateId: item.templateId,
        templateLabel: item.templateLabel,
        placementLabel: item.placementLabel,
        score: item.score,
        expanded: item.expanded,
        capacity: item.capacity,
      })),
    },
    variants,
  }
}
