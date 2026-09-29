import { findSlideTitleElements } from '../slides/slide-title-detect.js'
import { patchSlideTextContent } from '../slides/text-content-patch.js'
import { finalizeScenarioPreviewSlide } from './finalize-scenario-preview.js'
import { placeTextUnderTitle } from './place-text-under-title.js'

const GRID = 10

function slideList(report) {
  return report?.slides?.slides || []
}

function elementBox(element) {
  const box = element?.geometry_norm
  if (!box || !(box.width > 0) || !(box.height > 0)) return null
  if (box.width >= 0.98 && box.height >= 0.98) return null
  return box
}

function occupy(box, cells) {
  const x0 = Math.max(0, Math.floor(box.x * GRID))
  const y0 = Math.max(0, Math.floor(box.y * GRID))
  const x1 = Math.min(GRID, Math.ceil((box.x + box.width) * GRID))
  const y1 = Math.min(GRID, Math.ceil((box.y + box.height) * GRID))
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) cells.add(`${x}:${y}`)
  }
}

function boxesOverlap(left, right) {
  const width = Math.min(left.x + left.width, right.x + right.width) - Math.max(left.x, right.x)
  const height = Math.min(left.y + left.height, right.y + right.height) - Math.max(left.y, right.y)
  if (width <= 0 || height <= 0) return false
  const minArea = Math.min(left.width * left.height, right.width * right.height)
  return minArea > 0 && (width * height) / minArea >= 0.18
}

export function templateDensity(slide) {
  const cells = new Set()
  let substantial = 0
  for (const element of slide?.content_elements || []) {
    const box = elementBox(element)
    if (!box || box.width * box.height < 0.01) continue
    substantial += 1
    occupy(box, cells)
  }
  return {
    substantial,
    coverage: cells.size / (GRID * GRID),
  }
}

function densityScore(slide) {
  const title = findSlideTitleElements(slide, null)
  if (!elementBox(title.primary)) return -1
  const { substantial, coverage } = templateDensity(slide)
  if (substantial < 4 || coverage < 0.34) return -1
  return coverage * 100 + Math.min(substantial, 16)
}

function hashSeed(value) {
  let hash = 2166136261
  for (const char of String(value || '')) {
    hash ^= char.charCodeAt(0)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

function visualIdsBeside(slide, protectedBoxes) {
  return (slide.content_elements || [])
    .filter((element) => element.kind === 'image' || element.kind === 'fill' || element.kind === 'line')
    .filter((element) => {
      const box = elementBox(element)
      if (!box) return false
      return !protectedBoxes.some((kept) => boxesOverlap(box, kept))
    })
    .map((element) => element.element_id)
}

export function rankDenseTemplateSlides(report, { usedSlideNumbers = [], usedTemplates = [] } = {}) {
  const usedSlides = new Set(usedSlideNumbers)
  const usedLayouts = new Set(usedTemplates.filter(Boolean))
  return slideList(report)
    .map((slide) => ({ slide, score: densityScore(slide) }))
    .filter((item) => item.score > 0)
    .filter((item) => !usedSlides.has(item.slide.slide_number))
    .filter((item) => !usedLayouts.has(item.slide.layout_source || item.slide.template_id || ''))
    .sort((left, right) => right.score - left.score || left.slide.slide_number - right.slide.slide_number)
}

export function buildTemplateFirstVariant(report, spec, {
  usedSlideNumbers = [],
  usedTemplates = [],
  seed = '',
} = {}) {
  const ranked = rankDenseTemplateSlides(report, { usedSlideNumbers, usedTemplates }).slice(0, 4)
  if (!ranked.length) return null
  const source = ranked[hashSeed(`${seed}|template`) % ranked.length].slide
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
    keepElementIds: visualIdsBeside(slide, protectedBoxes),
  })
  if (!catalogSlide) return null
  if (templateDensity(catalogSlide).coverage < 0.2) return null

  return {
    key: `template-first-${source.slide_number}`,
    role: 'alternative',
    label: 'Плотный шаблон',
    sublabel: `Слайд ${source.slide_number} · от макета`,
    score: 22,
    catalogSlide,
    slideNumber: source.slide_number,
    templateId: source.layout_source || source.template_id || null,
    dataBlock: 'template_first',
  }
}

function variantSlideNumber(item) {
  return item.slideNumber || item.catalogSlide?.slide_number
}

function variantTemplate(item) {
  return item.templateId || item.catalogSlide?.layout_source || ''
}

export function withTemplateFirstVariant(variants, report, spec, { seed = '' } = {}) {
  const picked = []
  const blocks = new Set()
  const slides = new Set()
  const templates = new Set()
  for (const item of variants || []) {
    const block = item.dataBlock || ''
    const slideNumber = variantSlideNumber(item)
    const template = variantTemplate(item)
    if (block && blocks.has(block)) continue
    if (slideNumber && slides.has(slideNumber)) continue
    if (template && templates.has(template)) continue
    if (block) blocks.add(block)
    if (slideNumber) slides.add(slideNumber)
    if (template) templates.add(template)
    picked.push(item)
    if (picked.length >= 3) return picked
  }
  if (picked.some((item) => item.dataBlock === 'template_first')) return picked

  const extra = buildTemplateFirstVariant(report, spec, {
    usedSlideNumbers: [...slides],
    usedTemplates: [...templates],
    seed,
  })
  return extra ? [...picked, extra] : picked
}
