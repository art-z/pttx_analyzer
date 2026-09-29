import test from 'node:test'
import assert from 'node:assert/strict'

import { translateElement } from './fit-template-preview.js'

const slideSize = { width: 960, height: 540 }

test('an image keeps its box when the component shifts clear of the title', () => {
  const image = {
    kind: 'image',
    geometry_norm: { x: 0.2, y: 0.3, width: 0.1, height: 0.1 },
  }
  const placed = translateElement(image, 0, 0.08, slideSize)
  assert.equal(placed.geometry_norm.width, 0.1)
  assert.equal(placed.geometry_norm.height, 0.1)
  assert.equal(placed.geometry_norm.x, 0.2)
  assert.ok(Math.abs(placed.geometry_norm.y - 0.38) < 0.001)
})

test('an svg ellipse mask keeps its box when the component shifts', () => {
  const icon = {
    kind: 'fill',
    mask: { kind: 'ellipse' },
    geometry_norm: { x: 0.2, y: 0.35, width: 0.08, height: 0.12 },
  }
  const placed = translateElement(icon, 0, 0.08, slideSize)
  assert.equal(placed.geometry_norm.width, 0.08)
  assert.equal(placed.geometry_norm.height, 0.12)
  assert.ok(Math.abs(placed.geometry_norm.y - 0.43) < 0.001)
})

test('text keeps its box when the component shifts', () => {
  const text = {
    kind: 'text',
    geometry_norm: { x: 0.2, y: 0.3, width: 0.4, height: 0.1 },
  }
  const placed = translateElement(text, 0, 0.08, slideSize)
  assert.equal(placed.geometry_norm.width, 0.4)
  assert.equal(placed.geometry_norm.height, 0.1)
  assert.ok(Math.abs(placed.geometry_norm.y - 0.38) < 0.001)
})
