import { pickBodyTypography, pickTitleTypography } from './tokens.js'
import {
  boxFromGeometry,
  defaultContentForRole,
  findPatternInstance,
  findRegistryInstance,
  buildSlotDefaults,
  getComponentPlacementProfile,
  getEditableSlot,
  findShellTitleElement,
  getEditableSlots,
  normalizeSlotRole,
  typographyFromTemplateSlot,
} from './templates.js'

let elementCounter = 0

const nextId = (prefix) => {
  elementCounter += 1
  return `${prefix}_${elementCounter}`
}

export function createConstructorDocument(report, tokens) {
  return {
    slideSize: { ...tokens.slideSize },
    selectedTemplateId: null,
    slides: [createBlankSlide(tokens)],
    activeSlideIndex: 0,
    selectedElementId: null,
  }
}

export function createBlankSlide(tokens, template = null) {
  return {
    id: nextId('slide'),
    background: template?.render?.background_color || template?.colors?.background || tokens.defaultBackground,
    template: template || null,
    templateId: template?.layout_source || null,
    elements: [],
  }
}

function createTextElementFromTemplateSlot(slot, template, tokens) {
  const role = normalizeSlotRole(slot.role || slot.placeholder_type)
  const box = boxFromGeometry(slot.geometry_norm)
  return {
    id: nextId('el'),
    type: 'text',
    role,
    templateSlotId: slot.shape_id,
    templateSlotRole: role,
    slotBounds: { ...box },
    ...box,
    content: defaultContentForRole(role),
    typography: typographyFromTemplateSlot(slot, template, tokens, role),
  }
}

function seedTemplateElements(slide, template, tokens) {
  slide.elements = getEditableSlots(template).map((slot) => createTextElementFromTemplateSlot(slot, template, tokens))
  return slide
}

function findElementBySlotRole(elements, role) {
  const normalizedRole = normalizeSlotRole(role)
  return elements.find((element) => (
    element.type === 'text'
    && (element.templateSlotRole === normalizedRole || normalizeSlotRole(element.role) === normalizedRole)
  )) || null
}

export function selectTemplate(document, template, tokens) {
  document.selectedTemplateId = template.layout_source
  const slide = createBlankSlide(tokens, template)
  seedTemplateElements(slide, template, tokens)
  const shellTitle = findShellTitleElement(template.shellSlide)
  if (shellTitle?.text) {
    const titleElement = findElementBySlotRole(slide.elements, 'title')
    if (titleElement) titleElement.content = shellTitle.text.trim()
  }
  document.slides = [slide]
  document.activeSlideIndex = 0
  document.selectedElementId = slide.elements[0]?.id || null
  return document
}

export function clearTemplateSelection(document, tokens) {
  document.selectedTemplateId = null
  document.slides = [createBlankSlide(tokens)]
  document.activeSlideIndex = 0
  document.selectedElementId = null
  return document
}

function mapComponentSlotRole(role) {
  if (role === 'description') return 'body'
  if (role === 'list') return 'body'
  return normalizeSlotRole(role)
}

function slotToElement(slot, componentId, parentBox, tokens, template = null, slotDefaults = null) {
  const pos = slot.position || {}
  const cx = pos.cx_norm ?? 0.5
  const cy = pos.cy_norm ?? 0.5
  const w = pos.width_norm ?? 0.2
  const h = pos.height_norm ?? 0.1
  const x = cx - w / 2
  const y = cy - h / 2
  const typography = slot.typography || {}
  const role = mapComponentSlotRole(slot.role || 'description')
  const defaults = slotDefaults || slot.defaults || {}
  const isText = slot.kind === 'text' || ['title', 'description', 'list', 'subtitle', 'body', 'content'].includes(role)

  if (isText) {
    const templateSlot = template ? getEditableSlot(template, role) : null
    const resolvedTypography = templateSlot
      ? typographyFromTemplateSlot(templateSlot, template, tokens, role)
      : (role === 'title'
        ? pickTitleTypography(tokens)
        : {
          family: typography.dominant_family || tokens.defaultFontFamily,
          sizePt: typography.dominant_size_pt || 14,
          scaleLevel: typography.dominant_scale_level || null,
          bold: false,
          color: tokens.defaultTextColor,
          role,
        })

    return {
      id: nextId('el'),
      type: 'text',
      role,
      componentId,
      parentBox,
      x, y, width: w, height: h,
      content: defaults.text || defaultContentForRole(role),
      typography: resolvedTypography,
      templateSlotRole: templateSlot ? role : null,
    }
  }

  if (slot.kind === 'image' || role === 'image' || role === 'background_image') {
    return {
      id: nextId('el'),
      type: 'image',
      role: slot.kind === 'icon' ? 'icon' : role,
      componentId,
      parentBox,
      x, y, width: w, height: h,
      asset: defaults.asset || null,
      objectFit: 'cover',
    }
  }

  return {
    id: nextId('el'),
    type: 'shape',
    role,
    componentId,
    parentBox,
    x, y, width: w, height: h,
    fill: 'rgba(0,119,255,0.12)',
  }
}

function createComponentElement(component, tokens, template, placement, cloneIndex = 0) {
  const width = component.container?.width_norm || placement.width || 0.35
  const height = component.container?.height_norm || placement.height || 0.22
  const parentBox = {
    x: placement.x ?? 0.12,
    y: placement.y ?? 0.18,
    width,
    height,
  }

  const instanceId = nextId('comp')
  const slots = [...component.slots.required, ...component.slots.optional.filter((slot) => (slot.presence_ratio ?? 0) >= 0.35)]
  const instance = component.pattern
    ? findPatternInstance(component.pattern, template)
    : findRegistryInstance(component, template)
  const slotDefaults = buildSlotDefaults(component, instance)
  const children = slots.map((slot) => slotToElement(
    slot,
    component.id,
    parentBox,
    tokens,
    template,
    slotDefaults[slot.slot_id],
  ))

  return {
    id: instanceId,
    type: 'component',
    componentId: component.id,
    label: component.label,
    cloneIndex,
    ...parentBox,
    children,
  }
}

export function countComponentInstances(slide, componentId) {
  return (slide?.elements || []).filter((element) => (
    element.type === 'component' && element.componentId === componentId
  )).length
}

export function syncComponentInstances(document, component, count, tokens) {
  const slide = document.slides[document.activeSlideIndex]
  const template = slide.template
  const profile = getComponentPlacementProfile(component, template)
  const targetCount = Math.min(
    profile.maxCount,
    Math.max(0, Number(count) || 0),
  )

  slide.elements = slide.elements.filter((element) => (
    !(element.type === 'component' && element.componentId === component.id)
  ))

  let lastId = null

  for (let index = 0; index < targetCount; index += 1) {
    const placement = profile.placements[index]
    if (!placement) break
    const element = createComponentElement(component, tokens, template, placement, index)
    slide.elements.push(element)
    lastId = element.id
  }

  if (lastId) document.selectedElementId = lastId
  else if (document.selectedElementId) {
    const stillSelected = findElement(slide.elements, document.selectedElementId)
    if (!stillSelected) document.selectedElementId = null
  }

  return document
}

export function insertComponent(document, component, tokens, position = null) {
  const slide = document.slides[document.activeSlideIndex]
  const template = slide.template
  const currentCount = countComponentInstances(slide, component.id)
  const profile = getComponentPlacementProfile(component, template)
  if (currentCount >= profile.maxCount) return document

  const placement = position
    || profile.placements[currentCount]
    || null
  if (!placement) return document

  slide.elements.push(createComponentElement(component, tokens, template, placement, currentCount))
  document.selectedElementId = slide.elements[slide.elements.length - 1].id
  return document
}

export function insertTextBlock(document, tokens, variant = 'title') {
  const slide = document.slides[document.activeSlideIndex]
  const role = normalizeSlotRole(variant)

  if (slide.template) {
    const existing = findElementBySlotRole(slide.elements, role)
    if (existing) {
      document.selectedElementId = existing.id
      return document
    }

    const slot = getEditableSlot(slide.template, role)
    if (slot) {
      const element = createTextElementFromTemplateSlot(slot, slide.template, tokens)
      slide.elements.push(element)
      document.selectedElementId = element.id
      return document
    }
  }

  const typography = role === 'body' ? pickBodyTypography(tokens) : pickTitleTypography(tokens)
  const box = role === 'title'
    ? tokens.slideTitleBox
    : { x: 0.08, y: 0.24, width: 0.84, height: 0.18 }
  const id = nextId('el')
  slide.elements.push({
    id,
    type: 'text',
    role,
    x: box.x,
    y: box.y,
    width: box.width,
    height: box.height,
    content: defaultContentForRole(role),
    typography,
  })
  document.selectedElementId = id
  return document
}

export function insertImage(document, asset, position = { x: 0.55, y: 0.22 }) {
  const slide = document.slides[document.activeSlideIndex]
  const id = nextId('el')
  slide.elements.push({
    id,
    type: 'image',
    role: 'image',
    x: position.x,
    y: position.y,
    width: 0.35,
    height: 0.45,
    asset: asset.filename,
    objectFit: 'contain',
  })
  document.selectedElementId = id
  return document
}

export function addSlide(document, tokens) {
  const activeSlide = document.slides[document.activeSlideIndex]
  const template = activeSlide?.template || null
  const slide = createBlankSlide(tokens, template)
  if (template) seedTemplateElements(slide, template, tokens)
  document.slides.push(slide)
  document.activeSlideIndex = document.slides.length - 1
  document.selectedElementId = slide.elements[0]?.id || null
  return document
}

export function removeSelectedElement(document) {
  const slide = document.slides[document.activeSlideIndex]
  slide.elements = slide.elements.filter((element) => element.id !== document.selectedElementId)
  document.selectedElementId = null
  return document
}

export function updateSelectedElement(document, patch) {
  const slide = document.slides[document.activeSlideIndex]
  const element = findElement(slide.elements, document.selectedElementId)
  if (!element) return document
  Object.assign(element, patch)
  if (patch.typography) element.typography = { ...element.typography, ...patch.typography }
  return document
}

export function findElement(elements, id) {
  if (!id) return null
  for (const element of elements) {
    if (element.id === id) return element
    if (element.children) {
      const child = element.children.find((item) => item.id === id)
      if (child) return child
    }
  }
  return null
}

export function getSelectedElement(document) {
  const slide = document.slides[document.activeSlideIndex]
  return findElement(slide.elements, document.selectedElementId)
}

export function isTemplateBoundElement(element) {
  return Boolean(element?.templateSlotId || element?.slotBounds)
}
