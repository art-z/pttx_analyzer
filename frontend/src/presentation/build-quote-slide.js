import { findSlide, listAllComponents } from '../components/catalog.js'
import { findSlideTitleElements } from '../slides/slide-title-detect.js'
import { patchSlideTextContent } from '../slides/text-content-patch.js'
import { finalizeScenarioPreviewSlide } from './finalize-scenario-preview.js'

function quoteInstanceCandidates(report) {
  const candidates = []
  for (const component of listAllComponents(report)) {
    if (component.kind !== 'quote') continue
    for (const instance of component.instances || []) {
      const source = findSlide(report, instance.slide_number)
      if (!source || !component.templates?.includes(source.template_id)) continue
      const elementIds = new Set(instance.element_ids || [])
      const bodyIds = (source.content_elements || [])
        .filter((element) => elementIds.has(element.element_id) && element.narrative_role === 'quote_body')
        .map((element) => element.element_id)
      if (!bodyIds.length) continue
      const attributionIds = (source.content_elements || [])
        .filter((element) => elementIds.has(element.element_id) && element.narrative_role === 'quote_attribution')
        .map((element) => element.element_id)
      candidates.push({ component, instance, source, bodyIds, attributionIds })
    }
  }
  return candidates
}

function attributionFor(spec, quoteIndex) {
  const persons = spec?.persons || []
  const quotes = spec?.quotes || []
  if (!(persons.length === 1 && quotes.length === 1) && persons.length !== quotes.length) return ''
  const person = persons[quoteIndex]
  if (!person) return ''
  const name = String(person.heading || person.name || '').trim()
  const role = String(person.body || person.bio || '').trim()
  return [name, role].filter(Boolean).join(', ')
}

export function buildQuoteTemplateVariants(report, spec, { limit = 3 } = {}) {
  const quotes = (spec?.quotes || []).filter((item) => String(item?.body || '').trim())
  if (!quotes.length) return []
  const candidates = quoteInstanceCandidates(report)
  const seenTemplates = new Set()
  const variants = []

  for (const candidate of candidates) {
    if (variants.length >= limit) break
    const { component, source, bodyIds, attributionIds } = candidate
    const templateId = source.template_id
    if (seenTemplates.has(templateId)) continue

    let slide = JSON.parse(JSON.stringify(source))
    slide = patchSlideTextContent(slide, { elementIds: bodyIds, text: quotes[0].body })
    slide = patchSlideTextContent(slide, {
      elementIds: attributionIds,
      text: attributionFor(spec, 0),
    })
    const quoteIds = new Set([...bodyIds, ...attributionIds])
    const titleIds = [...findSlideTitleElements(slide, report).elementIds]
      .filter((id) => !quoteIds.has(id))
    if (titleIds.length && spec?.title) {
      slide = patchSlideTextContent(slide, { elementIds: titleIds, text: spec.title })
    }
    // A parsed quote occupies one quote field. Clear unused source text and
    // remove emptied line fragments so they cannot collide in layout checks.
    const keep = new Set([...quoteIds, ...titleIds])
    slide.content_elements = (slide.content_elements || []).filter((element) => (
      element.kind !== 'text'
      || (keep.has(element.element_id) && String(element.text || '').trim())
    ))
    const keepElementIds = (slide.content_elements || [])
      .filter((element) => element.kind !== 'text' || keep.has(element.element_id))
      .map((element) => element.element_id)
      .filter(Boolean)
    const catalogSlide = finalizeScenarioPreviewSlide(report, slide, {
      title: '', text: '',
    }, null, { mode: 'content', keepElementIds })
    if (!catalogSlide) continue

    seenTemplates.add(templateId)
    variants.push({
      key: `quote:${templateId}`,
      role: 'alternative',
      label: 'Шаблон цитаты',
      sublabel: `${component.label} · слайд ${source.slide_number}${quotes.length > 1 ? ` · 1 из ${quotes.length} цитат` : ''}`,
      score: 120 + Number(component.isBaseline) * 8,
      catalogSlide,
      componentId: component.id,
      templateId,
      slideNumber: source.slide_number,
      dataBlock: 'quotes',
      gaps: quotes.length > 1 ? [`quotes: показана 1 цитата из ${quotes.length}; шаблон содержит одно поле`] : [],
    })
  }
  return variants
}
