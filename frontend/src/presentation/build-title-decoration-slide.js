import { findSlideTitleElements } from '../slides/slide-title-detect.js'
import { patchSlideTextContent } from '../slides/text-content-patch.js'
import { finalizeScenarioPreviewSlide } from './finalize-scenario-preview.js'
import { placeTextUnderTitle } from './place-text-under-title.js'

const MIN_PHOTO_SIDE = 0.08

function slideList(report) {
  return report?.slides?.slides || []
}

function elementBox(element) {
  const box = element?.geometry_norm
  if (!box || !(box.width > 0) || !(box.height > 0)) return null
  return box
}

function isRoomyPhoto(element) {
  if (element?.kind !== 'image') return false
  const box = elementBox(element)
  if (!box) return false
  return Math.min(box.width, box.height) >= MIN_PHOTO_SIDE
    && box.width * box.height >= 0.02
    && box.width < 0.99
    && box.height < 0.99
}

export function roomyPhotoCount(slide) {
  return (slide?.content_elements || []).filter(isRoomyPhoto).length
}

function boxesOverlap(left, right) {
  const width = Math.min(left.x + left.width, right.x + right.width) - Math.max(left.x, right.x)
  const height = Math.min(left.y + left.height, right.y + right.height) - Math.max(left.y, right.y)
  if (width <= 0 || height <= 0) return false
  const minArea = Math.min(left.width * left.height, right.width * right.height)
  return minArea > 0 && (width * height) / minArea >= 0.2
}

function photoIdsBeside(slide, protectedBoxes) {
  return (slide?.content_elements || [])
    .filter(isRoomyPhoto)
    .filter((element) => {
      const box = elementBox(element)
      return box && !protectedBoxes.some((protectedBox) => boxesOverlap(box, protectedBox))
    })
    .map((element) => element.element_id)
}

function hashSeed(value) {
  let hash = 2166136261
  for (const char of String(value || '')) {
    hash ^= char.charCodeAt(0)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

function decorationScore(slide) {
  const photos = (slide?.content_elements || []).filter(isRoomyPhoto)
  if (!photos.length) return -1
  const texts = (slide.content_elements || []).filter((element) => element.kind === 'text')
  const heavy = (slide.content_elements || []).filter((element) => (
    element.kind === 'table' || element.kind === 'chart'
  )).length
  if (texts.length > 4 || heavy) return -1

  const title = findSlideTitleElements(slide, null)
  const titleBox = elementBox(title.primary)
  if (!titleBox || titleBox.y > 0.28) return -1

  const covering = photos.filter((photo) => boxesOverlap(elementBox(photo), titleBox)).length
  const openPhotos = photos.length - covering
  if (!openPhotos) return -1

  return openPhotos * 40
    + photos.reduce((sum, photo) => sum + elementBox(photo).width * elementBox(photo).height, 0) * 20
    - texts.length * 6
    - covering * 30
}

export function rankTitleDecorationSlides(report, { usedSlideNumbers = [], usedTemplates = [] } = {}) {
  const used = new Set(usedSlideNumbers)
  const usedLayouts = new Set(usedTemplates.filter(Boolean))
  return slideList(report)
    .map((slide) => ({ slide, score: decorationScore(slide) }))
    .filter((item) => item.score > 0 && !used.has(item.slide.slide_number))
    .filter((item) => !usedLayouts.has(item.slide.layout_source || item.slide.template_id || ''))
    .sort((left, right) => right.score - left.score || left.slide.slide_number - right.slide.slide_number)
}

export function buildTitleDecorationVariant(report, spec, {
  usedSlideNumbers = [],
  usedTemplates = [],
  seed = '',
} = {}) {
  const ranked = rankTitleDecorationSlides(report, { usedSlideNumbers, usedTemplates }).slice(0, 4)
  if (!ranked.length) return null
  const source = ranked[hashSeed(seed) % ranked.length].slide
  let slide = JSON.parse(JSON.stringify(source))
  const title = findSlideTitleElements(slide, report)
  const titleIds = [...(title.elementIds || [])]
  if (spec?.title && titleIds.length) {
    slide = patchSlideTextContent(slide, {
      elementIds: titleIds,
      text: spec.title,
    })
  }

  const body = String(spec?.text || '').trim()
  if (body) {
    const placed = placeTextUnderTitle(slide, report, body, { avoidOccupied: true })
    if (placed.created) slide = placed.slide
  }

  const protectedBoxes = (slide.content_elements || [])
    .filter((element) => titleIds.includes(element.element_id) || element.synthetic)
    .map(elementBox)
    .filter(Boolean)

  const catalogSlide = finalizeScenarioPreviewSlide(report, slide, {
    title: spec?.title || '',
    text: body,
  }, null, {
    mode: 'text',
    includeDescription: Boolean(body),
    keepElementIds: photoIdsBeside(slide, protectedBoxes),
  })
  if (!catalogSlide || !roomyPhotoCount(catalogSlide)) return null

  return {
    key: `title-decor-${source.slide_number}`,
    role: 'alternative',
    label: 'Заголовок и декорации',
    sublabel: `Слайд ${source.slide_number} · картинки шаблона`,
    score: 24,
    catalogSlide,
    slideNumber: source.slide_number,
    templateId: source.layout_source || source.template_id || null,
    dataBlock: 'title_decor',
  }
}

export function withTitleDecorationVariant(variants, report, spec, { seed = '' } = {}) {
  const picked = [...(variants || [])]
  const usedSlideNumbers = picked.map((item) => item.slideNumber || item.catalogSlide?.slide_number)
  const usedTemplates = picked.map((item) => item.templateId || item.catalogSlide?.layout_source)
  const wantsImages = spec?.intent === 'example' || (spec?.images || []).length > 0
  const hasImages = picked.some((item) => roomyPhotoCount(item.catalogSlide) > 0)
  if (picked.length >= 3 && !(wantsImages && !hasImages)) return picked

  const extra = buildTitleDecorationVariant(report, spec, { usedSlideNumbers, usedTemplates, seed })
  if (!extra) return picked
  if (picked.length < 3) return [...picked, extra]

  const plainIndex = picked.findLastIndex((item) => roomyPhotoCount(item.catalogSlide) === 0)
  if (plainIndex < 0) return picked
  const next = [...picked]
  next[plainIndex] = extra
  return next
}
