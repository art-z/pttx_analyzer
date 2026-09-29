import { extractDesignTokens } from '../constructor/tokens.js'
import { listAllComponents } from '../components/catalog.js'
import {
  buildContainerModelFromContext,
  matchRepeatComponents,
} from '../components/component-semantics.js'
import {
  llmChartToModelData,
  llmDiagramToModelData,
  llmTableToModelData,
  normalizeChartType,
  suitableChartTypes,
} from './graphic-contract.js'
import { findBaselineGraphicComponent } from './find-graphic-component.js'
import { matchTemplateForSpec } from './match-template.js'
import { filterShellBlockGaps } from './match-catalog-blocks.js'
import { normalizeSlideSpec, specBlockCounts } from './slide-spec.js'
import { defaultSlideDescriptionModel } from '../components/slide-description-catalog.js'
import { buildMetricModelPayload } from '../components/metric-catalog.js'
import { normalizeMetricItems, layoutAcceptsMetricUnits } from './metric-contract.js'
import { recommendationSortScore } from './scenario-priority.js'
import {
  applyPlacementToMatch,
  clampItemCount,
  placementMaxCount,
} from './placement-selection.js'

const REPEAT_CONTEXT_BLOCKS = [
  'persons', 'cards', 'lists', 'timelines', 'icon_lists', 'quotes',
]
const GRAPHIC_CONTEXT_BLOCKS = ['tables', 'charts', 'diagrams']

const GRAPHIC_KIND_BY_BLOCK = {
  tables: 'table',
  charts: 'chart',
  diagrams: 'diagram',
}

function templateLabel(report, templateId) {
  if (!templateId) return null
  const template = (report?.slide_templates?.templates || []).find((item) => item.template_id === templateId)
  return template?.layout_name || templateId
}

function pickComponentInstance(component, templateId = null) {
  const instances = component.instances || []
  if (!instances.length) return null
  if (templateId) {
    return instances.find((item) => item.template_id === templateId) || instances[0]
  }
  return instances[0]
}

function summarizeComponent(component) {
  return {
    component_id: component.id,
    label: component.label,
    kind: component.kind,
    group: component.group,
    is_baseline: Boolean(component.isBaseline),
  }
}

function summarizeMatch(entry, { payload = null, templateId = null, templateLabel: templateName = null } = {}) {
  if (!entry?.component) return null
  return {
    ...summarizeComponent(entry.component),
    score: entry.score,
    reasons: entry.reasons || [],
    template_id: templateId ?? entry.templateId ?? null,
    template_label: templateName ?? null,
    semantics: entry.semantics ? {
      pattern: entry.semantics.pattern,
      pattern_label: entry.semantics.patternLabel,
      roles: entry.semantics.roles,
    } : null,
    payload,
  }
}

export function matchSlideTitleComponent(report, spec) {
  if (!spec?.title && !spec?.text) return null
  const component = listAllComponents(report).find((item) => item.kind === 'slide_title')
  if (!component) return null

  const templateId = component.templates?.[0] || component.instances?.[0]?.template_id || null
  return {
    component,
    score: 95,
    reasons: [
      spec.title ? 'slide.title' : null,
      !spec.title && spec.text ? 'slide.text' : null,
    ].filter(Boolean),
    templateId,
    templates: component.templates || [],
    payload: {
      component_id: component.id,
      word_count: (spec.title || spec.text || '').split(/\s+/).filter(Boolean).length
        || component.capacity?.word_count_typical
        || 5,
      text: spec.title || spec.text || null,
    },
  }
}

export function matchSlideDescriptionComponent(report, spec) {
  if (!spec?.text || !spec?.title) return null
  const component = listAllComponents(report).find((item) => item.kind === 'slide_description')
  if (!component) return null

  const templateId = component.templates?.[0] || component.instances?.[0]?.template_id || null
  const instance = (component.instances || []).find((item) => (
    !templateId || item.template_id === templateId
  )) || component.instances?.[0]

  return {
    component,
    score: 86,
    reasons: ['slide.text', 'body', 'paragraph'],
    templateId,
    templates: component.templates || [],
    payload: defaultSlideDescriptionModel(component, instance, spec.text),
  }
}

function scoreTableComponent(component, tableSpec) {
  let score = component.isBaseline ? 40 : 20
  const reasons = component.isBaseline ? ['baseline:table'] : ['table']
  const rows = (tableSpec?.rows || []).length + (tableSpec?.headers?.length ? 1 : 0)
  const cols = tableSpec?.headers?.length || tableSpec?.rows?.[0]?.length || 0
  const capacity = component.capacity || {}

  if (capacity.row_count_max && rows <= capacity.row_count_max) {
    score += 12
    reasons.push(`rows:${rows}`)
  } else if (rows > 0) {
    score -= 8
    reasons.push(`rows:${rows}>max`)
  }

  if (capacity.col_count_max && cols <= capacity.col_count_max) {
    score += 10
    reasons.push(`cols:${cols}`)
  }

  score += Math.min(component.frequency?.instance_count || 0, 10)
  return { score, reasons }
}

const DERIVED_CHART_PENALTY = 200

function scoreChartComponent(component, chartSpec) {
  let score = component.isBaseline ? 48 : 28
  const reasons = component.isBaseline ? ['baseline:chart'] : ['chart']
  const preferred = normalizeChartType(chartSpec?.type || chartSpec?.chart_type)
  const aliases = {
    line: ['area', 'line'],
    bar: ['bar'],
    pie: ['pie', 'doughnut'],
    doughnut: ['doughnut', 'pie'],
    area: ['area', 'line'],
  }[preferred] || [preferred]

  const exactPreferred = preferred === 'line' ? 'area' : preferred
  if (component.chartType === exactPreferred) {
    score += 72
    reasons.push(`type:${exactPreferred}`)
  } else if (component.chartType && aliases.includes(component.chartType)) {
    score += 12
    reasons.push(`compatible:${component.chartType}`)
  } else if (component.chartType && suitableChartTypes(chartSpec).includes(component.chartType)) {
    // Another kind that suits the data: a second view, never above the
    // requested kind.
    score -= 50
    reasons.push(`suits:${component.chartType}`)
  }

  const pointCount = chartSpec?.values?.length || chartSpec?.labels?.length || 0
  if (pointCount >= 4) {
    score += 8
    reasons.push(`points:${pointCount}`)
  }
  // A chart drawn from KPI/table numbers is an extra view of that data: it
  // must not outrank the slide's native content, only fill a new variant.
  if (chartSpec?.derived_from) {
    score -= DERIVED_CHART_PENALTY
    reasons.push(`derived:${chartSpec.derived_from}`)
  }

  return { score, reasons }
}

function scoreDiagramComponent(component) {
  return {
    score: (component.isBaseline ? 42 : 22) + Math.min(component.frequency?.instance_count || 0, 8),
    reasons: [component.isBaseline ? 'baseline:diagram' : 'diagram'],
  }
}

export function matchMetricComponents(report, rawSpec, { limit = 5 } = {}) {
  const spec = normalizeSlideSpec(rawSpec)
  const { metrics } = normalizeMetricItems(spec?.metrics)
  if (!metrics.length) return []

  const needed = metrics.length
  return listAllComponents(report)
    .filter((component) => component.group === 'metrics')
    .map((component) => {
      const maxCount = component.capacity?.item_count_max || 1
      const visibleCount = component.capacity?.item_count_known || 1
      const layout = component.placement?.layout
      let score = 40
      if (maxCount >= needed) score += 28
      else score -= (needed - maxCount) * 8
      if (component.pattern === 'metric_hero' && needed === 1) score += 6
      if (component.pattern === 'metric_repeat' && needed >= 2) score += 8
      if (layoutAcceptsMetricUnits(layout, metrics)) score += 16
      else score -= 24

      return {
        component,
        score,
        reasons: [
          `metrics:${needed}`,
          `capacity:${visibleCount}-${maxCount}`,
          component.label,
        ],
        templateId: component.placement?.template_id || component.templates?.[0] || null,
        payload: buildMetricModelPayload(component, metrics.slice(0, maxCount), component.instances?.[0]),
      }
    })
    .sort((left, right) => right.score - left.score || String(left.component.label).localeCompare(String(right.component.label), 'ru'))
    .slice(0, limit)
}

export function matchGraphicComponents(report, rawSpec, contextBlock, { limit = 5 } = {}) {
  const spec = normalizeSlideSpec(rawSpec)
  const kind = GRAPHIC_KIND_BY_BLOCK[contextBlock]
  if (!kind) return []

  const items = spec?.[contextBlock] || []
  if (!items.length) return []

  const primary = items[0]
  let pool = listAllComponents(report).filter((component) => component.kind === kind)
  if (kind === 'chart') {
    // Every chart kind the data suits (not only the requested one): the
    // requested type still scores highest.
    const suitable = suitableChartTypes(primary)
    pool = pool.filter((component) => suitable.includes(component.chartType))
  }

  const needed = items.length
  return pool.map((component) => {
    let scored
    if (kind === 'table') scored = scoreTableComponent(component, primary)
    else if (kind === 'chart') scored = scoreChartComponent(component, primary)
    else scored = scoreDiagramComponent(component)

    let payload = null
    if (kind === 'table') payload = llmTableToModelData(primary, component.id)
    else if (kind === 'chart') {
      payload = llmChartToModelData(primary, component.id)
      const requested = normalizeChartType(primary?.type || primary?.chart_type)
      if (component.chartType && component.chartType !== requested) {
        payload = { ...payload, chart_type: component.chartType }
      }
    } else if (kind === 'diagram') payload = llmDiagramToModelData(primary, component.id)

    return {
      component,
      score: scored.score,
      reasons: scored.reasons,
      templateId: component.templates?.[0] || null,
      templates: component.templates || [],
      payload,
    }
  })
    .map((entry) => applyPlacementToMatch(report, entry, {
      needed,
      allowAnyTemplate: true,
      templateIds: entry.component.templates?.length ? entry.component.templates : null,
    }))
    .filter(Boolean)
    .sort((left, right) => right.score - left.score || Number(right.component.isBaseline) - Number(left.component.isBaseline))
    .slice(0, limit)
}

function repeatNeededCount(spec, contextBlock) {
  return Math.max(1, spec?.[contextBlock]?.length || 0)
}

export function matchRepeatComponentsForBlock(report, spec, contextBlock, options = {}) {
  const needed = repeatNeededCount(spec, contextBlock)
  return matchRepeatComponents(report, spec, options)
    .filter((entry) => entry.semantics.contextBlocks.includes(contextBlock))
    .map((entry) => applyPlacementToMatch(report, entry, {
      needed,
      templateIds: (entry.templates || []).map((item) => item.templateId),
    }))
    .filter(Boolean)
    .sort((left, right) => {
      if (left.semantics.contextBlocks.includes(contextBlock) && !right.semantics.contextBlocks.includes(contextBlock)) {
        return -1
      }
      if (right.semantics.contextBlocks.includes(contextBlock) && !left.semantics.contextBlocks.includes(contextBlock)) {
        return 1
      }
      const leftFits = (left.placementMax || 0) >= needed ? 1 : 0
      const rightFits = (right.placementMax || 0) >= needed ? 1 : 0
      return rightFits - leftFits || right.score - left.score
    })
}

function buildRepeatPayload(match, spec, contextBlock, report) {
  const instance = pickComponentInstance(match.component, match.templateId)
  if (!instance) return null
  const payload = buildContainerModelFromContext(match.component, instance, spec, { block: contextBlock })
  if (!payload) return null
  const limit = match.placementMax ?? placementMaxCount(report, match.component, match.templateId)
  const itemCount = clampItemCount(payload.item_count, limit)
  if (!itemCount) return null
  return {
    ...payload,
    item_count: itemCount,
    items: (payload.items || []).slice(0, itemCount),
  }
}

function buildRecommendation(slot, contextBlock, count, matches, report, spec, { buildPayload = null } = {}) {
  if (!matches.length) return null
  const best = matches[0]
  const templateName = templateLabel(report, best.templateId)
  const payload = buildPayload ? buildPayload(best, spec, contextBlock) : best.payload || null

  return {
    slot,
    context_block: contextBlock,
    count,
    best: summarizeMatch(best, {
      payload,
      templateId: best.templateId,
      templateLabel: templateName,
    }),
    alternatives: matches.slice(1, 4).map((entry) => summarizeMatch(entry, {
      templateId: entry.templateId,
      templateLabel: templateLabel(report, entry.templateId),
    })).filter(Boolean),
  }
}

export function resolveSlideRelevantComponents(report, rawSlide, baseTokens = null) {
  const spec = normalizeSlideSpec(rawSlide)
  const blockCounts = specBlockCounts(spec)
  const tokens = baseTokens || extractDesignTokens(report)
  const recommendations = []
  const gaps = []

  if (spec.metric_issues?.length) {
    gaps.push(`metrics: отклонено неполных KPI — ${spec.metric_issues.length}`)
  }

  const titleMatch = matchSlideTitleComponent(report, spec)
  if (titleMatch) {
    recommendations.push(buildRecommendation(
      'slide_title',
      null,
      1,
      [titleMatch],
      report,
      spec,
    ))
  } else if (spec.title || spec.text) {
    gaps.push('slide_title: компонент не найден')
  }

  const descriptionMatch = matchSlideDescriptionComponent(report, spec)
  if (descriptionMatch) {
    recommendations.push(buildRecommendation(
      'slide_description',
      null,
      1,
      [descriptionMatch],
      report,
      spec,
    ))
  } else if (spec.text && spec.title) {
    gaps.push('slide_description: компонент не найден')
  }

  REPEAT_CONTEXT_BLOCKS.forEach((contextBlock) => {
    const count = blockCounts[contextBlock] || 0
    if (!count) return
    const matches = matchRepeatComponentsForBlock(report, spec, contextBlock, { limit: 5 })
    const recommendation = buildRecommendation(
      'repeat',
      contextBlock,
      count,
      matches,
      report,
      spec,
      { buildPayload: (best, specForPayload, block) => buildRepeatPayload(best, specForPayload, block, report) },
    )
    if (recommendation) recommendations.push(recommendation)
    else gaps.push(`${contextBlock}: repeat-компонент не найден`)
  })

  if (blockCounts.metrics) {
    const matches = matchMetricComponents(report, spec, { limit: 5 })
    const recommendation = buildRecommendation('metric', 'metrics', blockCounts.metrics, matches, report, spec)
    if (recommendation) recommendations.push(recommendation)
    else gaps.push('metrics: KPI-компонент не найден в каталоге')
  }

  GRAPHIC_CONTEXT_BLOCKS.forEach((contextBlock) => {
    const count = blockCounts[contextBlock] || 0
    if (!count) return
    const matches = matchGraphicComponents(report, spec, contextBlock, { limit: 5 })
    const slot = GRAPHIC_KIND_BY_BLOCK[contextBlock]
    const recommendation = buildRecommendation(slot, contextBlock, count, matches, report, spec)
    if (recommendation) recommendations.push(recommendation)
    else gaps.push(`${contextBlock}: graphic-компонент не найден в каталоге`)
  })

  const templateMatch = matchTemplateForSpec(report, spec, tokens)
  if (!templateMatch.templateItem) {
    gaps.push('shell: подходящий layout не найден')
  }

  const ranked = [...recommendations].sort((left, right) => (
    recommendationSortScore(right) - recommendationSortScore(left)
  ))

  const primary = ranked.find((item) => (
    item.slot === 'slide_title' || item.slot === 'slide_description'
  ))?.best || ranked[0]?.best || null

  return {
    intent: spec.intent,
    purpose: spec.purpose || '',
    title: spec.title || '',
    block_counts: blockCounts,
    template: templateMatch.templateItem ? {
      layout_source: templateMatch.templateItem.id,
      name: templateMatch.templateItem.name,
      score: templateMatch.score,
      shell_id: templateMatch.templateItem.template?.shell_id || null,
      candidates: templateMatch.candidates || [],
    } : null,
    recommendations: ranked,
    primary,
    gaps: filterShellBlockGaps(report, [...new Set([...gaps, ...(templateMatch.gaps || [])])]),
  }
}

export function resolvePresentationRelevantComponents(report, presentation, baseTokens = null) {
  const payload = presentation?.presentation || presentation
  const slides = Array.isArray(payload?.slides) ? payload.slides : []
  const tokens = baseTokens || extractDesignTokens(report)

  return {
    title: payload?.title || null,
    goal: payload?.goal || null,
    audience: payload?.audience || null,
    slides: slides.map((slide) => ({
      index: slide.index,
      ...resolveSlideRelevantComponents(report, slide, tokens),
    })),
  }
}

export function findBestGraphicComponent(report, kind, spec, contextBlock) {
  const items = spec?.[contextBlock] || []
  if (!items.length) return null
  if (kind === 'chart') {
    return findBaselineGraphicComponent(report, kind, items[0]?.type || items[0]?.chart_type)
  }
  return findBaselineGraphicComponent(report, kind)
}
