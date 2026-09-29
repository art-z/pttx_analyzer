import { mountDesignSystemSlide } from '../slides/design-system-render.js'
import { createSlideRenderContext } from '../slides/resolve-element-style.js'
import { buildContainerRepeatPreviewSlide } from './container-render.js'
import {
  findSlide,
  getInstanceBBox,
  getTypicalBBox,
  resolveComponentPreviewContext,
} from './catalog.js'
import {
  getPlaygroundInstanceBBox,
  isIterableRepeatComponent,
} from './container-catalog.js'
import {
  applyContainerDataToInstance,
  applyModelDataToComponent,
} from './model-data.js'
import {
  baselinePreviewLabel,
  buildBaselinePreviewSlide,
  resolveBaselinePreviewPlacement,
} from './baseline-template.js'
import { buildPaginatorPreviewView } from './pagination-render.js'
import { buildSlideImagePreviewView } from './image-render.js'
import { buildSlideTitlePreviewView } from './slide-title-render.js'
import { buildSlideDescriptionPreviewView } from './slide-description-render.js'
import {
  applyMetricsToLayout,
  computeMetricHeroPreviewBBox,
  computeMetricPreviewBBox,
} from './metric-render.js'
import { defaultMetricModel } from './metric-catalog.js'
import { METRIC_PATTERNS } from '../slides/metric-detect.js'
import { replaceTextElementContent } from '../slides/text-content-patch.js'

function bboxNormFromPt(bboxPt, slideSizePt) {
  const width = slideSizePt?.width || 960
  const height = slideSizePt?.height || 540
  return {
    x: (bboxPt.x_pt || 0) / width,
    y: (bboxPt.y_pt || 0) / height,
    width: (bboxPt.width_pt || width) / width,
    height: (bboxPt.height_pt || height) / height,
  }
}

function formatPositionNote(bboxPt, bboxNorm, slideSizePt) {
  if (!bboxPt) return ''
  const width = slideSizePt?.width || 960
  const height = slideSizePt?.height || 540
  return `${Math.round(bboxPt.x_pt)}×${Math.round(bboxPt.y_pt)} pt · ${Math.round(bboxPt.width_pt)}×${Math.round(bboxPt.height_pt)} pt · ${Math.round((bboxNorm?.x || 0) * 100)}%, ${Math.round((bboxNorm?.y || 0) * 100)}% на ${Math.round(width)}×${Math.round(height)} pt`
}

export function resolveComponentInstance(component, instanceIndex = 0) {
  const instances = component.instances || []
  if (!instances.length) return null
  const index = Number.isFinite(instanceIndex) ? instanceIndex : 0
  return instances[Math.max(0, Math.min(index, instances.length - 1))]
}

function buildBaselinePreviewSlideWrapper(report, component, options) {
  return buildBaselinePreviewSlide(report, component, options)
}

function buildSpatialPreviewSlide(report, component, instance, { modelData = null } = {}) {
  const slide = findSlide(report, instance.slide_number)
  if (!slide) return null

  const nextSlide = JSON.parse(JSON.stringify(slide))
  if (!modelData) return nextSlide

  const appliedInstance = applyContainerDataToInstance(instance, modelData)
  const bbox = getInstanceBBox(appliedInstance)
  if (!bbox) return nextSlide

  const slotTexts = new Map(
    (appliedInstance.slots || [])
      .filter((slot) => slot.text != null)
      .map((slot) => [slot.role || slot.slot_id, slot.text]),
  )

  nextSlide.content_elements = (nextSlide.content_elements || []).map((element) => {
    if (element.kind !== 'text') return element
    const geometry = element.geometry_pt || {}
    const inside = geometry.x_pt >= bbox.x_pt
      && geometry.y_pt >= bbox.y_pt
      && geometry.x_pt + (geometry.width_pt || 0) <= bbox.x_pt + bbox.width_pt
      && geometry.y_pt + (geometry.height_pt || 0) <= bbox.y_pt + bbox.height_pt
    if (!inside) return element

    const role = element.text_role || element.role || element.name
    const nextText = slotTexts.get(role)
      || (role === 'title' ? modelData.title : null)
      || ((role === 'body' || role === 'description') ? modelData.text : null)
    if (nextText == null) return element
    return replaceTextElementContent(element, nextText)
  })

  return nextSlide
}

export function buildComponentSlideView(report, component, { templateId = null, instanceIndex = 0, modelData = null } = {}) {
  const context = resolveComponentPreviewContext(report, component, { templateId, instanceIndex })
  const instance = context.instance
  if (!instance && component.isBaseline) {
    const placement = resolveBaselinePreviewPlacement(report, component)
    const slide = buildBaselinePreviewSlideWrapper(report, component, { modelData })
    const slideSizePt = slide.render.slide_size_pt
    const bboxPt = placement.geometry_pt || {
      x_pt: slide.content_elements.at(-1)?.geometry_pt?.x_pt || 0,
      y_pt: slide.content_elements.at(-1)?.geometry_pt?.y_pt || 0,
      width_pt: slide.content_elements.at(-1)?.geometry_pt?.width_pt || slideSizePt.width * 0.62,
      height_pt: slide.content_elements.at(-1)?.geometry_pt?.height_pt || slideSizePt.height * 0.48,
    }
    const bboxNorm = bboxNormFromPt(bboxPt, slideSizePt)
    return {
      ...context,
      slide,
      instance: { slide_number: slide.slide_number || 0, baseline: true },
      bboxPt,
      bboxNorm,
      typicalBBoxPt: bboxPt,
      typicalBBoxNorm: bboxNorm,
      positionNote: formatPositionNote(bboxPt, bboxNorm, slideSizePt),
      isBaselinePreview: true,
      baselinePreviewMeta: placement,
    }
  }
  if (!instance) return { ...context, slide: null, bboxPt: null, bboxNorm: null }

  if (component.kind === 'slide_title' || component.source === 'slide_title') {
    const titleView = buildSlideTitlePreviewView(report, component, {
      instance: context.instance,
      modelData: modelData || null,
    })
    if (!titleView.slide) return { ...context, slide: null, bboxPt: null, bboxNorm: null }
    return {
      ...context,
      slide: titleView.slide,
      bboxPt: titleView.bboxPt,
      bboxNorm: titleView.bboxNorm,
      typicalBBoxPt: titleView.bboxPt,
      typicalBBoxNorm: titleView.bboxNorm,
      positionNote: formatPositionNote(titleView.bboxPt, titleView.bboxNorm, titleView.slideSizePt),
      isSlideTitlePreview: true,
    }
  }

  if (component.kind === 'slide_description' || component.source === 'slide_description') {
    const descriptionView = buildSlideDescriptionPreviewView(report, component, {
      instance: context.instance,
      modelData: modelData || null,
    })
    if (!descriptionView.slide) return { ...context, slide: null, bboxPt: null, bboxNorm: null }
    return {
      ...context,
      slide: descriptionView.slide,
      bboxPt: descriptionView.bboxPt,
      bboxNorm: descriptionView.bboxNorm,
      typicalBBoxPt: descriptionView.bboxPt,
      typicalBBoxNorm: descriptionView.bboxNorm,
      positionNote: formatPositionNote(descriptionView.bboxPt, descriptionView.bboxNorm, descriptionView.slideSizePt),
      isSlideDescriptionPreview: true,
    }
  }

  if (component.kind === 'slide_image' || component.source === 'slide_image') {
    const imageView = buildSlideImagePreviewView(report, component, {
      instance: context.instance,
      modelData: modelData || null,
    })
    if (!imageView.slide) return { ...context, slide: null, bboxPt: null, bboxNorm: null }
    return {
      ...context,
      slide: imageView.slide,
      bboxPt: imageView.bboxPt,
      bboxNorm: imageView.bboxNorm,
      typicalBBoxPt: imageView.bboxPt,
      typicalBBoxNorm: imageView.bboxNorm,
      positionNote: formatPositionNote(imageView.bboxPt, imageView.bboxNorm, imageView.slideSizePt),
      isSlideImagePreview: true,
    }
  }

  if (component.kind === 'metric' || component.source === 'metric') {
    const layout = instance.layout || component.placement?.layout
    const model = modelData || defaultMetricModel(component, instance)
    const metrics = (model.metrics || []).filter((item) => (
      String(item?.title || item?.value || '').trim() || String(item?.text || item?.description || '').trim()
    ))
    const expanded = Boolean(model.expanded)
    const metricSlide = applyMetricsToLayout(report, layout, metrics, { expanded, flexAssembly: true })
    if (!metricSlide) return { ...context, slide: null, bboxPt: null, bboxNorm: null }

    const slideSizePt = metricSlide.render?.slide_size_pt || { width: 960, height: 540 }
    const sourceSlide = findSlide(report, layout.slide_number)
    const renderedBBox = computeMetricPreviewBBox(metricSlide)
    const previewBBox = renderedBBox.bboxPt
      ? renderedBBox
      : computeMetricHeroPreviewBBox(sourceSlide, layout, metrics.length)
    const bboxPt = previewBBox.bboxPt || instance.container || getInstanceBBox(instance)
    const bboxNorm = previewBBox.bboxNorm || instance.container_norm || (bboxPt ? bboxNormFromPt(bboxPt, slideSizePt) : null)

    return {
      ...context,
      slide: metricSlide,
      bboxPt,
      bboxNorm,
      typicalBBoxPt: bboxPt,
      typicalBBoxNorm: bboxNorm,
      positionNote: formatPositionNote(bboxPt, bboxNorm, slideSizePt),
      isMetricPreview: true,
    }
  }

  if (component.kind === 'paginator' || component.source === 'pagination') {
    const paginatorView = buildPaginatorPreviewView(report, component, {
      instance: context.instance,
      modelData: modelData || null,
    })
    if (!paginatorView.slide) return { ...context, slide: null, bboxPt: null, bboxNorm: null }
    return {
      ...context,
      slide: paginatorView.slide,
      bboxPt: paginatorView.bboxPt,
      bboxNorm: paginatorView.bboxNorm,
      typicalBBoxPt: paginatorView.bboxPt,
      typicalBBoxNorm: paginatorView.bboxNorm,
      positionNote: formatPositionNote(paginatorView.bboxPt, paginatorView.bboxNorm, paginatorView.slideSizePt),
      isPaginatorPreview: true,
    }
  }

  let slide = findSlide(report, instance.slide_number)
  if (!slide) return { ...context, slide: null, bboxPt: null, bboxNorm: null }

  if (modelData && isIterableRepeatComponent(component)) {
    slide = buildContainerRepeatPreviewSlide(report, component, instance, { modelData })
  } else if (modelData && (component.source === 'spatial' || component.source === 'vgroups')) {
    slide = buildSpatialPreviewSlide(report, component, instance, { modelData })
  } else if (modelData && component.source === 'graphic') {
    slide = JSON.parse(JSON.stringify(slide))
    const applied = applyModelDataToComponent(component, modelData, { report, instance })
    if (applied.ok && applied.element) {
      slide.content_elements = (slide.content_elements || []).map((element) => (
        element.element_id === instance.element_id ? applied.element : element
      ))
    }
  }

  const slideSizePt = slide.render?.slide_size_pt || { width: 960, height: 540 }
  const playgroundBBox = getPlaygroundInstanceBBox(component, instance)
  const bboxPt = playgroundBBox || getInstanceBBox(instance)
  const bboxNorm = bboxPt ? bboxNormFromPt(bboxPt, slideSizePt) : null
  const typical = getTypicalBBox(context.instances, slideSizePt)

  return {
    ...context,
    slide,
    bboxPt,
    bboxNorm,
    typicalBBoxPt: typical?.bboxPt || null,
    typicalBBoxNorm: typical?.bboxNorm || null,
    positionNote: formatPositionNote(bboxPt, bboxNorm, slideSizePt),
  }
}

function mountComponentPositionHighlight(slideNode, bboxNorm) {
  if (!slideNode || !bboxNorm?.width || !bboxNorm?.height) return

  const highlight = document.createElement('div')
  highlight.className = 'component-position-highlight'
  highlight.style.left = `${bboxNorm.x * 100}%`
  highlight.style.top = `${bboxNorm.y * 100}%`
  highlight.style.width = `${bboxNorm.width * 100}%`
  highlight.style.height = `${bboxNorm.height * 100}%`
  highlight.setAttribute('aria-hidden', 'true')
  slideNode.append(highlight)
}

function mountHitTestBox(slideNode, box, className, label) {
  if (!slideNode || !box?.width || !box?.height) return
  const node = document.createElement('div')
  node.className = className
  node.style.left = `${box.x * 100}%`
  node.style.top = `${box.y * 100}%`
  node.style.width = `${box.width * 100}%`
  node.style.height = `${box.height * 100}%`
  node.setAttribute('aria-hidden', 'true')
  if (label) {
    const caption = document.createElement('span')
    caption.className = 'component-hittest-label'
    caption.textContent = label
    node.append(caption)
  }
  slideNode.append(node)
}

function mountTitleHitTest(slideNode, hitTest, componentBox) {
  if (!hitTest) return
  mountHitTestBox(slideNode, hitTest.titleSlot, 'component-hittest-slot', 'bbox заголовка')
  mountHitTestBox(slideNode, hitTest.titleInk, 'component-hittest-ink', 'текст')
  if (hitTest.shifted) {
    mountHitTestBox(slideNode, hitTest.sourceBox, 'component-hittest-source', 'исходный bbox')
  }
  mountHitTestBox(slideNode, componentBox, 'component-hittest-fit', 'компонент')
}

export function enableComponentEditing(mount, bboxNorm) {
  mount.querySelectorAll('.ds-element--text, .catalog-element--text').forEach((node) => {
    if (!bboxNorm) {
      node.classList.add('component-editable-text')
      node.style.pointerEvents = 'auto'
      node.contentEditable = 'true'
      node.spellcheck = false
      return
    }

    const left = parseFloat(node.style.left) / 100
    const top = parseFloat(node.style.top) / 100
    const width = parseFloat(node.style.width) / 100
    const height = parseFloat(node.style.height) / 100
    const right = left + width
    const bottom = top + height
    const inside = right > bboxNorm.x
      && left < bboxNorm.x + bboxNorm.width
      && bottom > bboxNorm.y
      && top < bboxNorm.y + bboxNorm.height
    if (!inside) return

    node.classList.add('component-editable-text')
    node.style.pointerEvents = 'auto'
    node.contentEditable = 'true'
    node.spellcheck = false
  })
}

export function mountComponentPreview(
  container,
  report,
  jobId,
  component,
  { templateId = null, instanceIndex = 0, editable = true, modelData = null } = {},
) {
  container.replaceChildren()
  const view = buildComponentSlideView(report, component, { templateId, instanceIndex, modelData })
  if (!view.slide) {
    container.append(Object.assign(document.createElement('p'), {
      className: 'catalog-detail-empty',
      textContent: view.templateId
        ? 'Нет экземпляра компонента на выбранном шаблоне.'
        : 'Нет экземпляра для рендера.',
    }))
    return view
  }

  const context = createSlideRenderContext(report)
  const mount = document.createElement('div')
  mount.className = 'component-preview-mount'
  container.append(mount)

  mountDesignSystemSlide(mount, view.slide, jobId, context)

  const frame = mount.querySelector('.catalog-slide-frame')
  if (frame) {
    frame.classList.add('component-preview-frame')
    const slideNode = frame.querySelector('.catalog-slide, .ds-slide')
    if (slideNode) {
      slideNode.classList.add('component-preview-slide')
      mountComponentPositionHighlight(slideNode, view.bboxNorm)
    }
  }

  if (editable) enableComponentEditing(mount, view.bboxNorm)

  const note = document.createElement('p')
  note.className = 'component-preview-note'
  const templateLabel = view.templates.find((item) => item.templateId === view.templateId)?.label || view.templateId
  note.textContent = [
    view.isBaselinePreview ? baselinePreviewLabel(view.baselinePreviewMeta) : `Слайд ${view.instance.slide_number}`,
    templateLabel ? `шаблон ${templateLabel}` : null,
    view.positionNote,
    view.isBaselinePreview
      ? 'baseline · master/layout shell + компонент в content region'
      : view.isSlideTitlePreview
        ? 'полный слайд · slide title playground · рамка = зона заголовка'
        : view.isSlideDescriptionPreview
          ? 'полный слайд · slide description playground · рамка = зона абзаца'
          : view.isSlideImagePreview
            ? 'полный слайд · hero image playground · рамка = image area · title + image'
            : view.isPaginatorPreview
        ? 'полный слайд · paginator playground · рамка = позиция индикаторов'
        : component.kind === 'table' && modelData
          ? 'полный слайд · table playground · рамка = позиция таблицы'
        : component.kind === 'metric'
          ? 'flex-сборка KPI · рамка = зона раскладки · только metrics[]'
          : isIterableRepeatComponent(component) && modelData?.item_count
            ? `полный слайд · repeat playground · ${modelData.item_count} items · рамка = контейнер`
        : 'полный слайд · master/layout + контент · рамка = позиция компонента',
  ].filter(Boolean).join(' · ')
  container.append(note)

  return view
}

export function mountSlidePreview(container, report, jobId, slide, bboxNorm = null, hitTest = null) {
  container.replaceChildren()
  if (!slide) {
    container.append(Object.assign(document.createElement('p'), {
      className: 'catalog-detail-empty',
      textContent: 'Превью на этом шаблоне не собралось.',
    }))
    return
  }

  const context = createSlideRenderContext(report)
  const mount = document.createElement('div')
  mount.className = 'component-preview-mount'
  container.append(mount)
  mountDesignSystemSlide(mount, slide, jobId, context)

  const frame = mount.querySelector('.catalog-slide-frame')
  if (!frame) return
  frame.classList.add('component-preview-frame')
  const slideNode = frame.querySelector('.catalog-slide, .ds-slide')
  if (!slideNode) return
  slideNode.classList.add('component-preview-slide')
  if (hitTest) mountTitleHitTest(slideNode, hitTest, bboxNorm)
  else mountComponentPositionHighlight(slideNode, bboxNorm)
}
