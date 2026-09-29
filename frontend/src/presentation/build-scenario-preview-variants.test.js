import test from 'node:test'
import assert from 'node:assert/strict'

import {
  pickScenarioDisplayVariants,
  runScenarioVariantPipeline,
  selectDiverseVariants,
} from './build-scenario-preview-variants.js'

function variant(key, dataBlock, options = {}) {
  return {
    key,
    role: 'alternative',
    dataBlock,
    catalogSlide: { slide_number: options.slideNumber || 1 },
    componentId: options.componentId,
    templateId: options.templateId,
    titlePositionKey: options.titlePositionKey || null,
    score: options.score ?? 50,
  }
}

function assetBoardTemplate(id = 'tmpl_assets') {
  return {
    template_id: id,
    layout_name: 'Assets',
    editable_slots: [],
    render: {
      layers: Array.from({ length: 14 }, (_, index) => ({
        layer_id: `asset_${index}`,
        kind: 'image',
        geometry_norm: {
          x: 0.06 + (index % 7) * 0.12,
          y: 0.08 + Math.floor(index / 7) * 0.18,
          width: 0.045,
          height: 0.055,
        },
      })),
    },
  }
}

test('rich data blocks are preferred over narrative-only variants', () => {
  const picked = pickScenarioDisplayVariants([
    variant('text', 'title_text'),
    variant('lists', 'lists'),
    variant('metrics', 'metrics'),
    variant('tables', 'tables'),
  ], { intent: 'content', seed: 'deck|1' })

  assert.equal(picked[0].dataBlock, 'metrics')
})

test('asset board templates are ranked below normal templates instead of winning by raw score', () => {
  const report = {
    slide_templates: {
      templates: [
        assetBoardTemplate('tmpl_assets'),
        { template_id: 'tmpl_normal', layout_name: 'Normal', editable_slots: [], render: { layers: [] } },
      ],
    },
  }
  const picked = pickScenarioDisplayVariants([
    variant('asset', 'cards', { templateId: 'tmpl_assets', componentId: 'cards-assets', score: 220 }),
    variant('normal', 'cards', { templateId: 'tmpl_normal', componentId: 'cards-normal', score: 30 }),
  ], { intent: 'features', seed: 'asset-board', report })

  assert.equal(picked[0].key, 'normal')
})

test('asset board templates remain usable as fallback when they are the only candidate', () => {
  const report = {
    slide_templates: { templates: [assetBoardTemplate('tmpl_assets')] },
  }
  const picked = pickScenarioDisplayVariants([
    variant('asset', 'cards', { templateId: 'tmpl_assets', componentId: 'cards-assets', score: 80 }),
  ], { intent: 'features', seed: 'asset-board-only', report })

  assert.equal(picked[0].key, 'asset')
})

test('deck usage rotates primary blocks from metrics to tables', () => {
  const candidates = [
    variant('text', 'title_text'),
    variant('metrics', 'metrics'),
    variant('tables', 'tables'),
  ]
  const picked = pickScenarioDisplayVariants(candidates, {
    intent: 'content',
    seed: 'deck|2',
    selectionContext: {
      blockUsage: { metrics: 1 },
      componentUsage: {},
      templateUsage: {},
    },
  })

  assert.equal(picked[0].dataBlock, 'tables')
})

test('used repeat component is rotated to another comparable candidate', () => {
  const candidates = [
    variant('repeat-a', 'lists', {
      componentId: 'vg_001',
      templateId: 'tpl_1',
      score: 80,
    }),
    variant('repeat-b', 'lists', {
      componentId: 'vg_002',
      templateId: 'tpl_2',
      score: 79,
    }),
  ]
  const first = pickScenarioDisplayVariants(candidates, {
    intent: 'features',
    seed: 'deck|features|1',
  })[0]
  const second = pickScenarioDisplayVariants(candidates, {
    intent: 'features',
    seed: 'deck|features|2',
    selectionContext: {
      blockUsage: { lists: 1 },
      componentUsage: { [first.componentId]: 1 },
      templateUsage: { [first.templateId]: 1 },
    },
  })[0]

  assert.notEqual(second.componentId, first.componentId)
})

test('seeded variant ordering is reproducible', () => {
  const candidates = [
    variant('repeat-a', 'lists', { componentId: 'vg_001', score: 80 }),
    variant('repeat-b', 'lists', { componentId: 'vg_002', score: 80 }),
  ]
  const options = { intent: 'features', seed: 'same-seed' }

  assert.equal(
    pickScenarioDisplayVariants(candidates, options)[0].componentId,
    pickScenarioDisplayVariants(candidates, options)[0].componentId,
  )
})

test('a better component keeps its template when another shell is merely unused', () => {
  const picked = pickScenarioDisplayVariants([
    variant('used', 'cards', { templateId: 'tmpl_used', score: 95, componentId: 'cards-used' }),
    variant('fresh', 'cards', { templateId: 'tmpl_fresh', score: 40, componentId: 'cards-fresh' }),
  ], {
    intent: 'features',
    seed: 'unused-template',
    selectionContext: {
      blockUsage: {},
      componentUsage: {},
      templateUsage: { tmpl_used: 1 },
    },
  })

  assert.equal(picked[0].componentId, 'cards-used')
  assert.equal(picked[0].templateId, 'tmpl_used')
})

test('the same component avoids the template it just used when another fit is close', () => {
  const picked = pickScenarioDisplayVariants([
    variant('again', 'cards', { templateId: 'tmpl_a', score: 90, componentId: 'vg_cards' }),
    variant('other', 'cards', { templateId: 'tmpl_b', score: 84, componentId: 'vg_cards' }),
  ], {
    intent: 'features',
    seed: 'rotate-component-template',
    selectionContext: {
      blockUsage: { cards: 1 },
      componentUsage: { vg_cards: 1 },
      templateUsage: { tmpl_a: 1 },
      lastTemplateByComponent: { vg_cards: 'tmpl_a' },
    },
  })

  assert.equal(picked[0].componentId, 'vg_cards')
  assert.equal(picked[0].templateId, 'tmpl_b')
})

test('the only fitting template stays even if this component just used it', () => {
  const picked = pickScenarioDisplayVariants([
    variant('again', 'cards', { templateId: 'tmpl_a', score: 90, componentId: 'vg_cards' }),
  ], {
    intent: 'features',
    seed: 'only-template',
    selectionContext: {
      lastTemplateByComponent: { vg_cards: 'tmpl_a' },
    },
  })

  assert.equal(picked[0].templateId, 'tmpl_a')
})

test('filled paragraphs keep a text variant next to richer layouts', () => {
  const picked = pickScenarioDisplayVariants([
    variant('metric-a1', 'metrics', { templateId: 'tmpl_001', score: 90, componentId: 'metric-a' }),
    variant('metric-a2', 'metrics', { templateId: 'tmpl_001', score: 88, componentId: 'metric-a' }),
    variant('metric-b', 'metrics', { templateId: 'tmpl_002', score: 70, componentId: 'metric-b' }),
    variant('text-c', 'title_text', { templateId: 'tmpl_003', score: 20, componentId: 'text-c' }),
  ], { intent: 'metrics', seed: 'template-diversity' })

  assert.deepEqual(
    picked.map((item) => item.templateId),
    ['tmpl_001', 'tmpl_003', 'tmpl_002'],
  )
  assert.deepEqual(
    picked.map((item) => item.dataBlock),
    ['metrics', 'title_text', 'metrics'],
  )
})

test('similar title positions rotate instead of always keeping the first template', () => {
  const titleKey = 'title:0.060:0.080:0.880'
  const candidates = [
    variant('best', 'metrics', {
      templateId: 'tmpl_a',
      score: 90,
      titlePositionKey: titleKey,
      componentId: 'metric-a',
    }),
    variant('similar', 'metrics', {
      templateId: 'tmpl_b',
      score: 84,
      titlePositionKey: titleKey,
      componentId: 'metric-a',
    }),
    variant('shifted', 'metrics', {
      templateId: 'tmpl_c',
      score: 40,
      titlePositionKey: 'title:0.500:0.400:0.400',
      componentId: 'metric-c',
    }),
    variant('text', 'title_text', { templateId: 'tmpl_d', score: 20 }),
  ]
  const first = pickScenarioDisplayVariants(candidates, {
    intent: 'metrics',
    seed: 'slide-1',
  })[0]
  const second = pickScenarioDisplayVariants(candidates, {
    intent: 'metrics',
    seed: 'slide-2',
    selectionContext: {
      blockUsage: {},
      componentUsage: { [first.componentId]: 1 },
      templateUsage: { [first.templateId]: 1 },
      lastTemplateByComponent: { [first.componentId]: first.templateId },
    },
  })[0]

  assert.equal(first.dataBlock, 'metrics')
  assert.notEqual(first.templateId, 'tmpl_c')
  assert.notEqual(second.templateId, first.templateId)
  assert.notEqual(second.templateId, 'tmpl_c')
  assert.equal(second.dataBlock, 'metrics')
})

test('the same similar-template choice is stable for one seed', () => {
  const titleKey = 'title:0.060:0.080:0.880'
  const candidates = [
    variant('best', 'metrics', { templateId: 'tmpl_a', score: 90, titlePositionKey: titleKey }),
    variant('similar', 'metrics', { templateId: 'tmpl_b', score: 86, titlePositionKey: titleKey }),
  ]
  const options = { intent: 'metrics', seed: 'stable-similar' }

  assert.equal(
    pickScenarioDisplayVariants(candidates, options)[0].templateId,
    pickScenarioDisplayVariants(candidates, options)[0].templateId,
  )
})

test('a single compatible layout is not cloned into extra variants', () => {
  const picked = pickScenarioDisplayVariants([
    variant('only', 'cards', { templateId: 'tmpl_001', score: 80 }),
  ], { intent: 'features', seed: 'single-layout' })

  assert.equal(picked.length, 1)
  assert.equal(picked[0].key, 'only')
})

test('three display variants use different components and chart families', () => {
  const chart = (key, componentId, templateId, chartType, score) => ({
    ...variant(key, 'charts', { componentId, templateId, score }),
    catalogSlide: { content_elements: [{ kind: 'chart', chart_type: chartType }] },
  })
  const picked = pickScenarioDisplayVariants([
    chart('bar-one', 'chart-a', 'tmpl-a', 'bar', 100),
    chart('bar-other-template', 'chart-a', 'tmpl-b', 'bar', 99),
    chart('bar-other-component', 'chart-b', 'tmpl-c', 'bar', 98),
    chart('line', 'chart-c', 'tmpl-d', 'line', 90),
    variant('table', 'tables', { componentId: 'table-a', templateId: 'tmpl-e', score: 85 }),
  ], { intent: 'comparison', seed: 'diverse-variants' })
  assert.equal(picked.length, 3)
  assert.equal(new Set(picked.map((item) => item.componentId)).size, 3)
  assert.deepEqual(picked.filter((item) => item.dataBlock === 'charts')
    .map((item) => item.catalogSlide.content_elements[0].chart_type).sort(), ['bar', 'line'])
})

test('pie and doughnut count as the same circular chart family', () => {
  const chart = (key, componentId, templateId, chartType) => ({
    ...variant(key, 'charts', { componentId, templateId, score: 80 }),
    catalogSlide: { content_elements: [{ kind: 'chart', chart_type: chartType }] },
  })
  const picked = pickScenarioDisplayVariants([
    chart('pie', 'pie-component', 'pie-template', 'pie'),
    chart('donut', 'donut-component', 'donut-template', 'doughnut'),
    chart('line', 'line-component', 'line-template', 'line'),
  ], { intent: 'comparison', seed: 'circular-diversity' })
  assert.equal(picked.length, 2)
  assert.ok(picked.some((item) => item.key === 'line'))
})

test('overflowing variants lose to a clean layout', () => {
  const picked = pickScenarioDisplayVariants([
    variant('cramped', 'cards', {
      templateId: 'tmpl_001',
      score: 90,
    }),
    variant('open', 'lists', {
      templateId: 'tmpl_002',
      score: 40,
    }),
  ].map((item) => (
    item.key === 'cramped'
      ? {
        ...item,
        catalogSlide: {
          ...item.catalogSlide,
          layout_validation: { issues: [{ code: 'text_overflow' }, { code: 'text_overlap' }] },
        },
      }
      : item
  )), { intent: 'features', seed: 'layout-quality' })

  assert.deepEqual(picked.map((item) => item.key), ['open'])
})

test('preflight rejects candidates whose data block is absent from the spec', () => {
  const result = runScenarioVariantPipeline([
    variant('invented-chart', 'charts', { templateId: 'tmpl_chart' }),
    variant('real-list', 'lists', { templateId: 'tmpl_list' }),
  ], {
    spec: {
      title: 'Only a list',
      text: '',
      lists: [{ heading: '1', body: 'Item' }],
      charts: [],
    },
    intent: 'features',
    seed: 'preflight',
  })

  assert.deepEqual(result.variants.map((item) => item.key), ['real-list'])
  assert.deepEqual(result.diagnostics, {
    generated: 2,
    eligible: 1,
    selected: 1,
    selected_variants: [{
      key: 'real-list',
      data_block: 'lists',
      component_id: null,
      template_id: 'tmpl_list',
      transplanted: false,
    }],
    rejected: [{ key: 'invented-chart', reason: 'missing_source_data' }],
  })
})

test('pipeline diagnostics report layout candidates removed by the quality gate', () => {
  const broken = variant('broken', 'cards', { templateId: 'tmpl_broken' })
  broken.catalogSlide.layout_validation = {
    valid: true,
    issues: [{ code: 'text_overlap' }],
  }
  const clean = variant('clean', 'cards', { templateId: 'tmpl_clean' })
  clean.catalogSlide.layout_validation = { valid: true, issues: [] }

  const result = runScenarioVariantPipeline([broken, clean], {
    spec: { cards: [{ heading: 'Card', body: 'Body' }] },
    intent: 'features',
  })

  assert.deepEqual(result.variants.map((item) => item.key), ['clean'])
  assert.deepEqual(result.diagnostics.rejected, [
    { key: 'broken', reason: 'blocking_layout_warning' },
  ])
})

test('pipeline drops a variant whose assembled content hits a template obstacle', () => {
  const report = {
    layout: { content_margins: { left_norm: 0.04, right_norm: 0.04, top_norm: 0.04, bottom_norm: 0.04 } },
    slide_templates: {
      templates: [{
        template_id: 'tmpl_photo',
        editable_slots: [],
        render: {
          layers: [{
            layer_id: 'side',
            kind: 'image',
            geometry_norm: { x: 0.5, y: 0.1, width: 0.45, height: 0.8 },
          }],
        },
      }],
    },
  }
  const blocked = variant('blocked', 'cards', { templateId: 'tmpl_photo', score: 90, componentId: 'cards-a' })
  blocked.catalogSlide = {
    content_elements: [{
      element_id: 'card__repeat_1',
      geometry_norm: { x: 0.55, y: 0.4, width: 0.3, height: 0.3 },
    }],
  }
  const clear = variant('clear', 'cards', { templateId: 'tmpl_open', score: 40, componentId: 'cards-b' })
  clear.catalogSlide = {
    slide_number: 2,
    content_elements: [{
      element_id: 'card__repeat_1',
      geometry_norm: { x: 0.08, y: 0.3, width: 0.3, height: 0.2 },
    }],
  }

  const result = runScenarioVariantPipeline([blocked, clear], {
    report,
    spec: { cards: [{ heading: 'Card', body: 'Body' }] },
    intent: 'features',
    seed: 'placement-audit',
  })

  assert.deepEqual(result.variants.map((item) => item.key), ['clear'])
  assert.deepEqual(result.diagnostics.rejected, [
    { key: 'blocked', reason: 'placement_obstacle' },
  ])
})

test('pipeline refuses a high-scoring component on a shell rejected in Components', () => {
  const open = {
    template_id: 'tmpl_open',
    editable_slots: [],
    render: { layers: [] },
  }
  const bleed = {
    template_id: 'tmpl_bleed',
    editable_slots: [],
    render: { layers: [{ kind: 'image', geometry_norm: { x: 0, y: 0, width: 1, height: 1 } }] },
  }
  const report = {
    layout: { content_margins: { left_norm: 0.04, right_norm: 0.04, top_norm: 0.04, bottom_norm: 0.04 } },
    slide_templates: { templates: [open, bleed] },
    graphic_components: {
      charts: [{
        component_id: 'chart_a',
        frequency: { template_ids: ['tmpl_open'] },
        instances: [{ template_id: 'tmpl_open', geometry_norm: { x: 0.1, y: 0.3, width: 0.3, height: 0.2 } }],
      }],
    },
  }
  const rejected = variant('rejected', 'charts', { componentId: 'chart_a', templateId: 'tmpl_bleed', score: 100 })
  const allowed = variant('allowed', 'charts', { componentId: 'chart_a', templateId: 'tmpl_open', score: 40 })
  const result = runScenarioVariantPipeline([rejected, allowed], {
    report,
    spec: { title: 'График', charts: [{ type: 'bar' }] },
    intent: 'content',
  })

  assert.deepEqual(result.variants.map((item) => item.key), ['allowed'])
  assert.deepEqual(result.diagnostics.rejected, [{ key: 'rejected', reason: 'component_template_rejected' }])
})



test('pipeline skips chart templates that need a synthetic title', () => {
  const synthetic = variant('synthetic-title-chart', 'charts', { componentId: 'chart_a', templateId: 'tmpl_synth', score: 100 })
  synthetic.catalogSlide = {
    content_elements: [
      { element_id: 'chart_1', kind: 'chart' },
      { element_id: 'synthetic_slide_title_1', kind: 'text', text: 'График', role: 'title', synthetic: true },
    ],
    layout_validation: { valid: true, issues: [] },
  }
  const clean = variant('real-title-chart', 'charts', { componentId: 'chart_b', templateId: 'tmpl_real', score: 10 })
  clean.catalogSlide = {
    content_elements: [
      { element_id: 'chart_2', kind: 'chart' },
      { element_id: 'slide_title_2', kind: 'text', text: 'График', role: 'title' },
    ],
    layout_validation: { valid: true, issues: [] },
  }

  const result = runScenarioVariantPipeline([synthetic, clean], {
    spec: { title: 'График', charts: [{ type: 'bar' }] },
    intent: 'content',
  })

  assert.deepEqual(result.variants.map((item) => item.key), ['real-title-chart'])
  assert.deepEqual(result.diagnostics.rejected, [
    { key: 'synthetic-title-chart', reason: 'chart_synthetic_title_template' },
  ])
})

test('pipeline hard-rejects chart variants whose title still overlaps the chart', () => {
  const titleOver = variant('title-over', 'charts', { componentId: 'chart_a', templateId: 'tmpl_decor', score: 100 })
  titleOver.catalogSlide = {
    content_elements: [
      { element_id: 'chart_1', kind: 'chart' },
      { element_id: 'title_1', kind: 'text', text: 'Title' },
    ],
    layout_validation: { valid: true, issues: [{ code: 'title_over_graphic', element_id: 'title_1', obstacle: 'chart_1' }] },
  }
  const textOverlap = variant('text-over-chart', 'charts', { componentId: 'chart_b', templateId: 'tmpl_tight', score: 90 })
  textOverlap.catalogSlide = {
    content_elements: [
      { element_id: 'chart_2', kind: 'chart' },
      { element_id: 'title_2', kind: 'text', text: 'Title' },
    ],
    layout_validation: { valid: true, warnings: [{ code: 'text_overlap', element_ids: ['title_2', 'chart_2'] }] },
  }
  const clean = variant('clean-chart', 'charts', { componentId: 'chart_c', templateId: 'tmpl_open', score: 10 })
  clean.catalogSlide = {
    content_elements: [{ element_id: 'chart_3', kind: 'chart' }],
    layout_validation: { valid: true, issues: [] },
  }

  const result = runScenarioVariantPipeline([titleOver, textOverlap, clean], {
    spec: { title: 'График', charts: [{ type: 'doughnut' }] },
    intent: 'content',
  })

  assert.deepEqual(result.variants.map((item) => item.key), ['clean-chart'])
  assert.deepEqual(result.diagnostics.rejected, [
    { key: 'title-over', reason: 'chart_title_overlap' },
    { key: 'text-over-chart', reason: 'chart_text_overlap' },
  ])
})

test('paragraphs and a chart give one text and two different chart types', () => {
  const chart = (key, componentId, templateId, chartType, score) => ({
    ...variant(key, 'charts', { componentId, templateId, score }),
    catalogSlide: { content_elements: [{ kind: 'chart', chart_type: chartType }] },
  })
  const picked = pickScenarioDisplayVariants([
    chart('bar', 'chart-a', 'tmpl-a', 'bar', 95),
    chart('line', 'chart-b', 'tmpl-b', 'line', 94),
    chart('area', 'chart-c', 'tmpl-c', 'area', 93),
    variant('text', 'title_text', { componentId: 'text-a', templateId: 'tmpl-d', score: 30 }),
  ], { intent: 'content', seed: 'text-plus-chart' })

  assert.equal(picked.length, 3)
  assert.equal(picked.filter((item) => item.dataBlock === 'title_text').length, 1)
  assert.deepEqual(picked.filter((item) => item.dataBlock === 'charts')
    .map((item) => item.catalogSlide.content_elements[0].chart_type), ['bar', 'line'])
})

test('a second diagram does not displace a paragraph variant', () => {
  const diagram = (key, componentId, templateId, score) => ({
    ...variant(key, 'diagrams', { componentId, templateId, score }),
    catalogSlide: { content_elements: [{ kind: 'diagram', diagram_type: 'flow' }] },
  })
  const picked = pickScenarioDisplayVariants([
    diagram('diagram-a', 'diagram-a', 'tmpl-a', 120),
    diagram('diagram-b', 'diagram-b', 'tmpl-b', 119),
    variant('paragraph', 'title_text', { componentId: 'text-a', templateId: 'tmpl-c', score: 40 }),
    variant('cards', 'cards', { componentId: 'cards-a', templateId: 'tmpl-d', score: 30 }),
  ], { intent: 'process', seed: 'diagram-dedupe' })

  assert.equal(picked.filter((item) => item.dataBlock === 'diagrams').length, 1)
  assert.ok(picked.some((item) => item.dataBlock === 'title_text'))
})

test('mixed data yields three different content types on three different templates', () => {
  const picked = pickScenarioDisplayVariants([
    variant('metrics-a', 'metrics', { componentId: 'metric-a', templateId: 'tmpl-a', score: 95 }),
    variant('metrics-b', 'metrics', { componentId: 'metric-b', templateId: 'tmpl-b', score: 94 }),
    variant('table', 'tables', { componentId: 'table-a', templateId: 'tmpl-a', score: 80 }),
    variant('table-b', 'tables', { componentId: 'table-b', templateId: 'tmpl-c', score: 70 }),
    variant('cards', 'cards', { componentId: 'cards-a', templateId: 'tmpl-d', score: 50 }),
    variant('text', 'title_text', { componentId: 'text-a', templateId: 'tmpl-e', score: 20 }),
  ], { intent: 'content', seed: 'mixed' })

  assert.equal(picked.length, 3)
  assert.equal(new Set(picked.map((item) => item.dataBlock)).size, 3)
  assert.equal(new Set(picked.map((item) => item.templateId)).size, 3)
  assert.deepEqual(picked.map((item) => item.key), ['metrics-a', 'table-b', 'cards'])
})

test('every filled block is represented before one block takes a second slot', () => {
  const picked = pickScenarioDisplayVariants([
    variant('table-a', 'tables', { componentId: 'table-a', templateId: 'tmpl-a', score: 90 }),
    variant('table-b', 'tables', { componentId: 'table-b', templateId: 'tmpl-b', score: 89 }),
    variant('cards', 'cards', { componentId: 'cards-a', templateId: 'tmpl-c', score: 60 }),
    variant('metrics', 'metrics', { componentId: 'metric-a', templateId: 'tmpl-d', score: 55 }),
  ], { intent: 'comparison', seed: 'all-blocks' })

  assert.deepEqual(picked.map((item) => item.dataBlock).sort(), ['cards', 'metrics', 'tables'])
})

test('intent is only a small ranking bonus, never a filter', () => {
  const candidates = [
    variant('metrics', 'metrics', { componentId: 'metric-a', templateId: 'tmpl-a', score: 80 }),
    variant('table', 'tables', { componentId: 'table-a', templateId: 'tmpl-b', score: 60 }),
  ]
  const picked = pickScenarioDisplayVariants(candidates, { intent: 'comparison', seed: 'intent-bonus' })

  assert.equal(picked.length, 2)
  assert.equal(picked[0].dataBlock, 'metrics')

  const close = pickScenarioDisplayVariants([
    variant('metrics', 'metrics', { componentId: 'metric-a', templateId: 'tmpl-a', score: 60 }),
    variant('table', 'tables', { componentId: 'table-a', templateId: 'tmpl-b', score: 60 }),
  ], { intent: 'comparison', seed: 'intent-bonus' })
  assert.equal(close[0].dataBlock, 'tables')
})

test('a chart-only slide reaches three variants with three different chart types', () => {
  const chart = (key, componentId, templateId, chartType) => ({
    ...variant(key, 'charts', { componentId, templateId, score: 80 }),
    catalogSlide: { content_elements: [{ kind: 'chart', chart_type: chartType }] },
  })
  const picked = pickScenarioDisplayVariants([
    chart('bar', 'chart-a', 'tmpl-a', 'bar'),
    chart('line', 'chart-b', 'tmpl-b', 'line'),
    chart('area', 'chart-c', 'tmpl-c', 'area'),
  ], { intent: 'content', seed: 'chart-only' })

  assert.equal(picked.length, 3)
  assert.equal(new Set(picked.map((item) => item.catalogSlide.content_elements[0].chart_type)).size, 3)
})

test('a chart-only slide never yields identical charts; a title variant fills in', () => {
  const chart = (key, componentId, templateId) => ({
    ...variant(key, 'charts', { componentId, templateId, score: 90 }),
    catalogSlide: { content_elements: [{ kind: 'chart', chart_type: 'bar' }] },
  })
  const candidates = [
    chart('bar-a', 'chart-a', 'tmpl-a'),
    chart('bar-b', 'chart-b', 'tmpl-b'),
    chart('bar-c', 'chart-c', 'tmpl-c'),
  ]
  const onlyBars = pickScenarioDisplayVariants(candidates, { intent: 'content', seed: 'bars' })
  assert.equal(onlyBars.length, 1)

  const withTitle = pickScenarioDisplayVariants([
    ...candidates,
    variant('title', 'title_text', { componentId: 'text-a', templateId: 'tmpl-d', score: 10 }),
  ], { intent: 'content', seed: 'bars' })
  assert.deepEqual(withTitle.map((item) => item.dataBlock), ['charts', 'title_text'])
})

test('a single-block slide still reaches three variants', () => {
  const picked = pickScenarioDisplayVariants([
    variant('cards-a', 'cards', { componentId: 'cards-a', templateId: 'tmpl-a', score: 80 }),
    variant('cards-b', 'cards', { componentId: 'cards-b', templateId: 'tmpl-b', score: 79 }),
    variant('cards-c', 'cards', { componentId: 'cards-c', templateId: 'tmpl-c', score: 78 }),
  ], { intent: 'features', seed: 'single-block' })

  assert.equal(picked.length, 3)
})

test('a second KPI component on another donor slide beats a second text layout', () => {
  const metricsA = variant('metrics-50', 'metrics', { templateId: 'tmpl_free', slideNumber: 50, componentId: 'metric:50', score: 90 })
  const text = variant('text-11', 'title_text', { templateId: 'tmpl_card', slideNumber: 11, componentId: 'text:11', score: 88 })
  const metricsB = variant('metrics-33', 'metrics', { templateId: 'tmpl_free', slideNumber: 33, componentId: 'metric:33', score: 80 })
  const text2 = variant('text-10', 'title_text', { templateId: 'tmpl_card2', slideNumber: 10, componentId: 'text:10', score: 85 })
  const picked = selectDiverseVariants([metricsA, text, text2, metricsB], { limit: 3 })
  assert.deepEqual(picked.map((item) => item.key), ['metrics-50', 'text-11', 'metrics-33'])
})

test('the same template and donor slide is never picked twice', () => {
  const first = variant('a', 'metrics', { templateId: 'tmpl_free', slideNumber: 50, componentId: 'metric:hero', score: 90 })
  const same = variant('b', 'metrics', { templateId: 'tmpl_free', slideNumber: 50, componentId: 'metric:split', score: 89 })
  const text = variant('c', 'title_text', { templateId: 'tmpl_card', slideNumber: 11, componentId: 'text:11', score: 10 })
  const picked = selectDiverseVariants([first, same, text], { limit: 3 })
  assert.deepEqual(picked.map((item) => item.key), ['a', 'c'])
})
