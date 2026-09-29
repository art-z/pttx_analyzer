import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildTitlePositionIndex,
  orderBySimilarTemplates,
  orderByTemplateDiversity,
  similarTemplateIds,
  titlesSharePosition,
} from './similar-templates.js'

function template(id, box, slideCount = 1) {
  return {
    template_id: id,
    layout_source: `ppt/slideLayouts/${id}.xml`,
    slide_count: slideCount,
    editable_slots: [{ role: 'title', geometry_norm: box }],
  }
}

test('title positions match only when origin and width are almost the same', () => {
  const title = { x: 0.06, y: 0.08, width: 0.88, height: 0.1 }
  assert.equal(titlesSharePosition(title, { x: 0.07, y: 0.09, width: 0.86, height: 0.12 }), true)
  assert.equal(titlesSharePosition(title, { x: 0.06, y: 0.2, width: 0.88, height: 0.1 }), false)
  assert.equal(titlesSharePosition(title, { x: 0.45, y: 0.08, width: 0.4, height: 0.1 }), false)
})

test('similar templates are grouped by title slot, not by layout name', () => {
  const index = buildTitlePositionIndex({
    slide_templates: {
      templates: [
        template('tmpl_001', { x: 0.06, y: 0.08, width: 0.88, height: 0.1 }, 5),
        template('tmpl_002', { x: 0.065, y: 0.084, width: 0.86, height: 0.09 }, 3),
        template('tmpl_003', { x: 0.5, y: 0.4, width: 0.4, height: 0.08 }, 2),
      ],
    },
  })

  assert.equal(index.groups.length, 1)
  assert.deepEqual(index.groups[0].templateIds, ['tmpl_001', 'tmpl_002'])
  assert.deepEqual(similarTemplateIds(index, 'tmpl_001'), ['tmpl_002'])
  assert.deepEqual(similarTemplateIds(index, 'tmpl_002'), ['tmpl_001'])
  assert.deepEqual(similarTemplateIds(index, 'tmpl_003'), [])
  assert.equal(index.keyByTemplateId.get('tmpl_001'), index.keyByTemplateId.get('tmpl_002'))
  assert.notEqual(index.keyByTemplateId.get('tmpl_001'), index.keyByTemplateId.get('tmpl_003'))
  assert.equal(
    index.keyByTemplateId.get('ppt/slideLayouts/tmpl_002.xml'),
    index.keyByTemplateId.get('tmpl_001'),
  )
})

test('candidate shortlist keeps close templates with the same title position', () => {
  const ranked = orderBySimilarTemplates([
    { templateId: 'a', titlePositionKey: 'top', score: 90 },
    { templateId: 'other', titlePositionKey: 'side', score: 88 },
    { templateId: 'b', titlePositionKey: 'top', score: 80 },
    { templateId: 'd', titlePositionKey: 'bottom', score: 70 },
    { templateId: 'c', titlePositionKey: 'top', score: 60 },
  ], { limit: 4 })

  assert.deepEqual(ranked.map((item) => item.templateId), ['a', 'b', 'other', 'd'])
})

test('template diversity keeps the better fit and then a new title position', () => {
  const ranked = orderByTemplateDiversity([
    { templateId: 'used', titlePositionKey: 'top', score: 95, componentId: 'text-a' },
    { templateId: 'fresh-same', titlePositionKey: 'top', score: 70, componentId: 'text-a' },
    { templateId: 'fresh-side', titlePositionKey: 'side', score: 60, componentId: 'text-a' },
  ], {
    limit: 2,
    templateUsage: { used: 2 },
  })

  assert.deepEqual(ranked.map((item) => item.templateId), ['used', 'fresh-side'])
})

test('the same component skips the template it just used when another fit is close', () => {
  const ranked = orderByTemplateDiversity([
    { templateId: 'tmpl_a', titlePositionKey: 'top', score: 90, componentId: 'text-a' },
    { templateId: 'tmpl_b', titlePositionKey: 'top', score: 84, componentId: 'text-a' },
  ], {
    limit: 1,
    lastTemplateByComponent: { 'text-a': 'tmpl_a' },
  })

  assert.deepEqual(ranked.map((item) => item.templateId), ['tmpl_b'])
})
