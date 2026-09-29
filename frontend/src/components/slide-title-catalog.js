import { findSlideTitleElements } from '../slides/slide-title-detect.js'

export const DEFAULT_TITLE_PHRASE = 'Стратегия развития продукта и ключевые инициативы на следующий квартал с фокусом на рост выручки удержание клиентов масштабирование команды и качество сервиса'

export const MIN_TITLE_WORDS = 1

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

export function splitPhraseWords(phrase = DEFAULT_TITLE_PHRASE) {
  return String(phrase || '').trim().split(/\s+/).filter(Boolean)
}

export function countWords(text) {
  return splitPhraseWords(text).length
}

export function buildTitleTextFromWords(phrase, wordCount, { minWords = MIN_TITLE_WORDS } = {}) {
  const words = splitPhraseWords(phrase)
  if (!words.length) return ''
  const safeCount = Math.max(minWords, Math.min(words.length, Number(wordCount) || minWords))
  return words.slice(0, safeCount).join(' ')
}

function bboxFromElements(elements, slideWidth, slideHeight) {
  const pts = (elements || []).map((element) => element.geometry_pt || {}).filter((geometry) => geometry.width_pt > 0)
  if (!pts.length) return null
  const xs = pts.map((item) => item.x_pt)
  const ys = pts.map((item) => item.y_pt)
  const xe = pts.map((item) => item.x_pt + item.width_pt)
  const ye = pts.map((item) => item.y_pt + item.height_pt)
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

function buildPlacementVariants(instances) {
  const variants = new Map()

  for (const instance of instances) {
    const placement = instance.placement
    if (!placement) continue
    const key = `${instance.template_id || 'deck'}|${roundNorm(placement.y_norm, 0.03)}|${roundNorm(placement.x_norm, 0.03)}`
    if (!variants.has(key)) {
      variants.set(key, {
        id: `absolute_${variants.size + 1}`,
        label: `Absolute · ${instance.template_id || 'deck'} · x ${Math.round(placement.x_norm * 100)}% · y ${Math.round(placement.y_norm * 100)}%`,
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
        bbox_norm: instance.container_norm,
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
      (placement.template_id || null) === (instance.template_id || null)
      && roundNorm(placement.y_norm, 0.03) === roundNorm(instance.placement.y_norm, 0.03)
      && roundNorm(placement.x_norm, 0.03) === roundNorm(instance.placement.x_norm, 0.03)
    ))
    instance.placement_id = match?.id || placements[0]?.id || null
  })
  return instances
}

function normalizeSlideInstance(slide, report, spatialComponent) {
  const titleResult = findSlideTitleElements(slide, report)
  if (!titleResult.primary || titleResult.method === 'none') return null

  const slideWidth = slide.render?.slide_size_pt?.width || report?.slides?.summary?.slide_size_pt?.width || 960
  const slideHeight = slide.render?.slide_size_pt?.height || report?.slides?.summary?.slide_size_pt?.height || 540
  const elements = titleResult.elements?.length ? titleResult.elements : [titleResult.primary]
  const bbox = bboxFromElements(elements, slideWidth, slideHeight)
  const text = titleResult.primary.text || titleResult.primary.text_sample || ''
  const spatialInstance = spatialComponent?.instances?.find((item) => item.slide_number === slide.slide_number)

  return {
    slide_number: slide.slide_number,
    template_id: slide.template_id || null,
    element_ids: [...titleResult.elementIds],
    text,
    word_count: countWords(text),
    char_count: text.length,
    line_count: titleResult.primary.text_paragraphs?.length || spatialInstance?.line_count || 1,
    detection_method: titleResult.method,
    detection_score: titleResult.score,
    typography: {
      family: titleResult.primary.typography?.family || spatialInstance?.family || null,
      size_pt: titleResult.primary.typography?.size_pt || spatialInstance?.size_pt || null,
      scale_level: titleResult.primary.typography?.scale_level || spatialInstance?.scale_level || null,
    },
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
    placement: bbox ? {
      coordinate_space: 'slide_absolute',
      anchor_mode: 'absolute',
      source: 'content_elements',
      x_pt: bbox.x_pt,
      y_pt: bbox.y_pt,
      x_norm: bbox.x_norm,
      y_norm: bbox.y_norm,
      width_pt: bbox.width_pt,
      height_pt: bbox.height_pt,
      width_norm: bbox.width_norm,
      height_norm: bbox.height_norm,
    } : null,
    placement_id: null,
  }
}

function buildCapacity(instances, defaultPhrase) {
  const phraseWords = splitPhraseWords(defaultPhrase)
  return {
    word_count_min: MIN_TITLE_WORDS,
    word_count_max: phraseWords.length,
    word_count_typical: median(instances.map((item) => item.word_count).filter(Number.isFinite)) || MIN_TITLE_WORDS,
    word_count_observed_max: Math.max(...instances.map((item) => item.word_count).filter(Number.isFinite), MIN_TITLE_WORDS),
    char_count_max: Math.max(...instances.map((item) => item.char_count).filter(Number.isFinite), 0),
    line_count_max: Math.max(...instances.map((item) => item.line_count).filter(Number.isFinite), 1),
    line_count_typical: median(instances.map((item) => item.line_count).filter(Number.isFinite)) || 1,
  }
}

export function listSlideTitleComponents(report) {
  const spatialComponent = report?.typography?.spatial?.components
    ?.find((item) => item.id === 'slide_title')
  const slides = report?.slides?.slides || []
  let instances = slides
    .map((slide) => normalizeSlideInstance(slide, report, spatialComponent))
    .filter(Boolean)

  if (instances.length < 2) return []

  const absolutePlacements = buildPlacementVariants(instances)
  instances = assignInstancePlacements(instances, absolutePlacements)
  const defaultPhrase = DEFAULT_TITLE_PHRASE
  const capacity = buildCapacity(instances, defaultPhrase)
  const defaultPlacement = absolutePlacements[0] || null
  const typography = {
    dominant_family: spatialComponent?.typography?.dominant_family
      || median(instances.map((item) => item.typography?.family).filter(Boolean))
      || null,
    dominant_size_pt: spatialComponent?.typography?.dominant_size_pt
      || median(instances.map((item) => item.typography?.size_pt).filter(Number.isFinite))
      || null,
    scale_level: median(instances.map((item) => item.typography?.scale_level).filter(Number.isFinite)),
  }

  return [{
    component_id: 'title_001',
    name: 'SLIDE_TITLE',
    label: `Заголовок слайда · ${Math.round(typography.dominant_size_pt || 0)} pt`,
    source: 'slide_title',
    kind: 'slide_title',
    default_phrase: defaultPhrase,
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
    capacity,
    typography,
    placements: absolutePlacements,
    default_placement_id: defaultPlacement?.id || null,
    behavior: {
      detection_methods: [...new Set(instances.map((item) => item.detection_method))],
      spatial_rules: spatialComponent?.spatial_rules || null,
    },
    text_fields: [{
      field_id: 'title_text',
      role: 'title',
      required: true,
      presence_ratio: 1,
      sample_text: instances[0]?.text || null,
      typography,
    }],
    frequency: {
      instance_count: instances.length,
      slide_count: instances.length,
      slide_numbers: instances.map((item) => item.slide_number).sort((left, right) => left - right),
    },
    instances,
    spatial: spatialComponent || null,
  }]
}

export function defaultSlideTitleModel(component, instance = null) {
  const sample = instance || component.instances?.[0] || {}
  const phrase = component.default_phrase || component.raw?.default_phrase || DEFAULT_TITLE_PHRASE
  const wordCount = sample.word_count || component.capacity?.word_count_typical || MIN_TITLE_WORDS
  return {
    component_id: component.id || component.component_id,
    word_count: wordCount,
    text: buildTitleTextFromWords(phrase, wordCount),
    placement_id: sample.placement_id
      || component.defaultPlacementId
      || component.default_placement_id
      || component.placements?.[0]?.id
      || null,
  }
}

export function resolveSlideTitlePlacement(component, placementId = null, instance = null) {
  const placements = component.placements || component.raw?.placements || []
  const resolvedId = placementId
    || instance?.placement_id
    || component.defaultPlacementId
    || component.default_placement_id
    || placements[0]?.id
  return placements.find((item) => item.id === resolvedId)
    || instance?.placement
    || placements[0]
    || null
}
