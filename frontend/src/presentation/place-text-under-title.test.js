import test from 'node:test'
import assert from 'node:assert/strict'

import { placeTextUnderTitle } from './place-text-under-title.js'

function slideWith(elements) {
  return {
    slide_number: 1,
    render: { slide_size_pt: { width: 960, height: 540 }, background_color: '#000000' },
    content_elements: elements,
  }
}

function text(id, y, extra = {}) {
  return {
    element_id: id,
    kind: 'text',
    text: extra.text || 'Заголовок',
    role: extra.role || 'title',
    geometry_norm: {
      x: extra.x ?? 0.08,
      y,
      width: extra.width ?? 0.7,
      height: extra.height ?? 0.08,
    },
    typography: {
      family: 'Play',
      size_pt: extra.size_pt || 32,
      color: extra.color || '#FFFFFF',
    },
  }
}

test('missing body text is placed under the title', () => {
  const slide = slideWith([
    text('title', 0.06, { text: 'Тема' }),
  ])

  const placed = placeTextUnderTitle(slide, null, 'Абзац под заголовком, без своего компонента.')
  const body = placed.slide.content_elements.find((element) => element.synthetic)

  assert.equal(placed.created, true)
  assert.ok(body.geometry_norm.y > 0.14)
  assert.equal(body.typography.color, '#FFFFFF')
  assert.equal(body.typography.family, 'Play')
  assert.ok(body.typography.size_pt < 32)
})

test('body text steps below occupied content instead of covering it', () => {
  const slide = slideWith([
    text('title', 0.06, { text: 'Тема' }),
    text('card', 0.2, { role: 'body', text: 'Карточка', size_pt: 14, height: 0.2, color: '#E4E7EA' }),
  ])

  const placed = placeTextUnderTitle(slide, null, 'Абзац, которому нельзя лечь на карточку.')
  const body = placed.slide.content_elements.find((element) => element.synthetic)

  assert.ok(body)
  assert.ok(body.geometry_norm.y >= 0.4)
})

test('body text is skipped when the slide has no free band', () => {
  const slide = slideWith([
    text('title', 0.06, { text: 'Тема' }),
    text('block', 0.2, { role: 'body', text: 'Занято', height: 0.7, size_pt: 14 }),
  ])

  const placed = placeTextUnderTitle(slide, null, 'Этому абзацу уже некуда встать.')

  assert.equal(placed.created, false)
  assert.equal(placed.slide.content_elements.some((element) => element.synthetic), false)
})
