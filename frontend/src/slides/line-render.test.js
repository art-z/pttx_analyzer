import assert from 'node:assert/strict'
import test from 'node:test'
import { resolveArrowMarkerScale, resolveLineMarkerBase, resolveLineRenderMode } from './line-render.js'

test('resolveArrowMarkerScale uses backend size_pt when available', () => {
  const scale = resolveArrowMarkerScale({
    type: 'triangle',
    width: 'lg',
    length: 'lg',
    size_pt: { length_pt: 5, width_pt: 4 },
  }, 1)
  assert.deepEqual(scale, { length: 5, width: 4 })
})

test('resolveArrowMarkerScale falls back to DrawingML lg factors', () => {
  const scale = resolveArrowMarkerScale({ type: 'triangle', width: 'lg', length: 'lg' }, 1)
  assert.deepEqual(scale, { length: 5, width: 4 })
})

test('resolveLineMarkerBase includes slide source to avoid marker id collisions', () => {
  const base13 = resolveLineMarkerBase({
    source_part: 'ppt/slides/slide13.xml',
    element_id: 'slide_line_112',
  })
  const base14 = resolveLineMarkerBase({
    source_part: 'ppt/slides/slide14.xml',
    element_id: 'slide_line_112',
  })
  assert.notEqual(base13, base14)
  assert.match(base13, /13/)
  assert.match(base14, /14/)
})

test('resolveLineRenderMode distinguishes connector, rect outline and custom path', () => {
  assert.equal(resolveLineRenderMode({ line: { x1: 0, y1: 0, x2: 1, y2: 1 } }), 'segment')
  assert.equal(resolveLineRenderMode({ line: { outline: 'rect' } }), 'rect')
  assert.equal(resolveLineRenderMode({ outline_path: 'M 0 0 L 1 1 Z' }), 'path')
})

test('lineEndMarkerPath supports stealth and diamond markers', async () => {
  const { lineEndMarkerPath } = await import('./line-render.js')
  assert.match(lineEndMarkerPath('stealth', 3.5, 3, { atStart: false }), /L 2\.8 1\.5 Z$/)
  assert.match(lineEndMarkerPath('diamond', 3.5, 3, { atStart: true }), /L 1\.75 3 Z$/)
})

test('resolveArrowMarkerScale works for stealth endpoints', () => {
  const scale = resolveArrowMarkerScale({
    type: 'stealth',
    width: 'med',
    length: 'med',
    size_pt: { length_pt: 7.88, width_pt: 6.75 },
  }, 2.25)
  assert.deepEqual(scale, {
    length: 7.88 / 2.25,
    width: 6.75 / 2.25,
  })
})
