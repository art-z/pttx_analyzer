import { findSlide, listAllComponents } from '../components/catalog.js'
import { findSlideTitleElements } from '../slides/slide-title-detect.js'
import { patchSlideTextContent, splitContentParagraphs } from '../slides/text-content-patch.js'
import { buildExtraLines } from './build-catalog-slide.js'
import { ensureSyntheticTextElement } from '../components/synthetic-text-element.js'
import { placeTextUnderTitle } from './place-text-under-title.js'
import { contrastRatio } from './component-template-fit.js'
import { isCodeTextElement } from '../slides/text-typographer.js'
import {
  buildTitlePositionIndex,
  orderBySimilarTemplates,
  orderByTemplateDiversity,
  titlePositionKeyForTemplate,
} from './similar-templates.js'

export const TEXT_TEMPLATE_VARIANT_LIMIT = 4

function templateLabel(report, templateId) {
  if (!templateId) return null
  const template = (report?.slide_templates?.templates || []).find((item) => item.template_id === templateId)
  return template?.layout_name || templateId
}

function recommendationBySlot(relevantComponents, slot) {
  return relevantComponents?.recommendations?.find((item) => item.slot === slot) || null
}

function roundNorm(value, step = 0.05) {
  if (!Number.isFinite(value)) return null
  return Math.round(value / step) * step
}

export function descriptionPlacementKey(instance) {
  const box = instance?.container_norm || {}
  return [
    instance?.template_id || 'deck',
    roundNorm(box.y, 0.05),
    roundNorm(box.width, 0.05),
    instance?.line_count || 1,
  ].join('|')
}

function descriptionPlacementLabel(instance) {
  const box = instance?.container_norm || {}
  const width = Math.round((box.width || 0) * 100)
  const y = Math.round((box.y || 0) * 100)
  const lines = instance?.line_count || 1

  if (width >= 70) return `широкий абзац · y${y}%`
  if (lines >= 3) return `${lines} строк · w${width}%`
  return `текст · w${width}% · y${y}%`
}

// WCAG AA for large text. Donor slide shapes/images are removed in text
// previews, so the text lands on the template background (or a layout fill).
const MIN_DESCRIPTION_CONTRAST = 3
const CODE_FONT_RE = /consolas|courier|menlo|monaco|mono\b|monospace|source code|fira code/i
const HEX_COLOR_RE = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i

function normBoxContains(outer, inner, tolerance = 0.01) {
  return outer.x <= inner.x + tolerance
    && outer.y <= inner.y + tolerance
    && outer.x + outer.width >= inner.x + inner.width - tolerance
    && outer.y + outer.height >= inner.y + inner.height - tolerance
}

function effectiveTextBackground(slide, element) {
  const box = element?.geometry_norm
  const fills = (slide?.render?.layers || [])
    .filter((layer) => (
      layer.kind === 'fill'
      && HEX_COLOR_RE.test(String(layer.fill?.color || ''))
      && Number(layer.fill?.alpha ?? 1) >= 0.5
      && layer.geometry_norm
      && box
      && normBoxContains(layer.geometry_norm, box)
    ))
    .sort((left, right) => (Number(left.z_index) || 0) - (Number(right.z_index) || 0))
  return fills.at(-1)?.fill?.color || slide?.render?.background_color || '#FFFFFF'
}

// A description slot is unusable when it is really a code block (monospace /
// snippet role) or when its template colour was designed for a donor shape or
// image that the preview removes (e.g. yellow code text over a dark picture
// ends up on a white background).
export function descriptionPlacementIssue(report, instance) {
  const slide = findSlide(report, instance?.slide_number)
  if (!slide) return null
  const ids = new Set(instance?.element_ids || [])
  const elements = (slide.content_elements || [])
    .filter((element) => ids.has(element.element_id) && element.kind === 'text')
  for (const element of elements) {
    if (isCodeTextElement(element) || CODE_FONT_RE.test(String(element.typography?.family || ''))) {
      return 'code_text'
    }
    const color = String(element.typography?.color || '')
    const background = effectiveTextBackground(slide, element)
    if (HEX_COLOR_RE.test(color) && HEX_COLOR_RE.test(background)
      && contrastRatio(color, background) < MIN_DESCRIPTION_CONTRAST) {
      return 'low_contrast'
    }
  }
  return null
}

function scoreDescriptionTemplateInstance(instance, spec) {
  const text = String(spec?.text || '').trim()
  const charCount = text.length
  const width = instance?.container_norm?.width || 0
  const lines = instance?.line_count || 1
  let score = 36

  if (width >= 0.42) {
    score += 24
  } else if (width >= 0.28) {
    score += 12
  } else {
    score -= 8
  }

  if (charCount >= 80 && width >= 0.55) score += 18
  else if (charCount >= 40 && width >= 0.35) score += 12
  else if (charCount <= 60 && width < 0.35) score += 8

  if (lines >= 2 && charCount >= 50) score += 10
  if (lines >= 3 && charCount >= 90) score += 8

  if (charCount > 120 && width < 0.32) score -= 20
  if (charCount > 0 && charCount < 30 && width >= 0.7) score -= 6
  // Tall many-line boxes leave a short paragraph floating in an empty column.
  if (lines >= 6) score -= Math.min(24, (lines - 5) * 4)

  return score
}

function scoreTitleTemplateInstance(instance) {
  let score = 40
  const width = instance?.container_norm?.width || 0
  if (width >= 0.5) score += 16
  else if (width >= 0.35) score += 8
  return score
}

function resolveTextTemplateComponents(report, spec, relevantComponents) {
  const titleRec = recommendationBySlot(relevantComponents, 'slide_title')
  const descRec = recommendationBySlot(relevantComponents, 'slide_description')

  const titleComponent = titleRec?.best?.component_id
    ? listAllComponents(report).find((item) => item.id === titleRec.best.component_id)
    : listAllComponents(report).find((item) => item.kind === 'slide_title')

  const descriptionComponent = spec.text
    ? (descRec?.best?.component_id
      ? listAllComponents(report).find((item) => item.id === descRec.best.component_id)
      : listAllComponents(report).find((item) => item.kind === 'slide_description'))
    : null

  return { titleComponent, descriptionComponent }
}

export function canBuildTextCatalogSlide(report, spec, relevantComponents = null) {
  const { titleComponent, descriptionComponent } = resolveTextTemplateComponents(report, spec, relevantComponents) || {}
  const hasText = Boolean(String(spec?.text || '').trim())
  const hasTitle = Boolean(String(spec?.title || '').trim())

  if (hasText && !(descriptionComponent?.instances?.length)) return false
  if (hasTitle && !(titleComponent?.instances?.length)) return false
  return hasText || hasTitle
}

function resolveTitleInstanceForSlide(report, slideNumber, titleComponent) {
  const catalogInstance = titleComponent?.instances?.find((item) => item.slide_number === slideNumber)
  if (catalogInstance) return catalogInstance

  const slide = findSlide(report, slideNumber)
  if (!slide || !titleComponent) return null

  const detected = findSlideTitleElements(slide, report)
  if (!detected.primary) return null

  return {
    slide_number: slideNumber,
    template_id: slide.template_id || null,
    element_ids: [...(detected.elementIds || [])],
    container_norm: detected.primary.geometry_norm || null,
  }
}

function buildCandidateFromDescription(report, spec, descriptionInstance, titleComponent, descriptionComponent) {
  const slideNumber = descriptionInstance.slide_number
  const titleInstance = titleComponent
    ? resolveTitleInstanceForSlide(report, slideNumber, titleComponent)
    : null

  return {
    slideNumber,
    score: scoreDescriptionTemplateInstance(descriptionInstance, spec),
    titleComponent,
    descriptionComponent,
    titleInstance,
    descriptionInstance,
    templateId: descriptionInstance.template_id || titleInstance?.template_id || null,
    templateLabel: templateLabel(report, descriptionInstance.template_id || titleInstance?.template_id),
    placementLabel: descriptionPlacementLabel(descriptionInstance),
    selection: 'description_first',
  }
}

function buildCandidateFromTitle(report, titleInstance, descriptionComponent) {
  const slideNumber = titleInstance.slide_number
  const descriptionInstance = descriptionComponent?.instances?.find((item) => (
    item.slide_number === slideNumber
  )) || null

  return {
    slideNumber,
    score: scoreTitleTemplateInstance(titleInstance),
    titleComponent: null,
    descriptionComponent,
    titleInstance,
    descriptionInstance,
    templateId: titleInstance.template_id || descriptionInstance?.template_id || null,
    templateLabel: templateLabel(report, titleInstance.template_id || descriptionInstance?.template_id),
    placementLabel: descriptionInstance
      ? descriptionPlacementLabel(descriptionInstance)
      : `заголовок · слайд ${slideNumber}`,
    selection: 'title_only',
  }
}

export function pickFirstTextCandidate(report, spec, relevantComponents = null) {
  const { titleComponent, descriptionComponent } = resolveTextTemplateComponents(report, spec, relevantComponents) || {}
  const hasText = Boolean(String(spec?.text || '').trim())
  const hasTitle = Boolean(String(spec?.title || '').trim())

  if (hasText && descriptionComponent?.instances?.length) {
    return buildCandidateFromDescription(report, spec, descriptionComponent.instances[0], titleComponent, descriptionComponent)
  }

  if (hasTitle && titleComponent?.instances?.length) {
    return buildCandidateFromTitle(report, titleComponent.instances[0], descriptionComponent)
  }

  return null
}

export function pickListTextCandidate(report, spec, relevantComponents = null) {
  if (!(spec?.lists?.length)) return null

  const { titleComponent, descriptionComponent } = resolveTextTemplateComponents(report, spec, relevantComponents) || {}

  if (descriptionComponent?.instances?.length) {
    return buildCandidateFromDescription(report, spec, descriptionComponent.instances[0], titleComponent, descriptionComponent)
  }

  if (String(spec?.title || '').trim() && titleComponent?.instances?.length) {
    const candidate = buildCandidateFromTitle(report, titleComponent.instances[0], descriptionComponent)
    if (candidate.descriptionInstance?.element_ids?.length) return candidate
    return candidate
  }

  return null
}

export function canBuildListTextCatalogSlide(report, spec, relevantComponents = null) {
  return Boolean(pickListTextCandidate(report, spec, relevantComponents))
}

export function rankTextTemplateCandidates(report, spec, relevantComponents = null, {
  limit = TEXT_TEMPLATE_VARIANT_LIMIT,
  templateUsage = null,
  lastTemplateByComponent = null,
} = {}) {
  const { titleComponent, descriptionComponent } = resolveTextTemplateComponents(report, spec, relevantComponents) || {}
  const hasText = Boolean(String(spec?.text || '').trim())
  const hasTitle = Boolean(String(spec?.title || '').trim())

  let ranked = []

  if (hasText && descriptionComponent?.instances?.length) {
    const usable = descriptionComponent.instances.filter((instance) => !descriptionPlacementIssue(report, instance))
    ranked = (usable.length ? usable : descriptionComponent.instances).map((instance) => (
      buildCandidateFromDescription(report, spec, instance, titleComponent, descriptionComponent)
    ))
  } else if (hasTitle && !hasText && titleComponent?.instances?.length) {
    ranked = titleComponent.instances.map((instance) => (
      buildCandidateFromTitle(report, instance, descriptionComponent)
    ))
  } else {
    return []
  }

  ranked.sort((left, right) => (
    right.score - left.score
    || left.slideNumber - right.slideNumber
  ))

  const placements = []
  const seenPlacements = new Set()

  for (const item of ranked) {
    const key = hasText && item.descriptionInstance
      ? descriptionPlacementKey(item.descriptionInstance)
      : `${item.templateId || 'deck'}|${item.slideNumber}`

    if (seenPlacements.has(key)) continue
    seenPlacements.add(key)
    placements.push(item)
  }

  const titlePositions = buildTitlePositionIndex(report)
  for (const item of placements) {
    item.titlePositionKey = titlePositionKeyForTemplate(titlePositions, item.templateId)
  }

  if (templateUsage || lastTemplateByComponent) {
    return orderByTemplateDiversity(placements, {
      limit,
      templateUsage,
      lastTemplateByComponent,
      componentIdOf: () => descriptionComponent?.id || titleComponent?.id || '',
    })
  }

  const diverse = orderBySimilarTemplates(placements, { limit })
  for (const item of placements) {
    if (diverse.length >= limit) break
    if (diverse.includes(item)) continue
    diverse.push(item)
  }
  return diverse
}

function hasSecondaryOnlyBlocks(spec) {
  return (spec?.tables?.length || 0) > 0
    || (spec?.charts?.length || 0) > 0
    || (spec?.diagrams?.length || 0) > 0
    || (spec?.persons?.length || 0) > 0
    || (spec?.metrics?.length || 0) > 0
    || (spec?.cards?.length || 0) > 0
    || (spec?.lists?.length || 0) > 0
    || (spec?.timelines?.length || 0) > 0
    || (spec?.icon_lists?.length || 0) > 0
}

function trackExtraLineFilled(filled, spec) {
  if (spec.cards.length) filled.push('cards')
  if (spec.lists.length) filled.push('lists')
  if (spec.timelines.length) filled.push('timelines')
  if (spec.icon_lists.length) filled.push('icon_lists')
  if (spec.metrics.length) filled.push('metrics')
  if (spec.persons.length) filled.push('persons')
  if (spec.quotes.length) filled.push('quotes')
  if (spec.snippets.length) filled.push('snippets')
}

export function buildTextCatalogSlideFromPick(report, spec, picked, { includeSecondaryGap = true } = {}) {
  const gaps = []
  const filled = []

  let catalogSlide = findSlide(report, picked.slideNumber)
  if (!catalogSlide) {
    gaps.push('title_text: исходный слайд шаблона не найден')
    return { catalogSlide: null, filled, gaps }
  }

  catalogSlide = JSON.parse(JSON.stringify(catalogSlide))

  const extraLines = buildExtraLines(spec)
  const descriptionText = [
    ...(spec.text ? splitContentParagraphs(spec.text) : []),
    ...extraLines,
  ].join('\n')

  const preparedDescription = picked.descriptionInstance?.synthetic
    ? placeTextUnderTitle(catalogSlide, report, descriptionText, { avoidOccupied: false })
    : ensureSyntheticTextElement(catalogSlide, {
      component: picked.descriptionComponent,
      instance: picked.descriptionInstance,
      kind: 'slide_description',
      text: descriptionText,
    })
  catalogSlide = preparedDescription.slide

  const preparedTitle = ensureSyntheticTextElement(catalogSlide, {
    component: picked.titleComponent,
    instance: picked.titleInstance,
    kind: 'slide_title',
    text: spec.title,
  })
  catalogSlide = preparedTitle.slide

  const descriptionElementIds = preparedDescription.elementIds
  const titleElementIds = preparedTitle.elementIds

  const keepElementIds = [...descriptionElementIds, ...titleElementIds]
  if (keepElementIds.length) {
    catalogSlide = patchSlideTextContent(catalogSlide, {
      elementIds: keepElementIds,
      text: '',
      isolate: true,
      keepElementIds,
    })
  }

  if (spec.text && !descriptionElementIds.length) {
    gaps.push('text: компонент описания не найден')
    return { catalogSlide: null, filled, gaps }
  }

  if (descriptionElementIds.length && spec.text) {
    const paragraphs = [
      ...splitContentParagraphs(spec.text),
      ...extraLines,
    ]
    catalogSlide = patchSlideTextContent(catalogSlide, {
      elementIds: descriptionElementIds,
      text: paragraphs.join('\n'),
    })
    filled.push('text')
    trackExtraLineFilled(filled, spec)
  } else if (descriptionElementIds.length && extraLines.length) {
    catalogSlide = patchSlideTextContent(catalogSlide, {
      elementIds: descriptionElementIds,
      text: extraLines.join('\n'),
    })
    trackExtraLineFilled(filled, spec)
  }

  if (spec.title && !titleElementIds.length) {
    gaps.push('title: компонент заголовка не найден')
    return { catalogSlide: null, filled, gaps }
  }

  if (titleElementIds.length && spec.title) {
    catalogSlide = patchSlideTextContent(catalogSlide, {
      elementIds: titleElementIds,
      text: spec.title,
    })
    filled.push('title')
  }

  if (extraLines.length && !descriptionElementIds.length) {
    gaps.push('text: некуда поместить списки и доп. контент без компонента описания')
  }

  if (includeSecondaryGap && hasSecondaryOnlyBlocks(spec)) {
    gaps.push('title_text: таблицы/графики/повторы пока добавлены текстом')
  }

  return {
    catalogSlide,
    filled: [...new Set(filled)],
    gaps: [...new Set(gaps)],
  }
}

function summarizeTextPick(picked, spec) {
  return {
    componentId: [
      picked.descriptionComponent?.id || 'no-description',
      picked.titleComponent?.id || 'no-title',
      picked.descriptionInstance ? descriptionPlacementKey(picked.descriptionInstance) : `slide:${picked.slideNumber}`,
    ].join('|'),
    slideNumber: picked.slideNumber,
    templateId: picked.templateId,
    templateLabel: picked.templateLabel,
    placementLabel: picked.placementLabel,
    selection: picked.selection,
    score: picked.score,
    titlePositionKey: picked.titlePositionKey || null,
    hasDescription: Boolean(picked.descriptionInstance && spec.text),
  }
}

export function buildScenarioTextCatalogSlide(report, spec, relevantComponents = null, options = {}) {
  const limit = options.limit || TEXT_TEMPLATE_VARIANT_LIMIT

  if (!String(spec?.title || '').trim() && !String(spec?.text || '').trim()) {
    return { catalogSlide: null, filled: [], gaps: [], textMeta: null, variants: [] }
  }

  if (!canBuildTextCatalogSlide(report, spec, relevantComponents)) {
    return {
      catalogSlide: null,
      filled: [],
      gaps: ['title_text: текстовые компоненты не найдены'],
      textMeta: null,
      variants: [],
    }
  }

  const candidates = rankTextTemplateCandidates(report, spec, relevantComponents, {
    limit,
    templateUsage: options.templateUsage || null,
    lastTemplateByComponent: options.lastTemplateByComponent || null,
  })
  if (!candidates.length) {
    return {
      catalogSlide: null,
      filled: [],
      gaps: ['title_text: подходящий шаблон описания не найден'],
      textMeta: null,
      variants: [],
    }
  }

  const variants = candidates.map((picked, index) => {
    const built = buildTextCatalogSlideFromPick(report, spec, picked, {
      includeSecondaryGap: index === 0,
    })
    return {
      ...summarizeTextPick(picked, spec),
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
      gaps: ['title_text: не удалось собрать ни один вариант'],
      textMeta: null,
      variants: [],
    }
  }

  return {
    catalogSlide: best.catalogSlide,
    filled: best.filled,
    gaps: best.gaps,
    textMeta: {
      ...summarizeTextPick(candidates[0], spec),
      templateLabel: best.templateLabel || templateLabel(report, best.templateId),
      selectionStrategy: 'description_first',
      alternatives: variants.slice(1, limit).map((item) => ({
        slideNumber: item.slideNumber,
        templateId: item.templateId,
        templateLabel: item.templateLabel,
        placementLabel: item.placementLabel,
        score: item.score,
        hasDescription: item.hasDescription,
      })),
    },
    variants,
  }
}
