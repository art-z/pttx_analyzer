import assert from 'node:assert/strict'
import test from 'node:test'
import {
  applyFlexStackLineHeight,
  flexStackItemWidthPercent,
  flexStackUsesCompactDisplayLayout,
  resolveFlexStackAlignItems,
  resolveFlexStackDirection,
  resolveFlexStackBodyInsetsPt,
  resolveTextGroupLineGapPt,
} from './flex-layout.js'

const compactMembers = [
  {
    split_from_shape: true,
    vertical_anchor: 'ctr',
    body_insets_pt: { top: 14.17, right: 7.2, bottom: 3.6, left: 7.09 },
    text_group_spacing_pt: {
      line_gap_pt: 0,
      flex_stack_layout: 'compact_display',
      render_line_height_ratio: 0.6,
    },
    typography: { size_pt: 44 },
  },
  { typography: { size_pt: 20 } },
]

test('resolveTextGroupLineGapPt uses backend text_group_spacing_pt', () => {
  const gap = resolveTextGroupLineGapPt(compactMembers)
  assert.equal(gap, 0)
})

test('row text groups preserve source direction, gap and relative item width', () => {
  const members = [{
    geometry_norm: { width: 0.13 },
    text_group_spacing_pt: {
      flex_stack_direction: 'row',
      flex_stack_align_items: 'center',
      item_gap_pt: 12,
    },
  }, {
    geometry_norm: { width: 0.41 },
  }]

  assert.equal(resolveFlexStackDirection(members), 'row')
  assert.equal(resolveFlexStackAlignItems(members), 'center')
  assert.equal(resolveTextGroupLineGapPt(members), 12)
  assert.ok(Math.abs(flexStackItemWidthPercent(members[0], { width: 0.56 }, 'row') - 23.214) < 0.01)
})

test('flexStackUsesCompactDisplayLayout matches centered tight metric stacks', () => {
  assert.equal(flexStackUsesCompactDisplayLayout(compactMembers), true)
  assert.equal(flexStackUsesCompactDisplayLayout([
    { ...compactMembers[0], vertical_anchor: 't' },
    compactMembers[1],
  ]), false)
  assert.equal(resolveFlexStackBodyInsetsPt(compactMembers), null)
})

test('applyFlexStackLineHeight uses PPTX ratio by default', () => {
  const node = { style: {} }
  applyFlexStackLineHeight(node, {
    text_group_spacing_pt: { render_line_height_ratio: 0.6 },
  })
  assert.equal(node.style.lineHeight, '0.6')
})

test('applyFlexStackLineHeight uses DS ratio for compact display stacks', () => {
  const node = { style: {} }
  applyFlexStackLineHeight(node, compactMembers[0], {
    compactDisplayLayout: true,
    lineHeightRatio: 1.1,
  })
  assert.equal(node.style.lineHeight, '1.1')
})
