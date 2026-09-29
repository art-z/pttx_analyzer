import { detectSlideSingletons, SINGLETON_PATTERN_LABELS, SINGLETON_PATTERNS } from '../slides/singleton-detect.js'
import { collectRepeatElementIds } from './from-vgroups.js'

const COMPONENT_IDS = {
  [SINGLETON_PATTERNS.speaker_card]: 'sing_speaker_001',
  [SINGLETON_PATTERNS.metric_card]: 'sing_metric_001',
  [SINGLETON_PATTERNS.text_list]: 'sing_list_001',
  [SINGLETON_PATTERNS.text_block]: 'sing_text_001',
}

function median(values) {
  const sorted = values.filter(Number.isFinite).sort((left, right) => left - right)
  if (!sorted.length) return null
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

function normalizeSlideSingletonInstance(slide, singleton) {
  const slideWidth = slide.render?.slide_size_pt?.width || 960
  const slideHeight = slide.render?.slide_size_pt?.height || 540
  const bbox = singleton.container_norm
  const text = (singleton.text_fields || [])
    .map((field) => field.sample_text)
    .filter(Boolean)
    .join('\n')

  return {
    slide_number: slide.slide_number,
    template_id: slide.template_id || null,
    pattern: singleton.pattern,
    vgroup_id: singleton.vgroup_id || null,
    layout: singleton.layout || null,
    element_ids: [...(singleton.element_ids || [])],
    text,
    item_count: singleton.pattern === SINGLETON_PATTERNS.text_list
      ? (singleton.element_ids || []).length
      : 1,
    detection_method: singleton.detection_method,
    container: bbox ? {
      x_pt: (bbox.x || 0) * slideWidth,
      y_pt: (bbox.y || 0) * slideHeight,
      width_pt: (bbox.width || 0) * slideWidth,
      height_pt: (bbox.height || 0) * slideHeight,
    } : null,
    container_norm: bbox ? { ...bbox } : null,
    text_fields: singleton.text_fields || [],
  }
}

function buildComponentDefinition(pattern, instances) {
  const componentId = COMPONENT_IDS[pattern] || `sing_${pattern}_001`
  const slideNumbers = [...new Set(instances.map((item) => item.slide_number))].sort((left, right) => left - right)

  return {
    component_id: componentId,
    name: pattern.toUpperCase(),
    label: SINGLETON_PATTERN_LABELS[pattern] || pattern,
    source: 'singleton',
    kind: 'singleton',
    pattern,
    container: instances[0]?.container || {},
    container_norm: instances[0]?.container_norm || null,
    container_bounds: {
      typical: {
        width_pt: median(instances.map((item) => item.container?.width_pt).filter(Number.isFinite)),
        height_pt: median(instances.map((item) => item.container?.height_pt).filter(Number.isFinite)),
      },
      max: {
        width_pt: Math.max(...instances.map((item) => item.container?.width_pt).filter(Number.isFinite), 0),
        height_pt: Math.max(...instances.map((item) => item.container?.height_pt).filter(Number.isFinite), 0),
      },
    },
    capacity: {
      item_count_typical: pattern === SINGLETON_PATTERNS.text_list
        ? median(instances.map((item) => item.item_count).filter(Number.isFinite))
        : 1,
      item_count_max: pattern === SINGLETON_PATTERNS.text_list
        ? Math.max(...instances.map((item) => item.item_count).filter(Number.isFinite), 1)
        : 1,
    },
    text_fields: instances[0]?.text_fields || [],
    frequency: {
      instance_count: instances.length,
      slide_count: slideNumbers.length,
      slide_numbers: slideNumbers,
    },
    behavior: {
      singleton: true,
      repeatable: false,
      detection_methods: [...new Set(instances.map((item) => item.detection_method).filter(Boolean))],
    },
    instances,
  }
}

export function listSingletonComponents(report) {
  const slides = report?.slides?.slides || []
  const grouped = new Map()

  for (const slide of slides) {
    const repeatElementIds = collectRepeatElementIds(report, slide.slide_number)
    const { singletons } = detectSlideSingletons(slide, report, { repeatElementIds })

    for (const singleton of singletons) {
      const bucket = grouped.get(singleton.pattern) || []
      bucket.push(normalizeSlideSingletonInstance(slide, singleton))
      grouped.set(singleton.pattern, bucket)
    }
  }

  return [...grouped.entries()]
    .map(([pattern, instances]) => buildComponentDefinition(pattern, instances))
    .sort((left, right) => left.label.localeCompare(right.label, 'ru'))
}

export function defaultSingletonModel(component, instance = null) {
  const sample = instance || component.instances?.[0] || {}
  const fields = {}
  for (const field of sample.text_fields || component.text_fields || []) {
    fields[field.field_id || field.role] = field.sample_text || ''
  }
  return {
    component_id: component.component_id || component.id,
    pattern: component.pattern,
    fields,
    text: sample.text || Object.values(fields).filter(Boolean).join('\n'),
  }
}
