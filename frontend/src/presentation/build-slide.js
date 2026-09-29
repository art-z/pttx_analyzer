import { extractDesignTokens } from '../constructor/tokens.js'
import { matchTemplateForSpec } from './match-template.js'
import { normalizeSlideSpec } from './slide-spec.js'
import {
  buildScenarioSequentialSlide,
  sliceSpecForDataStep,
} from './build-scenario-sequential.js'
import { buildScenarioMetricCatalogSlide } from './build-metric-slide.js'
import { buildScenarioTextCatalogSlide } from './build-text-slide.js'
import { buildScenarioRepeatCatalogSlide } from './build-repeat-slide.js'
import {
  buildScenarioPreviewVariants,
  runScenarioVariantPipeline,
  selectDiverseVariants,
} from './build-scenario-preview-variants.js'
import { filterShellBlockGaps } from './match-catalog-blocks.js'
import { buildTitleDecorationVariant } from './build-title-decoration-slide.js'
import { buildTemplateFirstVariant } from './build-template-first-slide.js'
import { matchGraphicComponents, resolveSlideRelevantComponents } from './match-relevant-components.js'
import { buildTitlePositionIndex } from './similar-templates.js'
import { buildTerminalSlideVariants } from './build-terminal-slide.js'
import { typographSlideSpec } from '../slides/text-typographer.js'
import { buildParagraphFallbackVariants, FALLBACK_SCORE_PENALTY } from './paragraph-fallback.js'
import { deriveChartsFromSpec } from './derived-charts.js'

const DIAGRAM_INTENTS = new Set(['process', 'workflow', 'architecture', 'solution'])
const CHART_INTENTS = new Set(['timeline', 'roadmap'])
const TABLE_INTENTS = new Set(['comparison', 'table'])
const METRIC_INTENTS = new Set(['metrics', 'problem', 'summary'])
const REPEAT_INTENTS = new Set(['features', 'team', 'quote', 'timeline', 'roadmap'])
const REPEAT_BLOCKS = ['cards', 'lists', 'timelines', 'icon_lists', 'persons', 'quotes']
const RICH_BLOCKS = [...REPEAT_BLOCKS, 'metrics', 'tables', 'charts', 'diagrams']

export function resolveTerminalRole(position, totalSlides) {
  if (!Number.isInteger(position) || !Number.isInteger(totalSlides) || totalSlides <= 0) return null
  if (position === 0) return 'initial'
  if (position === totalSlides - 1) return 'final'
  return null
}

export function prioritizeTerminalVariant(variants, terminalRole) {
  if (!terminalRole) return variants
  const preferred = variants.find((item) => (
    item.terminalRole === terminalRole && item.preferredTerminal
  )) || variants.find((item) => item.terminalRole === terminalRole)
  if (!preferred || variants[0] === preferred) return variants
  return [preferred, ...variants.filter((item) => item !== preferred)]
}

export function promoteChartPrimaryVariant(spec, variants, { terminalRole = null } = {}) {
  if (terminalRole || !Array.isArray(variants) || variants.length < 2) return variants
  if (variants[0]?.dataBlock === 'charts') return variants
  const wantsChart = (spec?.charts?.length || 0) > 0 || (spec?.derived_charts?.length || 0) > 0
  if (!wantsChart) return variants
  const chart = variants.find((item) => item?.dataBlock === 'charts' && (item.catalogSlide || item.constructorSlide))
  if (!chart) return variants
  return [chart, ...variants.filter((item) => item !== chart)]
}

function hasRepeatContext(spec) {
  return REPEAT_BLOCKS.some((block) => spec[block]?.length)
}

function primaryRepeatContextBlock(relevantComponents) {
  return [...(relevantComponents?.recommendations || [])]
    .filter((item) => item.slot === 'repeat' && item.best?.payload?.item_count > 0)
    .sort((left, right) => (right.best?.score || 0) - (left.best?.score || 0))[0]
    ?.context_block || null
}

function specForDataBlock(spec, block) {
  const blocks = block === 'title_text'
    ? ['title', 'text', 'paragraphs']
    : [block]
  return sliceSpecForDataStep(spec, { key: block, blocks })
}

function primaryGraphicBlock(spec) {
  if (TABLE_INTENTS.has(spec.intent) && spec.tables.length) return 'tables'
  if (CHART_INTENTS.has(spec.intent) && spec.charts.length) return 'charts'
  if (DIAGRAM_INTENTS.has(spec.intent) && spec.diagrams.length) return 'diagrams'
  if (spec.charts.length) return 'charts'
  if (spec.tables.length) return 'tables'
  if (spec.diagrams.length) return 'diagrams'
  return null
}

function buildVariantSeed(report, spec, relevantComponents, sequential, match) {
  const specializedGraphic = primaryGraphicBlock(spec)
  const hasExplicitGraphicIntent = specializedGraphic && (
    (TABLE_INTENTS.has(spec.intent) && spec.tables.length)
    || (CHART_INTENTS.has(spec.intent) && spec.charts.length && !spec.timelines.length)
    || (DIAGRAM_INTENTS.has(spec.intent) && spec.diagrams.length)
  )

  // Strong content intents keep their native component. On regular slides,
  // follow the requested preference: narrative text, repeatables, then KPIs.
  if (hasExplicitGraphicIntent) {
    return buildGraphicSeed(report, spec, relevantComponents, sequential, match, specializedGraphic)
  }

  if (REPEAT_INTENTS.has(spec.intent) && hasRepeatContext(spec)) {
    const contextBlock = primaryRepeatContextBlock(relevantComponents)
    const repeatSpec = contextBlock ? specForDataBlock(spec, contextBlock) : spec
    const result = buildScenarioRepeatCatalogSlide(report, repeatSpec, relevantComponents, match)
    if (result.catalogSlide) return {
      ...result,
      primaryBlock: result.repeatMeta?.contextBlock || 'lists',
      match: { ...match, repeatMeta: result.repeatMeta },
    }
  }

  if (METRIC_INTENTS.has(spec.intent) && spec.metrics.length) {
    const result = buildScenarioMetricCatalogSlide(
      report,
      specForDataBlock(spec, 'metrics'),
      relevantComponents,
      { limit: 6 },
    )
    return {
      ...result,
      primaryBlock: 'metrics',
      metricTemplateVariants: result.variants,
      match: { ...match, metricMeta: result.metricMeta },
    }
  }

  if (String(spec.text || '').trim()) {
    const result = buildScenarioTextCatalogSlide(
      report,
      specForDataBlock(spec, 'title_text'),
      relevantComponents,
      { limit: 6 },
    )
    if (result.catalogSlide) return {
      ...result,
      primaryBlock: 'title_text',
      textTemplateVariants: result.variants,
      match: { ...match, textMeta: result.textMeta },
    }
  }

  if (hasRepeatContext(spec)) {
    const contextBlock = primaryRepeatContextBlock(relevantComponents)
    const repeatSpec = contextBlock ? specForDataBlock(spec, contextBlock) : spec
    const result = buildScenarioRepeatCatalogSlide(report, repeatSpec, relevantComponents, match)
    if (result.catalogSlide) return {
      ...result,
      primaryBlock: result.repeatMeta?.contextBlock || null,
      match: { ...match, repeatMeta: result.repeatMeta },
    }
  }

  // KPI components require explicit metric data from the model contract.
  if (spec.metrics.length) {
    const result = buildScenarioMetricCatalogSlide(
      report,
      specForDataBlock(spec, 'metrics'),
      relevantComponents,
      { limit: 6 },
    )
    return {
      ...result,
      primaryBlock: 'metrics',
      metricTemplateVariants: result.variants,
      match: { ...match, metricMeta: result.metricMeta },
    }
  }

  const graphicBlock = specializedGraphic || primaryGraphicBlock(spec)
  if (graphicBlock) {
    return buildGraphicSeed(report, spec, relevantComponents, sequential, match, graphicBlock)
  }

  const result = buildScenarioTextCatalogSlide(
    report,
    specForDataBlock(spec, 'title_text'),
    relevantComponents,
    { limit: 6 },
  )
  return {
    ...result,
    primaryBlock: 'title_text',
    textTemplateVariants: result.variants,
    match: { ...match, textMeta: result.textMeta },
  }
}

function buildGraphicSeed(report, spec, relevantComponents, sequential, match, graphicBlock) {
  const kind = { tables: 'table', charts: 'chart', diagrams: 'diagram' }[graphicBlock]
  const best = matchGraphicComponents(report, spec, graphicBlock, { limit: 1 })[0]
  return {
    catalogSlide: sequential.dataSteps.find((item) => item.key === graphicBlock)?.catalogSlide || sequential.catalogSlide,
    primaryBlock: graphicBlock,
    filled: sequential.filled,
    gaps: sequential.gaps,
    match: {
      ...match,
      graphicMeta: best ? {
        kind,
        componentId: best.component.id,
        score: best.score,
      } : null,
    },
  }
}

function sequentialFallbackVariants(sequential, primaryBlock = null) {
  const scoreByBlock = {
    metrics: 34,
    tables: 33,
    charts: 32,
    diagrams: 32,
    timelines: 28,
    cards: 27,
    lists: 26,
    icon_lists: 26,
    persons: 26,
    quotes: 26,
    title_text: 12,
  }
  // Sequential previews do not carry a verified component/template pairing.
  // Only source-bound text/KPI layouts (and text-backed lists) may fall back
  // here; repeats and graphics must go through the fitted-template registry.
  const sourceBound = (step) => step.key === 'title_text' || step.key === 'metrics'
    || (step.key === 'lists' && !(step.catalogSlide?.content_elements || []).some((element) => (
      String(element.element_id || '').includes('__repeat_')
    )))
  return (sequential.dataSteps || []).filter((step) => (
    step.key !== primaryBlock && sourceBound(step)
  )).map((step, index) => ({
    key: `data-${step.key}`,
    role: index === 0 ? 'best' : 'alternative',
    label: step.label,
    sublabel: `Вариант по данным: ${step.label}`,
    score: (scoreByBlock[step.key] || 18) - index * 0.01,
    catalogSlide: step.catalogSlide,
    dataBlock: step.key,
  }))
}

function buildCandidatesForAllContexts(report, spec, relevantComponents, seed, selectionContext = null) {
  const candidates = []
  const contexts = []
  const addContext = (block, blockSpec, buildResult) => {
    const generated = buildScenarioPreviewVariants(
      report,
      blockSpec,
      relevantComponents,
      { ...buildResult, selectionContext },
    )
    const local = runScenarioVariantPipeline(generated, {
      spec: blockSpec,
      intent: spec.intent,
      seed: `${seed}|${block}`,
      limit: 10,
      report,
      selectionContext,
      // The shortlist keeps several templates of one chart kind; the final
      // pick still shows a chart family once.
      dedupeChartFamilies: false,
    })
    const selected = local.variants.map((item, index) => ({
      ...item,
      key: `${block}:${item.key || index + 1}`,
      contextRank: index + 1,
      // A chart built from the slide's KPI/table numbers re-draws data another
      // variant already shows; selection reserves it a slot instead of letting
      // it compete as a brand-new content type.
      ...(block === 'charts' && !spec.charts?.length ? { derivedChart: true } : {}),
    }))
    candidates.push(...selected)
    contexts.push({
      block,
      generated: local.diagnostics.generated,
      eligible: local.diagnostics.eligible,
      selected: selected.length,
      selected_variants: local.diagnostics.selected_variants,
      rejected: local.diagnostics.rejected,
    })
  }

  if (spec.title || spec.text || spec.paragraphs?.length) {
    const blockSpec = specForDataBlock(spec, 'title_text')
    const result = buildScenarioTextCatalogSlide(report, blockSpec, relevantComponents, {
      limit: 6,
      templateUsage: selectionContext?.templateUsage || null,
      lastTemplateByComponent: selectionContext?.lastTemplateByComponent || null,
    })
    addContext('title_text', blockSpec, {
      catalogSlide: result.catalogSlide,
      textTemplateVariants: result.variants,
      match: { textMeta: result.textMeta },
    })
  }

  if (spec.metrics?.length) {
    const blockSpec = specForDataBlock(spec, 'metrics')
    const result = buildScenarioMetricCatalogSlide(report, blockSpec, relevantComponents, {
      limit: 6,
      templateUsage: selectionContext?.templateUsage || null,
      lastTemplateByComponent: selectionContext?.lastTemplateByComponent || null,
    })
    addContext('metrics', blockSpec, {
      catalogSlide: result.catalogSlide,
      metricTemplateVariants: result.variants,
      match: { metricMeta: result.metricMeta },
    })
  }

  for (const block of REPEAT_BLOCKS) {
    if (!spec[block]?.length) continue
    const blockSpec = specForDataBlock(spec, block)
    addContext(block, blockSpec, {
      match: { repeatMeta: { contextBlock: block } },
      quotePersons: block === 'quotes' ? spec.persons : [],
    })
  }

  for (const [block, kind] of Object.entries({ tables: 'table', charts: 'chart', diagrams: 'diagram' })) {
    // Without an explicit chart, numbers already in the context (same-unit
    // KPIs, comparison tables) still get a chart candidate.
    const items = block === 'charts' && !spec.charts?.length ? spec.derived_charts || [] : spec[block] || []
    if (!items.length) continue
    const blockSpec = { ...specForDataBlock(spec, block), [block]: items }
    addContext(block, blockSpec, {
      match: { graphicMeta: { kind } },
    })
  }

  return { candidates, contexts }
}

function buildScenarioSlideForTitle(report, rawSlide, baseTokens = null, {
  selectionContext = null,
  seed: selectionSeed = '',
  position = null,
  totalSlides = null,
} = {}) {
  const typographed = typographSlideSpec(normalizeSlideSpec(rawSlide))
  const spec = { ...typographed, derived_charts: deriveChartsFromSpec(typographed) }
  const tokens = baseTokens || extractDesignTokens(report)
  const relevantComponents = resolveSlideRelevantComponents(report, spec, tokens)
  const match = matchTemplateForSpec(report, spec, tokens)
  const narrativeGaps = spec.metric_issues?.length
    ? [`metrics: отклонено неполных KPI — ${spec.metric_issues.length}`]
    : []

  const sequential = buildScenarioSequentialSlide(report, spec, relevantComponents)
  const seed = buildVariantSeed(report, spec, relevantComponents, sequential, match)
  const variantBuildResult = {
    ...seed,
    tokens,
    match: seed.match || match,
  }
  const selectionKey = selectionSeed || `${spec.index ?? ''}|${spec.title}|${spec.intent}`
  const contextBuild = buildCandidatesForAllContexts(
    report,
    spec,
    relevantComponents,
    selectionKey,
    selectionContext,
  )
  const blocksWithCandidates = new Set(contextBuild.candidates.map((item) => item.dataBlock))
  const previewCandidates = [
    ...contextBuild.candidates,
    ...sequentialFallbackVariants(sequential, null)
      .filter((item) => !blocksWithCandidates.has(item.dataBlock)),
  ]
  const terminalRole = resolveTerminalRole(position, totalSlides)
  let terminalCandidates = []
  if (terminalRole) {
    terminalCandidates = buildTerminalSlideVariants(report, spec, terminalRole, { relevantComponents, selectionContext })
    previewCandidates.push(...terminalCandidates)
  }
  const fallbackSlide = seed.catalogSlide || sequential.catalogSlide || null
  if (!terminalRole &&
    fallbackSlide
    && (seed.primaryBlock === 'title_text' || seed.primaryBlock === 'metrics')
    && !previewCandidates.some((item) => item.catalogSlide || item.constructorSlide)
  ) {
    previewCandidates.push({
      key: 'fallback',
      role: 'best',
      label: 'Базовый вариант',
      sublabel: 'Совместимая компоновка',
      score: 0,
      catalogSlide: fallbackSlide,
      dataBlock: seed.primaryBlock || 'content',
    })
  }
  const titlePositions = buildTitlePositionIndex(report)
  const hasRichData = RICH_BLOCKS.some((block) => spec[block]?.length)
  // Decoration is a data-driven variant (images supplied), not an intent one.
  const wantsImages = spec.images?.length > 0
  if (wantsImages) {
    const decoration = buildTitleDecorationVariant(report, spec, { seed: selectionKey })
    if (decoration) previewCandidates.push(decoration)
  }
  // A dense arbitrary slide is only a last resort when the component-based
  // text path produced no candidate at all.
  if (!hasRichData && (spec.title || spec.text)
    && !previewCandidates.some((item) => item.dataBlock === 'title_text')) {
    const templateFirst = buildTemplateFirstVariant(report, spec, { seed: selectionKey })
    if (templateFirst) previewCandidates.push(templateFirst)
  }
  // A terminal position has a deliberately smaller content contract: title
  // and text, plus contextual people when supplied. Do not let rich-content
  // candidates from the ordinary slide pipeline compete for the cover/ending.
  const selectionCandidates = terminalRole
    ? [
      ...terminalCandidates,
      ...previewCandidates.filter((item) => (
        item.dataBlock === 'title_text'
        && !terminalCandidates.some((terminal) => (
          (terminal.templateId || terminal.catalogSlide?.layout_source)
          === (item.templateId || item.catalogSlide?.layout_source)
        ))
      )),
    ]
    : previewCandidates
  let variantPipeline = runScenarioVariantPipeline(selectionCandidates, {
    spec,
    intent: spec.intent,
    selectionContext,
    seed: selectionKey,
    report,
    titlePositionByTemplate: titlePositions.keyByTemplateId,
    allowLayoutIssues: Boolean(terminalRole),
    terminalMode: Boolean(terminalRole),
  })
  if (terminalRole && terminalCandidates.length && !variantPipeline.variants.length) {
    // If the parser-marked templates cannot fit this copy, fall back only to
    // text layouts. Rich-content blocks are still out of scope for bookends.
    variantPipeline = runScenarioVariantPipeline(
      previewCandidates.filter((item) => item.dataBlock === 'title_text'),
      {
        spec,
        intent: spec.intent,
        selectionContext,
        seed: selectionKey,
        report,
        titlePositionByTemplate: titlePositions.keyByTemplateId,
        allowLayoutIssues: true,
        terminalMode: true,
      },
    )
  }
  variantPipeline.diagnostics.contexts = contextBuild.contexts
  const previewVariants = promoteChartPrimaryVariant(
    spec,
    prioritizeTerminalVariant(variantPipeline.variants, terminalRole),
    { terminalRole },
  )
  const selected = previewVariants[0] || null
  const hasPreview = Boolean(selected?.catalogSlide || selected?.constructorSlide)

  return {
    spec,
    report,
    slide: null,
    catalogSlide: selected?.catalogSlide || (terminalRole ? null : seed.catalogSlide || sequential.catalogSlide),
    dataSteps: sequential.dataSteps,
    previewVariants,
    selectedVariantKey: selected?.key || null,
    selectedDataBlock: selected?.dataBlock || null,
    candidatePipeline: variantPipeline.diagnostics,
    renderMode: hasPreview ? 'catalog' : 'none',
    tokens,
    match: {
      ...match,
      templateName: selected?.sublabel || seed.match?.templateName || match.templateItem?.name || null,
      shellId: match.templateItem?.template?.shell_id || null,
      graphicMeta: seed.match?.graphicMeta || null,
      repeatMeta: seed.match?.repeatMeta || null,
      textMeta: seed.match?.textMeta || null,
      metricMeta: seed.match?.metricMeta || null,
    },
    filled: [...new Set([...(seed.filled || []), ...sequential.filled])],
    gaps: filterShellBlockGaps(report, [...new Set([
      ...narrativeGaps,
      ...(seed.gaps || []),
      ...sequential.gaps,
      ...(selected?.gaps || []),
      ...(hasPreview ? [] : match.gaps),
      ...relevantComponents.gaps,
    ])]),
    relevantComponents,
  }
}

function titleCandidateScore(variant, title, preference) {
  const catalogSlide = variant?.catalogSlide
  if (!catalogSlide) return -100
  const normalize = (value) => String(value || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim()
  const expected = normalize(title)
  const titleElement = (catalogSlide.content_elements || []).find((element) => (
    element.kind === 'text' && normalize(element.text) === expected
  ))
  if (!titleElement) return -20
  // Cover/ending titles already sit in a box fitted to this exact text (see
  // terminal-text-area.js), so box occupancy says nothing; prefer the title
  // length that needed the least font shrinking.
  if (titleElement.text_area_normalized) {
    const collided = (catalogSlide.layout_validation?.issues || []).some((issue) => (
      ['text_overflow', 'text_overlap', 'outside_slide'].includes(issue.code)
      && [issue.element_id, ...(issue.element_ids || [])].includes(titleElement.element_id)
    ))
    if (collided) return -100
    // Shrinking only counts below a comfortable cover size (40pt): a 126pt
    // display title that comes down to 54pt is still big.
    const scale = Number(titleElement.text_area_scale) || 1
    const font = Number(titleElement.typography?.size_pt) || 0
    const designed = scale > 0 ? font / scale : font
    const comfort = designed > 0 ? Math.min(1, font / Math.min(designed, 40)) : 1
    return 20 - (1 - comfort) * 12 + (preference === 'middle' ? 0.3 : 0)
  }
  const box = titleElement.geometry_pt || {}
  const font = Number(titleElement.typography?.size_pt) || 0
  const width = Number(box.width_pt) || 0
  const height = Number(box.height_pt) || 0
  const charsPerLine = width > 0 && font > 0 ? Math.max(1, Math.floor(width / (font * 0.44))) : 0
  const requiredLines = charsPerLine > 0
    ? String(titleElement.text).split('\n').reduce((total, line) => total + Math.max(1, Math.ceil(line.length / charsPerLine)), 0)
    : 0
  const availableLines = font > 0 ? height / (font * 1.12) : 0
  const ids = new Set([titleElement.element_id])
  const titleCollision = (catalogSlide.layout_validation?.issues || []).some((issue) => (
    ['text_overflow', 'text_overlap', 'outside_slide'].includes(issue.code)
    && [issue.element_id, ...(issue.element_ids || [])].some((id) => ids.has(id))
  ))
  if (titleCollision || (requiredLines > availableLines * 1.2 && requiredLines - availableLines >= 0.8)) return -100
  const occupancy = availableLines > 0 ? Math.min(2, requiredLines / availableLines) : 0.5
  return 20 - Math.abs(occupancy - 0.7) * 8 + (preference === 'middle' ? 0.3 : 0)
}

export function selectBestTitleVariants(builds) {
  const bestByTemplate = new Map()
  for (const build of builds) {
    for (const [rank, variant] of (build.result.previewVariants || []).entries()) {
      // One entry per placement across the title builds. Donor slide and
      // component are part of the identity: several KPI donors may share one
      // "free layout" template id and are still different variants.
      const identity = [
        variant.templateId || variant.catalogSlide?.template_id || variant.catalogSlide?.layout_source || variant.key,
        variant.dataBlock || '',
        variant.slideNumber || variant.catalogSlide?.slide_number || '',
        variant.componentId || '',
      ].join('|')
      const score = titleCandidateScore(variant, build.title, build.key)
        - rank * 2 - Number(variant.terminalHitIssues || 0) * 100
      const old = bestByTemplate.get(identity)
      if (!old || score > old.score) {
        bestByTemplate.set(identity, {
          variant: {
            ...variant,
            key: `${identity}|title:${build.key}`,
            titleVariant: build.key,
            titleText: build.title,
            titleFitScore: score,
          },
          score,
        })
      }
    }
  }
  return [...bestByTemplate.values()]
    .filter((entry) => entry.score > -100)
    .sort((left, right) => right.score - left.score)
    .map((entry) => entry.variant)
}

// Cover/ending variants merged across title builds: keep one per visual family
// (base layout name + background class) as long as enough families remain.
export function dedupeTerminalFamilies(ranked, limit = 3) {
  const seen = new Set()
  const keep = []
  const duplicates = []
  for (const item of ranked || []) {
    if (!item?.terminalRole || !item.visualFamily) {
      keep.push(item)
    } else if (seen.has(item.visualFamily)) {
      duplicates.push(item)
    } else {
      seen.add(item.visualFamily)
      keep.push(item)
    }
  }
  return keep.length >= limit ? keep : [...keep, ...duplicates.slice(0, limit - keep.length)]
}

export function pickDiverseTitleVariants(ranked, selectionContext = null) {
  // Same rules as the per-slide pick: new content types first, never a
  // repeated template, component or chart family.
  return selectDiverseVariants(ranked, {
    limit: 3,
    scoreOf: (item) => item.titleFitScore ?? -ranked.indexOf(item),
    selectionContext,
  })
}

export function resolveTitleVariants(rawSlide) {
  const source = rawSlide?.title_options || rawSlide?.title_variants || rawSlide?.title
  return source && typeof source === 'object'
    ? ['middle', 'short', 'long'].map((key) => ({
      key,
      title: String(source[key] || (key === 'middle' ? source.medium : '') || '').trim(),
    })).filter((item) => item.title)
    : []
}

// Fewer than 3 clean variants on a regular slide: fill up with paragraph
// fallbacks (paragraph-fallback.js). Real variants keep their places and
// order; fallbacks are picked after them under the same diversity rules and
// always score below them.
export function fillWithParagraphFallback(report, rawSlide, title, variants, baseTokens = null, options = {}) {
  if (variants.length >= 3 || resolveTerminalRole(options.position, options.totalSlides)) return variants
  const spec = typographSlideSpec(normalizeSlideSpec({ ...rawSlide, title }))
  const tokens = baseTokens || extractDesignTokens(report)
  const relevantComponents = resolveSlideRelevantComponents(report, spec, tokens)
  const excludeTemplates = variants.map((item) => item.templateId || item.catalogSlide?.template_id || item.catalogSlide?.layout_source).filter(Boolean)
  const extra = buildParagraphFallbackVariants(report, spec, tokens, relevantComponents, {
    selectionContext: options.selectionContext || null,
    seed: options.seed || `${spec.index ?? ''}|${spec.title}`,
    excludeTemplates,
  }).map((item, index) => ({
    ...item,
    titleVariant: item.titleVariant || 'middle',
    titleText: title,
    titleFitScore: titleCandidateScore(item, title, 'middle') - FALLBACK_SCORE_PENALTY - index * 0.01,
  })).filter((item) => item.titleFitScore > -100 - FALLBACK_SCORE_PENALTY)
  if (!extra.length) return variants
  const real = new Map(variants.map((item, index) => [item, index]))
  return selectDiverseVariants([...variants, ...extra], {
    limit: 3,
    scoreOf: (item) => (real.has(item) ? 1e9 - real.get(item) : item.titleFitScore),
    selectionContext: options.selectionContext || null,
  })
}

export function buildScenarioSlide(report, rawSlide, baseTokens = null, options = {}) {
  const titles = resolveTitleVariants(rawSlide)
  if (titles.length < 2) {
    const title = titles[0]?.title || (typeof rawSlide?.title === 'string' ? rawSlide.title : '')
    const single = buildScenarioSlideForTitle(report, { ...rawSlide, title }, baseTokens, options)
    const filled = fillWithParagraphFallback(report, rawSlide, title, single.previewVariants || [], baseTokens, options)
    if (filled === single.previewVariants || !filled.length) return single
    return { ...single, catalogSlide: filled[0].catalogSlide, previewVariants: filled, selectedVariantKey: filled[0].key, selectedDataBlock: filled[0].dataBlock }
  }

  const builds = titles.map(({ key, title }) => ({
    key,
    title,
    result: buildScenarioSlideForTitle(report, { ...rawSlide, title }, baseTokens, options),
  }))
  const result = builds[0].result
  const middle = titles.find((item) => item.key === 'middle') || titles[0]
  const variants = fillWithParagraphFallback(
    report,
    rawSlide,
    middle.title,
    pickDiverseTitleVariants(dedupeTerminalFamilies(selectBestTitleVariants(builds)), options.selectionContext),
    baseTokens,
    options,
  )
  if (!variants.length) {
    const fallback = builds.find((build) => build.key === 'short')?.result || result
    const fallbackVariants = pickDiverseTitleVariants(fallback.previewVariants || [], options.selectionContext)
    return { ...fallback, previewVariants: fallbackVariants }
  }
  const terminalRole = resolveTerminalRole(options.position, options.totalSlides)
  const promoted = promoteChartPrimaryVariant(result.spec || rawSlide, variants, { terminalRole })
  return {
    ...result,
    catalogSlide: promoted[0].catalogSlide,
    previewVariants: promoted,
    selectedVariantKey: promoted[0].key,
    selectedDataBlock: promoted[0].dataBlock,
  }
}
