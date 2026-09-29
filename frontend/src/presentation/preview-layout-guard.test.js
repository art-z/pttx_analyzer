import test from 'node:test'
import assert from 'node:assert/strict'

import { validatePreviewLayout } from './preview-layout-guard.js'

function textElement(elementId, geometry, extra = {}) {
  return {
    element_id: elementId,
    kind: 'text',
    text: extra.text || 'Текст',
    geometry_norm: geometry,
    typography: { size_pt: extra.size_pt || 14 },
    ...extra,
  }
}

test('layout guard warns without rejecting elements outside content margins', () => {
  const validation = validatePreviewLayout({
    layout: {
      content_margins: {
        left_norm: 0.05,
        right_norm: 0.05,
        top_norm: 0.05,
        bottom_norm: 0.05,
      },
    },
  }, {
    content_elements: [
      textElement('card__repeat_1', { x: 0.01, y: 0.2, width: 0.2, height: 0.1 }),
    ],
  })

  assert.equal(validation.valid, true)
  assert.ok(validation.warnings.some((issue) => issue.code === 'outside_safe_area'))
})

test('layout guard warns without rejecting overlap between repeat text and title', () => {
  const validation = validatePreviewLayout(null, {
    content_elements: [
      textElement('title', { x: 0.1, y: 0.1, width: 0.5, height: 0.12 }),
      textElement('card__repeat_1', { x: 0.2, y: 0.12, width: 0.3, height: 0.12 }),
    ],
  })

  assert.equal(validation.valid, true)
  assert.ok(validation.warnings.some((issue) => issue.code === 'text_overlap'))
})

test('layout guard ignores text boxes inside the same repeat item', () => {
  const validation = validatePreviewLayout(null, {
    content_elements: [
      textElement('heading__repeat_1', { x: 0.1, y: 0.2, width: 0.3, height: 0.1 }),
      textElement('body__repeat_1', { x: 0.1, y: 0.25, width: 0.3, height: 0.1 }),
    ],
  })

  assert.equal(validation.valid, true)
})
