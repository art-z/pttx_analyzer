import { resolveBaselinePreviewPlacement } from '../components/baseline-template.js'
import { buildGraphicComponentPreviewSlide } from './build-catalog-slide.js'
import { findSlide, listAllComponents, resolveComponentPreviewContext } from '../components/catalog.js'
import { buildContainerRepeatPreviewSlide } from '../components/container-render.js'
import {
  INTENT_RANK_BONUS,
  buildContainerModelFromContext,
  matchRepeatComponents,
} from '../components/component-semantics.js'
import {
  matchGraphicComponents,
  matchRepeatComponentsForBlock,
} from './match-relevant-components.js'
import { finalizeScenarioPreviewSlide } from './finalize-scenario-preview.js'
import { sliceSpecForDataStep } from './build-scenario-sequential.js'

import { recommendationSortScore } from './scenario-priority.js'
import {
  buildTitlePositionIndex,
  titlePositionKeyForTemplate,
} from './similar-templates.js'
import {
  applyPlacementToMatch,
  allowedComponentTemplateIds,
  clampItemCount,
  componentAllowsTemplate,
  placementMaxCount,
} from './placement-selection.js'
import { auditPlacedContent, templateAssetBoardPenalty } from './component-template-fit.js'
import { HIT_ENGINE } from './slide-hit-test.js'
import { transplantComponentToTemplate } from './transplant-component-to-template.js'
import { buildQuoteTemplateVariants } from './build-quote-slide.js'

const CONTENT_SLOTS = new Set(['slide_title', 'slide_description', 'repeat', 'chart', 'table', 'diagram'])
const TEXT_PRIMARY_SLOTS = new Set(['slide_title', 'slide_description'])

function specForDataBlock(spec, block) {
  const blocks = block === 'title_text'
    ? ['title', 'text', 'paragraphs']
    : [block]
  return sliceSpecForDataStep(spec, { key: block, blocks })
}

function cloneSlide(slide) {
  return JSON.parse(JSON.stringify(slide))
}

function templateLabel(report, templateId) {
  if (!templateId) return null
  const template = (report?.slide_templates?.templates || []).find((item) => item.template_id === templateId)
  return template?.layout_name || templateId
}

function primaryContentRecommendation(relevantComponents, spec = {}) {
  const items = (relevantComponents?.recommendations || [])
    .filter((item) => CONTENT_SLOTS.has(item.slot)
      && item.best
      && (item.slot !== 'metric' || (spec.metrics || []).length > 0))

  const richPrimary = items
    .filter((item) => !TEXT_PRIMARY_SLOTS.has(item.slot))
    .sort((left, right) => recommendationSortScore(right) - recommendationSortScore(left))[0]

  if (richPrimary) return richPrimary

  return items
    .sort((left, right) => recommendationSortScore(right) - recommendationSortScore(left))[0] || null
}

function lastTemplateForComponent(selectionContext, componentId) {
  if (!componentId) return ''
  const bucket = selectionContext?.lastTemplateByComponent
  if (!bucket) return ''
  if (bucket instanceof Map) return bucket.get(componentId) || ''
  return bucket[componentId] || ''
}

function expandMatchesWithSimilarTemplates(report, matches, limit = 4, {
  needed = 1,
  templateUsage = null,
  selectionContext = null,
  titleText = '',
} = {}) {
  const index = buildTitlePositionIndex(report)
  const expanded = []
  const buckets = []
  const usageOf = (templateId) => Number(templateUsage?.[templateId]) || 0
  const maxOf = (component, templateId) => placementMaxCount(report, component, templateId, { titleText })

  for (const match of matches || []) {
    // The registry is the authority. Recommendations and source matches can
    // propose an order, but cannot bring a rejected shell back into the pool.
    const pool = allowedComponentTemplateIds(report, match.component, { needed, titleText })
    const previousTemplate = lastTemplateForComponent(selectionContext, match.component?.id)

    const ordered = pool.slice().sort((left, right) => {
      const leftMax = left ? maxOf(match.component, left) : null
      const rightMax = right ? maxOf(match.component, right) : null
      const leftEnough = leftMax != null && leftMax >= needed ? 1 : 0
      const rightEnough = rightMax != null && rightMax >= needed ? 1 : 0
      const leftRepeat = previousTemplate && left === previousTemplate ? 1 : 0
      const rightRepeat = previousTemplate && right === previousTemplate ? 1 : 0
      return rightEnough - leftEnough
        || leftRepeat - rightRepeat
        || templateAssetBoardPenalty(report, left) - templateAssetBoardPenalty(report, right)
        || (rightMax || 0) - (leftMax || 0)
        || usageOf(left) - usageOf(right)
    })

    const bucket = []
    for (const templateId of ordered) {
      bucket.push({
        ...match,
        templateId,
        placementMax: templateId ? maxOf(match.component, templateId) : match.placementMax,
        titlePositionKey: titlePositionKeyForTemplate(index, templateId),
      })
    }
    if (bucket.length) buckets.push(bucket)
  }

  // One new template per round. A partial fit stays in the pool: two copies
  // out of four are a valid slide when the hit-test says that is the maximum.
  const emittedTemplates = new Set()
  const cursor = buckets.map(() => 0)
  while (expanded.length < limit) {
    let added = false
    for (let index = 0; index < buckets.length; index += 1) {
      const bucket = buckets[index]
      while (cursor[index] < bucket.length && emittedTemplates.has(bucket[cursor[index]].templateId)) {
        cursor[index] += 1
      }
      const item = bucket[cursor[index]]
      if (!item) continue
      cursor[index] += 1
      if (item.templateId) emittedTemplates.add(item.templateId)
      expanded.push(item)
      added = true
      if (expanded.length >= limit) break
    }
    if (!added) break
  }

  return expanded
}

function substrateExpandOptions(spec, selectionContext, needed = 1) {
  return {
    needed,
    templateUsage: selectionContext?.templateUsage || null,
    selectionContext,
    titleText: spec?.title || '',
  }
}

function withPlacement(report, matches, needed, contextBlock = null, selectionContext = null, titleText = '') {
  return (matches || [])
    .map((match) => applyPlacementToMatch(report, match, {
      needed,
      templateUsage: selectionContext?.templateUsage || null,
      avoidTemplateId: lastTemplateForComponent(selectionContext, match.component?.id),
      titleText,
      templateIds: (match.templates || []).map((item) => (
        typeof item === 'string' ? item : item.templateId
      )).filter(Boolean),
    }))
    .filter((match) => match && (!contextBlock || match.semantics?.contextBlocks?.includes(contextBlock)))
}

function loadContentMatches(report, spec, primaryRec, selectionContext = null) {
  if (primaryRec.slot === 'slide_title' || primaryRec.slot === 'slide_description') {
    return primaryRec.best ? [{ ...primaryRec.best, component: null, payload: null }] : []
  }
  if (primaryRec.slot === 'repeat') {
    const needed = Math.max(1, spec?.[primaryRec.context_block]?.length || 1)
    return withPlacement(
      report,
      matchRepeatComponents(report, spec, { limit: 4 }),
      needed,
      primaryRec.context_block,
      selectionContext,
      spec?.title || '',
    )
  }
  return matchGraphicComponents(report, spec, primaryRec.context_block, { limit: 4 })
}

function resolveOriginalTemplateSlide(report, matchEntry, slot) {
  const component = matchEntry?.component
  if (!component) return null

  if (slot === 'repeat') {
    const { instance } = resolveComponentPreviewContext(report, component, {
      templateId: matchEntry.templateId || null,
    })
    if (!instance?.slide_number) return null
    const slide = findSlide(report, instance.slide_number)
    return slide ? cloneSlide(slide) : null
  }

  const placement = resolveBaselinePreviewPlacement(report, component)
  const slideNumber = placement?.slide_number || component.instances?.[0]?.slide_number
  if (!slideNumber) return null
  const slide = findSlide(report, slideNumber)
  return slide ? cloneSlide(slide) : null
}

function formatOriginalSublabel(slide, best) {
  const parts = [`слайд ${slide.slide_number}`]
  if (slide.layout_source) parts.push(slide.layout_source)
  if (best?.template_label) parts.push(best.template_label)
  else if (best?.template_id) parts.push(best.template_id)
  return parts.join(' · ')
}

function buildCatalogVariant(report, spec, primaryRec, matchEntry, relevantComponents) {
  const component = matchEntry?.component
  if (!component) return null
  const dataBlock = primaryRec.context_block
    || (primaryRec.slot === 'slide_title' || primaryRec.slot === 'slide_description'
      ? 'title_text'
      : primaryRec.slot)
  const primarySpec = specForDataBlock(spec, dataBlock)

  if (primaryRec.slot === 'repeat') {
    const { instance } = resolveComponentPreviewContext(report, component, {
      templateId: matchEntry.templateId || null,
    })
    if (!instance) return null

    const placementLimit = matchEntry.placementMax
      ?? placementMaxCount(report, component, matchEntry.templateId, { titleText: spec?.title || '' })
    const rawPayload = matchEntry.payload
      || buildContainerModelFromContext(component, instance, primarySpec, { block: primaryRec.context_block })
    const itemCount = clampItemCount(rawPayload?.item_count, placementLimit)
    const payload = rawPayload && itemCount
      ? { ...rawPayload, item_count: itemCount, items: (rawPayload.items || []).slice(0, itemCount) }
      : null
    if (!payload?.item_count) return null

    let slide = buildContainerRepeatPreviewSlide(report, component, instance, { modelData: payload })
    if (!slide) return null
    if (matchEntry.templateId && !component.templates?.includes(matchEntry.templateId)) {
      slide = transplantComponentToTemplate(report, slide, component, matchEntry.templateId, {
        elementPredicate: (element) => String(element.element_id || '').includes('__repeat_'),
        titleText: spec?.title || '',
      })
      if (!slide) return null
    }

    return finalizeScenarioPreviewSlide(report, slide, primarySpec, relevantComponents, {
      mode: 'repeat',
      includeDescription: false,
    })
  }

  const modelData = matchEntry.payload
  if (!modelData) return null

  const preview = buildGraphicComponentPreviewSlide(report, component, modelData, {
    templateId: matchEntry.templateId || null,
  })
  if (!preview.catalogSlide) return null
  let graphicSlide = preview.catalogSlide
  // Charts are always fitted into the template's free region (also on their
  // home template: a longer title there changes the free space).
  if (matchEntry.templateId && (!component.templates?.includes(matchEntry.templateId) || component.group === 'charts')) {
    graphicSlide = transplantComponentToTemplate(report, graphicSlide, component, matchEntry.templateId, {
      elementIds: preview.graphicElementIds || [],
      titleText: spec?.title || '',
    })
    if (!graphicSlide) return null
  }
  return finalizeScenarioPreviewSlide(report, graphicSlide, primarySpec, relevantComponents, {
    mode: 'graphic',
    keepElementIds: preview.graphicElementIds || [],
  })
}

function buildConstructorFallbackVariants(report, buildResult) {
  const variants = []
  const templateItem = buildResult.match?.templateItem
  if (!templateItem) return variants

  const previewNumber = templateItem.template?.preview_slide
    || templateItem.exampleSlideNumbers?.[0]
    || templateItem.slide_numbers?.[0]

  if (previewNumber) {
    const slide = findSlide(report, previewNumber)
    if (slide) {
      variants.push({
        key: 'original',
        role: 'original',
        label: 'Оригинал шаблона',
        sublabel: `${templateItem.name || 'shell'} · слайд ${slide.slide_number}`,
        score: null,
        catalogSlide: cloneSlide(slide),
      })
    }
  }

  if (buildResult.slide) {
    variants.push({
      key: 'assembled',
      role: 'best',
      label: 'Сборка shell',
      sublabel: templateItem.name || 'constructor',
      score: buildResult.match?.score || null,
      constructorSlide: buildResult.slide,
      tokens: buildResult.tokens,
    })
  }

  return variants
}

export const SCENARIO_VARIANT_DISPLAY_LIMIT = 3

const BLOCKING_LAYOUT_CODES = new Set(['text_overflow', 'text_overlap', 'title_over_graphic'])
const NARRATIVE_BLOCKS = new Set(['title_text', 'title_decor', 'template_first'])
// Diversity penalties used by selectDiverseVariants (see the comment there).
const CONTENT_REPEAT_PENALTY = 1000
const TEMPLATE_FAMILY_PENALTY = 6
const COMPONENT_FAMILY_PENALTY = 10
// A repeated narrative layout (second plain-text variant) ranks below a
// repeated data block shown with a different component: a second KPI
// component says more than a second text box.
const NARRATIVE_REPEAT_EXTRA = 60
// Same template id but another donor slide (decks often put every KPI donor
// on one shared "free layout" template): allowed, ranked below a new template.
const SHARED_TEMPLATE_PENALTY = 30
// Intent adds at most INTENT_RANK_BONUS (shared with component-semantics.js).
const REPEAT_DATA_BLOCKS = ['cards', 'lists', 'icon_lists', 'persons', 'quotes']
const INTENT_DATA_BLOCKS = {
  timeline: ['timelines'],
  roadmap: ['timelines'],
  comparison: ['tables'],
  table: ['tables'],
  process: ['diagrams'],
  workflow: ['diagrams'],
  architecture: ['diagrams'],
  solution: ['diagrams'],
  features: REPEAT_DATA_BLOCKS,
  team: REPEAT_DATA_BLOCKS,
  quote: REPEAT_DATA_BLOCKS,
  metrics: ['metrics'],
  problem: ['metrics'],
  summary: ['metrics'],
  example: ['title_decor'],
}

const SPECIAL_DATA_BLOCKS = new Set(['title_decor', 'template_first', 'terminal', 'content'])

export function variantChartFamily(item, selectionContext = null) {
  const element = (item.catalogSlide?.content_elements || []).find((entry) => entry.kind === 'chart')
  if (!element && item?.dataBlock !== 'charts') return null
  const raw = String(
    item.chartType || element?.chart_type || element?.chart?.chart_type
    || selectionContext?.componentKeys?.[item.componentId]?.replace(/^chart:/, '') || 'unknown'
  ).toLowerCase()
  return ['pie', 'doughnut', 'donut'].includes(raw) ? 'circular' : raw
}

function specHasDataBlock(spec, dataBlock) {
  if (!spec || !dataBlock || SPECIAL_DATA_BLOCKS.has(dataBlock)) return true
  if (dataBlock === 'title_text') return Boolean(spec.title || spec.text || spec.paragraphs?.length)
  if (dataBlock === 'charts' && spec.derived_charts?.length) return true
  return Array.isArray(spec[dataBlock]) && spec[dataBlock].length > 0
}


function layoutIssues(item) {
  const validation = item?.catalogSlide?.layout_validation || {}
  return [...(validation.issues || []), ...(validation.warnings || [])]
}

function chartElementIds(item) {
  return new Set((item?.catalogSlide?.content_elements || [])
    .filter((element) => element?.kind === 'chart')
    .map((element) => element.element_id)
    .filter(Boolean))
}

function chartLayoutRejectReason(item) {
  if (item?.dataBlock !== 'charts') return null
  const issues = layoutIssues(item)
  if (issues.some((issue) => issue?.code === 'title_over_graphic')) return 'chart_title_overlap'
  const chartIds = chartElementIds(item)
  if (!chartIds.size) return null
  const hasChartTextOverlap = issues.some((issue) => (
    issue?.code === 'text_overlap'
    && (issue.element_ids || []).some((id) => chartIds.has(id))
  ))
  return hasChartTextOverlap ? 'chart_text_overlap' : null
}

function blockingLayoutIssueCount(item) {
  return layoutIssues(item).filter((issue) => BLOCKING_LAYOUT_CODES.has(issue?.code)).length
}

function withoutBrokenLayouts(candidates) {
  const scored = candidates.map((item) => ({
    item,
    issues: blockingLayoutIssueCount(item),
  }))
  const clean = scored.filter((entry) => entry.issues === 0)
  if (clean.length) return clean.map((entry) => entry.item)
  const minimum = Math.min(...scored.map((entry) => entry.issues))
  return scored.filter((entry) => entry.issues === minimum).map((entry) => entry.item)
}

function placementRejectReason(report, item) {
  if (!report || !item.templateId || !item.catalogSlide) return null
  // The unit hit-test already checked this exact slide against the layout's
  // safe area, the real title text and picture layers after correcting it;
  // the registry audit (generic margins, decorative art) would only re-reject
  // layouts that were fixed.
  if (item.catalogSlide.layout_validation?.engine === HIT_ENGINE) return null
  const audit = auditPlacedContent(report, item.catalogSlide, item.templateId)
  if (audit.ok) return null
  return audit.reason === 'obstacle' ? 'placement_obstacle' : 'placement_bounds'
}

function componentTemplateRejectReason(report, item, spec) {
  if (!report || !item.componentId) return null
  const component = listAllComponents(report).find((entry) => entry.id === item.componentId)
  if (!component) return null // Text variants use a composite placement key.
  const templateId = item.templateId || item.catalogSlide?.template_id || item.catalogSlide?.layout_source
  return componentAllowsTemplate(report, component, templateId, { titleText: spec?.title || '' })
    ? null
    : 'component_template_rejected'
}

// A shown variant must carry the slide title, legibly: a donor whose "title"
// placeholder is really a 10pt chart caption, or a quote layout without any
// title on a layout that has a title slot, is not a variant of this slide.
// (A layout without any title slot — a pure quote/section design — may omit it.)
export const MIN_TITLE_FONT_PT = 14

function normalizedText(value) {
  return String(value ?? '').replace(/[\u00a0\u2009\u202f]/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase()
}

function templateHasTitleSlot(report, item) {
  const slide = item?.catalogSlide
  const templateId = item?.templateId || slide?.template_id
  const template = (report?.slide_templates?.templates || []).find((entry) => (
    (templateId && entry.template_id === templateId)
    || (slide?.layout_source && entry.layout_source === slide.layout_source)
  ))
  return Boolean(template?.editable_slots?.some((slot) => slot.role === 'title' || ['title', 'ctrTitle'].includes(slot.placeholder_type)))
}

function hasSyntheticTitle(item, spec = null) {
  const wanted = [spec?.title, ...Object.values(spec?.title_options || {})].map(normalizedText).filter(Boolean)
  return (item?.catalogSlide?.content_elements || []).some((element) => (
    element?.kind === 'text'
    && element.synthetic
    && (
      element.role === 'title'
      || ['title', 'ctrTitle'].includes(element.placeholder_type)
      || /(^|_)slide_title(_|$)/.test(String(element.element_id || ''))
      || wanted.includes(normalizedText(element.text))
    )
  ))
}

function chartSyntheticTitleRejectReason(item, spec = null) {
  return item?.dataBlock === 'charts' && hasSyntheticTitle(item, spec) ? 'chart_synthetic_title_template' : null
}

function titleRejectReason(item, spec, report = null) {
  const slide = item?.catalogSlide
  const wanted = [spec?.title, ...Object.values(spec?.title_options || {})].map(normalizedText).filter(Boolean)
  if (!slide || !wanted.length) return null
  const texts = (slide.content_elements || []).filter((element) => element.kind === 'text' && normalizedText(element.text))
  const titles = texts.filter((element) => element.role === 'title'
    || ['title', 'ctrTitle'].includes(element.placeholder_type)
    || /(^|_)slide_title(_|$)/.test(String(element.element_id || ''))
    || wanted.includes(normalizedText(element.text)))
  if (!titles.length) return templateHasTitleSlot(report, item) ? 'title_missing' : null
  const legible = titles.some((element) => !(Number(element.typography?.size_pt) > 0)
    || Number(element.typography.size_pt) >= MIN_TITLE_FONT_PT)
  return legible ? null : 'title_too_small'
}

function prepareScenarioVariantCandidates(previewVariants, spec = null, report = null, { allowLayoutIssues = false } = {}) {
  const accepted = []
  const rejected = []

  for (const item of previewVariants || []) {
    let reason = null
    if (item.role === 'original') reason = 'original_reference'
    else if (!item.catalogSlide && !item.constructorSlide) reason = 'missing_preview'
    else if (!specHasDataBlock(spec, item.dataBlock)) reason = 'missing_source_data'
    else reason = componentTemplateRejectReason(report, item, spec)
    if (!reason) reason = titleRejectReason(item, spec, report)
    if (!reason && !allowLayoutIssues) reason = chartSyntheticTitleRejectReason(item, spec)
    if (!reason && !allowLayoutIssues) reason = chartLayoutRejectReason(item)
    if (!reason && !allowLayoutIssues && item.catalogSlide?.layout_validation?.valid === false) {
      const issues = item.catalogSlide?.layout_validation?.issues || []
      reason = item.dataBlock === 'charts' && issues.some((issue) => issue?.code === 'title_over_graphic')
        ? 'chart_title_overlap'
        : 'invalid_layout'
    }
    if (!reason && !allowLayoutIssues) reason = placementRejectReason(report, item)

    if (reason) {
      const layout = item.catalogSlide?.layout_validation
      rejected.push({
        key: item.key || null,
        reason,
        ...(reason === 'invalid_layout' && layout?.reject_reason ? { layout: layout.reject_reason } : {}),
      })
    } else accepted.push(item)
  }

  if (allowLayoutIssues) return { candidates: accepted, rejected }

  const clean = accepted.filter((item) => blockingLayoutIssueCount(item) === 0)
  if (!clean.length) return { candidates: withoutBrokenLayouts(accepted), rejected }

  for (const item of accepted) {
    if (blockingLayoutIssueCount(item) > 0) {
      rejected.push({ key: item.key || null, reason: 'blocking_layout_warning' })
    }
  }
  return { candidates: clean, rejected }
}

function stableHash(value) {
  let hash = 2166136261
  for (const char of String(value || '')) {
    hash ^= char.charCodeAt(0)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

function usageCount(usage, key) {
  if (!key) return 0
  if (usage instanceof Map) return usage.get(key) || 0
  return Number(usage?.[key]) || 0
}

function intentBonus(intent, dataBlock) {
  return INTENT_DATA_BLOCKS[intent]?.includes(dataBlock) ? INTENT_RANK_BONUS : 0
}

const BLOCK_TIE = {
  metrics: 0,
  tables: 1,
  charts: 2,
  diagrams: 3,
  timelines: 4,
  cards: 5,
  lists: 5,
  icon_lists: 5,
  persons: 5,
  quotes: 5,
  title_decor: 7,
  template_first: 8,
  title_text: 8,
  terminal: -1,
}

function variantRank(item, intent, selectionContext = null, seed = '', report = null) {
  const dataBlock = item.dataBlock || ''
  const score = Number.isFinite(item.score) ? item.score : 0
  const blockUsage = usageCount(selectionContext?.blockUsage, dataBlock)
  const componentKey = item.componentId || ''
  const templateKey = item.templateId || item.catalogSlide?.layout_source || ''
  const componentUsage = usageCount(selectionContext?.componentUsage, componentKey)
  const templateUsage = usageCount(selectionContext?.templateUsage, templateKey)
  const repeatedTemplate = componentKey && templateKey
    && lastTemplateForComponent(selectionContext, componentKey) === templateKey
    ? 16
    : 0
  const narrativePenalty = NARRATIVE_BLOCKS.has(dataBlock) ? 18 : 0
  const jitterKey = `${seed}|${dataBlock}|${componentKey}|${templateKey}|${item.key || ''}`
  const deterministicJitter = (stableHash(jitterKey) % 1000) / 10000
  const coverageKey = selectionContext?.componentKeys?.[componentKey]
  // A chart kind the data merely suits (bar for shares, ...) is a second view:
  // deck coverage must not lift it above the requested kind (a second pie
  // slide still shows a pie, not the still-unused bar component).
  const alternativeChartKind = dataBlock === 'charts'
    && (item.reasons || []).some((reason) => String(reason).startsWith('suits:'))
  const coverageBonus = coverageKey && !alternativeChartKind && !selectionContext?.coverageUsage?.[coverageKey] ? 90 : 0
  const componentBonus = !alternativeChartKind && selectionContext?.targetComponents?.includes(componentKey)
    && !selectionContext?.componentExposure?.[componentKey] ? 18 : 0

  return score
    + coverageBonus
    + componentBonus
    + intentBonus(intent, dataBlock)
    - Math.min(blockUsage, 3) * 8
    - componentUsage * 6
    - templateUsage * 4
    - templateAssetBoardPenalty(report, templateKey)
    - repeatedTemplate
    - narrativePenalty
    - (BLOCK_TIE[dataBlock] ?? 6) * 0.05
    - deterministicJitter
}

function contentGroupOf(item) {
  const block = item.dataBlock || ''
  return NARRATIVE_BLOCKS.has(block) ? 'title_text' : block
}

function templateKeyOf(item) {
  const slideNumber = item.slideNumber || item.catalogSlide?.slide_number
  return item.templateId
    || item.catalogSlide?.template_id
    || item.catalogSlide?.layout_source
    || (slideNumber ? `slide:${slideNumber}` : '')
}

function fingerprintOf(item) {
  return [
    item.templateId || item.catalogSlide?.layout_source || '',
    item.componentId || item.dataBlock || item.label || '',
    item.sublabel || '',
    item.slideNumber || item.catalogSlide?.slide_number || '',
  ].join('|')
}

// Greedy, diversity-aware pick over candidates ranked by fit. Every step
// takes the candidate with the best adjusted score:
//   base score
//   - CONTENT_REPEAT_PENALTY  x picks of the same content type
//   - TEMPLATE_FAMILY_PENALTY x picks with the same title-position family
//   - COMPONENT_FAMILY_PENALTY x picks of the same component family
//   - NARRATIVE_REPEAT_EXTRA  when a narrative (text) type repeats
//   - SHARED_TEMPLATE_PENALTY when the template id is taken by another donor slide
// CONTENT_REPEAT_PENALTY dwarfs any fit score, so a new content type (text,
// metrics, charts, tables, cards, ...) always beats a second variant of a type
// already shown; among repeats a data block in another component beats a
// second plain-text layout. Duplicates are never picked: no repeated
// component, chart family or template+donor slide.
// Chart guarantee: when a selection holds no chart although a valid (already
// hit-tested) chart candidate exists, the chart takes a slot: an empty one,
// else the last plain-text (paragraph) pick after the primary, else the last
// pick. The primary variant is never displaced. Derived charts (drawn from
// KPI/table numbers) only enter through this reserved slot.
export function isChartVariant(item) {
  return item?.dataBlock === 'charts'
}

export function selectDiverseVariants(ranked, options = {}) {
  const { limit = SCENARIO_VARIANT_DISPLAY_LIMIT, ensureChart = true } = options
  const primary = ensureChart ? ranked.filter((item) => !item.derivedChart) : ranked
  const picked = pickDiverseVariants(primary, options)
  if (!ensureChart || limit < 3 || picked.some(isChartVariant)) return picked
  const charts = ranked.filter(isChartVariant)
  if (!charts.length || !picked.length) return picked
  // Slots to try, best first: an empty one, the last paragraph pick, a
  // repeated content type (second tables/metrics variant), then the last pick.
  const slots = []
  if (picked.length < limit) slots.push(picked.length)
  const later = picked.map((_, index) => index).filter((index) => index > 0).reverse()
  later.filter((index) => contentGroupOf(picked[index]) === 'title_text').forEach((index) => slots.push(index))
  later.filter((index) => picked.slice(0, index).some((item) => contentGroupOf(item) === contentGroupOf(picked[index])))
    .forEach((index) => slots.push(index))
  if (later.length) slots.push(later[0])
  // Last resort: the only chart layout is the template another data block
  // (e.g. the table) already uses — a chart on the same design still beats a
  // second paragraph layout.
  for (const allowSharedTemplate of [false, true]) {
    for (const slot of [...new Set(slots)]) {
      const head = picked.filter((_, index) => index !== slot)
      const withChart = pickDiverseVariants(charts, { ...options, limit: head.length + 1, preselected: head, allowSharedTemplate })
      if (withChart.length !== head.length + 1) continue
      const chart = withChart[withChart.length - 1]
      return [...head.slice(0, slot), chart, ...head.slice(slot)]
    }
  }
  return picked
}

function pickDiverseVariants(ranked, {
  limit = SCENARIO_VARIANT_DISPLAY_LIMIT,
  scoreOf = (item) => (Number.isFinite(item.score) ? item.score : 0),
  selectionContext = null,
  dedupeChartFamilies = true,
  preselected = [],
  allowSharedTemplate = false,
} = {}) {
  const picked = []
  const fingerprints = new Set()
  const templates = new Set()
  const components = new Set()
  const chartFamilies = new Set()
  const diagramFamilies = new Set()
  const contentCounts = new Map()
  const templateFamilyCounts = new Map()
  const componentFamilyCounts = new Map()
  const countOf = (counts, key) => (key ? counts.get(key) || 0 : 0)
  const bump = (counts, key) => {
    if (key) counts.set(key, countOf(counts, key) + 1)
  }
  const familyOf = (item) => selectionContext?.componentKeys?.[item.componentId] || ''
  const donorSlides = new Set()
  const donorKeyOf = (item) => {
    const slideNumber = item.slideNumber || item.catalogSlide?.slide_number
    return `${templateKeyOf(item)}|${slideNumber || ''}`
  }
  const templateTaken = (item) => {
    const templateKey = templateKeyOf(item)
    return Boolean(templateKey && templates.has(templateKey))
  }
  const isDuplicate = (item) => {
    const chartFamily = variantChartFamily(item, selectionContext)
    const diagramFamily = item?.dataBlock === 'diagrams' ? 'diagram' : null
    return fingerprints.has(fingerprintOf(item))
      || (templateTaken(item) && donorSlides.has(donorKeyOf(item))
        && !(allowSharedTemplate && picked.every((other) => donorKeyOf(other) !== donorKeyOf(item) || (other.dataBlock !== item.dataBlock && contentGroupOf(other) !== 'title_text'))))
      || Boolean(item.componentId && components.has(item.componentId) && (dedupeChartFamilies || !chartFamily))
      || Boolean(dedupeChartFamilies && chartFamily && chartFamilies.has(chartFamily))
      || Boolean(diagramFamily && diagramFamilies.has(diagramFamily))
  }
  const adjustedScore = (item) => {
    const repeats = countOf(contentCounts, contentGroupOf(item))
    return scoreOf(item)
      - repeats * CONTENT_REPEAT_PENALTY
      - (repeats && contentGroupOf(item) === 'title_text' ? NARRATIVE_REPEAT_EXTRA : 0)
      - (templateTaken(item) ? SHARED_TEMPLATE_PENALTY : 0)
      - countOf(templateFamilyCounts, item.titlePositionKey) * TEMPLATE_FAMILY_PENALTY
      - countOf(componentFamilyCounts, familyOf(item)) * COMPONENT_FAMILY_PENALTY
  }

  const queue = [...preselected]
  while (picked.length < limit) {
    let best = queue.shift() || null
    let bestScore = -Infinity
    for (const item of best ? [] : ranked) {
      if (picked.includes(item) || isDuplicate(item)) continue
      const score = adjustedScore(item)
      if (score > bestScore) {
        best = item
        bestScore = score
      }
    }
    if (!best) break
    picked.push(best)
    fingerprints.add(fingerprintOf(best))
    const templateKey = templateKeyOf(best)
    if (templateKey) templates.add(templateKey)
    donorSlides.add(donorKeyOf(best))
    if (best.componentId) components.add(best.componentId)
    const chartFamily = variantChartFamily(best, selectionContext)
    if (chartFamily) chartFamilies.add(chartFamily)
    if (best?.dataBlock === 'diagrams') diagramFamilies.add('diagram')
    bump(contentCounts, contentGroupOf(best))
    bump(templateFamilyCounts, best.titlePositionKey)
    bump(componentFamilyCounts, familyOf(best))
  }
  return picked
}

function selectScenarioDisplayVariants(candidates, {
  limit = SCENARIO_VARIANT_DISPLAY_LIMIT,
  intent = '',
  selectionContext = null,
  seed = '',
  dedupeChartFamilies = true,
  report = null,
} = {}) {
  const ranks = new Map(candidates.map((item) => [item, variantRank(item, intent, selectionContext, seed, report)]))
  const ranked = [...candidates]
    .sort((left, right) => ranks.get(right) - ranks.get(left)
      || (right.score ?? -1) - (left.score ?? -1))
  return selectDiverseVariants(ranked, { limit, scoreOf: (item) => ranks.get(item), selectionContext, dedupeChartFamilies })
}

export function pickScenarioDisplayVariants(previewVariants = [], options = {}) {
  const prepared = prepareScenarioVariantCandidates(previewVariants, options.spec || null, options.report || null)
  return selectScenarioDisplayVariants(prepared.candidates, options)
}

export function runScenarioVariantPipeline(previewVariants = [], options = {}) {
  const prepared = prepareScenarioVariantCandidates(
    previewVariants,
    options.spec || null,
    options.report || null,
    { allowLayoutIssues: Boolean(options.allowLayoutIssues) },
  )
  const variants = selectScenarioDisplayVariants(prepared.candidates, options)
  return {
    variants,
    diagnostics: {
      generated: previewVariants.length,
      eligible: prepared.candidates.length,
      selected: variants.length,
      selected_variants: variants.map((item) => ({
        key: item.key || null,
        data_block: item.dataBlock || null,
        component_id: item.componentId || null,
        template_id: item.templateId || item.catalogSlide?.template_id || item.catalogSlide?.layout_source || null,
        transplanted: Boolean(item.catalogSlide?.component_transplant),
      })),
      rejected: prepared.rejected,
    },
  }
}

export function buildScenarioPreviewVariants(report, spec, relevantComponents, buildResult) {
  const textVariants = buildResult?.textTemplateVariants || []
  const metricVariants = buildResult?.metricTemplateVariants || []

  if (buildResult?.match?.metricMeta && metricVariants.length) {
    const variants = []
    const bestVariant = metricVariants[0]
    const metricSpec = specForDataBlock(spec, 'metrics')
    const original = findSlide(report, bestVariant.slideNumber)

    if (original) {
      variants.push({
        key: 'original',
        role: 'original',
        label: 'Оригинал шаблона',
        sublabel: `${bestVariant.templateLabel || 'KPI'} · слайд ${original.slide_number}`,
        score: null,
        catalogSlide: cloneSlide(original),
        slideNumber: original.slide_number,
        templateId: bestVariant.templateId || null,
      })
    }

    metricVariants.slice(0, 4).forEach((item, index) => {
      if (!item.catalogSlide) return
      const catalogSlide = finalizeScenarioPreviewSlide(
        report,
        item.catalogSlide,
        metricSpec,
        relevantComponents,
        { mode: 'metric', includeDescription: false },
      )
      variants.push({
        key: index === 0 ? 'best' : `alt-${index}`,
        role: index === 0 ? 'best' : 'alternative',
        label: index === 0 ? 'KPI layout' : `KPI ${index + 1}`,
        sublabel: [
          item.placementLabel || item.templateLabel || item.templateId,
          item.templateLabel && item.placementLabel ? item.templateLabel : null,
          `слайд ${item.slideNumber}`,
        ].filter(Boolean).join(' · '),
        score: item.score,
        catalogSlide,
        componentId: item.componentId || null,
        slideNumber: item.slideNumber,
        templateId: item.templateId || null,
        titlePositionKey: item.titlePositionKey || null,
        dataBlock: 'metrics',
      })
    })

    return variants
  }

  if (buildResult?.match?.graphicMeta) {
    const graphicMeta = buildResult.match.graphicMeta
    const contextBlock = graphicMeta.kind === 'chart'
      ? 'charts'
      : graphicMeta.kind === 'table'
        ? 'tables'
        : 'diagrams'
    const primaryRec = relevantComponents?.recommendations?.find((item) => (
      item.slot === graphicMeta.kind && item.best
    )) || {
      slot: graphicMeta.kind,
      context_block: contextBlock,
      best: {
        component_id: graphicMeta.componentId,
        score: graphicMeta.score,
      },
    }

    const matches = matchGraphicComponents(report, spec, contextBlock, { limit: 8 })
    if (matches.length) {
      const variants = []
      const originalSlide = resolveOriginalTemplateSlide(report, matches[0], primaryRec.slot)
      if (originalSlide) {
        variants.push({
          key: 'original',
          role: 'original',
          label: 'Оригинал шаблона',
          sublabel: formatOriginalSublabel(originalSlide, primaryRec.best),
          score: null,
          catalogSlide: originalSlide,
        })
      }

      expandMatchesWithSimilarTemplates(report, matches, 12, substrateExpandOptions(
        spec,
        buildResult?.selectionContext,
        Math.max(1, spec?.[contextBlock]?.length || 1),
      )).forEach((matchEntry, index) => {
        const catalogSlide = buildCatalogVariant(report, spec, primaryRec, matchEntry, relevantComponents)
        if (!catalogSlide) return

        const templateName = templateLabel(report, matchEntry.templateId)
        variants.push({
          key: index === 0 ? 'best' : `alt-${index}`,
          role: index === 0 ? 'best' : 'alternative',
          label: index === 0 ? `${graphicMeta.kind} layout` : `Вариант ${index + 1}`,
          sublabel: `${matchEntry.component.label} · ${templateName || matchEntry.templateId || '—'}`,
          score: matchEntry.score,
          reasons: matchEntry.reasons?.slice(0, 2) || [],
          catalogSlide,
          componentId: matchEntry.component.id,
          templateId: matchEntry.templateId || null,
          titlePositionKey: matchEntry.titlePositionKey || null,
          dataBlock: contextBlock,
        })
      })

      if (variants.length) return variants
    }
  }

  if (buildResult?.match?.textMeta && textVariants.length) {
    const variants = []
    const bestVariant = textVariants[0]
    const textSpec = specForDataBlock(spec, 'title_text')

    const original = findSlide(report, bestVariant.slideNumber)
    if (original) {
      variants.push({
        key: 'original',
        role: 'original',
        label: 'Оригинал шаблона',
        sublabel: `${bestVariant.templateLabel || 'title+text'} · слайд ${original.slide_number}`,
        score: null,
        catalogSlide: cloneSlide(original),
        slideNumber: original.slide_number,
        templateId: bestVariant.templateId || null,
      })
    }

    textVariants.slice(0, 4).forEach((item, index) => {
      if (!item.catalogSlide) return
      const catalogSlide = finalizeScenarioPreviewSlide(
        report,
        item.catalogSlide,
        textSpec,
        relevantComponents,
        { mode: 'text', includeDescription: Boolean(textSpec.text) },
      )
      variants.push({
        key: index === 0 ? 'best' : `alt-${index}`,
        role: index === 0 ? 'best' : 'alternative',
        label: index === 0 ? 'Title + text' : `Шаблон ${index + 1}`,
        sublabel: [
          item.placementLabel || item.templateLabel || item.templateId,
          item.templateLabel && item.placementLabel ? item.templateLabel : null,
          `слайд ${item.slideNumber}`,
        ].filter(Boolean).join(' · '),
        score: item.score,
        catalogSlide,
        componentId: item.componentId || null,
        slideNumber: item.slideNumber,
        templateId: item.templateId || null,
        titlePositionKey: item.titlePositionKey || null,
        dataBlock: 'title_text',
      })
    })

    return variants
  }

  if (buildResult?.match?.textMeta && buildResult.catalogSlide) {
    const meta = buildResult.match.textMeta
    const variants = []
    const textSpec = specForDataBlock(spec, 'title_text')
    const original = findSlide(report, meta.slideNumber)
    if (original) {
      variants.push({
        key: 'original',
        role: 'original',
        label: 'Оригинал шаблона',
        sublabel: `${meta.templateLabel || 'title+text'} · слайд ${original.slide_number}`,
        score: null,
        catalogSlide: cloneSlide(original),
      })
    }
    variants.push({
      key: 'best',
      role: 'best',
      label: 'Title + text',
      sublabel: [
        meta.templateLabel,
        meta.hasDescription ? 'title + описание' : 'title',
        meta.score != null ? `score ${meta.score}` : null,
      ].filter(Boolean).join(' · '),
      score: meta.score,
      catalogSlide: finalizeScenarioPreviewSlide(
        report,
        buildResult.catalogSlide,
        textSpec,
        relevantComponents,
        { mode: 'text', includeDescription: Boolean(textSpec.text) },
      ),
      dataBlock: 'title_text',
    })
    return variants
  }

  if (buildResult?.match?.repeatMeta) {
    const contextBlock = buildResult.match.repeatMeta.contextBlock
    const nativeQuotes = contextBlock === 'quotes'
      ? buildQuoteTemplateVariants(report, {
        ...spec,
        persons: buildResult.quotePersons || spec.persons || [],
      })
      : []
    const primaryRec = relevantComponents?.recommendations?.find((item) => (
      item.slot === 'repeat' && item.context_block === contextBlock && item.best
    ))
    const needed = Math.max(1, spec?.[contextBlock]?.length || 1)
    const matches = matchRepeatComponentsForBlock(report, spec, contextBlock, { limit: 8 })
    const similarMatches = expandMatchesWithSimilarTemplates(
      report,
      matches,
      9,
      substrateExpandOptions(spec, buildResult?.selectionContext, needed),
    )
    if (similarMatches.length) {
      const variants = []
      similarMatches.forEach((matchEntry, index) => {
        const catalogSlide = buildCatalogVariant(
          report,
          spec,
          primaryRec || {
            slot: 'repeat',
            context_block: contextBlock,
            best: { component_id: matchEntry.component?.id },
          },
          matchEntry,
          relevantComponents,
        )
        if (!catalogSlide) return
        variants.push({
          key: index === 0 ? 'best' : `repeat-${index}`,
          role: index === 0 ? 'best' : 'alternative',
          label: index === 0 ? 'Повторяемый компонент' : `Вариант ${index + 1}`,
          sublabel: `${matchEntry.component.label} · ${templateLabel(report, matchEntry.templateId) || matchEntry.templateId || '—'}`,
          score: matchEntry.score,
          reasons: matchEntry.reasons?.slice(0, 2) || [],
          catalogSlide,
          componentId: matchEntry.component.id,
          templateId: matchEntry.templateId || null,
          titlePositionKey: matchEntry.titlePositionKey || null,
          dataBlock: contextBlock || 'lists',
        })
      })
      if (nativeQuotes.length || variants.length) return [...nativeQuotes, ...variants]
    }
    if (nativeQuotes.length) return nativeQuotes
  }

  const primaryRec = primaryContentRecommendation(relevantComponents, spec)
  if (!primaryRec) {
    return buildConstructorFallbackVariants(report, buildResult)
  }

  const matches = loadContentMatches(report, spec, primaryRec, buildResult?.selectionContext)
  if (!matches.length) {
    return buildConstructorFallbackVariants(report, buildResult)
  }

  const variants = []
  const originalSlide = resolveOriginalTemplateSlide(report, matches[0], primaryRec.slot)
  if (originalSlide) {
    variants.push({
      key: 'original',
      role: 'original',
      label: 'Оригинал шаблона',
      sublabel: formatOriginalSublabel(originalSlide, primaryRec.best),
      score: null,
      catalogSlide: originalSlide,
    })
  }

  expandMatchesWithSimilarTemplates(
    report,
    matches,
    4,
    substrateExpandOptions(spec, buildResult?.selectionContext, 1),
  ).forEach((matchEntry, index) => {
    const catalogSlide = buildCatalogVariant(report, spec, primaryRec, matchEntry, relevantComponents)
    if (!catalogSlide) return

    const templateName = templateLabel(report, matchEntry.templateId)
    variants.push({
      key: index === 0 ? 'best' : `alt-${index}`,
      role: index === 0 ? 'best' : 'alternative',
      label: index === 0 ? 'Лучший match' : `Вариант ${index + 1}`,
      sublabel: `${matchEntry.component.label} · ${templateName || matchEntry.templateId || '—'}`,
      score: matchEntry.score,
      reasons: matchEntry.reasons?.slice(0, 2) || [],
      catalogSlide,
      componentId: matchEntry.component.id,
      templateId: matchEntry.templateId || null,
      titlePositionKey: matchEntry.titlePositionKey || null,
      dataBlock: primaryRec.context_block || primaryRec.slot,
    })
  })

  return variants
}
