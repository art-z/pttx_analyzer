// Minimum gap between a slide title and the content below it, learned from
// the template: the median gap between the title ink and the first text below
// it on the template's own filled slides (per layout, then per deck), with a
// floor tied to the title line height.
import { findSlideTitleElements } from '../slides/slide-title-detect.js'
import { estimateTextInkHeightPt } from './separate-vertical-text.js'
import { effectiveTextRect } from './text-rect.js'

export const TITLE_GAP_FLOOR_PT = 12
const LINE_HEIGHT_SHARE = 0.8
const LINE_HEIGHT_FLOOR_CAP_PT = 32
// The learned median is a typical gap, not a minimum: 75% of it, capped at
// one title line, is required.
const MEDIAN_SHARE = 0.75
const MEDIAN_CAP_LINES = 1
const MAX_SAMPLE_GAP_PT = 150
const DEFAULT_SIZE = { width: 960, height: 540 }
const cache = new WeakMap()

const hasText = (element) => element?.kind === 'text' && Boolean(String(element.text || '').trim())

function sizeOf(report, slide) {
  return slide?.render?.slide_size_pt || report?.typography?.visibility?.slide_size_pt || DEFAULT_SIZE
}

function boxOf(element) {
  const box = element?.geometry_norm
  if (!box) return null
  const value = { x: Number(box.x), y: Number(box.y), width: Number(box.width), height: Number(box.height) }
  return Object.values(value).every(Number.isFinite) && value.width > 0 && value.height > 0 ? value : null
}

export function titleLineHeightPt(element) {
  const font = Number(element?.typography?.size_pt) || 0
  const explicit = Number(element?.typography?.line_height_pt)
  if (explicit > 0) return explicit
  const ratio = Number(element?.typography?.line_height_ratio)
  return font * (ratio > 0 ? ratio : 1.15)
}

// Vertical ink band (normalized) of a text element: its effective text rect
// (insets, anchor growth up/down/both ways; text-rect.js), not the frame.
export function textInkBand(element, size) {
  const box = boxOf(element)
  if (!box) return null
  const rect = effectiveTextRect(element, box, size)
  return { x: box.x, width: box.width, top: rect.y, bottom: rect.y + rect.height }
}

function spanShare(a, b) {
  const shared = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)
  const narrower = Math.min(a.width, b.width)
  return narrower > 0 ? Math.max(0, shared) / narrower : 0
}

// Text blocks as the renderer stacks them: a lone text box, or a text group
// (members share the group box and are stacked from its anchor).
function textBlocks(elements, size) {
  const blocks = []
  const groups = new Map()
  for (const element of elements) {
    if (!hasText(element)) continue
    const group = element.text_group_id
    if (!group) {
      const band = textInkBand(element, size)
      if (band) blocks.push({ ids: [element.element_id], band })
      continue
    }
    if (!groups.has(group)) groups.set(group, [])
    groups.get(group).push(element)
  }
  for (const members of groups.values()) {
    const box = boxOf({ geometry_norm: members[0].text_group_geometry_norm }) || boxOf(members[0])
    if (!box) continue
    const gapPt = Number(members[0].text_group_spacing_pt?.line_gap_pt) || 0
    const totalPt = members.reduce((sum, element) => (
      sum + (estimateTextInkHeightPt(element, box.width * size.width) ?? 0)
    ), 0) + gapPt * Math.max(0, members.length - 1)
    const height = totalPt / size.height
    const anchor = String(members[0].vertical_anchor || 't').toLowerCase()
    const top = ['b', 'bottom'].includes(anchor) ? box.y + box.height - height
      : ['ctr', 'middle', 'center'].includes(anchor) ? box.y + (box.height - height) / 2
        : box.y
    blocks.push({ ids: members.map((element) => element.element_id), band: { x: box.x, width: box.width, top, bottom: top + height } })
  }
  return blocks
}

// Gap (pt) from the title ink to the nearest text below it in its column.
export function gapBelowTitlePt(elements, titleIds, size) {
  const ids = new Set(titleIds)
  const blocks = textBlocks(elements, size)
  const bands = blocks.filter((block) => block.ids.some((id) => ids.has(id))).map((block) => block.band)
  if (!bands.length) return null
  const title = {
    x: Math.min(...bands.map((band) => band.x)),
    width: Math.max(...bands.map((band) => band.x + band.width)) - Math.min(...bands.map((band) => band.x)),
    top: Math.min(...bands.map((band) => band.top)),
    bottom: Math.max(...bands.map((band) => band.bottom)),
  }
  const tolerance = 2 / size.height
  let best = null
  for (const block of blocks) {
    if (block.ids.some((id) => ids.has(id))) continue
    const band = block.band
    if (band.top < title.bottom - tolerance || spanShare(band, title) < 0.3) continue
    const gap = (band.top - title.bottom) * size.height
    if (best == null || gap < best) best = gap
  }
  return best
}

function median(values) {
  if (!values.length) return null
  const sorted = [...values].sort((left, right) => left - right)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}

function templateKey(slide) {
  return slide?.template_id || slide?.layout_source || null
}

function donorGaps(report) {
  if (cache.has(report)) return cache.get(report)
  const byTemplate = new Map()
  const all = []
  for (const slide of report?.slides?.slides || []) {
    const elements = (slide.content_elements || []).filter((element) => hasText(element) && boxOf(element))
    if (elements.length < 2) continue
    let titleIds = []
    try {
      titleIds = [...(findSlideTitleElements(slide, report, slide.content_elements || []).elementIds || [])]
    } catch {
      titleIds = []
    }
    if (!titleIds.length) continue
    const gap = gapBelowTitlePt(elements, titleIds, sizeOf(report, slide))
    if (gap == null || gap < 0 || gap > MAX_SAMPLE_GAP_PT) continue
    const key = templateKey(slide)
    if (key) {
      if (!byTemplate.has(key)) byTemplate.set(key, [])
      byTemplate.get(key).push(gap)
    }
    all.push(gap)
  }
  const result = {
    byTemplate: new Map([...byTemplate].map(([key, values]) => [key, median(values)])),
    deck: median(all),
  }
  if (report && typeof report === 'object') cache.set(report, result)
  return result
}

export function templateTitleGapPt(report, slide) {
  const gaps = donorGaps(report)
  return gaps.byTemplate.get(templateKey(slide)) ?? gaps.deck
}

// Required gap below this title on this slide.
export function requiredTitleGapPt(report, slide, titleElement) {
  const lineHeight = titleLineHeightPt(titleElement)
  const floor = Math.max(TITLE_GAP_FLOOR_PT, Math.min(LINE_HEIGHT_SHARE * lineHeight, LINE_HEIGHT_FLOOR_CAP_PT))
  const learned = templateTitleGapPt(report, slide)
  if (!(learned > 0)) return floor
  return Math.max(floor, Math.min(MEDIAN_SHARE * learned, MEDIAN_CAP_LINES * lineHeight))
}
