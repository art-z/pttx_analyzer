import { findShellTitleElement } from '../constructor/templates.js'
import { isIterableRepeatComponent } from './container-catalog.js'
import { buildComponentSlideView } from './render.js'
import { measureTextInkBox } from '../presentation/component-template-fit.js'
import { transplantComponentToTemplate } from '../presentation/transplant-component-to-template.js'

function finiteBox(box) {
  if (!box) return null
  const x = Number(box.x)
  const y = Number(box.y)
  const width = Number(box.width)
  const height = Number(box.height)
  if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0) return null
  return { x, y, width, height }
}

function unionBox(elements) {
  const boxes = elements.map((element) => finiteBox(element?.geometry_norm)).filter(Boolean)
  if (!boxes.length) return null
  const left = Math.min(...boxes.map((box) => box.x))
  const top = Math.min(...boxes.map((box) => box.y))
  const right = Math.max(...boxes.map((box) => box.x + box.width))
  const bottom = Math.max(...boxes.map((box) => box.y + box.height))
  return { x: left, y: top, width: right - left, height: bottom - top }
}

function slideSizeOf(slide, report) {
  return slide?.render?.slide_size_pt
    || report?.typography?.visibility?.slide_size_pt
    || { width: 960, height: 540 }
}

export function translateElement(element, dx, dy, slideSize) {
  const box = finiteBox(element?.geometry_norm)
  if (!box) return element
  const mapped = {
    x: box.x + dx,
    y: box.y + dy,
    width: box.width,
    height: box.height,
  }
  const next = JSON.parse(JSON.stringify(element))
  next.geometry_norm = { ...(next.geometry_norm || {}), ...mapped }
  if (next.geometry_pt && slideSize?.width && slideSize?.height) {
    next.geometry_pt = {
      ...next.geometry_pt,
      x_pt: mapped.x * slideSize.width,
      y_pt: mapped.y * slideSize.height,
      width_pt: mapped.width * slideSize.width,
      height_pt: mapped.height * slideSize.height,
    }
  }
  return next
}

function shellTitleHit(slide, report) {
  const title = findShellTitleElement({
    ...slide,
    content_elements: (slide?.content_elements || []).filter((element) => !element.placement_content),
  })
  const slot = finiteBox(title?.geometry_norm)
  const text = String(title?.text || '').trim()
  if (!slot || !text) return { titleSlot: slot, titleInk: null }
  return {
    titleSlot: slot,
    titleInk: measureTextInkBox(slot, text, title.typography || {}, slideSizeOf(slide, report)),
  }
}

function componentElementsForTemplatePreview(component, view) {
  if (isIterableRepeatComponent(component)) {
    return {
      elementPredicate: (element) => String(element?.element_id || '').includes('__repeat_'),
    }
  }
  const ids = new Set()
  const instance = view?.instance
  if (instance?.element_id) ids.add(instance.element_id)
  for (const id of instance?.element_ids || []) {
    if (id) ids.add(id)
  }
  if (!ids.size) {
    const graphic = [...(view?.slide?.content_elements || [])].reverse().find((element) => (
      element.kind === 'table' || element.kind === 'chart' || element.kind === 'diagram'
    ))
    if (graphic?.element_id) ids.add(graphic.element_id)
  }
  return { elementIds: [...ids] }
}

export function buildComponentOnTemplatePreview(report, component, templateId, {
  sourceTemplateId = null,
  instanceIndex = 0,
  modelData = null,
} = {}) {
  const view = buildComponentSlideView(report, component, {
    templateId: sourceTemplateId,
    instanceIndex,
    modelData,
  })
  if (!view?.slide) return null
  const slide = transplantComponentToTemplate(report, view.slide, component, templateId, {
    ...componentElementsForTemplatePreview(component, view),
  })
  if (!slide) {
    return {
      slide: null,
      fits: false,
      bboxNorm: view.bboxNorm || null,
      hitTest: { fits: false, shifted: false },
    }
  }

  const meta = slide.component_transplant || {}
  const { titleSlot, titleInk } = shellTitleHit(slide, report)
  return {
    slide,
    fits: true,
    bboxNorm: meta.box || unionBox((slide.content_elements || []).filter((element) => element.placement_content)) || view.bboxNorm || null,
    hitTest: {
      titleSlot,
      titleInk,
      sourceBox: meta.source_box || null,
      side: meta.side || null,
      shifted: Boolean(meta.shifted),
      fits: true,
    },
  }
}
