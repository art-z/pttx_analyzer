import { findSlide } from '../components/catalog.js'
import { listPaginationComponents } from '../components/pagination-catalog.js'
import { findSlideDescriptionElements } from '../slides/slide-description-detect.js'
import { findSlideTitleElements } from '../slides/slide-title-detect.js'
import {
  patchCatalogSlideScenarioText,
  resolveDescriptionElementIds,
  resolveTitleElementIds,
} from './build-catalog-slide.js'
import { materializeChartStyles, planFinalChartLabels } from './materialize-chart-styles.js'
import { refitChartsClearOfText } from './component-template-fit.js'
import { resolveSlideLayout, summarizeLayoutIssues } from './slide-hit-test.js'
import { typographSlideText } from '../slides/text-typographer.js'
import { detectSlideVgroups } from '../slides/vgroup-detect.js'

function elementCenterInNormBox(element, box, tolerance = 0.03) {
  const geometry = element.geometry_norm || {}
  const cx = (geometry.x || 0) + (geometry.width || 0) / 2
  const cy = (geometry.y || 0) + (geometry.height || 0) / 2
  return cx >= (box.x || 0) - tolerance
    && cx <= (box.x || 0) + (box.width || 0) + tolerance
    && cy >= (box.y || 0) - tolerance
    && cy <= (box.y || 0) + (box.height || 0) + tolerance
}

export function collectPaginationElementIds(report, slideNumber) {
  const ids = new Set()
  if (!report || slideNumber == null) return ids

  const slide = findSlide(report, slideNumber)
  for (const component of listPaginationComponents(report)) {
    for (const instance of component.instances || []) {
      if (instance.slide_number !== slideNumber) continue
      for (const id of instance.element_ids || []) ids.add(id)

      const box = instance.container_norm
        || (instance.container ? {
          x: (instance.placement?.x_norm ?? instance.container.x_pt / 960),
          y: (instance.placement?.y_norm ?? instance.container.y_pt / 540),
          width: instance.container.width_pt ? instance.container.width_pt / 960 : 0.2,
          height: instance.container.height_pt ? instance.container.height_pt / 540 : 0.05,
        } : null)

      if (!box || !slide) continue
      for (const element of slide.content_elements || []) {
        if (elementCenterInNormBox(element, box)) ids.add(element.element_id)
      }
    }
  }

  return ids
}

export function resolvePreviewTitleElementIds(report, slide, relevantComponents) {
  const slideNumber = slide?.slide_number ?? null
  const catalogIds = report
    ? (resolveTitleElementIds(report, relevantComponents, slideNumber) || [])
    : []
  const presentCatalogIds = catalogIds.filter((id) => (
    (slide?.content_elements || []).some((element) => element.element_id === id)
  ))
  if (presentCatalogIds.length) return presentCatalogIds

  const detected = findSlideTitleElements(slide, report)
  return [...(detected.elementIds || [])]
}

export function resolvePreviewDescriptionElementIds(report, slide, relevantComponents) {
  const slideNumber = slide?.slide_number ?? null
  const catalogIds = report
    ? (resolveDescriptionElementIds(report, relevantComponents, slideNumber) || [])
    : []
  const presentCatalogIds = catalogIds.filter((id) => (
    (slide?.content_elements || []).some((element) => element.element_id === id)
  ))
  if (presentCatalogIds.length) return presentCatalogIds

  const detected = findSlideDescriptionElements(slide, report)
  return detected.elementIds || []
}

function collectRepeatKeepElementIds(slide) {
  return (slide?.content_elements || [])
    .filter((element) => String(element.element_id).includes('__repeat_'))
    .map((element) => element.element_id)
}

function collectComponentDataElementIds(slide, { includeRepeats = true } = {}) {
  const keep = new Set()
  for (const element of slide?.content_elements || []) {
    if (element.component_data || element.baseline_preview) keep.add(element.element_id)
    if (includeRepeats && String(element.element_id).includes('__repeat_')) {
      keep.add(element.element_id)
    }
  }
  return [...keep]
}

function collectSyntheticTextElementIds(slide) {
  return (slide?.content_elements || [])
    .filter((element) => element.synthetic && element.kind === 'text')
    .map((element) => element.element_id)
}

function elementBox(element) {
  const normalized = element?.geometry_norm
  if (!normalized) return null
  const box = {
    x: Number(normalized.x),
    y: Number(normalized.y),
    width: Number(normalized.width),
    height: Number(normalized.height),
  }
  if (![box.x, box.y, box.width, box.height].every(Number.isFinite)) return null
  if (box.width <= 0 || box.height <= 0) return null
  return box
}

function boxesOverlap(left, right) {
  const width = Math.min(left.x + left.width, right.x + right.width) - Math.max(left.x, right.x)
  const height = Math.min(left.y + left.height, right.y + right.height) - Math.max(left.y, right.y)
  if (width <= 0 || height <= 0) return false
  const minArea = Math.min(left.width * left.height, right.width * right.height)
  return minArea > 0 && (width * height) / minArea >= 0.12
}

function isRoomyImage(element) {
  if (element?.kind !== 'image') return false
  const box = elementBox(element)
  if (!box) return false
  return Math.min(box.width, box.height) >= 0.03 && box.width * box.height >= 0.004
}

function collectFreeImageIds(slide, keepIds) {
  const elements = slide?.content_elements || []
  const occupied = elements
    .filter((element) => keepIds.has(element.element_id))
    .map(elementBox)
    .filter(Boolean)
  const ids = []
  for (const element of elements) {
    if (keepIds.has(element.element_id) || !isRoomyImage(element)) continue
    const box = elementBox(element)
    if (occupied.some((kept) => boxesOverlap(box, kept))) continue
    ids.push(element.element_id)
  }
  return ids
}

// Large panels/backdrops and named brand pieces are real decoration.
const PANEL_AREA = 0.25
const PROTECTED_DECOR_RE = /logo|логотип|brand|бренд|frame|рамк|border/i

function isProtectedDecor(element) {
  const box = elementBox(element)
  if (box && box.width * box.height >= PANEL_AREA) return true
  return PROTECTED_DECOR_RE.test(`${element.name || ''} ${element.element_id || ''} ${element.role || ''}`)
}

function centreInside(inner, outer) {
  const cx = inner.x + inner.width / 2
  const cy = inner.y + inner.height / 2
  return cx >= outer.x && cx <= outer.x + outer.width && cy >= outer.y && cy <= outer.y + outer.height
}

// Parts of recognised donor components (component_instances, vgroups incl.
// repeats) whose own text was dropped: empty card plates, avatar circles,
// badges, QR/photo placeholders, separators of a list that is not shown.
// A group is abandoned when none of its text is kept (a plain vgroup must also
// have had text on the donor, so text-free decoration groups stay). Its non-text members go, except real decoration (panels >= 25% of the
// slide, backdrops, logo/brand/frame pieces) and plates that now sit behind a
// kept text (they are that text's background).
// Pictures the caller asked for explicitly (exemptIds: the photos of a
// decoration variant, free images of a visual strategy) are never remnants;
// explicitly kept plates still are.
export function collectComponentRemnantIds(report, slide, keepIds, exemptIds = new Set()) {
  const remnants = new Set()
  const donor = report && slide ? findSlide(report, slide.slide_number) : null
  if (!donor) return remnants
  const donorElements = new Map((donor.content_elements || []).map((element) => [element.element_id, element]))
  const elements = new Map((slide.content_elements || []).map((element) => [element.element_id, element]))
  // Recognised components and repeat groups count as components on their
  // own; a plain vgroup only when it carried text on the donor.
  const groups = (donor.component_instances || []).map((instance) => ({ ids: instance.element_ids || [], component: true }))
  let vgroups = []
  try {
    vgroups = detectSlideVgroups(donor, { report }).groups || []
  } catch {
    vgroups = []
  }
  for (const group of vgroups) {
    groups.push({
      ids: (group.elements || []).map((element) => element?.element_id).filter(Boolean),
      component: Number(group.repeat?.count) >= 2 || Boolean(group.repeat?.grid),
    })
  }
  const keptTextBoxes = [...keepIds].map((id) => elements.get(id))
    .filter((element) => element?.kind === 'text' && String(element.text || '').trim())
    .map(elementBox).filter(Boolean)
  const isDonorText = (id) => {
    const element = donorElements.get(id)
    return element?.kind === 'text' && Boolean(String(element.text || '').trim())
  }
  const keptText = (id) => {
    const element = elements.get(id)
    return Boolean(element && keepIds.has(id) && element.kind === 'text' && String(element.text || '').trim())
  }
  for (const { ids, component } of groups) {
    if (!ids.length || ids.some(keptText) || (!component && !ids.some(isDonorText))) continue
    for (const id of ids) {
      const element = elements.get(id)
      if (!element || !keepIds.has(id) || element.kind === 'text' || isProtectedDecor(element)) continue
      if (exemptIds.has(id) && element.kind === 'image') continue
      const box = elementBox(element)
      if (box && keptTextBoxes.some((text) => centreInside(text, box))) continue
      remnants.add(id)
    }
  }
  return remnants
}

// The element that carries the slide title text is the title for the
// hit-test (title gap), whatever the catalog detection picked.
function withTitleTextIds(slide, ids, title) {
  const normalize = (value) => String(value || '').replace(/[\u00a0\u202f]/g, ' ').replace(/\s+/g, ' ').trim()
  const expected = normalize(title)
  const matching = (slide?.content_elements || [])
    .filter((element) => element.kind === 'text' && expected && normalize(element.text) === expected)
    .map((element) => element.element_id)
  return [...new Set([...ids, ...matching])]
}

function filterSlideElements(slide, keepElementIds, paginationIds) {
  const keep = new Set(keepElementIds.filter(Boolean))
  return {
    ...slide,
    content_elements: (slide.content_elements || []).filter((element) => {
      if (paginationIds.has(element.element_id)) return false
      return keep.has(element.element_id)
    }),
  }
}

export function finalizeScenarioPreviewSlide(report, slide, spec, relevantComponents, {
  mode = 'content',
  includeDescription = false,
  hidePagination = true,
  preserveFreeImages = false,
  allowInvalidLayout = false,
  keepElementIds: extraKeepElementIds = [],
  stripComponentRemnants = true,
} = {}) {
  if (!slide) return slide

  let next = JSON.parse(JSON.stringify(slide))
  const paginationIds = hidePagination
    ? collectPaginationElementIds(report, next.slide_number)
    : new Set()

  const shouldPatchText = Boolean(spec?.title || (includeDescription && spec?.text))
  if (shouldPatchText) {
    next = patchCatalogSlideScenarioText(report, next, {
      ...spec,
      title: spec.title || '',
      text: includeDescription ? (spec.text || '') : '',
      metrics: [],
      cards: [],
      lists: [],
      timelines: [],
      icon_lists: [],
      persons: [],
      quotes: [],
      snippets: [],
    }, relevantComponents)
  }

  const titleIds = spec?.title
    ? withTitleTextIds(next, resolvePreviewTitleElementIds(report, next, relevantComponents), spec.title)
    : []
  const descriptionIds = includeDescription && spec?.text
    ? resolvePreviewDescriptionElementIds(report, next, relevantComponents)
    : []

  const fallbackTextIds = mode === 'text' ? collectSyntheticTextElementIds(next) : []
  const textIds = [...titleIds, ...descriptionIds, ...fallbackTextIds]
  let keepIds = [...extraKeepElementIds, ...textIds]
  if (mode === 'repeat') {
    keepIds.push(...collectRepeatKeepElementIds(next))
  } else if (mode === 'graphic') {
    keepIds.push(...collectComponentDataElementIds(next, { includeRepeats: false }))
  } else if (mode === 'metric') {
    keepIds.push(...collectComponentDataElementIds(next))
  } else if (mode === 'content') {
    keepIds.push(...collectComponentDataElementIds(next))
  }
  // Donor-slide images are content, not harmless decoration. Keep them only for
  // an explicit visual strategy; otherwise they are a frequent source of stale,
  // irrelevant elements in an otherwise valid generated slide.
  const freeImageIds = preserveFreeImages ? collectFreeImageIds(next, new Set(keepIds)) : []
  keepIds.push(...freeImageIds)

  const remnants = stripComponentRemnants
    ? collectComponentRemnantIds(report, next, new Set(keepIds), new Set([...extraKeepElementIds, ...freeImageIds]))
    : new Set()
  let filtered = filterSlideElements(next, [...new Set(keepIds)].filter((id) => !remnants.has(id)), paginationIds)
  if (remnants.size) filtered = { ...filtered, component_remnants_removed: [...remnants] }
  // One hit-test pass: text fit, unit separation, safe-area clamp, re-check.
  // Only a slide that is physically off-canvas is dropped here; every other
  // remaining error travels with the slide so the variant pipeline can reject
  // it with its exact reason.
  const fitted = (filtered.content_elements || []).some((element) => element.kind === 'chart')
    ? refitChartsClearOfText(report, filtered)
    : filtered
  const styled = typographSlideText(materializeChartStyles(report, fitted))
  const resolvedLayout = resolveSlideLayout(report, styled, { titleIds })
  const labelled = planFinalChartLabels(report, resolvedLayout.slide)
  const resolved = labelled.issues.length
    ? { slide: labelled.slide, validation: withExtraLayoutIssues(resolvedLayout.validation, labelled.issues) }
    : { ...resolvedLayout, slide: labelled.slide }
  const validation = resolved.validation
  const hard = validation.errors.some((issue) => ['outside_slide', 'dynamic_element_limit'].includes(issue.code))
  if (hard && !allowInvalidLayout) return null
  return {
    ...resolved.slide,
    layout_validation: validation,
  }
}

function withExtraLayoutIssues(validation, extra) {
  const { errors, warnings, issues, valid, reject_reason: rejectReason, ...rest } = validation || {}
  return summarizeLayoutIssues([...(issues || []), ...extra], rest)
}
