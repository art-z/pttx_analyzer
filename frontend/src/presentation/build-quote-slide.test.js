import test from 'node:test'
import assert from 'node:assert/strict'

import { buildQuoteTemplateVariants } from './build-quote-slide.js'
import { buildScenarioPreviewVariants, runScenarioVariantPipeline } from './build-scenario-preview-variants.js'
import { normalizeSlideSpec } from './slide-spec.js'

function quoteReport() {
  return {
    layout: { content_margins: {} },
    slides: { slides: [{
      slide_number: 4,
      template_id: 'tmpl_quote',
      layout_source: 'quote-layout',
      render: { slide_size_pt: { width: 960, height: 540 }, layers: [] },
      content_elements: [
        { element_id: 'body', kind: 'text', text: 'Исходная цитата', narrative_role: 'quote_body',
          geometry_norm: { x: 0.15, y: 0.3, width: 0.7, height: 0.3 } },
        { element_id: 'attribution', kind: 'text', text: 'Старый автор', narrative_role: 'quote_attribution',
          geometry_norm: { x: 0.15, y: 0.75, width: 0.7, height: 0.08 } },
      ],
    }] },
    slide_templates: { templates: [{
      template_id: 'tmpl_quote',
      layout_source: 'quote-layout',
      detected_roles: ['quote'],
      editable_slots: [],
      render: { layers: [] },
    }] },
    narrative_components: { quotes: [{
      component_id: 'qte_001',
      kind: 'quote',
      label: 'Цитата',
      is_baseline: true,
      frequency: { instance_count: 1, template_ids: ['tmpl_quote'] },
      instances: [{ slide_number: 4, template_id: 'tmpl_quote', element_ids: ['body', 'attribution'] }],
    }] },
  }
}

test('one-slot quote template renders one quote and reports the second without stale attribution', () => {
  const report = quoteReport()
  const spec = { title: 'Отзывы', quotes: [
    { heading: '', body: 'Мы сократили подготовку презентаций в три раза.' },
    { heading: '', body: 'Flow сохраняет фирменный стиль.' },
  ] }
  const variants = buildQuoteTemplateVariants(report, spec)

  assert.equal(variants.length, 1)
  assert.equal(variants[0].templateId, 'tmpl_quote')
  assert.deepEqual(variants[0].catalogSlide.content_elements
    .filter((element) => element.kind === 'text').map((element) => element.text),
  ['Мы сократили подготовку презентаций в\u00a0три раза.'])
  assert.deepEqual(variants[0].gaps, ['quotes: показана 1 цитата из 2; шаблон содержит одно поле'])
})

test('quote context includes its native template in selectable generation variants', () => {
  const report = quoteReport()
  const spec = normalizeSlideSpec({
    title: 'Отзывы',
    context: { quotes: [{ heading: '', body: 'Мы ускорили работу.' }] },
  })
  const generated = buildScenarioPreviewVariants(report, spec, null, {
    match: { repeatMeta: { contextBlock: 'quotes' } },
  })
  const selected = runScenarioVariantPipeline(generated, { report, spec, intent: 'quote' })

  assert.equal(selected.variants[0]?.templateId, 'tmpl_quote')
  assert.equal(selected.variants[0]?.componentId, 'qte_001')
})

test('matching person replaces the original quote attribution', () => {
  const variants = buildQuoteTemplateVariants(quoteReport(), {
    quotes: [{ body: 'Новая цитата.' }],
    persons: [{ heading: 'Елена Смирнова', body: 'Автор отзыва' }],
  })
  const texts = variants[0].catalogSlide.content_elements
    .filter((element) => element.kind === 'text').map((element) => element.text)

  assert.deepEqual(texts, ['Новая цитата.', 'Елена Смирнова, Автор отзыва'])
})
