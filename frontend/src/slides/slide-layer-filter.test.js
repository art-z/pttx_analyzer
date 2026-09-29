import assert from 'node:assert/strict'
import test from 'node:test'
import { filterSlideRenderLayers, isDesignGlyphText, shouldRenderSlideLayer } from './slide-layer-filter.js'

const slideWithTitle = {
  content_elements: [
    { kind: 'text', placeholder_type: 'title', text: 'Полезные материалы' },
    { kind: 'text', placeholder_type: 'body', text: 'Body copy' },
  ],
}

test('isDesignGlyphText keeps short layout marks', () => {
  assert.equal(isDesignGlyphText('«'), true)
  assert.equal(isDesignGlyphText('ОБРАЗЕЦ ЗАГОЛОВКА'), false)
})

test('shouldRenderSlideLayer hides master placeholder copy when slide has content', () => {
  assert.equal(shouldRenderSlideLayer({
    decorative: true,
    kind: 'text',
    source_scope: 'master',
    placeholder_type: 'title',
    text: 'ОБРАЗЕЦ ЗАГОЛОВКА',
  }, slideWithTitle), false)

  assert.equal(shouldRenderSlideLayer({
    decorative: true,
    kind: 'text',
    source_scope: 'master',
    placeholder_type: 'body',
    text: 'Образец текста\nВторой уровень',
  }, slideWithTitle), false)
})

test('shouldRenderSlideLayer keeps quote glyph and empty-slide hints', () => {
  assert.equal(shouldRenderSlideLayer({
    decorative: true,
    kind: 'text',
    source_scope: 'layout',
    text: '«',
  }, slideWithTitle), true)

  assert.equal(shouldRenderSlideLayer({
    decorative: true,
    kind: 'text',
    source_scope: 'master',
    placeholder_type: 'title',
    text: 'ОБРАЗЕЦ ЗАГОЛОВКА',
  }, { content_elements: [] }), true)
})

test('shouldRenderSlideLayer hides system chrome on authored slides', () => {
  assert.equal(shouldRenderSlideLayer({
    decorative: true,
    kind: 'text',
    source_scope: 'layout',
    placeholder_type: 'sldNum',
    text: '‹#›',
  }, slideWithTitle), false)
})

test('filterSlideRenderLayers preserves backgrounds', () => {
  const layers = [
    { kind: 'image', decorative: false, source_scope: 'master_bg' },
    {
      decorative: true,
      kind: 'text',
      source_scope: 'master',
      placeholder_type: 'title',
      text: 'ОБРАЗЕЦ ЗАГОЛОВКА',
    },
  ]
  assert.deepEqual(filterSlideRenderLayers(layers, slideWithTitle).map((layer) => layer.kind), ['image'])
})
