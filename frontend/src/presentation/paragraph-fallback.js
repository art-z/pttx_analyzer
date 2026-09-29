// Guaranteed fallback when a slide still has fewer than 3 clean variants:
// the paragraphs (always present in the model data) are laid out
//   a) as title + text in other donor templates (text placed under the donor's
//      own title, one donor per template), and
//   b) as list items / cards: every paragraph becomes one item; a short
//      heading is taken from its first clause or sentence, the rest is the
//      body. Nothing is invented: headings and bodies are the paragraph's own
//      words. With a single paragraph the slide summary (also model text) is
//      used as the other item; failing that the paragraph's sentences are.
// Fallback candidates go through the same finalize/hit-test pipeline as the
// regular ones and are ranked below every real-data variant.
import { findSlide, listAllComponents } from '../components/catalog.js'
import { findSlideTitleElements } from '../slides/slide-title-detect.js'
import { buildTextCatalogSlideFromPick } from './build-text-slide.js'
import { sliceSpecForDataStep } from './build-scenario-sequential.js'
import { resolveSlideRelevantComponents } from './match-relevant-components.js'
import { buildScenarioPreviewVariants, runScenarioVariantPipeline } from './build-scenario-preview-variants.js'

export const FALLBACK_SCORE_PENALTY = 60
const MAX_TEXT_DONORS = 4
const MAX_HEADING_CHARS = 60
const MAX_DONOR_TITLE_PT = 48
const CLAUSE_SEPARATORS = [': ', ' — ', ' – ', '; ']
// A comma ends the first clause only before a new clause, not inside an
// enumeration ("подготовку, обучение и запуск" stays whole).
const CLAUSE_START = /^(?:а|но|однако|затем|поэтому|чтобы|что|где|когда|который|которая|которое|которые|при этом|так как|потому что|благодаря|сохраняя|позволяя|начиная|включая|обеспечивая|используя|and|but|which|while|so)\s/iu

const clean = (value) => String(value || '').replace(/\s+/g, ' ').trim()
const capitalize = (value) => (value ? value[0].toLocaleUpperCase('ru') + value.slice(1) : value)

// "Heading: body" from the paragraph's own words.
export function splitHeadingBody(text, { maxHeading = MAX_HEADING_CHARS } = {}) {
  const value = clean(text)
  if (!value) return null
  for (const separator of CLAUSE_SEPARATORS) {
    const at = value.indexOf(separator)
    if (at >= 6 && at <= maxHeading && value.length - at - separator.length >= 3) {
      return { heading: value.slice(0, at).trim(), body: capitalize(value.slice(at + separator.length).trim()) }
    }
  }
  const sentence = value.match(/^(.{6,}?[.!?])\s+(?=[^\s])/u)
  if (sentence && sentence[1].length <= maxHeading + 10) {
    return { heading: sentence[1].replace(/\.$/u, '').trim(), body: value.slice(sentence[0].length).trim() }
  }
  const comma = value.indexOf(', ')
  if (comma >= 12 && comma <= maxHeading + 10 && value.length - comma > 12 && CLAUSE_START.test(value.slice(comma + 2))) {
    return { heading: value.slice(0, comma).trim(), body: capitalize(value.slice(comma + 2).trim()) }
  }
  return { heading: '', body: value }
}

function sentencesOf(text) {
  return clean(text).split(/(?<=[.!?])\s+(?=[A-ZА-ЯЁ0-9«"])/u).map((item) => item.trim()).filter(Boolean)
}

// Items for list/card fallbacks: { items, usesSummary }.
export function paragraphFallbackItems(spec) {
  const paragraphs = (spec?.paragraphs || []).filter((item) => clean(item.heading) || clean(item.body))
  let items = paragraphs.map((item) => (clean(item.heading)
    ? { heading: clean(item.heading), body: clean(item.body) }
    : splitHeadingBody(item.body)))
  let usesSummary = false
  const paragraphText = clean(paragraphs.map((item) => `${item.heading || ''} ${item.body || ''}`).join(' '))
  const summary = clean(spec?.summary_text)
  if (items.length < 2 && summary && summary !== paragraphText && !paragraphText.includes(summary)) {
    items = [splitHeadingBody(summary), ...items]
    usesSummary = true
  }
  if (items.length < 2) {
    const sentences = sentencesOf(paragraphText || spec?.text)
    if (sentences.length >= 2) items = sentences.map((sentence) => splitHeadingBody(sentence))
  }
  return { items: items.filter(Boolean), usesSummary }
}

function tag(variants, fallback) {
  return variants.map((item) => ({ ...item, fallback, key: `${fallback}:${item.key || ''}` }))
}

function runContext(report, spec, blockSpec, relevantComponents, buildResult, { selectionContext, seed, block }) {
  const generated = buildScenarioPreviewVariants(report, blockSpec, relevantComponents, { ...buildResult, selectionContext })
  return runScenarioVariantPipeline(generated, {
    spec: blockSpec,
    intent: spec.intent,
    seed: `${seed}|fallback|${block}`,
    limit: 10,
    report,
    selectionContext,
  }).variants
}

// a) Donor slides of other templates that have a detectable title of a
//    content size; the text goes under that title.
function textDonors(report, excludeTemplates) {
  const slides = report?.slides?.slides || []
  const last = slides.at(-1)?.slide_number
  const terminalTemplates = new Set((report?.slide_templates?.templates || [])
    .filter((item) => (item.preferred_terminal_roles || []).length).map((item) => item.template_id))
  const titleComponents = listAllComponents(report).filter((item) => item.kind === 'slide_title')
  const seen = new Set(excludeTemplates)
  const donors = []
  for (const slide of slides) {
    const templateId = slide.template_id || slide.layout_source || `slide:${slide.slide_number}`
    if (seen.has(templateId) || terminalTemplates.has(templateId)) continue
    if (slide.slide_number === slides[0]?.slide_number || slide.slide_number === last) continue
    const detected = findSlideTitleElements(slide, report)
    const font = Number(detected.primary?.typography?.size_pt) || 0
    if (!detected.primary || !(font > 0) || font > MAX_DONOR_TITLE_PT) continue
    const component = titleComponents.find((item) => item.instances?.some((instance) => instance.slide_number === slide.slide_number))
      || titleComponents[0] || null
    const instance = component?.instances?.find((item) => item.slide_number === slide.slide_number) || {
      slide_number: slide.slide_number,
      template_id: slide.template_id || null,
      element_ids: [...(detected.elementIds || [])],
      container_norm: detected.primary.geometry_norm || null,
    }
    seen.add(templateId)
    donors.push({ slide, templateId, component, instance })
    if (donors.length >= MAX_TEXT_DONORS) break
  }
  return donors
}

function buildTextFallback(report, spec, relevantComponents, options) {
  const textSpec = sliceSpecForDataStep(spec, { key: 'title_text', blocks: ['title', 'text', 'paragraphs'] })
  if (!clean(textSpec.text) && !clean(textSpec.title)) return []
  const variants = textDonors(report, options.excludeTemplates).map(({ slide, templateId, component, instance }) => {
    const picked = {
      slideNumber: slide.slide_number,
      titleComponent: component,
      descriptionComponent: null,
      titleInstance: instance,
      descriptionInstance: { synthetic: true, slide_number: slide.slide_number, element_ids: [] },
      templateId: slide.template_id || templateId,
      templateLabel: null,
      placementLabel: 'абзацы под заголовком',
      selection: 'paragraph_fallback',
      score: 0,
    }
    const built = buildTextCatalogSlideFromPick(report, textSpec, picked, { includeSecondaryGap: false })
    return built.catalogSlide ? {
      componentId: `paragraph_text|${slide.slide_number}`,
      slideNumber: slide.slide_number,
      templateId: picked.templateId,
      templateLabel: picked.templateLabel,
      placementLabel: picked.placementLabel,
      selection: picked.selection,
      score: 0,
      hasDescription: Boolean(textSpec.text),
      catalogSlide: built.catalogSlide,
      filled: built.filled,
      gaps: built.gaps,
    } : null
  }).filter(Boolean)
  if (!variants.length) return []
  return tag(runContext(report, spec, textSpec, relevantComponents, {
    catalogSlide: variants[0].catalogSlide,
    textTemplateVariants: variants,
    match: { textMeta: { ...variants[0], selectionStrategy: 'paragraph_fallback' } },
  }, { ...options, block: 'title_text' }), 'paragraph_text')
}

// b) Paragraphs as list items and as cards.
function buildItemFallbacks(report, spec, tokens, options) {
  const { items, usesSummary } = paragraphFallbackItems(spec)
  if (items.length < 2) return []
  const summary = clean(spec.summary_text)
  const text = usesSummary ? '' : (summary && !items.some((item) => summary.includes(item.body)) ? summary : '')
  const results = []
  for (const block of ['lists', 'cards']) {
    if ((spec[block] || []).length) continue
    const itemSpec = { ...spec, text, paragraphs: [], [block]: items }
    const blockSpec = sliceSpecForDataStep(itemSpec, { key: block, blocks: [block] })
    const relevant = resolveSlideRelevantComponents(report, itemSpec, tokens)
    results.push(...tag(runContext(report, spec, blockSpec, relevant, {
      match: { repeatMeta: { contextBlock: block } },
    }, { ...options, block }), `paragraph_${block}`))
  }
  return results
}

export function buildParagraphFallbackVariants(report, spec, tokens, relevantComponents, {
  selectionContext = null,
  seed = '',
  excludeTemplates = [],
} = {}) {
  const options = { selectionContext, seed, excludeTemplates }
  return [
    ...buildItemFallbacks(report, spec, tokens, options),
    ...buildTextFallback(report, spec, relevantComponents, options),
  ]
}
