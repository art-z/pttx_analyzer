import { findSlideTitleElements } from '../slides/slide-title-detect.js'
import { findSlideDescriptionElements } from '../slides/slide-description-detect.js'
import { patchSlideTextContent } from '../slides/text-content-patch.js'
import { finalizeScenarioPreviewSlide } from './finalize-scenario-preview.js'
import { placeTextUnderTitle } from './place-text-under-title.js'
import { ensureSyntheticTextElement } from '../components/synthetic-text-element.js'
import { listAllComponents, resolveComponentPreviewContext } from '../components/catalog.js'
import { buildContainerRepeatPreviewSlide } from '../components/container-render.js'
import { buildContainerModelFromContext } from '../components/component-semantics.js'
import { listPaginationComponents } from '../components/pagination-catalog.js'
import { fitTerminalTextBoxes } from './terminal-text-hit-test.js'
import { applyTerminalTextAreas } from './terminal-text-area.js'
import {
  effectiveBackgroundUnder,
  inferTerminalSlotStyle,
  layoutBaseName,
  validateTerminalSlotStyle,
} from './terminal-slot-style.js'

const SYSTEM_PLACEHOLDERS = new Set(['sldNum', 'dt', 'ftr', 'hdr'])

function paginationBoxes(report, slideNumber) {
  return listPaginationComponents(report).flatMap((component) => (
    (component.instances || [])
      .filter((instance) => instance.slide_number === slideNumber)
      .map((instance) => instance.container_norm || instance.vgroup?.bbox_norm)
      .filter(Boolean)
  ))
}

function isPaginationLayer(layer, boxes) {
  if (SYSTEM_PLACEHOLDERS.has(layer.placeholder_type)) return true
  if (/pagination|page number|slide number|номер слайда|пагинац/i.test(String(layer.name || ''))) return true
  const geometry = layer.geometry_norm || {}
  const area = Number(geometry.width || 0) * Number(geometry.height || 0)
  if (area > 0.04) return false
  const cx = Number(geometry.x || 0) + Number(geometry.width || 0) / 2
  const cy = Number(geometry.y || 0) + Number(geometry.height || 0) / 2
  return boxes.some((box) => (
    cx >= box.x - 0.01 && cx <= box.x + box.width + 0.01
    && cy >= box.y - 0.01 && cy <= box.y + box.height + 0.01
  ))
}

function terminalClutter(report, slide, titleIds, keepPerson = false) {
  const paginationIds = new Set(listPaginationComponents(report).flatMap((component) => (
    (component.instances || []).filter((instance) => instance.slide_number === slide.slide_number)
      .flatMap((instance) => instance.element_ids || [])
  )))
  const personIds = new Set(keepPerson ? (slide.component_instances || [])
    .filter((component) => /person|speaker|author|profile|спикер|персон/i.test(
      [component.name, component.label, component.component_id].filter(Boolean).join(' '),
    ))
    .flatMap((component) => component.element_ids || []) : [])
  const extra = (slide.content_elements || []).filter((element) => (
    !titleIds.has(element.element_id) && !paginationIds.has(element.element_id)
    && !personIds.has(element.element_id)
  ))
  const bottom = extra.filter((element) => (element.geometry_norm?.y || 0) > 0.82).length
  return extra.length + bottom * 2 + paginationIds.size
}

// Empty-text templates (layout placeholders only) rank a little below an
// equivalent analyzer-approved template with real text.
export const INFERRED_STYLE_PENALTY = 10
const MISSING_BODY_PENALTY = 5000
const USED_TERMINAL_TEMPLATE_PENALTY = 150000
const RICH_KIND_RE = /table|chart|diagram|graphic/i

function normBoxArea(box) {
  return Number(box?.width || 0) * Number(box?.height || 0)
}

function titleSlotOf(profile) {
  return (profile?.editable_slots || []).find((slot) => (
    ['title', 'ctrTitle'].includes(slot.role)
    && slot.geometry_norm?.width > 0
    && slot.geometry_norm?.height > 0
  )) || null
}

// JS mirror of the analyzer's terminal scoring (app/terminal_slide_candidates.py
// _score_slide) for a template whose only title is the empty layout slot.
function emptyTemplateBackendScore(role, { isFirst, isLast, filledTexts, filledChars, decorations, substantial, position }) {
  const initial = role === 'initial'
  const sparse = substantial <= 3
  const hint = initial
    ? (position <= 1 / 3 ? 6 : position >= 2 / 3 ? -6 : 0)
    : (position >= 2 / 3 ? 6 : position <= 1 / 3 ? -6 : 0)
  return (initial ? 50 : 40)
    + (initial ? (isFirst ? 150 : 0) : (isLast ? 30 : 0))
    + (sparse ? (initial ? 42 : 38) : 0)
    + (filledTexts === 0 ? (initial ? 34 : 38) : 0)
    + (filledChars <= 160 ? (initial ? 18 : 25) : 0)
    + Math.min(decorations, 4) * 4
    + 12
    + hint
    - INFERRED_STYLE_PENALTY
}

// A template the analyzer skipped only because its text fields are empty.
// It becomes a candidate when its title slot can get a reliable inferred style.
function emptyTextTerminalCandidate(report, slide, profile, role, title, { position, isFirst, isLast }) {
  const titleSlot = titleSlotOf(profile)
  if (!titleSlot || title.primary) return null
  const elements = slide.content_elements || []
  if (elements.some((element) => RICH_KIND_RE.test(String(element.kind || '')))) return null
  const texts = elements.filter((element) => (
    element.kind === 'text'
    && !SYSTEM_PLACEHOLDERS.has(element.placeholder_type)
    && String(element.text || element.text_sample || '').trim()
  ))
  if (texts.length > 2) return null
  const others = elements.filter((element) => (
    !['text', 'fill', 'line'].includes(element.kind) && normBoxArea(element.geometry_norm) >= 0.0025
  )).length
  const substantial = 1 + texts.length + others
  if (substantial > 3) return null
  const style = inferTerminalSlotStyle(report, slide, {
    box: titleSlot.geometry_norm,
    role: 'title',
    slotTypography: titleSlot.typography,
  })
  if (!style.ok) return null
  return {
    style,
    backendScore: emptyTemplateBackendScore(role, {
      isFirst,
      isLast,
      filledTexts: texts.length,
      filledChars: texts.reduce((sum, element) => sum + String(element.text || element.text_sample || '').trim().length, 0),
      decorations: elements.filter((element) => ['fill', 'line'].includes(element.kind)).length,
      substantial,
      position,
    }),
  }
}

function findSlide(report, slideNumber) {
  return (report?.slides?.slides || []).find((slide) => slide.slide_number === slideNumber) || null
}

function terminalCandidateList(report, role, spec) {
  const terminal = report?.slides?.terminal_candidates || {}
  const slides = (report?.slides?.slides || []).slice().sort((left, right) => (
    slideOrder(left) - slideOrder(right)
  ))
  const edgeSlide = role === 'initial' ? slides[0] : slides[slides.length - 1]
  const preferredNumber = terminal.preferred?.[`${role}_slide_number`]
  const parserCandidates = [
    ...(terminal[role] || []),
    ...(role === 'final' ? terminal.initial || [] : []),
  ]
  const roleBackendScores = (terminal[role] || []).map((item) => Number(item.score) || 0)
  const parserBySlide = new Map()
  const parserRankBySlide = new Map()
  parserCandidates.forEach((item) => {
    const number = Number(item.slide_number)
    if (!parserBySlide.has(number)) {
      parserBySlide.set(number, item)
      parserRankBySlide.set(number, parserRankBySlide.size)
    }
  })
  const profileByLayout = new Map(
    (report?.slide_templates?.templates || []).map((item) => [item.layout_source, item]),
  )
  const presentationTemplateCount = profileByLayout.size
    || new Set(slides.map((slide) => slide.layout_source).filter(Boolean)).size
  const byTemplate = new Map()

  for (const slide of slides) {
    const profile = profileByLayout.get(slide.layout_source)
    const parserCandidate = parserBySlide.get(Number(slide.slide_number))
    const roles = new Set((profile?.detected_roles || []).map((item) => String(item).toLowerCase()))
    if (presentationTemplateCount > 1 && (roles.has('quote') || roles.has('snippet'))) continue

    const title = findSlideTitleElements(slide, report)
    const titleSlot = (profile?.editable_slots || []).find((slot) => (
      ['title', 'ctrTitle'].includes(slot.role)
    ))
    const textSlot = (profile?.editable_slots || []).find((slot) => (
      ['body', 'subtitle', 'content'].includes(slot.role)
    ))
    const hasTitle = Boolean(title.primary || titleSlot)
    const hasBodyText = (slide.content_elements || []).some((element) => (
      element.kind === 'text'
      && !title.elementIds.has(element.element_id)
      && String(element.text || element.text_sample || '').trim()
    ))
    const hasPerson = slideHasPerson(slide)
    const isEdge = slide.slide_number === edgeSlide?.slide_number
    const profilePreferred = (profile?.preferred_terminal_roles || []).includes(role)
    const profileCandidate = (profile?.terminal_roles || []).includes(role)
    const isPreferred = slide.slide_number === preferredNumber || profilePreferred
    let inferredEmpty = null
    if (parserCandidates.length && !parserCandidate && !profileCandidate) {
      const index = slides.indexOf(slide)
      inferredEmpty = emptyTextTerminalCandidate(report, slide, profile, role, title, {
        position: slides.length > 1 ? index / (slides.length - 1) : 0,
        isFirst: index === 0,
        isLast: index === slides.length - 1,
      })
      if (!inferredEmpty) continue
    }

    // A title-only layout is still usable: the generator can place body copy
    // below it. The physical edge and parser-marked slides also cover legacy
    // reports without presentation_order metadata.
    if (!hasTitle && !textSlot && !hasBodyText && !isEdge && !parserCandidate) continue

    const templateId = slide.template_id || profile?.template_id || slide.layout_source
    const parserRank = parserRankBySlide.get(Number(slide.slide_number))
    // Slot the inferred template between the analyzer candidates by its
    // mirrored analyzer score, always below an equal-scoring filled one.
    const inferredRank = inferredEmpty
      ? (() => {
        const index = roleBackendScores.findIndex((value) => value < inferredEmpty.backendScore)
        return index < 0 ? roleBackendScores.length : index
      })()
      : 0
    const score = (isPreferred ? 100000 : 0)
      + (parserCandidate ? 500000 - parserRank * 10000 : 0)
      + (inferredEmpty ? 505000 - inferredRank * 10000 + inferredEmpty.backendScore : 0)
      + (profileCandidate ? 3000 : 0)
      + (isEdge ? 100 : 0)
      + (hasPerson && spec?.persons?.length ? 50 : 0)
      + (hasBodyText || textSlot ? 25 : 0)
      + (hasTitle ? 10 : 0)
    const candidate = {
      slide_number: slide.slide_number,
      template_id: templateId,
      layout_source: slide.layout_source,
      score: score - terminalClutter(report, slide, title.elementIds || new Set(),
        hasPerson && Boolean(spec?.persons?.length)) * 3500,
      preferred: isPreferred,
      physicalEdge: isEdge,
      textPlan: parserCandidate?.text_plan || null,
      ...(inferredEmpty ? { inferredStyle: true, titleStyle: inferredEmpty.style } : {}),
    }
    const key = String(templateId || `slide:${slide.slide_number}`)
    const existing = byTemplate.get(key)
    // A filled analyzer-approved slide of the same template always wins over
    // an empty-text copy of it.
    if (!existing
      || (existing.inferredStyle && !candidate.inferredStyle)
      || (Boolean(existing.inferredStyle) === Boolean(candidate.inferredStyle) && existing.score < score)) {
      byTemplate.set(key, candidate)
    }
  }

  return [...byTemplate.values()]
    .sort((left, right) => right.score - left.score || left.slide_number - right.slide_number)
}

function slideOrder(slide) {
  return Number(slide?.presentation_order) || Number(slide?.slide_number) || 0
}

function slideHasPerson(slide) {
  const values = []
  for (const component of slide?.component_instances || []) {
    values.push(component.name, component.label, component.component_id)
  }
  for (const element of slide?.content_elements || []) {
    values.push(element.component_ref?.name, element.component_ref?.component_id)
  }
  return /person|speaker|author|profile|спикер|персон/i.test(values.filter(Boolean).join(' '))
}

function terminalDecorationIds(slide) {
  const componentIds = new Set((slide?.component_instances || []).flatMap((item) => item.element_ids || []))
  return (slide?.content_elements || [])
    .filter((element) => ['fill', 'line'].includes(element.kind))
    .filter((element) => !element.component_ref && !componentIds.has(element.element_id))
    .map((element) => element.element_id)
    .filter(Boolean)
}

function profileForSlide(report, slide) {
  return (report?.slide_templates?.templates || []).find((item) => (
    item.layout_source === slide?.layout_source
  )) || null
}

function textSlotFor(profile) {
  return (profile?.editable_slots || []).find((slot) => (
    ['body', 'subtitle', 'content'].includes(slot.role)
      && slot.geometry_norm?.width > 0
      && slot.geometry_norm?.height > 0
  )) || null
}

function textColorFor(slide) {
  const value = String(slide?.render?.background_color || '#FFFFFF').replace('#', '')
  if (!/^[0-9a-f]{6}$/i.test(value)) return '#111111'
  const channels = [0, 2, 4].map((index) => parseInt(value.slice(index, index + 2), 16))
  const brightness = channels[0] * .299 + channels[1] * .587 + channels[2] * .114
  return brightness < 140 ? '#FFFFFF' : '#111111'
}

function plannedTypography(plan, slide) {
  return { ...(plan?.typography || {}), color: plan?.typography?.color || textColorFor(slide) }
}

function withPlannedGeometry(slide, ids, plan, typographyOverride = null) {
  if (!plan?.geometry_norm || !ids.length) return slide
  const size = slide?.render?.slide_size_pt || { width: 960, height: 540 }
  const box = plan.geometry_norm
  const selected = new Set(ids)
  return {
    ...slide,
    content_elements: (slide.content_elements || []).map((element) => (
      selected.has(element.element_id) ? {
        ...element,
        geometry_norm: { ...box },
        geometry_pt: {
          x_pt: box.x * size.width,
          y_pt: box.y * size.height,
          width_pt: box.width * size.width,
          height_pt: box.height * size.height,
        },
        typography: { ...element.typography, ...(typographyOverride || plannedTypography(plan, slide)) },
      } : element
    )),
  }
}

// Typography for a synthetic text box placed into an empty template slot.
// Analyzer-approved templates keep their slot style unless it fails the
// contrast/code-font check; empty-text templates never use the slot style.
function resolveTerminalSlotTypography(report, source, slide, slot, role, candidate) {
  const legacy = plannedTypography(slot, slide)
  const check = candidate.inferredStyle ? null : validateTerminalSlotStyle(source, slot.geometry_norm, legacy)
  if (check?.ok) return { typography: legacy, style_source: null }
  const inferred = inferTerminalSlotStyle(report, source, {
    box: slot.geometry_norm,
    role,
    slotTypography: slot.typography,
  })
  if (inferred.ok && check?.reason === 'low_contrast') {
    // Analyzer-approved template: keep its planned font/size, fix only the
    // unreadable colour.
    return {
      typography: { ...legacy, color: inferred.typography.color },
      style_source: 'inferred',
      style_evidence: { ...inferred.evidence, scope: 'color', rejected_color: legacy.color },
    }
  }
  if (inferred.ok) {
    return { typography: inferred.typography, style_source: inferred.style_source, style_evidence: inferred.evidence }
  }
  return candidate.inferredStyle ? null : { typography: legacy, style_source: null }
}

function markStyleSource(slide, ids, style) {
  if (!style?.style_source || !ids.length) return slide
  const selected = new Set(ids)
  return {
    ...slide,
    content_elements: (slide.content_elements || []).map((element) => (
      selected.has(element.element_id)
        ? { ...element, style_source: style.style_source, style_evidence: style.style_evidence || null }
        : element
    )),
  }
}

function terminalVariantOrder(left, right) {
  return left.terminalHitIssues - right.terminalHitIssues || right.score - left.score
}

// Covers/endings: keep the best variant, then prefer other visual families
// (base layout name + background class) and templates not already used by the
// other bookend of this deck.
function pickDiverseTerminalVariants(variants, limit) {
  const sorted = variants.slice().sort(terminalVariantOrder)
  const minHit = sorted[0]?.terminalHitIssues ?? 0
  const picked = []
  const families = new Set()
  const passes = [
    (variant) => variant.terminalHitIssues === minHit && !families.has(variant.visualFamily) && !variant.usedTerminalTemplate,
    (variant) => variant.terminalHitIssues === minHit && !families.has(variant.visualFamily),
    (variant) => variant.terminalHitIssues === minHit,
    (variant) => !families.has(variant.visualFamily),
    () => true,
  ]
  for (const accept of passes) {
    for (const variant of sorted) {
      if (picked.length >= limit) break
      if (picked.includes(variant) || !accept(variant)) continue
      picked.push(variant)
      families.add(variant.visualFamily)
    }
  }
  return picked.sort(terminalVariantOrder)
}

function promoteTerminalText(slide, ids) {
  const selected = new Set(ids)
  const foreground = Math.max(0, ...(slide?.render?.layers || [])
    .map((layer) => Number(layer.z_index) || 0)) + 1
  return {
    ...slide,
    content_elements: (slide.content_elements || []).map((element) => (
      selected.has(element.element_id)
        ? { ...element, z_index: Math.max(Number(element.z_index) || 0, foreground) }
        : element
    )),
  }
}

function withoutSourceTextLayers(slide, report) {
  const pagerBoxes = paginationBoxes(report, slide.slide_number)
  return {
    ...slide,
    render: {
      ...(slide.render || {}),
      layers: (slide.render?.layers || []).filter((layer) => {
        if (isPaginationLayer(layer, pagerBoxes)) return false
        if (layer.kind !== 'text') return true
        const name = String(layer.name || '').toLowerCase()
        const box = layer.geometry_norm || {}
        const area = Number(box.width || 0) * Number(box.height || 0)
        return /logo|wordmark|brand|логотип|бренд/.test(name)
          && area > 0 && area < .08
          && !['sldNum', 'dt', 'ftr', 'hdr'].includes(layer.placeholder_type)
      }),
    },
  }
}

function layoutIssueSummary(validation) {
  const labels = {
    text_overflow: 'текст не помещается',
    text_overlap: 'текст перекрывается',
    outside_safe_area: 'за безопасной областью',
    outside_slide: 'за границей слайда',
    dynamic_element_limit: 'слишком много элементов',
  }
  const issues = validation?.issues || []
  const summary = [...new Set(issues.map((issue) => labels[issue.code] || issue.code).filter(Boolean))]
  return summary.length ? ` · проблемы: ${summary.slice(0, 2).join(', ')}` : ''
}

function injectContextPersons(report, slide, spec, relevantComponents) {
  if (!spec?.persons?.length) return { slide, elementIds: [] }
  const recommendation = (relevantComponents?.recommendations || []).find((item) => (
    item.slot === 'repeat'
    && item.context_block === 'persons'
    && item.best?.component_id
  ))
  if (!recommendation) return { slide, elementIds: [] }

  const component = listAllComponents(report).find((item) => item.id === recommendation.best.component_id)
  if (!component) return { slide, elementIds: [] }
  const { instance } = resolveComponentPreviewContext(report, component, {
    templateId: slide.template_id || recommendation.best.template_id || slide.layout_source || null,
  })
  if (!instance || instance.slide_number !== slide.slide_number) return { slide, elementIds: [] }

  const modelData = recommendation.best.payload
    || buildContainerModelFromContext(component, instance, spec, { block: 'persons' })
  const rendered = buildContainerRepeatPreviewSlide(report, component, instance, { modelData })
  if (!rendered) return { slide, elementIds: [] }
  const originalIds = new Set((slide.content_elements || []).map((element) => element.element_id))
  const elementIds = (rendered.content_elements || [])
    .filter((element) => !originalIds.has(element.element_id))
    .map((element) => element.element_id)
  return { slide: rendered, elementIds }
}

export function buildTerminalSlideVariants(report, spec, role, {
  limit = 3,
  relevantComponents = null,
  selectionContext = null,
} = {}) {
  if (role !== 'initial' && role !== 'final') return []
  const usedTerminalTemplates = selectionContext?.terminalTemplateUsage || {}
  const preferred = report?.slides?.terminal_candidates?.preferred?.[`${role}_slide_number`]
  const candidates = terminalCandidateList(report, role, spec)
  const variants = []
  const usedTemplates = new Set()
  for (const candidate of candidates) {
    if (variants.length >= Math.max(limit * 4, 12)) break
    const source = findSlide(report, candidate.slide_number)
    if (!source) continue
    const templateId = candidate.template_id || source.template_id || source.layout_source
    if (usedTemplates.has(templateId)) continue
    const profile = profileForSlide(report, source)
    const plan = candidate.textPlan
    let slide = JSON.parse(JSON.stringify(source))
    const contextualPersons = injectContextPersons(report, slide, spec, relevantComponents)
    slide = contextualPersons.slide
    const title = findSlideTitleElements(slide, report)
    let titleIds = [...(title.elementIds || [])]
    const titleSlot = (profile?.editable_slots || []).find((item) => (
      ['title', 'ctrTitle'].includes(item.role)
      && item.geometry_norm?.width > 0
      && item.geometry_norm?.height > 0
    ))
    const displayTitle = String(spec?.title || '').trim()
      || (role === 'initial' ? 'Название презентации' : 'Завершение презентации')
    const displayBody = String(spec?.text || spec?.summary_text || '').trim()
    let titleStyle = null
    if (!titleIds.length) {
      const plannedTitle = plan?.title || titleSlot
      if (plannedTitle?.geometry_norm) {
        titleStyle = resolveTerminalSlotTypography(report, source, slide, plannedTitle, 'title', candidate)
        if (!titleStyle) continue
        const synthetic = ensureSyntheticTextElement(slide, {
          kind: 'slide_title',
          text: displayTitle,
          instance: {
            slide_number: source.slide_number,
            container_norm: plannedTitle.geometry_norm,
            typography: titleStyle.typography,
            detection_method: 'terminal_template_title_slot',
          },
        })
        slide = synthetic.slide
        titleIds = synthetic.elementIds
      }
    }
    if (candidate.inferredStyle && !titleIds.length) continue
    if (titleIds.length && displayTitle) {
      slide = patchSlideTextContent(slide, { elementIds: titleIds, text: displayTitle })
      slide = withPlannedGeometry(slide, titleIds, plan?.title, titleStyle?.typography || null)
    }
    slide = markStyleSource(slide, titleIds, titleStyle)

    let bodyIds = []
    let bodyStyle = null
    let bodyDropped = false
    const bodySlot = plan?.text || textSlotFor(profile)
    const existingBody = findSlideDescriptionElements(slide, report)
    if (displayBody && existingBody.elementIds?.length) {
      bodyIds = [...existingBody.elementIds]
      slide = patchSlideTextContent(slide, { elementIds: bodyIds, text: displayBody })
      slide = withPlannedGeometry(slide, bodyIds, plan?.text)
    } else if (displayBody && bodySlot
      && (bodyStyle = resolveTerminalSlotTypography(report, source, slide, bodySlot, 'subtitle', candidate))) {
      const bodyElement = ensureSyntheticTextElement(slide, {
        kind: 'slide_description',
        text: displayBody,
        instance: {
          slide_number: source.slide_number,
          container_norm: bodySlot.geometry_norm,
          typography: bodyStyle.typography,
          detection_method: 'terminal_template_text_slot',
        },
      })
      slide = bodyElement.slide
      bodyIds = bodyElement.elementIds
      if (bodyIds.length) slide = patchSlideTextContent(slide, { elementIds: bodyIds, text: displayBody })
      slide = markStyleSource(slide, bodyIds, bodyStyle)
    } else if (displayBody && candidate.inferredStyle) {
      // No reliable style for the empty body slot: leave the box out rather
      // than guess, and rank the variant below complete ones.
      bodyDropped = true
    } else if (displayBody) {
      const placed = placeTextUnderTitle(slide, report, displayBody, { avoidOccupied: false })
      if (placed.created) {
        slide = placed.slide
        bodyIds = placed.elementIds
      }
    }

    slide = promoteTerminalText(slide, [...titleIds, ...bodyIds])
    // Clip/move the title and subtitle into the template's free area (no
    // photos/art/plates under them, inside the safe area, title above the
    // subtitle) and fit the real text there; the hit-test below is the final check.
    let prepared = withoutSourceTextLayers(slide, report)
    const textArea = applyTerminalTextAreas(report, prepared, {
      titleIds,
      bodyIds,
      title: displayTitle,
      subtitle: displayBody,
      cacheKey: `${templateId}|${source.slide_number}|${contextualPersons.elementIds.length}`,
    })
    prepared = textArea.slide
    const finalized = finalizeScenarioPreviewSlide(report, prepared, {
      title: titleIds.length ? displayTitle : '',
      text: displayBody,
    }, null, {
      mode: 'text',
      includeDescription: Boolean(displayBody),
      allowInvalidLayout: true,
      // Keep lightweight source decoration and contextual people only. Tables,
      // charts, and unrelated repeat components must not leak from the donor.
      keepElementIds: [
        ...terminalDecorationIds(slide),
        ...contextualPersons.elementIds,
        ...bodyIds,
      ],
    })
    if (!finalized) continue
    const catalogSlide = fitTerminalTextBoxes(report, finalized, { titleIds })

    usedTemplates.add(templateId)
    const usedTerminalTemplate = Boolean(usedTerminalTemplates[templateId])
    const inferredSource = [titleStyle, bodyStyle].find((item) => item?.style_source)?.style_source || null
    const layoutStatus = layoutIssueSummary(catalogSlide.layout_validation)
    const hitIssues = (catalogSlide.layout_validation?.issues || []).filter((issue) => (
      ['text_overlap', 'text_overflow', 'outside_slide'].includes(issue.code)
      || (issue.severity === 'error' && ['text_over_image', 'low_contrast'].includes(issue.code))
    )).length + (textArea.applied && !textArea.fits ? 1 : 0)
    variants.push({
      key: `terminal-${role}-${candidate.slide_number}`,
      role: variants.length === 0 ? 'best' : 'alternative',
      label: role === 'initial' ? 'Начальный слайд' : 'Финальный слайд',
      sublabel: `Шаблон ${source.layout_name || source.template_id || source.slide_number}${
        candidate.inferredStyle ? ' · стиль текста из дизайн-системы' : ''}${layoutStatus}`,
      score: 100000 + Number(candidate.score || 0)
        + (candidate.preferred || candidate.slide_number === preferred ? 10000 : 0)
        - (bodyDropped ? MISSING_BODY_PENALTY : 0)
        - (usedTerminalTemplate ? USED_TERMINAL_TEMPLATE_PENALTY : 0)
        - hitIssues * 1000000,
      catalogSlide,
      slideNumber: candidate.slide_number,
      templateId,
      dataBlock: 'terminal',
      terminalRole: role,
      preferredTerminal: !usedTerminalTemplate
        && (candidate.physicalEdge || candidate.preferred || candidate.slide_number === preferred),
      textPlan: plan,
      terminalHitIssues: hitIssues,
      titleCapacity: textArea.capacity?.label || null,
      titleFits: textArea.applied ? textArea.fits : null,
      styleSource: inferredSource || 'template',
      inferredStyle: Boolean(candidate.inferredStyle),
      usedTerminalTemplate,
      visualFamily: `${layoutBaseName(source.layout_name) || templateId}|${
        effectiveBackgroundUnder(source, { x: 0, y: 0, width: 1, height: 1 }).darkness}`,
    })
  }
  return pickDiverseTerminalVariants(variants, limit)
    .map((variant, index) => ({ ...variant, role: index === 0 ? 'best' : 'alternative' }))
}
