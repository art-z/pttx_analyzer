import test from 'node:test'
import assert from 'node:assert/strict'

import { collectLayoutFeedback } from './layout-feedback.js'

test('reports only residual overflow when every available variant fails', () => {
  const slides = [{ title: 'Очень длинный заголовок', text: 'Описание' }]
  const bad = {
    templateId: 'cover',
    catalogSlide: {
      layout_validation: { issues: [{ code: 'text_overflow', element_id: 'title' }] },
      content_elements: [{ element_id: 'title', text: slides[0].title, geometry_pt: { width_pt: 120, height_pt: 32 }, typography: { size_pt: 24 } }],
    },
  }
  assert.deepEqual(collectLayoutFeedback(slides, [{ variants: [bad, { catalogSlide: { layout_validation: { issues: [] } } }] }]), [])
  assert.deepEqual(collectLayoutFeedback(slides, [{ variants: [bad] }]), [{
    slide: 1,
    issues: [{ category: 'text_overflow', field: 'title', context_category: null, text_length: 23, box_width_pt: 120, box_height_pt: 32, font_size_pt: 24 }],
  }])
})

test('reports missing variants and three consecutive matching layouts', () => {
  const slides = [1, 2, 3].map((index) => ({ title: `Slide ${index}`, context: { paragraphs: [{ body: `Text ${index}` }] } }))
  const builds = slides.map(() => ({ variants: [{ templateId: 'same', dataBlock: 'title_text', catalogSlide: {} }] }))
  assert.equal(collectLayoutFeedback(slides, builds)[0].issues[0].category, 'repetitive_layout')
  builds[2].variants.push({ templateId: 'alternative', dataBlock: 'title_text', catalogSlide: {} })
  assert.deepEqual(collectLayoutFeedback(slides, builds), [])
  assert.equal(collectLayoutFeedback([slides[0]], [{ variants: [] }])[0].issues.length, 3)
})

test('measures title against the final text box even below the severe layout-warning threshold', () => {
  const slides = [{ title: 'Очень длинный заголовок для узкой рамки' }]
  const builds = [{ variants: [{ catalogSlide: {
    layout_validation: { issues: [] },
    content_elements: [{
      element_id: 'cover_title', kind: 'text', text: slides[0].title,
      geometry_pt: { width_pt: 120, height_pt: 30 }, typography: { size_pt: 22 },
    }],
  } }] }]
  assert.equal(collectLayoutFeedback(slides, builds)[0].issues[0].field, 'title')
})
