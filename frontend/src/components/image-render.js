import { findSlide } from './catalog.js'
import { defaultSlideImageModel } from './image-catalog.js'
import { isolateSlideMetricPreview } from '../slides/text-content-patch.js'

function cloneSlide(slide) {
  return JSON.parse(JSON.stringify(slide))
}

function collectKeepElementIds(instance) {
  return [
    ...(instance.title_element_ids || []),
    ...(instance.description_element_ids || []),
    ...(instance.element_ids || []),
    instance.element_id,
  ].filter(Boolean)
}

export function applySlideImageToSlide(report, component, instance, modelData = null) {
  const sourceSlide = findSlide(report, instance.slide_number)
  if (!sourceSlide) return null

  const effectiveModel = modelData || defaultSlideImageModel(component, instance)
  const keepIds = collectKeepElementIds(instance)
  let slide = cloneSlide(sourceSlide)

  slide.content_elements = (slide.content_elements || []).map((element) => {
    if (element.element_id !== instance.element_id || element.kind !== 'image') return element
    return {
      ...element,
      asset: effectiveModel.asset || element.asset || null,
      fill_mode: effectiveModel.fill_mode || element.fill_mode || 'stretch',
    }
  })

  slide = isolateSlideMetricPreview(slide, { keepElementIds: keepIds })
  return slide
}

export function buildSlideImagePreviewView(report, component, { instance = null, instanceIndex = 0, modelData = null } = {}) {
  const resolvedInstance = instance || component.instances?.[instanceIndex] || component.instances?.[0]
  if (!resolvedInstance) return { slide: null, bboxPt: null, bboxNorm: null, instance: null }

  const slide = applySlideImageToSlide(report, component, resolvedInstance, modelData)
  if (!slide) return { slide: null, bboxPt: null, bboxNorm: null, instance: null }

  const slideSizePt = slide.render?.slide_size_pt || { width: 960, height: 540 }
  const bboxPt = resolvedInstance.image_container || null
  const bboxNorm = resolvedInstance.image_container_norm || (bboxPt ? {
    x: bboxPt.x_pt / slideSizePt.width,
    y: bboxPt.y_pt / slideSizePt.height,
    width: bboxPt.width_pt / slideSizePt.width,
    height: bboxPt.height_pt / slideSizePt.height,
  } : null)

  return { slide, bboxPt, bboxNorm, instance: resolvedInstance, slideSizePt }
}
