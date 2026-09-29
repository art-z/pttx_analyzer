import test from 'node:test'
import assert from 'node:assert/strict'

import { prepareUnits } from './vgroup-structure.js'
import {
  attachFloatingUnits,
  findBestSplit,
  normalizePartitionTree,
  partitionRegion,
  projectionGaps,
} from './vgroup-partition.js'

const ASPECT = 9 / 16

function text(id, x, y, width, height, sizePt = 14) {
  return { element_id: id, kind: 'text', geometry_norm: { x, y, width, height }, typography: { size_pt: sizePt } }
}

function box(id, kind, x, y, width, height) {
  return { element_id: id, kind, geometry_norm: { x, y, width, height } }
}

function buildTree(elements, context = {}) {
  const { topLevel, floating } = prepareUnits(elements)
  const ctx = { aspect: ASPECT, pinned: new Set(), separators: floating.filter((unit) => unit.role === 'separator'), ...context }
  const tree = normalizePartitionTree(partitionRegion(topLevel, ctx), ctx)
  return attachFloatingUnits(tree, floating)
}

test('projectionGaps returns exact empty intervals and tolerates hairline overlaps', () => {
  const { topLevel } = prepareUnits([
    text('a', 0.1, 0.1, 0.2, 0.1),
    text('b', 0.35, 0.1, 0.2, 0.1),
    text('c', 0.549, 0.1, 0.2, 0.1),
  ])
  const gaps = projectionGaps(topLevel, 'x')
  assert.equal(gaps.length, 2)
  assert.ok(Math.abs(gaps[0].size - 0.05) < 1e-9)
  assert.ok(gaps[1].size < 0.002)
  assert.equal(projectionGaps(topLevel, 'y').length, 0)
})

test('repetition wins over a larger gap: cards with narrow column gaps are cut into cards', () => {
  const elements = []
  for (let column = 0; column < 4; column += 1) {
    const x = 0.05 + column * 0.222
    elements.push(box(`img${column}`, 'image', x, 0.16, 0.11, 0.19))
    elements.push(text(`name${column}`, x, 0.378, 0.22, 0.051, 20))
    elements.push(text(`role${column}`, x, 0.43, 0.208, 0.039, 14))
  }
  const { topLevel } = prepareUnits(elements)
  const split = findBestSplit(topLevel, null, { aspect: ASPECT })
  assert.equal(split.axis, 'x')
  assert.equal(split.segments.length, 4)
  assert.ok(split.repetition >= 0.99)
  assert.equal(split.compound, true)
})

test('separator lines reinforce the gap they sit in and are attached as floating units', () => {
  const tree = buildTree([
    text('l1', 0.05, 0.2, 0.4, 0.1),
    text('l2', 0.05, 0.35, 0.4, 0.1),
    text('r1', 0.55, 0.2, 0.4, 0.1),
    text('r2', 0.05, 0.6, 0.9, 0.1),
    box('rule', 'line', 0.5, 0.15, 0.001, 0.35),
  ])
  assert.equal(tree.kind, 'branch')
  const rules = []
  const walk = (node) => {
    rules.push(...node.floating)
    node.children?.forEach(walk)
  }
  walk(tree)
  assert.equal(rules.length, 1)
  assert.equal(rules[0].members[0].element_id, 'rule')
})

test('plate that contains units becomes a container with its own inner layout', () => {
  const tree = buildTree([
    box('plate', 'fill', 0.1, 0.1, 0.4, 0.5),
    text('t1', 0.12, 0.12, 0.3, 0.08, 20),
    text('t2', 0.12, 0.3, 0.3, 0.08, 14),
    text('outside', 0.6, 0.1, 0.3, 0.1),
  ])
  assert.equal(tree.kind, 'branch')
  assert.equal(tree.axis, 'x')
  const container = tree.children.find((child) => child.kind === 'container')
  assert.ok(container)
  assert.equal(container.background.members[0].element_id, 'plate')
  assert.equal(container.content.kind, 'branch')
  assert.equal(container.content.children.length, 2)
})

test('fill and its own text collapse into one shape unit', () => {
  const { units } = prepareUnits([
    { element_id: 's1', kind: 'fill', z_index: 3, name: 'Shape 1', geometry_norm: { x: 0.1, y: 0.1, width: 0.2, height: 0.1 } },
    { element_id: 't1', kind: 'text', z_index: 3, name: 'Shape 1', geometry_norm: { x: 0.1, y: 0.1, width: 0.2, height: 0.1 }, typography: { size_pt: 16 } },
  ])
  assert.equal(units.length, 1)
  assert.equal(units[0].kind, 'shape')
  assert.equal(units[0].members.length, 2)
})

test('alternating pattern is regrouped into periods and marked as repeat', () => {
  const elements = []
  for (let index = 0; index < 3; index += 1) {
    const y = 0.1 + index * 0.25
    elements.push(text(`h${index}`, 0.1, y, 0.5, 0.05, 24))
    elements.push(text(`b${index}`, 0.1, y + 0.06, 0.5, 0.08, 12))
  }
  const tree = buildTree(elements)
  assert.equal(tree.kind, 'branch')
  assert.equal(tree.axis, 'y')
  assert.equal(tree.children.length, 3)
  assert.ok(tree.repeat)
  assert.equal(tree.repeat.count, 3)
  for (const child of tree.children) {
    assert.equal(child.kind, 'branch')
    assert.equal(child.children.length, 2)
  }
})

test('grid of identical rows is flagged as grid with flex layout metadata', () => {
  const elements = []
  for (let row = 0; row < 2; row += 1) {
    for (let column = 0; column < 3; column += 1) {
      const x = 0.05 + column * 0.3
      const y = 0.25 + row * 0.33
      elements.push(box(`p${row}${column}`, 'fill', x, y, 0.28, 0.3))
      elements.push(text(`t${row}${column}`, x + 0.01, y + 0.02, 0.2, 0.05, 16))
    }
  }
  const tree = buildTree(elements)
  assert.ok(tree.repeat?.grid)
  assert.deepEqual(tree.repeat.grid, { rows: 2, cols: 3 })
  assert.equal(tree.layout.flex, true)
  assert.equal(tree.layout.uniformGap, true)
})

test('pinned title stays first even when its box overlaps the content', () => {
  const tree = buildTree([
    text('title', 0.05, 0.1, 0.9, 0.1, 36),
    box('img', 'image', 0.55, 0.08, 0.3, 0.3),
    text('caption', 0.55, 0.4, 0.3, 0.05),
    text('left', 0.05, 0.3, 0.3, 0.2),
  ], { pinned: new Set(['title']) })
  assert.equal(tree.kind, 'branch')
  assert.equal(tree.children[0].pinned, true)
  assert.equal(tree.children[0].units[0].members[0].element_id, 'title')
})
