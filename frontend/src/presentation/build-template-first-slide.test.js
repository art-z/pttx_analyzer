import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildTemplateFirstVariant,
  withTemplateFirstVariant,
} from './build-template-first-slide.js'

function denseSlide(slideNumber) {
  return {
    slide_number: slideNumber,
    layout_source: `layout-${slideNumber}`,
    render: { slide_size_pt: { width: 960, height: 540 } },
    content_elements: [
      {
        element_id: `title-${slideNumber}`,
        kind: 'text',
        role: 'title',
        text: 'Заголовок',
        geometry_norm: { x: 0.06, y: 0.05, width: 0.8, height: 0.1 },
        typography: { family: 'Play', size_pt: 28, color: '#111111' },
      },
      {
        element_id: `plate-${slideNumber}`,
        kind: 'fill',
        geometry_norm: { x: 0.06, y: 0.34, width: 0.4, height: 0.45 },
      },
      {
        element_id: `plate-b-${slideNumber}`,
        kind: 'fill',
        geometry_norm: { x: 0.52, y: 0.34, width: 0.4, height: 0.45 },
      },
      {
        element_id: `photo-${slideNumber}`,
        kind: 'image',
        geometry_norm: { x: 0.08, y: 0.38, width: 0.36, height: 0.28 },
      },
    ],
  }
}

test('template-first variant keeps the donor plates and does not reuse a taken slide', () => {
  const report = { slides: { slides: [denseSlide(4), denseSlide(9)] } }
  const variant = buildTemplateFirstVariant(report, {
    title: 'Плотный слайд',
    text: 'Короткий текст',
  }, { usedSlideNumbers: [4], seed: 'dense' })

  assert.equal(variant.slideNumber, 9)
  assert.equal(variant.dataBlock, 'template_first')
  const ids = variant.catalogSlide.content_elements.map((element) => element.element_id)
  assert.ok(ids.includes('plate-9'))
  assert.ok(ids.includes('photo-9'))
  assert.ok(variant.catalogSlide.content_elements.some((element) => element.text === 'Плотный слайд'))
})

test('three slots do not repeat a data block or a slide', () => {
  const report = { slides: { slides: [denseSlide(9)] } }
  const next = withTemplateFirstVariant([
    { key: 'metrics-a', dataBlock: 'metrics', slideNumber: 2, templateId: 'layout-a', catalogSlide: { slide_number: 2 } },
    { key: 'metrics-b', dataBlock: 'metrics', slideNumber: 3, templateId: 'layout-b', catalogSlide: { slide_number: 3 } },
    { key: 'text', dataBlock: 'title_text', slideNumber: 5, templateId: 'layout-c', catalogSlide: { slide_number: 5 } },
  ], report, { title: 'Тема', text: 'Текст' }, { seed: 'unique' })

  assert.deepEqual(next.map((item) => item.dataBlock), ['metrics', 'title_text', 'template_first'])
  assert.equal(new Set(next.map((item) => item.slideNumber)).size, 3)
})
