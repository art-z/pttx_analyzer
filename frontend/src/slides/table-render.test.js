import assert from 'node:assert/strict'
import test from 'node:test'
import { resolveTableTextColor, resolveTableTextSizePt } from './table-render.js'

const tokens = {
  defaultTextColor: '#333333',
  titleColors: ['#111111'],
  bodyTypographyOptions: [{ color: '#444444', sizePt: 15 }],
}

test('resolveTableTextColor uses design-system body color for baseline cells', () => {
  const color = resolveTableTextColor(tokens, {}, { tokenKey: 'body_cell', isHeader: false })
  assert.equal(color, '#444444')
})

test('resolveTableTextColor uses body/default color for header cells without explicit color', () => {
  const color = resolveTableTextColor(tokens, {}, { tokenKey: 'header_cell', isHeader: true })
  assert.equal(color, '#444444')
})

test('resolveTableTextColor keeps explicit pptx color', () => {
  const color = resolveTableTextColor(tokens, {}, {
    typography: { color: '#ABCDEF' },
    tokenKey: 'body_cell',
  })
  assert.equal(color, '#ABCDEF')
})

test('resolveTableTextSizePt uses DS body size when cell typography is missing', () => {
  const size = resolveTableTextSizePt(tokens, {}, { tokenKey: 'body_cell' })
  assert.equal(size, 15)
})

test('resolveTableTextSizePt keeps explicit cell size', () => {
  const size = resolveTableTextSizePt(tokens, {}, {
    typography: { size_pt: 11 },
    tokenKey: 'body_cell',
  })
  assert.equal(size, 11)
})
