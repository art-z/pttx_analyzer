import { buildShellSlide, findShellTitleElement } from '../constructor/templates.js'
import { findSlide } from '../components/catalog.js'
import { contentMarginFrame, measureTextInkBox, shiftComponentClearOfTitle } from './component-template-fit.js'
import { placementForTemplate } from './placement-selection.js'

function templateRecord(report, templateId) {
  return (report?.slide_templates?.templates || []).find((item) => (
    item.template_id === templateId || item.layout_source === templateId
  )) || null
}

function targetSlide(report, templateId) {
  const template = templateRecord(report, templateId)
  const slideNumber = template?.preview_slide || template?.slide_numbers?.[0]
  if (slideNumber) {
    const slide = findSlide(report, slideNumber)
    if (slide) return slide
  }
  return (report?.slides?.slides || []).find((slide) => (
    slide.template_id === templateId || slide.layout_source === templateId
  )) || null
}

function finiteBox(element) {
  const box = element?.geometry_norm
  if (!box) return null
  const values = [box.x, box.y, box.width, box.height].map(Number)
  if (!values.every(Number.isFinite) || values[2] <= 0 || values[3] <= 0) return null
  return { x: values[0], y: values[1], width: values[2], height: values[3] }
}

function unionBox(elements) {
  const boxes = elements.map(finiteBox).filter(Boolean)
  if (!boxes.length) return null
  const left = Math.min(...boxes.map((box) => box.x))
  const top = Math.min(...boxes.map((box) => box.y))
  const right = Math.max(...boxes.map((box) => box.x + box.width))
  const bottom = Math.max(...boxes.map((box) => box.y + box.height))
  return { x: left, y: top, width: right - left, height: bottom - top }
}

function translateElement(element, dx, dy, slideSize) {
  const next = JSON.parse(JSON.stringify(element))
  next.placement_content = true
  if (next.geometry_norm) {
    next.geometry_norm.x = (Number(next.geometry_norm.x) || 0) + dx
    next.geometry_norm.y = (Number(next.geometry_norm.y) || 0) + dy
  }
  if (next.geometry_pt) {
    next.geometry_pt.x_pt = (Number(next.geometry_pt.x_pt) || 0) + dx * slideSize.width
    next.geometry_pt.y_pt = (Number(next.geometry_pt.y_pt) || 0) + dy * slideSize.height
  }
  // Text groups are drawn at their group box: move it with the elements, or
  // the plates move while the text stays behind.
  if (next.text_group_geometry_norm) {
    next.text_group_geometry_norm.x = (Number(next.text_group_geometry_norm.x) || 0) + dx
    next.text_group_geometry_norm.y = (Number(next.text_group_geometry_norm.y) || 0) + dy
  }
  if (next.text_group_geometry_pt) {
    next.text_group_geometry_pt.x_pt = (Number(next.text_group_geometry_pt.x_pt) || 0) + dx * slideSize.width
    next.text_group_geometry_pt.y_pt = (Number(next.text_group_geometry_pt.y_pt) || 0) + dy * slideSize.height
  }
  return next
}

// A flexible graphic (chart) is scaled into the free box the registry found
// for this template instead of being moved at its source size.
function fitElementIntoBox(element, from, to, slideSize) {
  const next = JSON.parse(JSON.stringify(element))
  next.placement_content = true
  const box = finiteBox(element)
  if (!box) return next
  const sx = to.width / from.width
  const sy = to.height / from.height
  const geometry = {
    x: to.x + (box.x - from.x) * sx,
    y: to.y + (box.y - from.y) * sy,
    width: box.width * sx,
    height: box.height * sy,
  }
  next.geometry_norm = { ...next.geometry_norm, ...geometry }
  next.geometry_pt = {
    ...(next.geometry_pt || {}),
    x_pt: geometry.x * slideSize.width,
    y_pt: geometry.y * slideSize.height,
    width_pt: geometry.width * slideSize.width,
    height_pt: geometry.height * slideSize.height,
  }
  return next
}

function shellTitleHit(slide, report, slideSize) {
  const title = findShellTitleElement({
    ...slide,
    content_elements: (slide?.content_elements || []).filter((element) => !element.placement_content),
  })
  const slot = finiteBox(title)
  const text = String(title?.text || '').trim()
  if (!slot || !text) return { titleSlot: slot, titleInk: null }
  return {
    titleSlot: slot,
    titleInk: measureTextInkBox(slot, text, title.typography || {}, slideSize),
  }
}

/**
 * Places already materialized component elements on a different template shell.
 * The group keeps its size and only shifts to leave a gap from the title.
 * If that same bbox does not fit, the pair is rejected.
 */
export function transplantComponentToTemplate(report, sourceSlide, component, templateId, {
  elementIds = [],
  elementPredicate = null,
  titleText = '',
} = {}) {
  if (!sourceSlide || !component || !templateId) return null
  const fit = placementForTemplate(report, component, templateId, { titleText })
  if (fit?.status !== 'fit') return null
  const template = templateRecord(report, templateId)
  const target = targetSlide(report, templateId)
  if (!template || !target) return null

  const ids = new Set(elementIds.filter(Boolean))
  const elements = (sourceSlide.content_elements || []).filter((element) => (
    ids.has(element.element_id) || elementPredicate?.(element)
  ))
  const box = unionBox(elements)
  if (!elements.length || !box) return null

  const shell = buildShellSlide(target, report, { titleOnly: true })
  if (!shell) return null
  const slideSize = shell.render?.slide_size_pt
    || report?.typography?.visibility?.slide_size_pt
    || { width: 960, height: 540 }
  const { titleSlot, titleInk } = shellTitleHit(shell, report, slideSize)
  const goal = fit.flexible && fit.box ? fit.box : box
  let moved = shiftComponentClearOfTitle(goal, { slot: titleSlot, ink: titleInk }, contentMarginFrame(report))
  // A chart keeps its free-region box; the final pass refits it around the
  // placed texts (refitChartsClearOfText).
  if ((!moved.fits || !moved.box) && fit.flexible && fit.box) moved = { box: goal, side: null, fits: true }
  if (!moved.fits || !moved.box) return null
  const dx = moved.box.x - goal.x
  const dy = moved.box.y - goal.y
  const transplanted = fit.flexible && fit.box
    ? elements.map((element) => fitElementIntoBox(element, box, moved.box, slideSize))
    : elements.map((element) => translateElement(element, dx, dy, slideSize))

  return {
    ...JSON.parse(JSON.stringify(shell)),
    template_id: templateRecord(report, templateId)?.template_id || templateId,
    content_elements: [...(shell.content_elements || []), ...transplanted],
    component_transplant: {
      component_id: component.id,
      source_slide_number: sourceSlide.slide_number || null,
      target_template_id: templateId,
      anchor: { x: moved.box.x, y: moved.box.y },
      source_box: box,
      box: moved.box,
      side: moved.side,
      shifted: Math.abs(dx) > 0.001 || Math.abs(dy) > 0.001,
    },
  }
}
