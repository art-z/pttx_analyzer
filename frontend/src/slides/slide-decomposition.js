import { collectRepeatElementIds } from '../components/from-vgroups.js'
import { isIterableRepeatComponent } from '../components/container-catalog.js'
import { listAllComponents } from '../components/catalog.js'
import { detectSlideVgroups } from './vgroup-detect.js'
import { findSlideTitleElements } from './slide-title-detect.js'
import { findSlideDescriptionElements } from './slide-description-detect.js'
import { collectGraphicExcludedElementIds } from './graphic-region-exclude.js'
import { detectSlideSingletons } from './singleton-detect.js'

function slideByNumber(report, slideNumber) {
  return (report?.slides?.slides || []).find((slide) => slide.slide_number === slideNumber) || null
}

export { collectRepeatElementIds } from '../components/from-vgroups.js'

function collectGraphicInstances(report, slideNumber) {
  const graphic = report?.graphic_components || {}
  const kinds = [
    ['table', graphic.tables || []],
    ['chart', graphic.charts || []],
    ['diagram', graphic.diagrams || []],
  ]

  const items = []
  for (const [kind, components] of kinds) {
    for (const component of components) {
      for (const instance of component.instances || []) {
        if (instance.slide_number !== slideNumber) continue
        items.push({
          kind,
          component_id: component.component_id,
          element_id: instance.element_id || null,
          element_ids: instance.element_id ? [instance.element_id] : [],
          is_baseline: Boolean(component.is_baseline),
        })
      }
    }
  }
  return items
}

function collectRepeatInstances(report, slideNumber) {
  return listAllComponents(report)
    .filter((component) => isIterableRepeatComponent(component))
    .map((component) => {
      const instances = (component.instances || []).filter((item) => item.slide_number === slideNumber)
      if (!instances.length) return null
      return {
        component_id: component.id,
        kind: 'repeat',
        pattern: component.semantics?.itemPattern || null,
        instances,
        element_ids: [...new Set(instances.flatMap((item) => item.element_ids || []))],
      }
    })
    .filter(Boolean)
}

function summarizeBlock(result) {
  if (!result?.primary) return null
  return {
    element_ids: result.elementIds || [],
    method: result.method || 'none',
    score: result.score || 0,
    text: result.primary.text || result.primary.text_sample || '',
  }
}

export function decomposeSlide(slide, report, options = {}) {
  const vgroupResult = options.vgroupResult || detectSlideVgroups(slide, { report })
  const titleResult = options.titleResult || findSlideTitleElements(slide, report)
  const repeatElementIds = options.repeatElementIds || collectRepeatElementIds(report, slide.slide_number)
  const singletonResult = detectSlideSingletons(slide, report, {
    vgroupResult,
    titleResult,
    repeatElementIds,
    reservedElementIds: options.reservedElementIds || [],
  })
  const singletonElementIds = singletonResult.singletons.flatMap((item) => item.element_ids || [])
  const descriptionResult = options.descriptionResult || findSlideDescriptionElements(slide, report, {
    excludedElementIds: singletonElementIds,
  })

  const repeats = collectRepeatInstances(report, slide.slide_number)
  const graphics = collectGraphicInstances(report, slide.slide_number)
  const graphicIds = collectGraphicExcludedElementIds(slide)

  const covered = new Set([
    ...(titleResult.elementIds || []),
    ...(descriptionResult.elementIds || []),
    ...repeatElementIds,
    ...singletonResult.singletons.flatMap((item) => item.element_ids || []),
    ...graphicIds,
    ...(options.reservedElementIds || []),
  ])

  const allContentIds = (slide.content_elements || [])
    .map((element) => element.element_id)
    .filter(Boolean)
  const uncovered = allContentIds.filter((id) => !covered.has(id))

  return {
    slide_number: slide.slide_number,
    template_id: slide.template_id || null,
    title: summarizeBlock(titleResult),
    description: summarizeBlock(descriptionResult),
    singletons: singletonResult.singletons,
    repeats,
    graphics,
    uncovered,
    coverage: {
      total_elements: allContentIds.length,
      covered_elements: allContentIds.length - uncovered.length,
      uncovered_elements: uncovered.length,
      ratio: allContentIds.length
        ? (allContentIds.length - uncovered.length) / allContentIds.length
        : 1,
    },
    vgroups: {
      group_count: vgroupResult.summary?.groupCount || 0,
      ungrouped_count: vgroupResult.summary?.ungroupedElementCount || 0,
    },
  }
}

export function decomposeDeck(report) {
  return (report?.slides?.slides || []).map((slide) => decomposeSlide(slide, report))
}

export function decomposeSlideByNumber(report, slideNumber) {
  const slide = slideByNumber(report, slideNumber)
  if (!slide) return null
  return decomposeSlide(slide, report)
}
