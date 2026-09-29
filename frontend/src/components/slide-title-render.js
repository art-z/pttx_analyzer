import { findSlide } from './catalog.js'
import {
  buildTitleTextFromWords,
  DEFAULT_TITLE_PHRASE,
  defaultSlideTitleModel,
} from './slide-title-catalog.js'

function cloneSlide(slide) {
  return JSON.parse(JSON.stringify(slide))
}

export function applySlideTitleToSlide(report, component, instance, modelData = null) {
  const slide = cloneSlide(findSlide(report, instance.slide_number))
  if (!slide) return null

  const phrase = component.default_phrase || component.raw?.default_phrase || DEFAULT_TITLE_PHRASE
  const effectiveModel = modelData || defaultSlideTitleModel(component, instance)
  const text = effectiveModel.text || buildTitleTextFromWords(phrase, effectiveModel.word_count)
  const titleIds = new Set(instance.element_ids || [])

  slide.content_elements = (slide.content_elements || []).map((element) => {
    if (!titleIds.has(element.element_id)) return element
    if (element.kind !== 'text') return element
    return {
      ...element,
      text,
      text_sample: text,
    }
  })

  return slide
}

export function buildSlideTitlePreviewView(report, component, { instance = null, instanceIndex = 0, modelData = null } = {}) {
  const resolvedInstance = instance || component.instances?.[instanceIndex] || component.instances?.[0]
  if (!resolvedInstance) return { slide: null, bboxPt: null, bboxNorm: null, instance: null }

  const slide = applySlideTitleToSlide(report, component, resolvedInstance, modelData)
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
