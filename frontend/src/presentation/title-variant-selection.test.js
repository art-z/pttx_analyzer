import test from 'node:test'
import assert from 'node:assert/strict'

import { pickDiverseTitleVariants, selectBestTitleVariants } from './build-slide.js'

function variant(templateId, title, width) {
  return {
    templateId, dataBlock: 'title_text',
    catalogSlide: {
      layout_validation: { issues: [] },
      content_elements: [{
        element_id: 'title', kind: 'text', text: title,
        geometry_pt: { width_pt: width, height_pt: 30 },
        typography: { size_pt: 24 },
      }],
    },
  }
}

test('fits a different planned title length to each template without an LLM call', () => {
  const builds = [
    { key: 'middle', title: 'Средний заголовок', result: { previewVariants: [
      variant('narrow', 'Средний заголовок', 120),
      variant('wide', 'Средний заголовок', 420),
    ] } },
    { key: 'short', title: 'Тема', result: { previewVariants: [
      variant('narrow', 'Тема', 120),
      variant('wide', 'Тема', 420),
    ] } },
    { key: 'long', title: 'Развёрнутый заголовок раздела', result: { previewVariants: [
      variant('wide', 'Развёрнутый заголовок раздела', 420),
    ] } },
  ]
  const chosen = selectBestTitleVariants(builds)
  assert.equal(chosen.find((item) => item.templateId === 'narrow').titleVariant, 'short')
  assert.ok(chosen.find((item) => item.templateId === 'wide'))
  assert.equal(chosen.length, 2)
})

test('title variants prefer new content types and keep components and chart types distinct', () => {
  const candidates = [
    { templateId: 'a', componentId: 'chart-1', dataBlock: 'charts',
      catalogSlide: { content_elements: [{ kind: 'chart', chart_type: 'bar' }] } },
    { templateId: 'b', componentId: 'chart-1', dataBlock: 'charts',
      catalogSlide: { content_elements: [{ kind: 'chart', chart_type: 'bar' }] } },
    { templateId: 'c', componentId: 'chart-2', dataBlock: 'charts',
      catalogSlide: { content_elements: [{ kind: 'chart', chart_type: 'bar' }] } },
    { templateId: 'd', componentId: 'chart-3', dataBlock: 'charts',
      catalogSlide: { content_elements: [{ kind: 'chart', chart_type: 'line' }] } },
    { templateId: 'e', componentId: 'table-1', dataBlock: 'tables', catalogSlide: {} },
  ]
  const selected = pickDiverseTitleVariants(candidates)
  assert.deepEqual(selected.map((item) => item.templateId), ['a', 'e', 'd'])
})
