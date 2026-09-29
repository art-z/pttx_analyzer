import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildTitleDecorationVariant,
  roomyPhotoCount,
  withTitleDecorationVariant,
} from './build-title-decoration-slide.js'

function reportWith(slide) {
  return { slides: { slides: [slide] } }
}

function decorationSlide() {
  return {
    slide_number: 7,
    layout_source: 'ppt/slideLayouts/slideLayout7.xml',
    render: { slide_size_pt: { width: 960, height: 540 } },
    content_elements: [
      {
        element_id: 'title',
        kind: 'text',
        role: 'title',
        text: 'Заголовок',
        geometry_norm: { x: 0.06, y: 0.06, width: 0.7, height: 0.1 },
        typography: { family: 'Play', size_pt: 28, color: '#FFFFFF' },
      },
      {
        element_id: 'photo',
        kind: 'image',
        geometry_norm: { x: 0.08, y: 0.28, width: 0.84, height: 0.55 },
      },
    ],
  }
}

test('a short list of variants gains a title and photo template', () => {
  const variant = buildTitleDecorationVariant(reportWith(decorationSlide()), {
    intent: 'example',
    title: 'Как это выглядит',
    text: 'Короткий пример',
    images: [{ heading: 'Скриншот' }],
  })

  assert.ok(variant)
  assert.equal(variant.dataBlock, 'title_decor')
  assert.ok(roomyPhotoCount(variant.catalogSlide) >= 1)
  assert.ok(variant.catalogSlide.content_elements.some((element) => element.text === 'Как\u00a0это выглядит'))
})

test('example slides replace a plain variant with a photo template', () => {
  const plain = {
    key: 'text',
    dataBlock: 'title_text',
    slideNumber: 1,
    catalogSlide: {
      slide_number: 1,
      content_elements: [
        {
          element_id: 'only-title',
          kind: 'text',
          text: 'Текст',
          geometry_norm: { x: 0.1, y: 0.1, width: 0.6, height: 0.1 },
        },
      ],
    },
  }
  const filled = [plain, { ...plain, key: 'metrics', dataBlock: 'metrics', slideNumber: 2 }, { ...plain, key: 'lists', dataBlock: 'lists', slideNumber: 3 }]
  const next = withTitleDecorationVariant(filled, reportWith(decorationSlide()), {
    intent: 'example',
    title: 'Пример',
    text: '',
    images: [{ heading: 'Кадр' }],
  }, { seed: 'example' })

  assert.equal(next.length, 3)
  assert.equal(next[0].dataBlock, 'title_text')
  assert.equal(next[2].dataBlock, 'title_decor')
})
