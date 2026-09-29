import test from 'node:test'
import assert from 'node:assert/strict'

import { fitTerminalTextBoxes } from './terminal-text-hit-test.js'

const size = { width: 960, height: 540 }
const report = { layout: { content_margins: {} } }

function textElement(id, text, box, font = 28) {
  return {
    element_id: id, kind: 'text', text,
    geometry_norm: box,
    geometry_pt: {
      x_pt: box.x * size.width, y_pt: box.y * size.height,
      width_pt: box.width * size.width, height_pt: box.height * size.height,
    },
    typography: { size_pt: font },
  }
}

function overlaps(a, b) {
  const left = a.geometry_norm
  const right = b.geometry_norm
  return Math.min(left.x + left.width, right.x + right.width) > Math.max(left.x, right.x)
    && Math.min(left.y + left.height, right.y + right.height) > Math.max(left.y, right.y)
}

test('terminal hit-test narrows overlapping title/body boxes and keeps them on slide', () => {
  const slide = {
    render: { slide_size_pt: size, layers: [] },
    content_elements: [
      textElement('title', 'Название продукта', { x: .08, y: .18, width: .7, height: .3 }, 36),
      textElement('body', 'Краткое описание продукта', { x: .08, y: .38, width: .7, height: .24 }, 20),
    ],
  }
  const fitted = fitTerminalTextBoxes(report, slide, { titleIds: ['title'] })
  const [title, body] = fitted.content_elements
  assert.equal(overlaps(title, body), false)
  assert.equal(fitted.layout_validation.issues.some((issue) => issue.code === 'text_overlap'), false)
  for (const element of [title, body]) {
    const box = element.geometry_norm
    assert.ok(box.x >= 0 && box.y >= 0 && box.x + box.width <= 1 && box.y + box.height <= 1)
    assert.equal(element.geometry_pt.width_pt, box.width * size.width)
  }
})

test('terminal hit-test clips a text box at the slide edge instead of leaving it outside', () => {
  const slide = {
    render: { slide_size_pt: size, layers: [] },
    content_elements: [textElement('title', 'Край', { x: .9, y: .92, width: .3, height: .2 }, 16)],
  }
  const fitted = fitTerminalTextBoxes(report, slide, { titleIds: ['title'] })
  const box = fitted.content_elements[0].geometry_norm
  assert.ok(box.x + box.width <= 1 && box.y + box.height <= 1)
  assert.equal(fitted.layout_validation.issues.some((issue) => issue.code === 'outside_slide'), false)
})
