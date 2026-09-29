import {
  listDeckMetricLayouts,
  computeMetricHeroRowCapacity,
  computeMetricRepeatRowCapacity,
} from './metric-render.js'
import { METRIC_PATTERN_LABELS, METRIC_PATTERNS } from '../slides/metric-detect.js'

const SAMPLE_METRICS = [
  { value: '91', unit: '%', description: 'Описание показателя' },
  { value: '72', unit: '%', description: 'Второй показатель' },
  { value: '7', unit: 'дней', description: 'Событие компании' },
  { value: '10', unit: 'млн', description: 'Динамика роста' },
  { value: '43', unit: '%', description: 'Описание показателя' },
  { value: '3', unit: '×', description: 'Второй показатель' },
]
const SAMPLE_METRIC_CAPTIONS = [
  'Описание показателя',
  'Второй показатель',
  'Событие компании',
  'Динамика роста',
]

function slideByNumber(report, slideNumber) {
  return (report?.slides?.slides || []).find((slide) => slide.slide_number === slideNumber) || null
}

function previewInstanceKey(instance) {
  if (!instance) return ''
  return instance.layout_key
    || [
      instance.slide_number,
      instance.vgroup_id,
      instance.pattern,
      instance.detection_method,
    ].filter(Boolean).join('|')
}

function buildSampleMetrics(count, instance = null) {
  const visible = instance?.layout?.capacity_visible || instance?.item_capacity || count
  const limit = Math.max(1, count || visible || 1)
  const acceptsUnits = instance?.layout?.unit_mode !== 'none'
  return Array.from({ length: limit }, (_, index) => {
    const sample = SAMPLE_METRICS[index % SAMPLE_METRICS.length]
    return {
      value: sample.value,
      unit: acceptsUnits ? sample.unit : '',
      description: SAMPLE_METRIC_CAPTIONS[index % SAMPLE_METRIC_CAPTIONS.length],
    }
  })
}

function withResolvedMetricCapacity(report, layout) {
  const slide = slideByNumber(report, layout.slide_number)
  const visible = layout.capacity_visible || layout.item_capacity || 1
  const measured = layout.pattern === METRIC_PATTERNS.hero && slide
    ? computeMetricHeroRowCapacity(slide, layout)
    : (layout.pattern === METRIC_PATTERNS.repeat && slide
      ? computeMetricRepeatRowCapacity(slide, layout)
      : (layout.capacity_expandable || visible))
  return {
    ...layout,
    capacity_visible: visible,
    capacity_expandable: Math.max(visible, measured),
  }
}

function isReusableMetricLayout(layout) {
  const box = layout?.container_norm || layout?.hero_region?.container_norm || {}
  const capacity = layout?.capacity_expandable || layout?.capacity_visible || layout?.item_capacity || 1
  const isPeripheral = (box.x || 0) >= 0.7 || (box.y || 0) <= 0.18
  const isCompact = (box.width || 0) <= 0.3

  // A compact one-off number in a slide corner is usually a chart annotation,
  // not a reusable KPI component. Keep it in raw slide analysis only.
  if (capacity <= 1 && isPeripheral && isCompact) return false
  return true
}

export function metricLayoutPlacementKey(layout, { expanded = false } = {}) {
  const box = layout?.container_norm || layout?.hero_region?.container_norm || {}
  return [
    layout?.template_id || 'deck',
    layout?.pattern,
    expanded ? 'expanded' : 'visible',
    layout?.slide_number,
    layout?.vgroup_id,
    roundNorm(box.y, 0.05),
    roundNorm(box.width, 0.05),
    layout?.item_capacity || 1,
    layout?.capacity_expandable || 1,
  ].join('|')
}

function roundNorm(value, step = 0.05) {
  if (!Number.isFinite(value)) return null
  return Math.round(value / step) * step
}

export function metricLayoutPlacementLabel(layout, { expanded = false } = {}) {
  const width = Math.round((layout?.container_norm?.width || layout?.hero_region?.container_norm?.width || 0) * 100)
  const y = Math.round((layout?.container_norm?.y || layout?.hero_region?.container_norm?.y || 0) * 100)
  const capacity = expanded ? layout?.capacity_expandable : layout?.capacity_visible
  const pattern = METRIC_PATTERN_LABELS[layout?.pattern] || layout?.pattern

  if (expanded) return `${pattern} · до ${capacity} KPI · y${y}%`
  if (layout?.pattern === METRIC_PATTERNS.combo) return `${pattern} · ${capacity} KPI · w${width}%`
  if (layout?.pattern === METRIC_PATTERNS.repeat) return `${pattern} · ${capacity} KPI · w${width}%`
  return `слайд ${layout.slide_number} · y${y}% · w${width}%`
}

function normalizeMetricPlacement(report, layout) {
  const slide = slideByNumber(report, layout.slide_number)
  const slideWidth = slide?.render?.slide_size_pt?.width || 960
  const slideHeight = slide?.render?.slide_size_pt?.height || 540
  const bbox = layout.container_norm || layout.hero_region?.container_norm || null

  return {
    slide_number: layout.slide_number,
    template_id: layout.template_id || slide?.template_id || null,
    layout_key: metricLayoutPlacementKey(layout),
    layout,
    vgroup_id: layout.vgroup_id || null,
    pattern: layout.pattern,
    item_capacity: layout.item_capacity || 1,
    capacity_visible: layout.capacity_visible || layout.item_capacity || 1,
    capacity_expandable: layout.capacity_expandable || layout.item_capacity || 1,
    detection_method: layout.detection_method || null,
    label: metricLayoutPlacementLabel(layout),
    container_norm: bbox ? { ...bbox } : null,
    container: bbox ? {
      x_pt: (bbox.x || 0) * slideWidth,
      y_pt: (bbox.y || 0) * slideHeight,
      width_pt: (bbox.width || 0) * slideWidth,
      height_pt: (bbox.height || 0) * slideHeight,
    } : null,
  }
}

function buildMetricPlacementComponent(report, layout) {
  const slide = slideByNumber(report, layout.slide_number)
  const patternLabel = METRIC_PATTERN_LABELS[layout.pattern] || layout.pattern
  let capacityExpandable = layout.capacity_expandable || layout.item_capacity || 1
  if (layout.pattern === METRIC_PATTERNS.hero && slide) {
    capacityExpandable = computeMetricHeroRowCapacity(slide, layout)
  } else if (layout.pattern === METRIC_PATTERNS.repeat && slide) {
    capacityExpandable = computeMetricRepeatRowCapacity(slide, layout)
  }
  const resolvedLayout = {
    ...layout,
    capacity_expandable: Math.max(layout.capacity_visible || layout.item_capacity || 1, capacityExpandable),
  }
  const placement = normalizeMetricPlacement(report, resolvedLayout)

  return {
    component_id: placement.layout_key,
    name: layout.pattern,
    label: `${patternLabel} · ${placement.label}`,
    source: 'metric',
    kind: 'metric',
    pattern: layout.pattern,
    layout: resolvedLayout.layout_direction
      || (resolvedLayout.pattern === METRIC_PATTERNS.repeat && resolvedLayout.metric_slots?.length >= 2 ? 'row' : 'column'),
    container: placement.container || {},
    container_norm: placement.container_norm || null,
    capacity: {
      item_count_typical: layout.item_capacity || 1,
      item_count_known: layout.item_capacity || 1,
      item_count_max: capacityExpandable,
    },
    frequency: {
      instance_count: 1,
      slide_count: 1,
      slide_numbers: [layout.slide_number],
    },
    behavior: {
      detection_methods: layout.detection_method ? [layout.detection_method] : [],
      flex_assembly: true,
      row_tile_capacity: layout.pattern === METRIC_PATTERNS.hero ? capacityExpandable : null,
      unit_mode: resolvedLayout.unit_mode || 'none',
      original_units_present: resolvedLayout.unit_mode !== 'none',
    },
    placement: {
      ...placement,
      capacity_expandable: resolvedLayout.capacity_expandable,
    },
    instances: [{
      ...placement,
      capacity_expandable: resolvedLayout.capacity_expandable,
    }],
  }
}

function stylePart(element, typography = null) {
  const source = typography || element?.typography || {}
  return {
    family: source.family || null,
    size_pt: source.size_pt || null,
    bold: Boolean(source.bold),
    italic: Boolean(source.italic),
    color: source.color || null,
    alignment: element?.typography?.alignment || element?.alignment || null,
  }
}

function metricStyleProfile(report, component) {
  const placement = component.placement
  const layout = placement?.layout || {}
  const slot = layout.hero_region || layout.metric_slots?.[0] || null
  const slide = slideByNumber(report, placement?.slide_number)
  const valueElement = (slide?.content_elements || []).find((element) => (
    element.element_id === slot?.pair?.valueElementId
  ))
  const captionElement = (slide?.content_elements || []).find((element) => (
    element.element_id === slot?.pair?.captionElementId
  ))

  return {
    value: stylePart(valueElement, valueElement?.metric?.value_typography),
    unit: stylePart(valueElement, valueElement?.metric?.unit_typography),
    description: stylePart(captionElement),
    unit_present: layout.unit_mode !== 'none',
    unit_sample: slot?.pair?.unitSample || null,
  }
}

function metricStyleSignature(profile) {
  return JSON.stringify(profile)
}

function metricStyleLabel(profile) {
  const value = profile.value || {}
  const description = profile.description || {}
  const sizes = [value.size_pt, description.size_pt].filter(Boolean).join('/')
  const color = value.color ? ` · ${value.color}` : ''
  const units = profile.unit_present ? 'unit' : 'без unit'
  return `Метрика · ${sizes || 'типографика'} pt${color} · ${units}`
}

function rankStyleRepresentatives(left, right) {
  const leftHero = left.pattern === METRIC_PATTERNS.hero ? 1 : 0
  const rightHero = right.pattern === METRIC_PATTERNS.hero ? 1 : 0
  const leftCapacity = left.capacity?.item_count_max || 1
  const rightCapacity = right.capacity?.item_count_max || 1
  const leftWidth = left.container_norm?.width || 1
  const rightWidth = right.container_norm?.width || 1
  return rightCapacity - leftCapacity
    || rightHero - leftHero
    || leftWidth - rightWidth
    || left.placement.slide_number - right.placement.slide_number
}

// Depends only on the template deck; asked for per template while ranking
// templates, per title variant and per slide. Cached per report; callers get a
// fresh array and must treat the components as read-only.
const metricComponentCache = new WeakMap()

export function listMetricComponents(report) {
  const slides = report?.slides?.slides || []
  const cacheable = report && typeof report === 'object'
  const cached = cacheable ? metricComponentCache.get(report) : null
  if (cached && cached.slides === slides && cached.count === slides.length) return [...cached.components]
  const components = buildMetricComponents(report)
  if (cacheable) metricComponentCache.set(report, { slides, count: slides.length, components: components })
  return [...components]
}

function buildMetricComponents(report) {
  const placements = listDeckMetricLayouts(report)
    .map((layout) => buildMetricPlacementComponent(report, layout))
    .filter((component) => isReusableMetricLayout(component.placement))
  if (!placements.length) return []

  const groups = new Map()
  placements.forEach((component) => {
    const profile = metricStyleProfile(report, component)
    const signature = metricStyleSignature(profile)
    if (!groups.has(signature)) groups.set(signature, { profile, components: [] })
    groups.get(signature).components.push(component)
  })

  return [...groups.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, group], index) => {
      const ranked = [...group.components].sort(rankStyleRepresentatives)
      const representative = ranked[0]
      const slideNumbers = [...new Set(group.components.map((item) => item.placement.slide_number))]
        .sort((left, right) => left - right)
      return {
        ...representative,
        component_id: `metric_style_${String(index + 1).padStart(3, '0')}`,
        name: 'metric_style',
        label: metricStyleLabel(group.profile),
        style_profile: group.profile,
        frequency: {
          instance_count: 1,
          slide_count: 1,
          slide_numbers: [representative.placement.slide_number],
        },
        behavior: {
          ...representative.behavior,
          detected_placement_count: group.components.length,
          detected_slide_numbers: slideNumbers,
          catalog_mode: 'style_representative',
        },
      }
    })
}

export function buildMetricModelPayload(component, metrics, instance = null) {
  const sample = instance || component.placement || component.instances?.[0] || {}
  const maxCount = component.capacity?.item_count_max
    || sample.capacity_expandable
    || sample.item_capacity
    || 1
  const visibleCount = sample.capacity_visible
    || component.capacity?.item_count_known
    || sample.item_capacity
    || 1
  const slice = (metrics || []).slice(0, maxCount)

  return {
    component_id: component.id || component.component_id,
    pattern: component.pattern,
    metrics: slice,
    expanded: slice.length > visibleCount,
    requestedCount: metrics?.length || slice.length,
  }
}

export function defaultMetricModel(component, instance = null) {
  const sample = instance || component.placement || component.instances?.[0] || {}
  const visibleCapacity = sample.capacity_visible || sample.item_capacity || 1
  const metrics = buildSampleMetrics(visibleCapacity, sample)

  return {
    component_id: component.component_id || component.id,
    pattern: component.pattern,
    metrics,
    expanded: false,
    preview_instance_key: previewInstanceKey(sample),
  }
}

export function resizeMetricModel(model, metricCount, component, instance = null) {
  const sample = instance || component.placement || component.instances?.[0] || {}
  const maxCount = sample.capacity_expandable || sample.item_capacity || metricCount
  const nextCount = Math.max(1, Math.min(metricCount, maxCount))
  return {
    ...model,
    metrics: buildSampleMetrics(nextCount, sample),
    expanded: nextCount > (sample.capacity_visible || sample.item_capacity || 1),
  }
}

export function listMetricLayoutCatalog(report) {
  const layouts = listDeckMetricLayouts(report)
    .map((layout) => withResolvedMetricCapacity(report, layout))
    .filter(isReusableMetricLayout)
  const slideNumbers = [...new Set(layouts.map((item) => item.slide_number))].sort((left, right) => left - right)

  return {
    layouts,
    summary: {
      layout_count: layouts.length,
      slide_count: slideNumbers.length,
      by_pattern: Object.fromEntries(
        Object.values(METRIC_PATTERNS).map((pattern) => [
          pattern,
          layouts.filter((item) => item.pattern === pattern).length,
        ]),
      ),
    },
  }
}
