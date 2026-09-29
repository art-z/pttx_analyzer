import { buildBaselinePreviewSlide } from '../components/baseline-template.js'
import { findSlide, listAllComponents } from '../components/catalog.js'
import { buildComponentSlideView } from '../components/render.js'
import { buildTokensForTemplate, extractDesignTokens } from '../constructor/tokens.js'
import { findSlideTemplate, resolveRoleTextColor } from '../constructor/templates.js'
import { applyTextContentToElements, patchSlideTextContent, splitContentParagraphs } from '../slides/text-content-patch.js'
import { findSlideDescriptionElements } from '../slides/slide-description-detect.js'
import { findSlideTitleElements } from '../slides/slide-title-detect.js'
import { findBaselineGraphicComponent } from './find-graphic-component.js'
import { ensureSyntheticTextElement } from '../components/synthetic-text-element.js'
import { placeTextUnderTitle } from './place-text-under-title.js'
import { contrastRatio } from './component-template-fit.js'
import {
  llmChartToModelData,
  llmDiagramToModelData,
  llmTableToModelData,
} from './graphic-contract.js'

function resolveComponentInstance(component, { templateId = null, slideNumber = null } = {}) {
  const instances = component?.instances || []
  if (!instances.length) return null

  if (slideNumber != null) {
    const onSlide = instances.find((item) => item.slide_number === slideNumber)
    if (onSlide) return onSlide
  }

  if (templateId) {
    return instances.find((item) => item.template_id === templateId) || instances[0]
  }

  return instances[0]
}

function resolveComponentElementIds(report, relevantComponents, slot, slideNumber = null) {
  if (!report) return null
  const recommendation = relevantComponents?.recommendations?.find((item) => item.slot === slot)
  const fallbackKind = slot === 'slide_title' ? 'slide_title' : 'slide_description'

  const component = recommendation?.best?.component_id
    ? listAllComponents(report).find((item) => item.id === recommendation.best.component_id)
    : listAllComponents(report).find((item) => item.kind === fallbackKind)

  if (!component) return null

  const instance = resolveComponentInstance(component, {
    templateId: recommendation?.best?.template_id || null,
    slideNumber,
  })

  const elementIds = instance?.element_ids || null
  if (elementIds?.length) {
    if (slideNumber == null) return elementIds
    const slide = findSlide(report, slideNumber)
    const present = elementIds.filter((id) => (
      slide?.content_elements?.some((element) => element.element_id === id)
    ))
    if (present.length) return present
  }

  if (slideNumber != null) {
    const slide = findSlide(report, slideNumber)
    if (slide) {
      if (slot === 'slide_title') {
        const detected = findSlideTitleElements(slide, report)
        if (detected.elementIds?.size) return [...detected.elementIds]
      }
      if (slot === 'slide_description') {
        const detected = findSlideDescriptionElements(slide, report)
        if (detected.elementIds?.length) return detected.elementIds
      }
    }
  }

  return elementIds
}

function resolveTextComponentTarget(report, relevantComponents, slot, slide) {
  if (!report) return { component: null, instance: null }
  const recommendation = relevantComponents?.recommendations?.find((item) => item.slot === slot)
  const fallbackKind = slot === 'slide_title' ? 'slide_title' : 'slide_description'
  const component = recommendation?.best?.component_id
    ? listAllComponents(report).find((item) => item.id === recommendation.best.component_id)
    : listAllComponents(report).find((item) => item.kind === fallbackKind)

  if (!component) return { component: null, instance: null }
  const instance = resolveComponentInstance(component, {
    slideNumber: slide?.slide_number ?? null,
    templateId: slide?.template_id || recommendation?.best?.template_id || null,
  })
  return { component, instance }
}

function ensureTextTarget(report, slide, relevantComponents, slot, text) {
  const resolvedIds = resolveComponentElementIds(
    report,
    relevantComponents,
    slot,
    slide?.slide_number ?? null,
  ) || []
  const presentIds = resolvedIds.filter((id) => (
    slide?.content_elements?.some((element) => element.element_id === id && element.kind === 'text')
  ))
  const role = slot === 'slide_title' ? 'title' : 'body'
  const syntheticIds = (slide?.content_elements || [])
    .filter((element) => element.synthetic && element.kind === 'text' && element.role === role)
    .map((element) => element.element_id)
  const reusableIds = presentIds.length ? presentIds : syntheticIds
  if (reusableIds.length || !String(text || '').trim()) {
    return { slide, elementIds: reusableIds, created: false }
  }

  const { component, instance } = resolveTextComponentTarget(report, relevantComponents, slot, slide)
  if (slot === 'slide_description' && instance?.synthetic) {
    return placeTextUnderTitle(slide, report, text)
  }
  return ensureSyntheticTextElement(slide, {
    component,
    instance,
    kind: slot,
    text,
  })
}

export function resolveTitleElementIds(report, relevantComponents, slideNumber = null) {
  return resolveComponentElementIds(report, relevantComponents, 'slide_title', slideNumber)
}

export function resolveDescriptionElementIds(report, relevantComponents, slideNumber = null) {
  return resolveComponentElementIds(report, relevantComponents, 'slide_description', slideNumber)
}

function normalizeHexColor(value) {
  const text = String(value || '').trim()
  const short = text.match(/^#?([0-9a-f]{3})$/i)?.[1]
  if (short) return `#${short.split('').map((item) => item + item).join('').toUpperCase()}`
  const long = text.match(/^#?([0-9a-f]{6})$/i)?.[1]
  return long ? `#${long.toUpperCase()}` : null
}

function roleTextColor(report, slide, role) {
  if (!report) return null
  const template = findSlideTemplate(report, slide?.layout_source)
  if (!template) return null
  const tokens = buildTokensForTemplate(extractDesignTokens(report), template)
  return resolveRoleTextColor(template, role, tokens)
}

function textColorNeedsRepair(color, slide) {
  const normalized = normalizeHexColor(color)
  if (!normalized) return true
  const background = normalizeHexColor(slide?.render?.background_color)
  if (!background) return false
  return (contrastRatio(normalized, background) ?? 99) < 3
}

function repairPatchedTextColor(slide, elementIds, color) {
  if (!color || !elementIds?.length) return slide
  const ids = new Set(elementIds)
  let changed = false
  const content = (slide.content_elements || []).map((element) => {
    if (!ids.has(element.element_id) || element.kind !== 'text') return element
    if (!textColorNeedsRepair(element.typography?.color, slide)) return element
    changed = true
    return {
      ...element,
      typography: {
        ...(element.typography || {}),
        color,
      },
    }
  })
  return changed ? { ...slide, content_elements: content } : slide
}

export function patchCatalogSlideText(slide, {
  report = null,
  title,
  text,
  extraLines = [],
  titleElementIds = null,
  descriptionElementIds = null,
} = {}) {
  let next = JSON.parse(JSON.stringify(slide))

  if (title && titleElementIds?.length) {
    next = patchSlideTextContent(next, { elementIds: titleElementIds, text: title })
    next = repairPatchedTextColor(next, titleElementIds, roleTextColor(report, next, 'title'))
  }

  if (text && descriptionElementIds?.length) {
    next = applyTextContentToElements(next, descriptionElementIds, text)
    next = repairPatchedTextColor(next, descriptionElementIds, roleTextColor(report, next, 'body'))
  }

  const bodyLines = extraLines.filter(Boolean)
  if (bodyLines.length && descriptionElementIds?.length) {
    const existing = (next.content_elements || [])
      .filter((element) => descriptionElementIds.includes(element.element_id) && element.text)
      .map((element) => element.text)
      .join('\n')
    const merged = [existing, ...bodyLines].filter(Boolean).join('\n')
    next = applyTextContentToElements(next, descriptionElementIds, merged)
    next = repairPatchedTextColor(next, descriptionElementIds, roleTextColor(report, next, 'body'))
  }

  return next
}

export function patchCatalogSlideScenarioText(report, slide, spec, relevantComponents = null, { extraLineSkip = new Set() } = {}) {
  const extraLines = buildExtraLines(spec, { skip: extraLineSkip })
  let descriptionText = spec.text || ''
  if (descriptionText || extraLines.length) {
    const paragraphs = [
      ...(descriptionText ? splitContentParagraphs(descriptionText) : []),
      ...extraLines,
    ]
    descriptionText = paragraphs.join('\n')
  }

  const preparedTitle = ensureTextTarget(
    report,
    slide,
    relevantComponents,
    'slide_title',
    spec.title,
  )
  const preparedDescription = ensureTextTarget(
    report,
    preparedTitle.slide,
    relevantComponents,
    'slide_description',
    descriptionText,
  )

  return patchCatalogSlideText(preparedDescription.slide, {
    report,
    title: spec.title,
    text: descriptionText,
    titleElementIds: preparedTitle.elementIds,
    descriptionElementIds: preparedDescription.elementIds,
  })
}

function formatListItem(item) {
  const heading = item.heading || item.title || ''
  const body = item.body || item.text || ''
  return body && heading ? `${heading}: ${body}` : String(body || heading)
}

function formatMetric(item) {
  const title = item.title || item.value || ''
  const text = item.text || ''
  return text ? `${title} — ${text}` : String(title)
}

export function buildExtraLines(spec, { skip = new Set() } = {}) {
  const lines = []
  if (!skip.has('cards')) spec.cards.forEach((item) => lines.push(`• ${formatListItem(item)}`))
  if (!skip.has('lists')) spec.lists.forEach((item) => lines.push(`• ${formatListItem(item)}`))
  if (!skip.has('timelines')) spec.timelines.forEach((item) => lines.push(`• ${formatListItem(item)}`))
  if (!skip.has('icon_lists')) spec.icon_lists.forEach((item) => lines.push(`• ${formatListItem(item)}`))
  if (!skip.has('metrics')) spec.metrics.forEach((item) => lines.push(formatMetric(item)))
  if (!skip.has('quotes')) {
    spec.quotes.forEach((item) => {
      const heading = item.heading || item.title || ''
      const body = item.body || item.text || ''
      lines.push(`«${body}»${heading ? ` — ${heading}` : ''}`)
    })
  }
  if (!skip.has('persons')) {
    spec.persons.forEach((item) => {
      const heading = item.heading || item.name || item.title || ''
      const body = item.body || item.bio || item.text || ''
      lines.push(`${heading}${body ? ` · ${body}` : ''}`)
    })
  }
  if (!skip.has('snippets')) {
    spec.snippets.forEach((item) => lines.push(`${item.title || 'Snippet'}\n${item.code || ''}`.trim()))
  }
  return lines.filter(Boolean)
}

function resolvePrimaryGraphic(spec) {
  if (spec.charts.length) {
    const chart = spec.charts[0]
    return {
      kind: 'chart',
      modelDataFactory: (component) => llmChartToModelData(chart, component.id),
      chart,
      total: spec.charts.length,
      label: 'charts',
    }
  }
  if (spec.tables.length) {
    const table = spec.tables[0]
    return {
      kind: 'table',
      modelDataFactory: (component) => llmTableToModelData(table, component.id),
      total: spec.tables.length,
      label: 'tables',
    }
  }
  if (spec.diagrams.length) {
    const diagram = spec.diagrams[0]
    return {
      kind: 'diagram',
      modelDataFactory: (component) => llmDiagramToModelData(diagram, component.id),
      total: spec.diagrams.length,
      label: 'diagrams',
    }
  }
  return null
}

function filterConstructorGraphicGaps(gaps = []) {
  return gaps.filter((gap) => !/нет компонента для (charts|tables|diagrams)/.test(gap))
}

export function buildGraphicComponentPreviewSlide(report, component, modelData, { templateId = null } = {}) {
  const view = buildComponentSlideView(report, component, {
    templateId: templateId || component.templates?.[0] || null,
    modelData,
  })

  if (!view.slide) return { catalogSlide: null, graphicElementIds: [] }

  const graphicElementIds = []
  if (view.instance?.element_id) {
    graphicElementIds.push(view.instance.element_id)
  } else if (view.isBaselinePreview) {
    const graphic = [...(view.slide.content_elements || [])]
      .reverse()
      .find((element) => element.kind === 'table' || element.kind === 'chart' || element.kind === 'diagram')
    if (graphic?.element_id) graphicElementIds.push(graphic.element_id)
  }

  const graphicIds = new Set(graphicElementIds)
  return {
    catalogSlide: {
      ...view.slide,
      content_elements: (view.slide.content_elements || []).map((element) => (
        graphicIds.has(element.element_id)
          ? { ...element, component_data: true }
          : element
      )),
    },
    graphicElementIds,
  }
}

export function buildMetricComponentPreviewSlide(report, component, modelData, { templateId = null, instanceIndex = 0 } = {}) {
  const view = buildComponentSlideView(report, component, {
    templateId: templateId || component.templates?.[0] || null,
    instanceIndex,
    modelData,
  })

  return {
    catalogSlide: view.slide ? {
      ...view.slide,
      content_elements: (view.slide.content_elements || []).map((element) => ({
        ...element,
        component_data: true,
      })),
    } : null,
    bboxPt: view.bboxPt || null,
    bboxNorm: view.bboxNorm || null,
  }
}

function graphicRecommendation(relevantComponents, kind) {
  return (relevantComponents?.recommendations || []).find((item) => item.slot === kind && item.best) || null
}

function resolveGraphicComponent(report, primary, relevantComponents) {
  const recommendation = graphicRecommendation(relevantComponents, primary.kind)
  if (recommendation?.best?.component_id) {
    const component = listAllComponents(report).find((item) => item.id === recommendation.best.component_id)
    if (component) {
      return {
        component,
        modelData: recommendation.best.payload || primary.modelDataFactory(component),
        recommendation,
      }
    }
  }

  const component = findBaselineGraphicComponent(report, primary.kind, primary.chart?.type)
  if (!component) return null
  return {
    component,
    modelData: primary.modelDataFactory(component),
    recommendation: null,
  }
}

export function buildScenarioCatalogSlide(report, spec, match = {}, relevantComponents = null) {
  const gaps = filterConstructorGraphicGaps(match.gaps || [])
  const filled = []

  const primary = resolvePrimaryGraphic(spec)
  if (!primary) {
    return { catalogSlide: null, filled, gaps, graphicMeta: null }
  }

  const resolved = resolveGraphicComponent(report, primary, relevantComponents)
  if (!resolved?.component) {
    gaps.push(`${primary.label}: baseline-компонент не найден в шаблоне`)
    return { catalogSlide: null, filled, gaps, graphicMeta: null }
  }

  const { component, modelData, recommendation } = resolved
  const templateId = recommendation?.best?.template_id || component.templates?.[0] || null
  const preview = buildGraphicComponentPreviewSlide(report, component, modelData, { templateId })
  if (!preview.catalogSlide) {
    gaps.push(`${primary.label}: не удалось собрать preview компонента`)
    return { catalogSlide: null, filled, gaps, graphicMeta: null }
  }

  let catalogSlide = preview.catalogSlide
  catalogSlide = patchCatalogSlideScenarioText(report, catalogSlide, spec, relevantComponents)

  filled.push(primary.label)
  if (spec.title) filled.push('title')
  if (spec.text) filled.push('text')
  if (spec.cards.length) filled.push('cards')
  if (spec.lists.length) filled.push('lists')
  if (spec.timelines.length) filled.push('timelines')
  if (spec.icon_lists.length) filled.push('icon_lists')
  if (spec.metrics.length) filled.push('metrics')

  if (primary.total > 1) {
    gaps.push(`${primary.label}: показан 1 из ${primary.total}`)
  }

  if (recommendation && recommendation.best?.component_id !== component.id) {
    gaps.push(`${primary.label}: использован fallback-компонент`)
  }

  return {
    catalogSlide,
    filled,
    gaps: [...new Set(gaps)],
    graphicMeta: {
      kind: primary.kind,
      componentId: component.id,
      componentLabel: component.label,
      chartType: component.chartType || null,
      score: recommendation?.best?.score || null,
      reasons: recommendation?.best?.reasons || [],
    },
  }
}
