import test from 'node:test'
import assert from 'node:assert/strict'

import { componentCoverageKey, recordDisplayedVariants } from './component-coverage.js'
import { pickScenarioDisplayVariants } from './build-scenario-preview-variants.js'

test('icon coverage requires both a text field and an icon', () => {
  const base = { group: 'repeats', slots: { required: [
    { kind: 'image', role: 'image' },
  ], optional: [] } }
  assert.equal(componentCoverageKey(base), null)
  assert.equal(componentCoverageKey({ ...base, slots: { ...base.slots, optional: [
    { kind: 'text', role: 'body' },
  ] } }), 'icon_list')
})

test('coverage register counts every displayed variant and promotes a missing chart family', () => {
  const context = {
    blockUsage: {}, componentUsage: {}, templateUsage: {}, lastTemplateByComponent: {},
    coverageUsage: {}, componentExposure: {},
    componentKeys: { bar: 'chart:bar', line: 'chart:line' },
    targetComponents: ['bar', 'line'],
  }
  recordDisplayedVariants(context, [
    { componentId: 'bar', dataBlock: 'charts', templateId: 'a', catalogSlide: {} },
    { componentId: 'line', dataBlock: 'charts', templateId: 'b', catalogSlide: {} },
  ])
  assert.equal(context.componentUsage.bar, 1)
  assert.equal(context.componentUsage.line, undefined)
  assert.equal(context.coverageUsage['chart:bar'], 1)
  assert.equal(context.coverageUsage['chart:line'], 1)

  const next = pickScenarioDisplayVariants([
    { key: 'bar', componentId: 'bar', dataBlock: 'charts', templateId: 'c', score: 80, catalogSlide: { slide_number: 1 } },
    { key: 'line', componentId: 'line', dataBlock: 'charts', templateId: 'd', score: 79, catalogSlide: { slide_number: 2 } },
  ], { selectionContext: context, intent: 'comparison' })
  assert.equal(next[0].componentId, 'line')
})
