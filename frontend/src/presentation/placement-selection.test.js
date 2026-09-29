import test from 'node:test'
import assert from 'node:assert/strict'

import { getComponentTemplateRegistry } from './component-template-fit.js'
import { applyPlacementToMatch, chooseFittingTemplate, fittingTemplateIds } from './placement-selection.js'

function reportWith(templates) {
  return {
    layout: { content_margins: { left_norm: 0.04, right_norm: 0.04, top_norm: 0.04, bottom_norm: 0.04 } },
    slide_templates: { templates },
  }
}

const empty = {
  template_id: 'tmpl_empty',
  layout_name: 'Пустой',
  editable_slots: [],
  render: { layers: [] },
}

const photo = {
  template_id: 'tmpl_photo',
  layout_name: 'С фото',
  editable_slots: [
    { role: 'title', geometry_norm: { x: 0.05, y: 0.08, width: 0.9, height: 0.1 } },
  ],
  render: {
    layers: [
      { layer_id: 'side', kind: 'image', geometry_norm: { x: 0.5, y: 0.1, width: 0.45, height: 0.8 } },
    ],
  },
}

function cardsComponent() {
  return {
    id: 'vg_cards',
    group: 'repeats',
    kind: 'container',
    label: 'Карточки',
    instances: [{
      layout: 'row',
      template_id: 'tmpl_photo',
      container_norm: { x: 0.1, y: 0.3, width: 0.6, height: 0.2 },
      repeat: { count: 3, item_count: 3 },
    }],
  }
}

test('a title remeasure does not make a quote template suitable', () => {
  const quote = {
    ...empty,
    template_id: 'tmpl_quote',
    layout_name: 'Цитата',
    detected_roles: ['quote'],
    editable_slots: [
      { role: 'title', geometry_norm: { x: 0.05, y: 0.08, width: 0.9, height: 0.1 } },
    ],
  }
  const report = reportWith([empty, quote])
  const component = {
    id: 'vg_cards',
    group: 'repeats',
    kind: 'container',
    label: 'Карточки',
    templates: ['tmpl_empty'],
    instances: [{
      layout: 'row',
      template_id: 'tmpl_empty',
      container_norm: { x: 0.1, y: 0.3, width: 0.3, height: 0.2 },
      repeat: { count: 2, item_count: 2 },
    }],
  }
  getComponentTemplateRegistry(report, [component])

  const chosen = chooseFittingTemplate(report, component, ['tmpl_empty', 'tmpl_quote'], {
    needed: 2,
    titleText: 'Длинный заголовок слайда',
  })
  assert.equal(chosen, 'tmpl_empty')
})

test('a title remeasure cannot reopen a full-bleed shell rejected for a foreign component', () => {
  const bleed = {
    ...empty,
    template_id: 'tmpl_bleed',
    render: { layers: [{ kind: 'image', geometry_norm: { x: 0, y: 0, width: 1, height: 1 } }] },
  }
  const report = reportWith([empty, bleed])
  const component = {
    id: 'chart_a',
    group: 'charts',
    kind: 'chart',
    templates: ['tmpl_empty'],
    instances: [{ template_id: 'tmpl_empty', geometry_norm: { x: 0.1, y: 0.3, width: 0.3, height: 0.2 } }],
  }
  getComponentTemplateRegistry(report, [component])

  assert.deepEqual(fittingTemplateIds(report, component, { titleText: 'Заголовок' }), ['tmpl_empty'])
  assert.equal(chooseFittingTemplate(report, component, ['tmpl_bleed'], { titleText: 'Заголовок' }), null)
})

test('selection prefers a template that can hold the requested copies', () => {
  const report = reportWith([empty, photo])
  const component = cardsComponent()
  getComponentTemplateRegistry(report, [component])

  const chosen = chooseFittingTemplate(report, component, ['tmpl_photo', 'tmpl_empty'], { needed: 3 })
  assert.equal(chosen, 'tmpl_empty')
})

test('a chart that does not fit at its preview size is resized beside the photo', () => {
  const report = reportWith([photo])
  const component = {
    id: 'cht_wide',
    group: 'charts',
    kind: 'chart',
    label: 'Широкий',
    templates: ['tmpl_photo'],
    raw: { baseline_preview: { geometry_norm: { x: 0.04, y: 0.2, width: 0.6, height: 0.3 } } },
    instances: [],
  }
  getComponentTemplateRegistry(report, [component])
  const placed = applyPlacementToMatch(report, {
    component,
    score: 40,
    reasons: ['chart'],
    templateId: 'tmpl_photo',
    templates: ['tmpl_photo'],
  }, { needed: 1, templateIds: ['tmpl_photo'] })
  assert.ok(placed, 'flexible chart is kept')
})

test('a component that fails the single-copy hit test is dropped', () => {
  const report = reportWith([photo])
  const component = {
    id: 'dgm_wide',
    group: 'diagrams',
    kind: 'diagram',
    label: 'Широкий',
    templates: ['tmpl_photo'],
    raw: {
      baseline_preview: {
        geometry_norm: { x: 0.04, y: 0.2, width: 0.6, height: 0.3 },
      },
    },
    instances: [],
  }
  getComponentTemplateRegistry(report, [component])

  const placed = applyPlacementToMatch(report, {
    component,
    score: 40,
    reasons: ['diagram'],
    templateId: 'tmpl_photo',
    templates: ['tmpl_photo'],
  }, { needed: 1, templateIds: ['tmpl_photo'] })

  assert.equal(placed, null)
})

test('a shell that holds the copies wins over a fresher template', () => {
  const report = reportWith([empty, photo])
  const component = cardsComponent()
  getComponentTemplateRegistry(report, [component])

  const chosen = chooseFittingTemplate(report, component, ['tmpl_photo', 'tmpl_empty'], {
    needed: 3,
    templateUsage: { tmpl_empty: 1 },
  })
  assert.equal(chosen, 'tmpl_empty')
})

test('the template just used by this component yields when another shell still fits', () => {
  const report = reportWith([empty, photo])
  const component = cardsComponent()
  getComponentTemplateRegistry(report, [component])

  const chosen = chooseFittingTemplate(report, component, ['tmpl_photo', 'tmpl_empty'], {
    needed: 1,
    avoidTemplateId: 'tmpl_empty',
  })
  assert.equal(chosen, 'tmpl_photo')
})

test('the last template stays when it is the only one that holds the copies', () => {
  const report = reportWith([empty, photo])
  const component = cardsComponent()
  getComponentTemplateRegistry(report, [component])

  const chosen = chooseFittingTemplate(report, component, ['tmpl_photo', 'tmpl_empty'], {
    needed: 3,
    avoidTemplateId: 'tmpl_empty',
  })
  assert.equal(chosen, 'tmpl_empty')
})

test('a partial fit stays when the template cannot hold every context item', () => {
  const report = reportWith([photo])
  const component = cardsComponent()
  getComponentTemplateRegistry(report, [component])

  const placed = applyPlacementToMatch(report, {
    component,
    score: 20,
    reasons: ['cards:4'],
    templateId: 'tmpl_photo',
    templates: [{ templateId: 'tmpl_photo' }],
  }, {
    needed: 4,
    templateIds: ['tmpl_photo'],
  })

  assert.equal(placed.templateId, 'tmpl_photo')
  assert.ok(placed.placementMax >= 1)
  assert.ok(placed.placementMax < 4)
})

test('repeat payload is aimed at the template with enough room', () => {
  const report = reportWith([empty, photo])
  const component = cardsComponent()
  getComponentTemplateRegistry(report, [component])

  const placed = applyPlacementToMatch(report, {
    component,
    score: 20,
    reasons: ['cards:3'],
    templateId: 'tmpl_photo',
    templates: [{ templateId: 'tmpl_photo' }, { templateId: 'tmpl_empty' }],
  }, {
    needed: 3,
    templateIds: ['tmpl_photo', 'tmpl_empty'],
  })

  assert.equal(placed.templateId, 'tmpl_empty')
  assert.ok(placed.placementMax >= 3)
  assert.ok(placed.reasons.some((reason) => reason.startsWith('placement:')))
})
