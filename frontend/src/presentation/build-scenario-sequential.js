import { findSlide, listAllComponents, resolveComponentPreviewContext } from '../components/catalog.js'
import { buildContainerRepeatPreviewSlide } from '../components/container-render.js'
import { buildContainerModelFromContext } from '../components/component-semantics.js'
import { patchSlideTextContent } from '../slides/text-content-patch.js'
import { buildGraphicComponentPreviewSlide, buildMetricComponentPreviewSlide, resolveDescriptionElementIds, resolveTitleElementIds } from './build-catalog-slide.js'
import {
  llmChartToModelData,
  llmDiagramToModelData,
  llmTableToModelData,
} from './graphic-contract.js'
import {
  buildMetricModelPayload,
} from '../components/metric-catalog.js'
import {
  buildTextCatalogSlideFromPick,
  canBuildTextCatalogSlide,
  pickFirstTextCandidate,
  pickListTextCandidate,
} from './build-text-slide.js'
import { pickFirstMetricCatalogComponent } from './build-metric-slide.js'
import {
  matchGraphicComponents,
  matchMetricComponents,
  matchRepeatComponentsForBlock,
} from './match-relevant-components.js'
import { finalizeScenarioPreviewSlide } from './finalize-scenario-preview.js'
import { normalizeMetricItems } from './metric-contract.js'

export const SCENARIO_DATA_FILL_ORDER = [
  { key: 'title_text', label: 'Текст', blocks: ['title', 'text', 'paragraphs'] },
  { key: 'metrics', label: 'KPI', blocks: ['metrics'] },
  { key: 'tables', label: 'Таблица', blocks: ['tables'] },
  { key: 'charts', label: 'График', blocks: ['charts'] },
  { key: 'diagrams', label: 'Схема', blocks: ['diagrams'] },
  { key: 'cards', label: 'Карточки', blocks: ['cards'] },
  { key: 'lists', label: 'Нумерованный список', blocks: ['lists'] },
  { key: 'timelines', label: 'Таймлайн', blocks: ['timelines'] },
  { key: 'icon_lists', label: 'Список с иконками', blocks: ['icon_lists'] },
  { key: 'persons', label: 'Команда', blocks: ['persons'] },
  { key: 'quotes', label: 'Цитата', blocks: ['quotes'] },
]

const GRAPHIC_KIND_BY_BLOCK = {
  tables: 'table',
  charts: 'chart',
  diagrams: 'diagram',
}

const GRAPHIC_GROUP_BY_KIND = {
  table: 'tables',
  chart: 'charts',
  diagram: 'diagrams',
}

function emptyBlocks(spec) {
  return {
    paragraphs: [],
    metrics: [],
    cards: [],
    lists: [],
    timelines: [],
    icon_lists: [],
    tables: [],
    charts: [],
    diagrams: [],
    persons: [],
    quotes: [],
    snippets: [],
    images: [],
  }
}

export function sliceSpecForDataStep(spec, step) {
  const blocks = emptyBlocks(spec)
  for (const block of step.blocks) {
    if (block === 'title' || block === 'text') continue
    if (Array.isArray(spec[block])) blocks[block] = spec[block]
  }
  return {
    ...spec,
    title: spec.title || '',
    text: step.blocks.includes('text') ? spec.text : '',
    ...blocks,
  }
}

function stepHasData(spec, step) {
  if (step.key === 'title_text') {
    return Boolean(String(spec.title || '').trim() || String(spec.text || '').trim())
  }
  return (spec[step.blocks[0]] || []).length > 0
}

function resolveGraphicCatalogComponent(report, spec, relevantComponents, contextBlock) {
  const kind = GRAPHIC_KIND_BY_BLOCK[contextBlock]
  const recommendation = relevantComponents?.recommendations?.find((item) => (
    item.slot === kind && item.best?.component_id
  ))

  if (recommendation?.best?.component_id) {
    const component = listAllComponents(report).find((item) => item.id === recommendation.best.component_id)
    if (component) {
      return {
        component,
        modelData: recommendation.best.payload || null,
        templateId: recommendation.best.template_id || null,
      }
    }
  }

  const match = matchGraphicComponents(report, spec, contextBlock, { limit: 1 })[0]
  if (match?.component) {
    return {
      component: match.component,
      modelData: match.payload || null,
      templateId: match.templateId || null,
    }
  }

  const component = listAllComponents(report).find((item) => (
    item.kind === kind && item.group === GRAPHIC_GROUP_BY_KIND[kind]
  ))
  if (!component) return null

  const item = spec[contextBlock]?.[0]
  if (!item) return null

  const modelData = kind === 'table'
    ? llmTableToModelData(item, component.id)
    : kind === 'chart'
      ? llmChartToModelData(item, component.id)
      : llmDiagramToModelData(item, component.id)

  return { component, modelData, templateId: component.templates?.[0] || null }
}

function pickRepeatComponentForBlock(report, spec, relevantComponents, contextBlock) {
  const recommendation = relevantComponents?.recommendations?.find((item) => (
    item.slot === 'repeat'
    && item.context_block === contextBlock
    && item.best?.payload?.item_count > 0
  ))

  if (recommendation?.best?.component_id) {
    const component = listAllComponents(report).find((item) => item.id === recommendation.best.component_id)
    if (component) {
      const { instance } = resolveComponentPreviewContext(report, component, {
        templateId: recommendation.best.template_id || null,
      })
      if (instance) {
        const payload = recommendation.best.payload
          || buildContainerModelFromContext(component, instance, spec, { block: contextBlock })
        if (payload?.item_count) {
          const catalogSlide = buildContainerRepeatPreviewSlide(report, component, instance, { modelData: payload })
          if (catalogSlide) {
            return { component, instance, payload }
          }
        }
      }
    }
  }

  const matches = matchRepeatComponentsForBlock(report, spec, contextBlock, { limit: 8 })
  for (const match of matches) {
    const { instance } = resolveComponentPreviewContext(report, match.component, {
      templateId: match.templateId || null,
    })
    if (!instance) continue

    const payload = buildContainerModelFromContext(match.component, instance, spec, { block: contextBlock })
    if (!payload?.item_count) continue

    const catalogSlide = buildContainerRepeatPreviewSlide(report, match.component, instance, { modelData: payload })
    if (catalogSlide) {
      return { component: match.component, instance, payload }
    }
  }

  return null
}

function fillRepeatPreviewStep(report, spec, relevantComponents, contextBlock) {
  const picked = pickRepeatComponentForBlock(report, spec, relevantComponents, contextBlock)
  if (!picked) {
    return { catalogSlide: null, filled: [], gaps: [`${contextBlock}: repeat-компонент не найден`] }
  }

  const catalogSlide = buildContainerRepeatPreviewSlide(report, picked.component, picked.instance, {
    modelData: picked.payload,
  })
  if (!catalogSlide) {
    return { catalogSlide: null, filled: [], gaps: [`${contextBlock}: не удалось собрать preview`] }
  }

  const stepSpec = sliceSpecForDataStep(spec, { key: contextBlock, blocks: [contextBlock] })

  const gaps = []
  const rendered = picked.payload.item_count || spec[contextBlock]?.length || 0
  const requested = spec[contextBlock]?.length || 0
  if (rendered < requested) {
    gaps.push(`${contextBlock}: размножено ${rendered} из ${requested}`)
  }

  return {
    catalogSlide,
    filled: [contextBlock, ...(stepSpec.title ? ['title'] : []), ...(stepSpec.text ? ['text'] : [])],
    gaps,
  }
}

function fillListsStep(report, spec, relevantComponents) {
  const stepSpec = sliceSpecForDataStep(spec, { key: 'lists', blocks: ['lists'] })
  const repeatResult = fillRepeatPreviewStep(report, stepSpec, relevantComponents, 'lists')
  if (repeatResult.catalogSlide) {
    return repeatResult
  }

  const textPicked = pickListTextCandidate(report, stepSpec, relevantComponents)
  if (!textPicked) {
    return {
      catalogSlide: null,
      filled: [],
      gaps: repeatResult.gaps?.length
        ? repeatResult.gaps
        : ['lists: repeat и текстовый компонент не найдены'],
    }
  }

  const textResult = buildTextCatalogSlideFromPick(report, stepSpec, textPicked, { includeSecondaryGap: false })
  if (textResult.catalogSlide) {
    return {
      ...textResult,
      filled: [...new Set([...(textResult.filled || []), 'lists'])],
      gaps: textResult.gaps || [],
    }
  }

  return {
    catalogSlide: null,
    filled: [],
    gaps: textResult.gaps?.length ? textResult.gaps : repeatResult.gaps,
  }
}

function appendMissingMetricElements(catalogSlide, sourceSlide, elementIds) {
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

function resolveMetricCatalogComponent(report, spec, relevantComponents) {
  const { metrics } = normalizeMetricItems(spec?.metrics)
  if (!metrics.length) return null

  const recommendation = relevantComponents?.recommendations?.find((item) => (
    item.slot === 'metric' && item.best?.component_id
  ))

  if (recommendation?.best?.component_id) {
    const component = listAllComponents(report).find((item) => item.id === recommendation.best.component_id)
    if (component) {
      const { instance } = resolveComponentPreviewContext(report, component, {
        templateId: recommendation.best.template_id || null,
      })
      return {
        component,
        modelData: recommendation.best.payload
          || buildMetricModelPayload(component, metrics, instance),
        templateId: recommendation.best.template_id || component.templates?.[0] || null,
      }
    }
  }

  const match = matchMetricComponents(report, spec, { limit: 1 })[0]
  if (match?.component) {
    return {
      component: match.component,
      modelData: match.payload || buildMetricModelPayload(match.component, metrics),
      templateId: match.templateId || null,
    }
  }

  const pick = pickFirstMetricCatalogComponent(report, spec)
  if (!pick?.component) return null

  return {
    component: pick.component,
    modelData: buildMetricModelPayload(pick.component, pick.metrics, pick.component.instances?.[0]),
    templateId: pick.component.placement?.template_id || pick.component.templates?.[0] || null,
  }
}

function fillTitleTextStep(report, spec, relevantComponents) {
  if (!canBuildTextCatalogSlide(report, spec, relevantComponents)) {
    return { catalogSlide: null, filled: [], gaps: ['text: компонент не найден'] }
  }

  const picked = pickFirstTextCandidate(report, spec, relevantComponents)
  if (!picked) {
    return { catalogSlide: null, filled: [], gaps: ['text: экземпляр не найден'] }
  }

  const stepSpec = sliceSpecForDataStep(spec, { key: 'title_text', blocks: ['title', 'text'] })
  return buildTextCatalogSlideFromPick(report, stepSpec, picked, { includeSecondaryGap: false })
}

function fillMetricsStep(report, spec, relevantComponents) {
  const resolved = resolveMetricCatalogComponent(report, spec, relevantComponents)
  if (!resolved?.component) {
    return { catalogSlide: null, filled: [], gaps: ['metrics: KPI-компонент не найден в каталоге'] }
  }

  const { component, modelData, templateId } = resolved
  const preview = buildMetricComponentPreviewSlide(report, component, modelData, { templateId })
  if (!preview.catalogSlide) {
    return { catalogSlide: null, filled: [], gaps: ['metrics: не удалось собрать preview для выбранной KPI-раскладки'] }
  }

  const gaps = []
  const filled = ['metrics']
  let catalogSlide = preview.catalogSlide
  const sourceSlide = findSlide(report, catalogSlide.slide_number)

  if (spec.title) {
    const titleElementIds = resolveTitleElementIds(report, relevantComponents, catalogSlide.slide_number)
    if (titleElementIds?.length) {
      catalogSlide = appendMissingMetricElements(catalogSlide, sourceSlide, titleElementIds)
      catalogSlide = patchSlideTextContent(catalogSlide, {
        elementIds: titleElementIds,
        text: spec.title,
      })
      filled.push('title')
    } else {
      gaps.push('title: компонент заголовка не найден на слайде KPI')
    }
  }

  if (modelData.requestedCount > modelData.metrics.length) {
    gaps.push(`metrics: размножено ${modelData.metrics.length} из ${modelData.requestedCount} KPI`)
  }

  return { catalogSlide, filled: [...new Set(filled)], gaps: [...new Set(gaps)] }
}

function fillGraphicStep(report, spec, relevantComponents, contextBlock) {
  const item = spec[contextBlock]?.[0]
  if (!item) {
    return { catalogSlide: null, filled: [], gaps: [`${contextBlock}: нет данных`] }
  }

  const resolved = resolveGraphicCatalogComponent(report, spec, relevantComponents, contextBlock)
  if (!resolved?.component) {
    return { catalogSlide: null, filled: [], gaps: [`${contextBlock}: компонент не найден в каталоге`] }
  }

  const { component, modelData, templateId } = resolved
  if (!modelData) {
    return { catalogSlide: null, filled: [], gaps: [`${contextBlock}: не удалось собрать modelData`] }
  }

  const preview = buildGraphicComponentPreviewSlide(report, component, modelData, { templateId })
  if (!preview.catalogSlide) {
    return { catalogSlide: null, filled: [], gaps: [`${contextBlock}: не удалось собрать preview компонента`] }
  }

  return {
    catalogSlide: preview.catalogSlide,
    graphicElementIds: preview.graphicElementIds,
    filled: [contextBlock, ...(spec.title ? ['title'] : [])],
    gaps: spec[contextBlock].length > 1 ? [`${contextBlock}: показан 1 из ${spec[contextBlock].length}`] : [],
  }
}

function fillRepeatStep(report, spec, relevantComponents, contextBlock) {
  return fillRepeatPreviewStep(report, spec, relevantComponents, contextBlock)
}

const PREVIEW_MODE_BY_STEP = {
  title_text: 'text',
  metrics: 'metric',
  tables: 'graphic',
  charts: 'graphic',
  diagrams: 'graphic',
  cards: 'repeat',
  lists: 'repeat',
  timelines: 'repeat',
  icon_lists: 'repeat',
  persons: 'repeat',
  quotes: 'repeat',
}

function resolvePreviewMode(step, catalogSlide) {
  if (step.key === 'lists') {
    const hasRepeat = (catalogSlide?.content_elements || []).some((element) => (
      String(element.element_id).includes('__repeat_')
    ))
    return hasRepeat ? 'repeat' : 'text'
  }
  return PREVIEW_MODE_BY_STEP[step.key] || 'content'
}

function withScenarioPreviewFinalize(report, spec, relevantComponents, step, result) {
  if (!result.catalogSlide) return result

  const stepSpec = sliceSpecForDataStep(spec, step)
  const keepElementIds = [
    ...(result.graphicElementIds || []),
  ]
  return {
    ...result,
    catalogSlide: finalizeScenarioPreviewSlide(report, result.catalogSlide, stepSpec, relevantComponents, {
      mode: resolvePreviewMode(step, result.catalogSlide),
      includeDescription: step.key === 'title_text',
      keepElementIds,
    }),
  }
}

function fillDataStep(report, spec, relevantComponents, step) {
  switch (step.key) {
    case 'title_text':
      return fillTitleTextStep(report, spec, relevantComponents)
    case 'metrics':
      return fillMetricsStep(report, spec, relevantComponents)
    case 'tables':
      return fillGraphicStep(report, spec, relevantComponents, 'tables')
    case 'charts':
      return fillGraphicStep(report, spec, relevantComponents, 'charts')
    case 'diagrams':
      return fillGraphicStep(report, spec, relevantComponents, 'diagrams')
    case 'lists':
      return fillListsStep(report, spec, relevantComponents)
    case 'cards':
    case 'timelines':
    case 'icon_lists':
    case 'persons':
    case 'quotes':
      return fillRepeatStep(report, spec, relevantComponents, step.key)
    default:
      return { catalogSlide: null, filled: [], gaps: [`${step.key}: не поддерживается`] }
  }
}

export function buildScenarioSequentialSlide(report, spec, relevantComponents) {
  const dataSteps = []
  const filled = []
  const gaps = []
  let catalogSlide = null
  let stepIndex = 0

  for (const step of SCENARIO_DATA_FILL_ORDER) {
    if (!stepHasData(spec, step)) continue

    const result = withScenarioPreviewFinalize(
      report,
      spec,
      relevantComponents,
      step,
      fillDataStep(report, spec, relevantComponents, step),
    )
    stepIndex += 1

    if (result.gaps?.length) gaps.push(...result.gaps)
    if (result.filled?.length) filled.push(...result.filled)

    if (!result.catalogSlide) continue

    catalogSlide = result.catalogSlide
    dataSteps.push({
      key: step.key,
      label: step.label,
      order: stepIndex,
      catalogSlide: result.catalogSlide,
      filled: result.filled || [],
      gaps: result.gaps || [],
    })
  }

  return {
    catalogSlide,
    dataSteps,
    filled: [...new Set(filled)],
    gaps: [...new Set(gaps)],
    summary: dataSteps.map((item) => item.label).join(' → ') || null,
  }
}
