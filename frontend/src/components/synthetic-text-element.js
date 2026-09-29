import { typographRussianText } from '../slides/text-typographer.js'

function slideSizePt(slide) {
  return slide?.render?.slide_size_pt || { width: 960, height: 540 }
}

function resolveContainer(instance, slide) {
  const size = slideSizePt(slide)
  const normalized = instance?.container_norm
  if (normalized?.width > 0 && normalized?.height > 0) {
    return {
      geometry_pt: {
        x_pt: normalized.x * size.width,
        y_pt: normalized.y * size.height,
        width_pt: normalized.width * size.width,
        height_pt: normalized.height * size.height,
      },
      geometry_norm: { ...normalized },
    }
  }

  const container = instance?.container || instance?.placement
  if (!(container?.width_pt > 0) || !(container?.height_pt > 0)) return null

  return {
    geometry_pt: {
      x_pt: container.x_pt,
      y_pt: container.y_pt,
      width_pt: container.width_pt,
      height_pt: container.height_pt,
    },
    geometry_norm: {
      x: container.x_pt / size.width,
      y: container.y_pt / size.height,
      width: container.width_pt / size.width,
      height: container.height_pt / size.height,
    },
  }
}

function resolveTypography(instance, component) {
  const instanceTypography = instance?.typography || {}
  const componentTypography = component?.typography || component?.raw?.typography || {}
  return {
    family: instanceTypography.family || componentTypography.dominant_family || null,
    size_pt: instanceTypography.size_pt || componentTypography.dominant_size_pt || null,
    color: instanceTypography.color || componentTypography.color || null,
    scale_level: instanceTypography.scale_level ?? componentTypography.scale_level ?? null,
    alignment: instanceTypography.alignment || null,
    line_height_pt: instanceTypography.line_height_pt ?? null,
    line_height_ratio: instanceTypography.line_height_ratio ?? null,
    line_height_applicable: instanceTypography.line_height_pt != null || instanceTypography.line_height_ratio != null,
  }
}

function uniqueElementId(slide, baseId) {
  const ids = new Set((slide?.content_elements || []).map((element) => element.element_id))
  if (!ids.has(baseId)) return baseId
  let suffix = 2
  while (ids.has(`${baseId}_${suffix}`)) suffix += 1
  return `${baseId}_${suffix}`
}

function foregroundZIndex(slide) {
  return Math.max(0, ...(slide?.render?.layers || []).map((layer) => Number(layer.z_index) || 0)) + 1
}

export function ensureSyntheticTextElement(slide, {
  component = null,
  instance = null,
  kind = 'slide_description',
  text = '',
} = {}) {
  if (!slide || !instance) return { slide, elementIds: [], created: false }

  const existingIds = (instance.element_ids || []).filter((id) => (
    slide.content_elements?.some((element) => element.element_id === id && element.kind === 'text')
  ))
  if (existingIds.length) return { slide, elementIds: existingIds, created: false }

  const geometry = resolveContainer(instance, slide)
  if (!geometry) return { slide, elementIds: [], created: false }

  const slideNumber = slide.slide_number ?? instance.slide_number ?? 'preview'
  const role = kind === 'slide_title' ? 'title' : 'body'
  const baseElementId = `synthetic_${kind}_${slideNumber}`
  const existingSynthetic = (slide.content_elements || []).find((element) => (
    element.synthetic
    && element.kind === 'text'
    && element.role === role
    && (element.element_id === baseElementId || element.element_id.startsWith(`${baseElementId}_`))
  ))
  if (existingSynthetic) {
    return { slide, elementIds: [existingSynthetic.element_id], created: false }
  }

  const elementId = uniqueElementId(slide, baseElementId)
  const insertText = typographRussianText(String(text || ''))
  const element = {
    element_id: elementId,
    kind: 'text',
    role,
    text: insertText,
    text_sample: insertText,
    geometry_pt: geometry.geometry_pt,
    geometry_norm: geometry.geometry_norm,
    typography: resolveTypography(instance, component),
    synthetic: true,
    synthetic_source: instance.detection_method || instance.placement?.source || 'text_component_fallback',
    source_component_id: component?.id || component?.component_id || null,
    z_index: foregroundZIndex(slide),
  }

  return {
    slide: {
      ...slide,
      content_elements: [...(slide.content_elements || []), element],
    },
    elementIds: [elementId],
    created: true,
  }
}
