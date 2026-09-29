import { listAllComponents, resolveComponentPreviewContext } from '../components/catalog.js'
import { buildContainerRepeatPreviewSlide } from '../components/container-render.js'
import { patchCatalogSlideScenarioText } from './build-catalog-slide.js'
import { validatePreviewLayout } from './preview-layout-guard.js'

const REPEAT_CONTEXT_BLOCKS = ['cards', 'lists', 'timelines', 'icon_lists', 'persons', 'quotes']

function filterConstructorRepeatGaps(gaps = []) {
  return gaps.filter((gap) => !/нет компонента для (persons|metrics|cards|lists|timelines|icon_lists|quotes)/.test(gap))
}

function repeatRecommendations(relevantComponents) {
  return (relevantComponents?.recommendations || [])
    .filter((item) => item.slot === 'repeat' && item.best?.payload?.item_count > 0)
    .sort((left, right) => (right.best?.score || 0) - (left.best?.score || 0))
}

export function buildScenarioRepeatCatalogSlide(report, spec, relevantComponents, match = {}) {
  const recommendations = repeatRecommendations(relevantComponents)
  if (!recommendations.length) {
    return { catalogSlide: null, filled: [], gaps: [], repeatMeta: null }
  }

  const primary = recommendations[0]
  const component = listAllComponents(report).find((item) => item.id === primary.best.component_id)
  if (!component) {
    return {
      catalogSlide: null,
      filled: [],
      gaps: [`${primary.context_block}: компонент ${primary.best.component_id} не найден`],
      repeatMeta: null,
    }
  }

  const { instance } = resolveComponentPreviewContext(report, component, {
    templateId: primary.best.template_id || null,
  })
  if (!instance) {
    return {
      catalogSlide: null,
      filled: [],
      gaps: [`${primary.context_block}: экземпляр компонента не найден`],
      repeatMeta: null,
    }
  }

  let catalogSlide = buildContainerRepeatPreviewSlide(report, component, instance, {
    modelData: primary.best.payload,
  })
  if (!catalogSlide) {
    return {
      catalogSlide: null,
      filled: [],
      gaps: [`${primary.context_block}: не удалось собрать repeat preview`],
      repeatMeta: null,
    }
  }

  const skipBlocks = new Set([primary.context_block])
  const repeatOnlySpec = {
    ...spec,
    text: '',
    paragraphs: [],
  }
  REPEAT_CONTEXT_BLOCKS.forEach((block) => {
    if (block !== primary.context_block) repeatOnlySpec[block] = []
  })
  catalogSlide = patchCatalogSlideScenarioText(report, catalogSlide, repeatOnlySpec, relevantComponents, {
    extraLineSkip: skipBlocks,
  })
  const layoutValidation = validatePreviewLayout(report, catalogSlide)
  if (!layoutValidation.valid) {
    return {
      catalogSlide: null,
      filled: [],
      gaps: layoutValidation.issues.map((issue) => `layout:${issue.code}`),
      repeatMeta: null,
    }
  }
  catalogSlide = { ...catalogSlide, layout_validation: layoutValidation }

  const filled = [primary.context_block]
  if (spec.title) filled.push('title')

  const gaps = filterConstructorRepeatGaps(match.gaps || [])
  recommendations.slice(1).forEach((item) => {
    if ((item.count || 0) > 0) {
      gaps.push(`${item.context_block}: показан только ${primary.context_block}`)
    }
  })

  if ((primary.count || 0) > (primary.best.payload?.item_count || 0)) {
    gaps.push(`${primary.context_block}: показано ${primary.best.payload.item_count} из ${primary.count}`)
  }

  return {
    catalogSlide,
    filled,
    gaps: [...new Set(gaps)],
    repeatMeta: {
      contextBlock: primary.context_block,
      componentId: component.id,
      componentLabel: component.label,
      templateId: primary.best.template_id || instance.template_id || null,
      score: primary.best.score || null,
      reasons: primary.best.reasons || [],
      itemCount: primary.best.payload?.item_count || 0,
    },
  }
}
