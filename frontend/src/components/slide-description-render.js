import { findSlide } from './catalog.js'
import {
  buildDescriptionTextFromWords,
  DEFAULT_DESCRIPTION_PHRASE,
  defaultSlideDescriptionModel,
} from './slide-description-catalog.js'
import { patchSlideTextContent } from '../slides/text-content-patch.js'
import { ensureSyntheticTextElement } from './synthetic-text-element.js'

function cloneSlide(slide) {
  return JSON.parse(JSON.stringify(slide))
}

export function applySlideDescriptionToSlide(report, component, instance, modelData = null) {
  const slide = cloneSlide(findSlide(report, instance.slide_number))
  if (!slide) return null

  const phrase = component.default_phrase || component.raw?.default_phrase || DEFAULT_DESCRIPTION_PHRASE
  const effectiveModel = modelData || defaultSlideDescriptionModel(component, instance)
  const text = effectiveModel.text || buildDescriptionTextFromWords(phrase, effectiveModel.word_count)
  const prepared = ensureSyntheticTextElement(slide, {
    component,
    instance,
    kind: 'slide_description',
    text,
  })
  const elementIds = prepared.elementIds

  return patchSlideTextContent(prepared.slide, {
    elementIds,
    text,
    isolate: true,
    keepElementIds: elementIds,
  })
}

export function buildSlideDescriptionPreviewView(report, component, { instance = null, instanceIndex = 0, modelData = null } = {}) {
  const resolvedInstance = instance || component.instances?.[instanceIndex] || component.instances?.[0]
  if (!resolvedInstance) return { slide: null, bboxPt: null, bboxNorm: null, instance: null }

  const slide = applySlideDescriptionToSlide(report, component, resolvedInstance, modelData)
  if (!slide) return { slide: null, bboxPt: null, bboxNorm: null, instance: null }

  const slideSizePt = slide.render?.slide_size_pt || { width: 960, height: 540 }
  const bboxPt = resolvedInstance.container || null
  const bboxNorm = resolvedInstance.container_norm || (bboxPt ? {
    x: bboxPt.x_pt / slideSizePt.width,
    y: bboxPt.y_pt / slideSizePt.height,
    width: bboxPt.width_pt / slideSizePt.width,
    height: bboxPt.height_pt / slideSizePt.height,
  } : null)

  return { slide, bboxPt, bboxNorm, instance: resolvedInstance, slideSizePt }
}
