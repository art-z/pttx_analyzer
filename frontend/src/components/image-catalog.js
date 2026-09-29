import {
  IMAGE_LAYOUT_PATTERNS,
  findSlideHeroImageElements,
  imageAreaNorm,
} from '../slides/slide-image-detect.js'

export const MIN_IMAGE_COMPONENT_INSTANCES = 2
export const MIN_BACKGROUND_IMAGE_COMPONENT_INSTANCES = 1

const PATTERN_LABELS = {
  [IMAGE_LAYOUT_PATTERNS.title_side]: 'Заголовок + фото сбоку',
  [IMAGE_LAYOUT_PATTERNS.title_below]: 'Заголовок + фото снизу',
  [IMAGE_LAYOUT_PATTERNS.title_desc_side]: 'Заголовок + описание + фото сбоку',
  [IMAGE_LAYOUT_PATTERNS.title_desc_below]: 'Заголовок + описание + фото снизу',
  [IMAGE_LAYOUT_PATTERNS.title_hero]: 'Заголовок + hero-изображение',
  [IMAGE_LAYOUT_PATTERNS.title_bg_side]: 'Заголовок + фон сбоку',
  [IMAGE_LAYOUT_PATTERNS.title_bg_below]: 'Заголовок + фон снизу',
  [IMAGE_LAYOUT_PATTERNS.title_desc_bg_side]: 'Заголовок + описание + фон сбоку',
  [IMAGE_LAYOUT_PATTERNS.title_desc_bg_below]: 'Заголовок + описание + фон снизу',
}

function median(values) {
  const sorted = values.filter(Number.isFinite).sort((left, right) => left - right)
  if (!sorted.length) return null
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

function roundNorm(value, step = 0.05) {
  if (!Number.isFinite(value)) return null
  return Math.round(value / step) * step
}

function bboxFromElement(element, slideWidth, slideHeight) {
  const geometry = element?.geometry_pt || {}
  if (geometry.width_pt > 0 && geometry.height_pt > 0) {
    return {
      x_pt: geometry.x_pt || 0,
      y_pt: geometry.y_pt || 0,
      width_pt: geometry.width_pt,
      height_pt: geometry.height_pt,
      x_norm: (geometry.x_pt || 0) / slideWidth,
      y_norm: (geometry.y_pt || 0) / slideHeight,
      width_norm: geometry.width_pt / slideWidth,
      height_norm: geometry.height_pt / slideHeight,
    }
  }

  const norm = element?.geometry_norm || {}
  return {
    x_pt: (norm.x || 0) * slideWidth,
    y_pt: (norm.y || 0) * slideHeight,
    width_pt: (norm.width || 0) * slideWidth,
    height_pt: (norm.height || 0) * slideHeight,
    x_norm: norm.x || 0,
    y_norm: norm.y || 0,
    width_norm: norm.width || 0,
    height_norm: norm.height || 0,
  }
}

function buildPlacementVariants(instances) {
  const variants = new Map()

  for (const instance of instances) {
    const placement = instance.image_placement
    if (!placement) continue
    const key = [
      instance.template_id || 'deck',
      roundNorm(placement.x_norm, 0.05),
      roundNorm(placement.y_norm, 0.05),
      roundNorm(placement.width_norm, 0.05),
    ].join('|')

    if (!variants.has(key)) {
      variants.set(key, {
        id: `absolute_${variants.size + 1}`,
        label: `Absolute · ${instance.template_id || 'deck'} · ${Math.round((placement.width_norm || 0) * 100)}×${Math.round((placement.height_norm || 0) * 100)}%`,
        source: 'absolute',
        coordinate_space: 'slide_absolute',
        anchor_mode: 'absolute',
        template_id: instance.template_id || null,
        x_pt: placement.x_pt,
        y_pt: placement.y_pt,
        x_norm: placement.x_norm,
        y_norm: placement.y_norm,
        width_pt: placement.width_pt,
        height_pt: placement.height_pt,
        width_norm: placement.width_norm,
        height_norm: placement.height_norm,
        bbox_norm: instance.image_container_norm,
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
    if (!instance.image_placement) return
    const match = placements.find((placement) => (
      (placement.template_id || null) === (instance.template_id || null)
      && roundNorm(placement.y_norm, 0.05) === roundNorm(instance.image_placement.y_norm, 0.05)
      && roundNorm(placement.width_norm, 0.05) === roundNorm(instance.image_placement.width_norm, 0.05)
    ))
    instance.placement_id = match?.id || placements[0]?.id || null
  })
  return instances
}

function normalizeSlideInstance(slide, report) {
  const hero = findSlideHeroImageElements(slide, report)
  if (!hero.primary || hero.method === 'none') return null

  const slideWidth = slide.render?.slide_size_pt?.width || report?.slides?.summary?.slide_size_pt?.width || 960
  const slideHeight = slide.render?.slide_size_pt?.height || report?.slides?.summary?.slide_size_pt?.height || 540
  const imageBox = bboxFromElement(hero.primary, slideWidth, slideHeight)

  return {
    slide_number: slide.slide_number,
    template_id: slide.template_id || null,
    element_id: hero.primary.element_id,
    element_ids: [hero.primary.element_id],
    asset: hero.primary.asset || null,
    fill_mode: hero.primary.fill_mode || 'stretch',
    crop: hero.primary.crop || null,
    layout_pattern: hero.layoutPattern,
    has_description: hero.hasDescription,
    is_background: Boolean(hero.isBackground),
    detection_method: hero.method,
    detection_score: hero.score,
    image_area_norm: imageAreaNorm(hero.primary),
    title_element_ids: [...(hero.title?.elementIds || [])],
    description_element_ids: [...(hero.description?.elementIds || [])],
    image_container: {
      x_pt: imageBox.x_pt,
      y_pt: imageBox.y_pt,
      width_pt: imageBox.width_pt,
      height_pt: imageBox.height_pt,
    },
    image_container_norm: {
      x: imageBox.x_norm,
      y: imageBox.y_norm,
      width: imageBox.width_norm,
      height: imageBox.height_norm,
    },
    image_placement: {
      coordinate_space: 'slide_absolute',
      anchor_mode: 'absolute',
      source: 'content_elements',
      x_pt: imageBox.x_pt,
      y_pt: imageBox.y_pt,
      x_norm: imageBox.x_norm,
      y_norm: imageBox.y_norm,
      width_pt: imageBox.width_pt,
      height_pt: imageBox.height_pt,
      width_norm: imageBox.width_norm,
      height_norm: imageBox.height_norm,
    },
    placement_id: null,
  }
}

function componentGroupKey(instance) {
  if (instance.is_background) {
    return [
      'background',
      instance.layout_pattern || IMAGE_LAYOUT_PATTERNS.title_bg_side,
      instance.has_description ? 'desc' : 'plain',
    ].join('|')
  }

  return [
    instance.layout_pattern || IMAGE_LAYOUT_PATTERNS.title_hero,
    instance.has_description ? 'desc' : 'plain',
    roundNorm(instance.image_container_norm?.width, 0.1),
    roundNorm(instance.image_container_norm?.y, 0.1),
  ].join('|')
}

function minInstancesForGroup(instances) {
  if (instances.some((item) => item.is_background)) return MIN_BACKGROUND_IMAGE_COMPONENT_INSTANCES
  return MIN_IMAGE_COMPONENT_INSTANCES
}

function buildCapacity(instances) {
  return {
    image_area_typical: median(instances.map((item) => item.image_area_norm).filter(Number.isFinite)),
    image_area_max: Math.max(...instances.map((item) => item.image_area_norm).filter(Number.isFinite), 0),
    image_width_typical: median(instances.map((item) => item.image_container_norm?.width).filter(Number.isFinite)),
    image_height_typical: median(instances.map((item) => item.image_container_norm?.height).filter(Number.isFinite)),
    with_description_ratio: instances.filter((item) => item.has_description).length / instances.length,
  }
}

function buildComponentFromInstances(groupKey, instances) {
  const minInstances = minInstancesForGroup(instances)
  if (instances.length < minInstances) return null

  const pattern = instances[0].layout_pattern || IMAGE_LAYOUT_PATTERNS.title_hero
  const hasDescription = instances.some((item) => item.has_description)
  const isBackground = instances.some((item) => item.is_background)
  const placements = buildPlacementVariants(instances)
  const normalizedInstances = assignInstancePlacements([...instances], placements)
  const capacity = buildCapacity(normalizedInstances)
  const safeGroupKey = String(groupKey).replace(/[^a-z0-9]+/gi, '_').replace(/^_+|_+$/g, '') || 'group'
  const componentId = `img_${pattern}${hasDescription ? '_desc' : ''}_${safeGroupKey}_${normalizedInstances.length}`

  return {
    component_id: componentId,
    name: 'SLIDE_IMAGE',
    label: `${PATTERN_LABELS[pattern] || pattern} · w${Math.round((capacity.image_width_typical || 0) * 100)}%`,
    source: 'slide_image',
    kind: 'slide_image',
    layout_pattern: pattern,
    has_description: hasDescription,
    is_background: isBackground,
    group_key: groupKey,
    container: normalizedInstances[0]?.image_container || {},
    container_norm: normalizedInstances[0]?.image_container_norm || null,
    container_bounds: {
      typical: {
        width_pt: median(normalizedInstances.map((item) => item.image_container?.width_pt).filter(Number.isFinite)),
        height_pt: median(normalizedInstances.map((item) => item.image_container?.height_pt).filter(Number.isFinite)),
      },
      max: {
        width_pt: Math.max(...normalizedInstances.map((item) => item.image_container?.width_pt).filter(Number.isFinite), 0),
        height_pt: Math.max(...normalizedInstances.map((item) => item.image_container?.height_pt).filter(Number.isFinite), 0),
      },
    },
    capacity,
    placements,
    default_placement_id: placements[0]?.id || null,
    behavior: {
      detection_methods: [...new Set(normalizedInstances.map((item) => item.detection_method))],
      layout_patterns: [...new Set(normalizedInstances.map((item) => item.layout_pattern))],
      requires_title: true,
      allows_background: isBackground,
    },
    image_fields: [{
      field_id: 'hero_image',
      role: 'image',
      required: true,
      presence_ratio: 1,
      sample_asset: normalizedInstances[0]?.asset || null,
    }],
    frequency: {
      instance_count: normalizedInstances.length,
      slide_count: normalizedInstances.length,
      slide_numbers: normalizedInstances.map((item) => item.slide_number).sort((left, right) => left - right),
    },
    instances: normalizedInstances,
  }
}

export function listSlideImageComponents(report) {
  const slides = report?.slides?.slides || []
  const instances = slides
    .map((slide) => normalizeSlideInstance(slide, report))
    .filter(Boolean)

  if (instances.length < MIN_BACKGROUND_IMAGE_COMPONENT_INSTANCES) return []

  const groups = new Map()
  for (const instance of instances) {
    const key = componentGroupKey(instance)
    const bucket = groups.get(key) || []
    bucket.push(instance)
    groups.set(key, bucket)
  }

  const components = [...groups.values()]
    .map((bucket) => buildComponentFromInstances(componentGroupKey(bucket[0]), bucket))
    .filter(Boolean)
    .sort((left, right) => (
      (right.frequency?.instance_count || 0) - (left.frequency?.instance_count || 0)
      || String(left.label).localeCompare(String(right.label), 'ru')
    ))

  return components
}

export function defaultSlideImageModel(component, instance = null) {
  const sample = instance || component.instances?.[0] || {}
  return {
    component_id: component.id || component.component_id,
    asset: sample.asset || null,
    fill_mode: sample.fill_mode || 'stretch',
    placement_id: sample.placement_id
      || component.default_placement_id
      || component.defaultPlacementId
      || component.placements?.[0]?.id
      || null,
  }
}
