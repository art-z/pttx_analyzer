import test from 'node:test'
import assert from 'node:assert/strict'

import { listAllComponents } from './catalog.js'

test('narrative quote and snippet components appear in the catalog', () => {
  const report = {
    slides: { slides: [] },
    slide_templates: { templates: [] },
    narrative_components: {
      quotes: [{
        component_id: 'qte_001',
        kind: 'quote',
        label: 'Цитата',
        is_baseline: true,
        variant_signature: 'quote|«|play',
        style_tokens: { mark: { text: '«' }, baseline_size_pt: 40 },
        text_fields: [{ field_id: 'body', role: 'body', sample_text: 'Текст цитаты' }],
        frequency: { instance_count: 1, slide_numbers: [19], template_ids: ['tmpl_003'] },
        instances: [{
          slide_number: 19,
          template_id: 'tmpl_003',
          element_ids: ['body'],
          container: { x_pt: 100, y_pt: 40, width_pt: 500, height_pt: 300 },
        }],
      }],
      snippets: [{
        component_id: 'snp_001',
        kind: 'snippet',
        label: 'Пример кода',
        is_baseline: true,
        variant_signature: 'snippet|consolas|#fff',
        style_tokens: { color_count: 5, baseline_size_pt: 16 },
        text_fields: [],
        frequency: { instance_count: 1, slide_numbers: [15], template_ids: ['tmpl_030'] },
        instances: [{ slide_number: 15, template_id: 'tmpl_030', element_ids: ['code'] }],
      }],
    },
  }

  const items = listAllComponents(report)
  const quote = items.find((item) => item.kind === 'quote')
  const snippet = items.find((item) => item.kind === 'snippet')
  assert.ok(quote)
  assert.equal(quote.group, 'quotes')
  assert.equal(quote.templates[0], 'tmpl_003')
  assert.ok(snippet)
  assert.equal(snippet.group, 'snippets')
  assert.equal(snippet.styleTokens.color_count, 5)
})
