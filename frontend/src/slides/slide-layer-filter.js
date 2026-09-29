const SYSTEM_PLACEHOLDER_TYPES = new Set(['dt', 'sldNum', 'ftr', 'hdr'])
const EDITABLE_PLACEHOLDER_TYPES = new Set(['title', 'ctrTitle', 'subTitle', 'body', 'obj', 'content'])

/** Short layout glyphs like « — intentional design, not placeholder copy. */
export function isDesignGlyphText(text) {
  const trimmed = (text || '').trim()
  return trimmed.length > 0 && trimmed.length <= 2
}

export function slideHasContentElements(slide) {
  return (slide?.content_elements || []).length > 0
}

export function slideCoversPlaceholder(slide, placeholderType) {
  if (!placeholderType) return false
  const elements = slide?.content_elements || []
  return elements.some((element) => element.placeholder_type === placeholderType)
}

/**
 * Slide catalog/DS preview: hide master/layout placeholder boilerplate when slide has real content.
 * Template constructor previews render all layers unchanged.
 */
export function shouldRenderSlideLayer(layer, slide) {
  if (!layer?.decorative) return true
  if (layer.kind !== 'text') return true

  if (isDesignGlyphText(layer.text)) return true

  const scope = layer.source_scope
  if (scope !== 'master' && scope !== 'layout') return true

  if (!slideHasContentElements(slide)) return true

  if (SYSTEM_PLACEHOLDER_TYPES.has(layer.placeholder_type)) return false

  if (slideCoversPlaceholder(slide, layer.placeholder_type)) return false

  return false
}

export function filterSlideRenderLayers(layers, slide) {
  return (layers || []).filter((layer) => shouldRenderSlideLayer(layer, slide))
}
