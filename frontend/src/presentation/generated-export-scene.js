import { materializeGraphicStyles } from './materialize-chart-styles.js'
import { resolveSlideLayout } from './slide-hit-test.js'

export const GENERATED_SCENE_VERSION = 1

const GENERATED_CONTENT_BASE_GAP = 100

function finiteBox(box, keys) {
  if (!box) return null
  const values = keys.map((key) => Number(box[key]))
  if (!values.every(Number.isFinite)) return null
  if (values[2] <= 0 || values[3] <= 0) return null
  return Object.fromEntries(keys.map((key, index) => [key, values[index]]))
}

function ptFromNorm(norm, slideSize) {
  const box = finiteBox(norm, ['x', 'y', 'width', 'height'])
  const width = Number(slideSize?.width)
  const height = Number(slideSize?.height)
  if (!box || !Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null
  return {
    x_pt: box.x * width,
    y_pt: box.y * height,
    width_pt: box.width * width,
    height_pt: box.height * height,
  }
}

function syncElementGeometry(element, slideSize) {
  let next = element
  const geometryPt = ptFromNorm(element.geometry_norm, slideSize)
  if (geometryPt) next = { ...next, geometry_pt: { ...(element.geometry_pt || {}), ...geometryPt } }

  const groupGeometryPt = ptFromNorm(element.text_group_geometry_norm, slideSize)
  if (groupGeometryPt) {
    next = { ...next, text_group_geometry_pt: { ...(element.text_group_geometry_pt || {}), ...groupGeometryPt } }
  }
  return next
}

function syncLayerGeometry(layer, slideSize) {
  const geometryPt = ptFromNorm(layer.geometry_norm, slideSize)
  return geometryPt ? { ...layer, geometry_pt: { ...(layer.geometry_pt || {}), ...geometryPt } } : layer
}


function exportTitleIds(slide) {
  return (slide?.content_elements || [])
    .filter((element) => (
      element?.kind === 'text'
      && (
        element.role === 'title'
        || element.text_role === 'title'
        || ['title', 'ctrTitle'].includes(element.placeholder_type)
        || /(^|_)slide_title(_|$)/.test(String(element.element_id || ''))
      )
    ))
    .map((element) => element.element_id)
    .filter(Boolean)
}

function resolveExportLayout(report, slide) {
  const resolved = resolveSlideLayout(report, slide, { titleIds: exportTitleIds(slide) })
  return resolved?.slide || slide
}

function syncSceneGeometry(slide, slideSize) {
  let changed = false
  const content = (slide?.content_elements || []).map((element) => {
    const next = syncElementGeometry(element, slideSize)
    if (next !== element) changed = true
    return next
  })
  const layers = (slide?.render?.layers || []).map((layer) => {
    const next = syncLayerGeometry(layer, slideSize)
    if (next !== layer) changed = true
    return next
  })
  if (!changed) return slide
  return {
    ...slide,
    render: { ...(slide.render || {}), layers },
    content_elements: content,
  }
}

function isGeneratedContentElement(element) {
  if (!element) return false
  if (element.placement_content || element.component_data || element.baseline_preview || element.synthetic) return true
  return ['chart', 'table', 'diagram'].includes(element.kind)
}

function promoteGeneratedContent(slide) {
  const maxLayerZ = Math.max(0, ...(slide?.render?.layers || []).map((layer) => Number(layer.z_index) || 0))
  const base = maxLayerZ + GENERATED_CONTENT_BASE_GAP
  let cursor = 0
  let changed = false
  const content = (slide?.content_elements || []).map((element) => {
    if (!isGeneratedContentElement(element)) return element
    const current = Number(element.z_index) || 0
    const nextZ = Math.max(current, base + cursor)
    cursor += 1
    if (nextZ === current) return element
    changed = true
    return { ...element, z_index: nextZ }
  })
  return changed ? { ...slide, content_elements: content } : slide
}

/** Editable slide data shared by the DOM preview and format exporters. */
export function prepareGeneratedSlide(report, slide) {
  if (!slide) return null
  const slideSize = slide.render?.slide_size_pt
    || report?.typography?.visibility?.slide_size_pt
    || { width: 960, height: 540 }
  const source = slide.export_scene_version === GENERATED_SCENE_VERSION
    ? slide
    : materializeGraphicStyles(report, slide)
  const synced = syncSceneGeometry(promoteGeneratedContent(source), slideSize)
  const resolved = resolveExportLayout(report, {
    ...synced,
    render: { ...(synced.render || {}), slide_size_pt: slideSize },
  })
  const final = syncSceneGeometry(resolved, slideSize)
  return {
    ...final,
    render: { ...(final.render || {}), slide_size_pt: slideSize },
    export_scene_version: GENERATED_SCENE_VERSION,
  }
}

export function prepareGeneratedSlides(report, slides) {
  return (slides || []).map((slide) => prepareGeneratedSlide(report, slide))
}
