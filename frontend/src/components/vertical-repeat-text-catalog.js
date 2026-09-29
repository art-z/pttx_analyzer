import { detectDeckVgroups } from '../slides/vgroup-detect.js'
import { extractDesignTokens } from '../constructor/tokens.js'
import { layoutUnderTitle } from '../presentation/place-text-under-title.js'
import {
  isVerticalRepeatFlow,
  resolveVerticalRepeatContainerBBox,
  resolveVerticalRepeatItems,
  unionBoxesNorm,
  unionBoxesPt,
} from './repeat-layout-analysis.js'
import {
  buildDescriptionTextFromWords,
  DEFAULT_DESCRIPTION_PHRASE,
  MIN_DESCRIPTION_WORDS,
} from './slide-description-catalog.js'

function roundNorm(value, step = 0.03) {
  if (!Number.isFinite(value)) return null
  return Math.round(value / step) * step
}

function slideSizePt(slide, report) {
  return slide?.render?.slide_size_pt
    || report?.slides?.summary?.slide_size_pt
    || { width: 960, height: 540 }
}

function bboxPtToContainer(bboxPt, bboxNorm) {
  if (!bboxPt?.width_pt || !bboxPt?.height_pt) return { container: null, container_norm: null, placement: null }
  return {
    container: {
      x_pt: bboxPt.x_pt,
      y_pt: bboxPt.y_pt,
      width_pt: bboxPt.width_pt,
      height_pt: bboxPt.height_pt,
    },
    container_norm: bboxNorm ? {
      x: bboxNorm.x,
      y: bboxNorm.y,
      width: bboxNorm.width,
      height: bboxNorm.height,
    } : null,
    placement: {
      coordinate_space: 'slide_absolute',
      anchor_mode: 'absolute',
      source: 'vertical_repeat',
      x_pt: bboxPt.x_pt,
      y_pt: bboxPt.y_pt,
      x_norm: bboxNorm?.x ?? null,
      y_norm: bboxNorm?.y ?? null,
      width_pt: bboxPt.width_pt,
      height_pt: bboxPt.height_pt,
      width_norm: bboxNorm?.width ?? null,
      height_norm: bboxNorm?.height ?? null,
    },
  }
}

function instanceClusterKey(instance) {
  return [
    instance.template_id || 'deck',
    roundNorm(instance.container_norm?.y),
    roundNorm(instance.container_norm?.width),
    roundNorm(instance.container_norm?.height),
  ].join('|')
}

function pickBestSyntheticCluster(instances = []) {
  const clusters = new Map()
  for (const instance of instances) {
    const key = instanceClusterKey(instance)
    if (!clusters.has(key)) clusters.set(key, [])
    clusters.get(key).push(instance)
  }

  return [...clusters.values()]
    .filter((cluster) => cluster.length >= 2)
    .sort((left, right) => (
      right.length - left.length
      || (right[0].container?.height_pt || 0) - (left[0].container?.height_pt || 0)
    ))[0] || []
}

function mostCommon(values) {
  const counts = new Map()
  for (const value of values) {
    if (value == null || value === '') continue
    counts.set(value, (counts.get(value) || 0) + 1)
  }
  return [...counts.entries()].sort((left, right) => right[1] - left[1])[0]?.[0] ?? null
}

function textElementsInItems(items = []) {
  return items.flatMap((item) => (item.elements || []).filter((element) => (
    element?.kind === 'text' && element.typography?.size_pt && (element.geometry_norm || element.geometry_pt)
  )))
}

function bodyTextElements(elements) {
  const lines = elements.filter((element) => Number(element.text_line_index) > 0)
  const pool = lines.length ? lines : elements
  const minSize = Math.min(...pool.map((element) => Number(element.typography.size_pt)))
  const bodies = pool.filter((element) => Number(element.typography.size_pt) <= minSize + 0.5)
  return bodies.length ? bodies : pool
}

function elementBoxPt(element, slideSize) {
  const points = element.geometry_pt
  if (points?.width_pt > 0 && points?.height_pt > 0) return points
  const normalized = element.geometry_norm
  if (!normalized?.width || !normalized?.height || !slideSize?.width) return null
  return {
    x_pt: normalized.x * slideSize.width,
    y_pt: normalized.y * slideSize.height,
    width_pt: normalized.width * slideSize.width,
    height_pt: normalized.height * slideSize.height,
  }
}

function elementBoxNorm(element, slideSize) {
  const normalized = element.geometry_norm
  if (normalized?.width > 0 && normalized?.height > 0) return normalized
  const points = element.geometry_pt
  if (!points?.width_pt || !slideSize?.width) return null
  return {
    x: points.x_pt / slideSize.width,
    y: points.y_pt / slideSize.height,
    width: points.width_pt / slideSize.width,
    height: points.height_pt / slideSize.height,
  }
}

export function textColumnFromRepeatItems(items, slideSize) {
  const bodies = bodyTextElements(textElementsInItems(items))
  if (!bodies.length) return null
  const boxesPt = bodies.map((element) => elementBoxPt(element, slideSize)).filter(Boolean)
  const boxesNorm = bodies.map((element) => elementBoxNorm(element, slideSize)).filter(Boolean)
  const sample = bodies[0].typography || {}
  const sizes = bodies.map((element) => Number(element.typography.size_pt)).filter(Number.isFinite)
  const mid = Math.floor(sizes.length / 2)
  const sortedSizes = [...sizes].sort((left, right) => left - right)
  return {
    bboxPt: unionBoxesPt(boxesPt),
    bboxNorm: unionBoxesNorm(boxesNorm),
    typography: {
      family: mostCommon(bodies.map((element) => element.typography.family)) || sample.family || null,
      size_pt: sortedSizes.length
        ? (sortedSizes.length % 2 ? sortedSizes[mid] : (sortedSizes[mid - 1] + sortedSizes[mid]) / 2)
        : sample.size_pt,
      color: mostCommon(bodies.map((element) => element.typography.color)) || sample.color || null,
      bold: false,
      alignment: mostCommon(bodies.map((element) => element.typography.alignment)) || sample.alignment || null,
      line_height_pt: sample.line_height_pt ?? null,
      line_height_ratio: sample.line_height_ratio ?? null,
    },
  }
}

function scoreVerticalRepeatGroup(group, slideGroups) {
  const repeatCount = Number(group.repeat?.count) || 0
  const area = (group.bboxPt?.width_pt || 0) * (group.bboxPt?.height_pt || 0)
  return repeatCount * 1_000_000 + area
}

export function findVerticalRepeatTextSource(slideNumber, deck, report) {
  const slideEntry = deck?.perSlide?.find((entry) => entry.slideNumber === slideNumber)
  const slide = report?.slides?.slides?.find((entry) => entry.slide_number === slideNumber)
  if (!slideEntry || !slide) return null

  const candidates = (slideEntry.groups || [])
    .filter((group) => Number(group.repeat?.count) >= 2 && isVerticalRepeatFlow(group, slideEntry.groups))
    .sort((left, right) => scoreVerticalRepeatGroup(right, slideEntry.groups) - scoreVerticalRepeatGroup(left, slideEntry.groups))

  const size = slideSizePt(slide, report)
  for (const group of candidates) {
    const items = resolveVerticalRepeatItems(group, slideEntry.groups, slide)
    const column = textColumnFromRepeatItems(items?.items, size)
    const resolved = column?.bboxPt
      ? column
      : resolveVerticalRepeatContainerBBox(group, slideEntry.groups, slide)
    if (!resolved?.bboxPt?.width_pt || !resolved?.bboxPt?.height_pt) continue
    return {
      group,
      bboxPt: resolved.bboxPt,
      bboxNorm: resolved.bboxNorm,
      typography: column?.typography || null,
      repeat_signature: group.repeat?.itemSig || group.signature || null,
    }
  }

  return null
}

export function buildSyntheticDescriptionInstance(slide, report, source, tokens) {
  const phrase = DEFAULT_DESCRIPTION_PHRASE
  const text = buildDescriptionTextFromWords(phrase, MIN_DESCRIPTION_WORDS)
  const layout = layoutUnderTitle(slide, report, text, tokens)
  if (!layout) return null
  const { container, container_norm, placement } = bboxPtToContainer({
    x_pt: layout.box.x * layout.slideSize.width,
    y_pt: layout.box.y * layout.slideSize.height,
    width_pt: layout.box.width * layout.slideSize.width,
    height_pt: layout.box.height * layout.slideSize.height,
  }, layout.box)
  const body = layout.typography

  return {
    slide_number: slide.slide_number,
    template_id: slide.template_id || null,
    element_ids: [],
    synthetic: true,
    source_vgroup_id: source.group.id,
    repeat_signature: source.repeat_signature,
    text,
    word_count: MIN_DESCRIPTION_WORDS,
    char_count: text.length,
    line_count: 1,
    detection_method: 'under_title',
    detection_score: null,
    detection_reasons: ['no slide_description detected', 'placed under slide title'],
    typography: {
      family: body.family || null,
      size_pt: body.size_pt || body.sizePt || null,
      scale_level: body.scaleLevel ?? body.scale_level ?? null,
      color: body.color || null,
      alignment: body.alignment || null,
      line_height_pt: body.line_height_pt ?? null,
      line_height_ratio: body.line_height_ratio ?? null,
    },
    container,
    container_norm,
    placement,
    placement_id: null,
  }
}

export function buildSyntheticSlideDescriptionInstances(report, deck, { excludeSlideNumbers = [] } = {}) {
  if (!report || !deck) return []

  const excluded = new Set(excludeSlideNumbers)
  const tokens = extractDesignTokens(report)
  const instances = []

  for (const slide of report?.slides?.slides || []) {
    if (excluded.has(slide.slide_number)) continue
    const source = findVerticalRepeatTextSource(slide.slide_number, deck, report)
    if (!source) continue
    const instance = buildSyntheticDescriptionInstance(slide, report, source, tokens)
    if (instance) instances.push(instance)
  }

  return pickBestSyntheticCluster(instances)
}

export function resolveDeckForVerticalRepeatText(report, deck = null) {
  return deck || detectDeckVgroups(report.slides, report)
}
