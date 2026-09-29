import assert from 'node:assert/strict'
import test from 'node:test'
import { paragraphSpacingForFlexStackItem, shouldApplyParagraphSpacingInFlexStack } from './text-list.js'

test('flex stack bullet items keep paragraph spacing from pPr', () => {
  const element = {
    split_from_shape: true,
    text: 'Second item',
    bullet: { kind: 'char', char: '•' },
    paragraph_spacing_pt: { margin_left: 20.13, indent: -20.13, space_before: 14 },
  }
  assert.equal(shouldApplyParagraphSpacingInFlexStack(element), true)
  assert.equal(paragraphSpacingForFlexStackItem(element, 1).space_before, 14)
  assert.equal(paragraphSpacingForFlexStackItem(element, 0).space_before, 0)
})

test('flex stack typography-split cards keep marL from pPr', () => {
  const element = {
    split_from_shape: true,
    text: 'Card line',
    paragraph_spacing_pt: { margin_left: 14.13 },
  }
  assert.equal(shouldApplyParagraphSpacingInFlexStack(element), true)
})

test('compact display metric stacks skip paragraph spacing', () => {
  const element = {
    split_from_shape: true,
    text: '10',
    typography: { size_pt: 44 },
    paragraph_spacing_pt: { line_spacing_ratio: 0.6, line_height_applicable: false },
  }
  assert.equal(shouldApplyParagraphSpacingInFlexStack(element, { compactDisplayLayout: true }), false)
})
