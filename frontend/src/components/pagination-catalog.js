import { detectSlideVgroups } from '../slides/vgroup-detect.js'

const PAGINATOR_KIND = 'paginator'
const MAX_DOTS = 20
const MIN_PAGINATOR_PAGES = 2
const MIN_DOTS = 3

const TYPE_LABELS = {
  dot_pagination: 'Точки',
  numeric: 'Числа',
  progress_bar: 'Progress bar',
}

const PLACEMENT_PRESETS = [
  { id: 'synthetic-bottom-left', label: 'Synthetic · низ слева', x_norm: 0.08, y_norm: 0.88, align: 'start', anchor_mode: 'preset' },
  { id: 'synthetic-bottom-center', label: 'Synthetic · низ центр', x_norm: 0.5, y_norm: 0.88, align: 'center', anchor_mode: 'preset' },
  { id: 'synthetic-bottom-right', label: 'Synthetic · низ справа', x_norm: 0.92, y_norm: 0.88, align: 'end', anchor_mode: 'preset' },
]

function themeColors(report) {
  return report?.theme?.themes?.[0]?.colors || report?.colors?.theme?.colors || {}
}

export function resolvePaginationColor(token, report) {
  if (!token) return null
  if (String(token).startsWith('#')) return token
  if (String(token).startsWith('scheme:')) {
    const name = String(token).slice(7)
    const entry = themeColors(report)[name]
    if (entry?.value) return `#${entry.value}`
    if (typeof entry === 'string' && entry.startsWith('#')) return entry
  }
  return token
}

function median(values) {
  const sorted = values.filter(Number.isFinite).sort((left, right) => left - right)
  if (!sorted.length) return null
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

function roundNorm(value, step = 0.02) {
  if (!Number.isFinite(value)) return null
  return Math.round(value / step) * step
}

function inferAlign(xNorm) {
  if (xNorm <= 0.22) return 'start'
  if (xNorm >= 0.72) return 'end'
  return 'center'
}

function matchDotElements(slide, dots, tolerancePt = 8) {
  if (!slide || !dots?.length) return []

  const bottomFills = (slide.content_elements || [])
    .filter((element) => {
      if (element.kind !== 'fill' && element.kind !== 'shape') return false
      return (element.geometry_norm?.y || 0) >= 0.72
    })
    .sort((left, right) => (left.geometry_pt?.x_pt || 0) - (right.geometry_pt?.x_pt || 0))

  if (bottomFills.length >= dots.length) {
    const row = bottomFills.slice(0, dots.length)
    const byGeometry = dots.map((dot) => bottomFills.find((element) => {
      const geometry = element.geometry_pt || {}
      return Math.abs((geometry.x_pt || 0) - dot.x_pt) <= tolerancePt
        && Math.abs((geometry.y_pt || 0) - dot.y_pt) <= tolerancePt * 6
    })).filter(Boolean)

    if (byGeometry.length === dots.length) {
      return byGeometry.map((element) => element.element_id)
    }

    const uniformSizes = row.every((element) => {
      const width = element.geometry_pt?.width_pt || 0
      const height = element.geometry_pt?.height_pt || 0
      const sample = row[0].geometry_pt || {}
      return Math.abs(width - (sample.width_pt || 0)) <= tolerancePt
        && Math.abs(height - (sample.height_pt || 0)) <= tolerancePt
    })

    if (uniformSizes) {
      return row.map((element) => element.element_id)
    }
  }

  return dots
    .map((dot) => matchDotElementId(slide, dot, tolerancePt))
    .filter(Boolean)
}

function matchDotElementId(slide, dot, tolerancePt = 8) {
  return (slide?.content_elements || []).find((element) => {
    if (element.kind !== 'fill' && element.kind !== 'shape') return false
    const geometry = element.geometry_pt || {}
    return Math.abs((geometry.x_pt || 0) - dot.x_pt) <= tolerancePt
      && Math.abs((geometry.y_pt || 0) - dot.y_pt) <= tolerancePt * 6
  })?.element_id || null
}

function dotRowBBox(dots, slideWidth = 960, slideHeight = 540) {
  if (!dots?.length) return null
  const xs = dots.map((dot) => dot.x_pt)
  const ys = dots.map((dot) => dot.y_pt)
  const xe = dots.map((dot) => dot.x_pt + dot.width_pt)
  const ye = dots.map((dot) => dot.y_pt + dot.height_pt)
  const xPt = Math.min(...xs)
  const yPt = Math.min(...ys)
  const widthPt = Math.max(...xe) - xPt
  const heightPt = Math.max(...ye) - yPt
  return {
    x_pt: xPt,
    y_pt: yPt,
    width_pt: widthPt,
    height_pt: heightPt,
    x_norm: xPt / slideWidth,
    y_norm: yPt / slideHeight,
    width_norm: widthPt / slideWidth,
    height_norm: heightPt / slideHeight,
  }
}

function buildStyleTokens(pattern, report, instances = []) {
  const sampleInstance = instances.find((item) => item.element_ids?.length) || instances[0] || (pattern.instances || [])[0]
  const sampleSlide = (report?.slides?.slides || []).find((item) => item.slide_number === sampleInstance?.slide_number)
  const matchedElements = (sampleInstance?.element_ids || [])
    .map((elementId) => (sampleSlide?.content_elements || []).find((element) => element.element_id === elementId))
    .filter(Boolean)
  const dots = sampleInstance?.dots || []
  const activeIndex = sampleInstance?.active_index ?? 0
  const activeElement = matchedElements[activeIndex] || matchedElements[0]
  const inactiveElement = matchedElements.find((_, index) => index !== activeIndex) || matchedElements[1] || matchedElements[0]
  const activeDot = dots[activeIndex] || dots[0]
  const inactiveDot = dots.find((_, index) => index !== activeIndex) || dots[1] || dots[0]

  return {
    dot_preset: activeElement?.mask?.kind || activeDot?.preset || 'ellipse',
    dot_width_pt: activeElement?.geometry_pt?.width_pt || activeDot?.width_pt || null,
    dot_height_pt: activeElement?.geometry_pt?.height_pt || activeDot?.height_pt || null,
    spacing_pt: sampleInstance?.spacing_pt || pattern.spacing_pt || null,
    active_fill: activeElement?.fill?.color || resolvePaginationColor(activeDot?.fill, report),
    inactive_fill: inactiveElement?.fill?.color || resolvePaginationColor(inactiveDot?.fill, report),
    active_stroke: resolvePaginationColor(activeDot?.stroke, report),
    inactive_stroke: resolvePaginationColor(inactiveDot?.stroke, report),
    active_reason: sampleInstance?.active_reason || pattern.logic?.active_state?.dominant_reason || null,
  }
}

function elementSpacingPt(elements) {
  if ((elements || []).length < 2) return null
  const gaps = []
  for (let index = 1; index < elements.length; index += 1) {
    gaps.push((elements[index].geometry_pt?.x_pt || 0) - (elements[index - 1].geometry_pt?.x_pt || 0))
  }
  return median(gaps)
}

function findVgroupRowMeta(slide, report, elementIds) {
  if (!slide || !elementIds?.length) return null
  const idSet = new Set(elementIds)
  const vgroups = detectSlideVgroups(slide, { report })
  const match = vgroups.groups
    .filter((group) => group.layout === 'row' || String(group.signature || '').startsWith('x['))
    .map((group) => ({
      group,
      overlap: group.elements.filter((element) => idSet.has(element.element_id)).length,
    }))
    .filter((item) => item.overlap >= Math.min(3, elementIds.length))
    .sort((left, right) => right.overlap - left.overlap)[0]

  if (!match) return null
  return {
    vgroup_id: match.group.id,
    signature: match.group.signature,
    bbox_norm: match.group.bboxNorm,
    bbox_pt: match.group.bboxPt,
  }
}

function buildPlacementVariantsFromInstances(instances) {
  const variants = new Map()

  for (const instance of instances) {
    const placement = instance.placement
    if (!placement) continue

    const key = `${roundNorm(placement.y_norm, 0.02)}|${roundNorm(placement.x_norm, 0.03)}`
    if (!variants.has(key)) {
      variants.set(key, {
        id: `absolute_${variants.size + 1}`,
        label: `Absolute · x ${Math.round(placement.x_norm * 100)}% · y ${Math.round(placement.y_norm * 100)}%`,
        source: 'absolute',
        coordinate_space: 'slide_absolute',
        anchor_mode: 'absolute',
        x_pt: placement.x_pt,
        y_pt: placement.y_pt,
        x_norm: placement.x_norm,
        y_norm: placement.y_norm,
        spacing_pt: placement.spacing_pt,
        dot_width_pt: placement.dot_width_pt,
        dot_height_pt: placement.dot_height_pt,
        bbox_norm: instance.container_norm || null,
        vgroup_id: placement.vgroup_id || null,
        instance_count: 0,
        slide_numbers: new Set(),
      })
    }

    const variant = variants.get(key)
    variant.instance_count += 1
    variant.slide_numbers.add(instance.slide_number)
  }

  return [...variants.values()]
    .map((item) => ({ ...item, slide_numbers: [...item.slide_numbers].sort((left, right) => left - right) }))
    .sort((left, right) => right.instance_count - left.instance_count)
}

function assignInstancePlacements(instances, placements) {
  instances.forEach((instance) => {
    if (!instance.placement) return
    const match = placements.find((placement) => (
      roundNorm(placement.y_norm, 0.02) === roundNorm(instance.placement.y_norm, 0.02)
      && roundNorm(placement.x_norm, 0.03) === roundNorm(instance.placement.x_norm, 0.03)
    ))
    instance.placement_id = match?.id || placements[0]?.id || null
  })
  return instances
}

function buildCapacity(pattern, instances = []) {
  const counts = (pattern.instances || []).map((item) => item.dot_count || pattern.dot_count || 0).filter(Boolean)
  const maxObserved = counts.length ? Math.max(...counts) : pattern.dot_count || MIN_DOTS
  const spacingValues = instances.map((item) => item.spacing_pt).filter(Number.isFinite)
  return {
    dot_count_min: MIN_PAGINATOR_PAGES,
    dot_count_observed_max: maxObserved,
    dot_count_max: MAX_DOTS,
    dot_count_typical: median(counts) || pattern.dot_count || MIN_DOTS,
    spacing_pt: median(spacingValues) || pattern.spacing_pt || null,
    spacing_pt_max: spacingValues.length ? Math.max(...spacingValues) : pattern.spacing_pt || null,
    y_norm_typical: median(instances.map((item) => item.placement?.y_norm).filter(Number.isFinite)) || pattern.y_norm || null,
  }
}

function buildBehavior(pattern) {
  const logic = pattern.logic || {}
  const active = logic.active_state || {}
  return {
    pagination_type: pattern.type,
    active_detection_rate: pattern.active_detection_rate ?? null,
    active_progression_score: pattern.active_progression_score ?? null,
    active_reason: active.dominant_reason || null,
    progression: active.progression || null,
    methods: pattern.detection?.methods || [],
    required: logic.required || [],
    rejects_decorative: logic.rejects_decorative || [],
  }
}

function normalizeInstance(pattern, instance, report) {
  const slide = (report?.slides?.slides || []).find((item) => item.slide_number === instance.slide_number)
  const slideWidth = slide?.render?.slide_size_pt?.width || report?.slides?.summary?.slide_size_pt?.width || 960
  const slideHeight = slide?.render?.slide_size_pt?.height || report?.slides?.summary?.slide_size_pt?.height || 540
  const elementIds = matchDotElements(slide, instance.dots)
  const matchedElements = elementIds
    .map((elementId) => (slide?.content_elements || []).find((element) => element.element_id === elementId))
    .filter(Boolean)
  const bboxFromElements = matchedElements.length
    ? dotRowBBox(matchedElements.map((element) => ({
      x_pt: element.geometry_pt?.x_pt || 0,
      y_pt: element.geometry_pt?.y_pt || 0,
      width_pt: element.geometry_pt?.width_pt || 0,
      height_pt: element.geometry_pt?.height_pt || 0,
    })), slideWidth, slideHeight)
    : null
  const bbox = bboxFromElements || dotRowBBox(instance.dots, slideWidth, slideHeight)
  const spacingPt = elementSpacingPt(matchedElements) || pattern.spacing_pt || null
  const firstElement = matchedElements[0] || null
  const vgroupMeta = findVgroupRowMeta(slide, report, elementIds)
  const anchorXpt = firstElement?.geometry_pt?.x_pt ?? bbox?.x_pt ?? null
  const anchorYpt = firstElement?.geometry_pt?.y_pt ?? bbox?.y_pt ?? null

  return {
    slide_number: instance.slide_number,
    template_id: slide?.template_id || null,
    dot_count: instance.dot_count || pattern.dot_count || 0,
    active_index: instance.active_index ?? 0,
    active_reason: instance.active_reason || null,
    spacing_uniformity: instance.spacing_uniformity ?? null,
    spacing_pt: spacingPt,
    dots: instance.dots || [],
    element_ids: elementIds,
    vgroup: vgroupMeta,
    placement: anchorXpt != null && anchorYpt != null ? {
      coordinate_space: 'slide_absolute',
      anchor_mode: 'absolute',
      source: matchedElements.length ? 'content_elements' : 'pagination_detection',
      x_pt: anchorXpt,
      y_pt: anchorYpt,
      x_norm: anchorXpt / slideWidth,
      y_norm: anchorYpt / slideHeight,
      spacing_pt: spacingPt,
      dot_width_pt: firstElement?.geometry_pt?.width_pt || null,
      dot_height_pt: firstElement?.geometry_pt?.height_pt || null,
      vgroup_id: vgroupMeta?.vgroup_id || null,
    } : null,
    placement_id: null,
    container: bbox ? {
      x_pt: bbox.x_pt,
      y_pt: bbox.y_pt,
      width_pt: bbox.width_pt,
      height_pt: bbox.height_pt,
    } : null,
    container_norm: bbox ? {
      x: bbox.x_norm,
      y: bbox.y_norm,
      width: bbox.width_norm,
      height: bbox.height_norm,
    } : null,
    current_page: instance.current_page ?? null,
    total_pages: instance.total_pages ?? null,
    text: instance.text ?? null,
  }
}

function componentLabel(pattern) {
  const typeLabel = TYPE_LABELS[pattern.type] || pattern.type
  if (pattern.type === 'dot_pagination') return `${typeLabel} · ${pattern.dot_count} dots`
  if (pattern.type === 'numeric') return `${typeLabel} · ${pattern.total_pages || '?'} pages`
  return `${typeLabel} · ${pattern.pattern_id}`
}

export function normalizePaginationPattern(pattern, report) {
  let instances = (pattern.instances || []).map((instance) => normalizeInstance(pattern, instance, report))
  const absolutePlacements = buildPlacementVariantsFromInstances(instances)
  instances = assignInstancePlacements(instances, absolutePlacements)
  const placements = [
    ...absolutePlacements,
    ...PLACEMENT_PRESETS.map((preset) => ({
      ...preset,
      source: 'synthetic',
      coordinate_space: 'slide_absolute',
      bbox_norm: null,
      instance_count: 0,
      slide_numbers: [],
    })),
  ]
  const capacity = buildCapacity(pattern, instances)
  const behavior = buildBehavior(pattern)
  const styleTokens = buildStyleTokens(pattern, report, instances)
  const defaultPlacement = absolutePlacements[0] || null

  return {
    component_id: pattern.pattern_id,
    name: `PAGINATOR_${String(pattern.type || 'unknown').toUpperCase()}`,
    label: componentLabel(pattern),
    source: 'pagination',
    kind: PAGINATOR_KIND,
    pagination_type: pattern.type,
    confidence: pattern.confidence || 0,
    container: instances[0]?.container || {},
    container_norm: instances[0]?.container_norm || defaultPlacement?.bbox_norm || null,
    container_bounds: {
      typical: {
        width_pt: styleTokens.dot_width_pt,
        height_pt: styleTokens.dot_height_pt,
        element_count: capacity.dot_count_typical,
      },
      max: {
        width_pt: null,
        height_pt: styleTokens.dot_height_pt,
        element_count: capacity.dot_count_max,
      },
      min: {
        element_count: capacity.dot_count_min,
      },
    },
    capacity,
    behavior,
    style_tokens: styleTokens,
    placements,
    default_placement_id: defaultPlacement?.id || absolutePlacements[0]?.id || null,
    iterability: {
      is_iterable: true,
      method: behavior.progression === 'sequential' ? 'cross_slide_progression' : 'pagination_pattern',
      confidence: pattern.confidence || 0.6,
      instance_count: instances.length,
      slide_count: pattern.slide_count || pattern.slide_numbers?.length || 0,
      slide_numbers: pattern.slide_numbers || [],
      checks: {
        deck_repeat: instances.length >= 2,
        cross_slide: (pattern.slide_numbers || []).length >= 2,
        repeat_series: behavior.progression === 'sequential',
        repeat_grid: false,
        active_state: Boolean(behavior.active_reason),
      },
    },
    text_fields: pattern.type === 'numeric'
      ? [{ field_id: 'page_label', role: 'page_label', required: true, presence_ratio: 1, sample_text: instances[0]?.text || null }]
      : [],
    variants: absolutePlacements.map((item, index) => ({
      variant_id: `pl_${String(index + 1).padStart(2, '0')}`,
      layout: item.align,
      element_count: capacity.dot_count_typical,
      instance_count: item.instance_count,
      slide_numbers: item.slide_numbers,
      container: item.bbox_norm,
    })),
    frequency: {
      instance_count: instances.length,
      slide_count: pattern.slide_count || pattern.slide_numbers?.length || 0,
      slide_numbers: pattern.slide_numbers || [],
    },
    instances,
    logic: pattern.logic || {},
    raw: pattern,
  }
}

export function listPaginationComponents(report) {
  const patterns = report?.typography?.pagination?.patterns || []
  return patterns
    .map((pattern) => normalizePaginationPattern(pattern, report))
    .sort((left, right) => (
      (right.confidence || 0) - (left.confidence || 0)
      || (right.frequency?.instance_count || 0) - (left.frequency?.instance_count || 0)
      || left.label.localeCompare(right.label, 'ru')
    ))
}

export function defaultPaginatorModel(component, instance = null) {
  const sample = instance || component.instances?.[0] || {}
  return {
    component_id: component.id || component.component_id,
    pagination_type: component.paginationType || component.pagination_type || component.raw?.pagination_type,
    page_count: sample.dot_count || component.capacity?.dot_count_typical || 5,
    active_index: sample.active_index ?? 0,
    placement_id: sample.placement_id
      || component.defaultPlacementId
      || component.default_placement_id
      || component.placements?.find((item) => item.source === 'absolute')?.id
      || null,
  }
}

export function resolvePaginatorPlacement(component, placementId = null, instance = null) {
  const placements = component.placements || component.raw?.placements || []
  const resolvedId = placementId
    || instance?.placement_id
    || component.defaultPlacementId
    || component.default_placement_id
    || placements.find((item) => item.source === 'absolute')?.id
  const resolved = placements.find((item) => item.id === resolvedId)
    || placements.find((item) => item.source === 'absolute')
    || instance?.placement
    || null

  if (resolved && resolved.anchor_mode !== 'preset' && instance?.placement) {
    return {
      ...resolved,
      x_pt: instance.placement.x_pt,
      y_pt: instance.placement.y_pt,
      x_norm: instance.placement.x_norm,
      y_norm: instance.placement.y_norm,
      spacing_pt: instance.placement.spacing_pt ?? resolved.spacing_pt,
      dot_width_pt: instance.placement.dot_width_pt ?? resolved.dot_width_pt,
      dot_height_pt: instance.placement.dot_height_pt ?? resolved.dot_height_pt,
    }
  }

  return resolved || PLACEMENT_PRESETS[1]
}

export function resolvePaginatorPlacementForInstance(component, instance, modelData = null) {
  const placementId = modelData?.placement_id || instance?.placement_id || component.defaultPlacementId
  const selected = resolvePaginatorPlacement(component, placementId, instance)
  if (selected?.anchor_mode === 'preset') return selected
  if (instance?.placement) {
    return {
      ...selected,
      ...instance.placement,
      id: selected?.id || instance.placement_id,
      source: instance.placement.source || 'content_elements',
      anchor_mode: 'absolute',
    }
  }
  return selected
}
