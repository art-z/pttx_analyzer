import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

import { probeChartOnTemplate, refitChartsClearOfText } from './component-template-fit.js'
import { suitableChartTypes } from './graphic-contract.js'
import { chartFromMetrics, chartFromTable, deriveChartsFromSpec, parseNumericCell } from './derived-charts.js'
import { selectDiverseVariants } from './build-scenario-preview-variants.js'

const report = {
  layout: { content_margins: { left_norm: 0.04, right_norm: 0.04, top_norm: 0.04, bottom_norm: 0.04 } },
  slide_templates: { templates: [] },
}

function template(layers = []) {
  return {
    template_id: 'tmpl_chart',
    layout_name: 'Chart',
    editable_slots: [{ role: 'title', geometry_norm: { x: 0.05, y: 0.08, width: 0.9, height: 0.1 } }],
    render: { layers },
  }
}

test('a chart is sized into the free area below the title and beside a distant photo', () => {
  const photo = { layer_id: 'side', kind: 'image', geometry_norm: { x: 0.68, y: 0.01, width: 0.28, height: 0.05 } }
  const fit = probeChartOnTemplate({ flexible: 'chart', chartType: 'bar' }, template([photo]), report, { titleText: 'Рост выручки' })
  assert.equal(fit.status, 'fit')
  assert.ok(fit.box.y >= 0.18, `chart top ${fit.box.y} is below the title slot`)
  assert.ok(fit.box.y >= 0.18, 'chart is vertically separated from the photo')
  assert.ok(fit.box.width >= 0.6, `chart width ${fit.box.width} is at least 60% of the slide`)
  assert.ok(fit.box.width * 960 >= 576 && fit.box.height * 540 >= 180)
})


test('a chart template may use a shell with a nearby right image when 60 percent width remains', () => {
  const photo = { layer_id: 'right_photo', kind: 'image', geometry_norm: { x: 0.74, y: 0.25, width: 0.18, height: 0.5 } }
  const fit = probeChartOnTemplate({ flexible: 'chart', chartType: 'area' }, template([photo]), report, { titleText: 'Динамика' })
  assert.equal(fit.status, 'fit')
  assert.ok(fit.box.width >= 0.6)
})

test('a chart is rejected when the remaining free width is below 60 percent of the slide', () => {
  const photo = { layer_id: 'side', kind: 'image', geometry_norm: { x: 0.38, y: 0.1, width: 0.28, height: 0.8 } }
  const fit = probeChartOnTemplate({ flexible: 'chart', chartType: 'area' }, template([photo]), report, { titleText: 'Динамика' })
  assert.equal(fit.status, 'rejected')
  assert.equal(fit.fail_reason, 'obstacle')
})

test('a chart is rejected when no free area is large enough', () => {
  const photo = { layer_id: 'big', kind: 'image', geometry_norm: { x: 0.2, y: 0.2, width: 0.76, height: 0.76 } }
  const fit = probeChartOnTemplate({ flexible: 'chart', chartType: 'bar' }, template([photo]), report, { titleText: 'Рост' })
  assert.equal(fit.status, 'rejected')
})

test('a chart is rejected in a narrow strip that is too tight to read', () => {
  const blocking = { layer_id: 'side', kind: 'image', geometry_norm: { x: 0.38, y: 0.18, width: 0.58, height: 0.78 } }
  const fit = probeChartOnTemplate({ flexible: 'chart', chartType: 'area' }, template([blocking]), report, { titleText: 'Динамика' })
  assert.equal(fit.status, 'rejected')
})

test('a doughnut gets a centred box with room for the legend', () => {
  const fit = probeChartOnTemplate({ flexible: 'chart', chartType: 'doughnut' }, template(), report, { titleText: 'Доли' })
  assert.equal(fit.status, 'fit')
  const widthPt = fit.box.width * 960
  const heightPt = fit.box.height * 540
  assert.ok(widthPt <= heightPt * 0.84 * 1.35 + 1e-6, 'width bounded by plot side + legend')
  const centre = fit.box.x + fit.box.width / 2
  assert.ok(Math.abs(centre - 0.5) < 0.01, `centred (${centre})`)
})

test('suitable chart kinds follow the data shape', () => {
  const time = suitableChartTypes({ type: 'bar', labels: ['Q1', 'Q2', 'Q3', 'Q4'], values: [1, 2, 3, 4] })
  assert.deepEqual(['bar', 'line', 'area'].every((type) => time.includes(type)), true)
  const shares = suitableChartTypes({ type: 'bar', labels: ['A', 'B', 'C'], values: [50, 30, 20] })
  assert.ok(shares.includes('doughnut') && shares.includes('pie'))
  const plain = suitableChartTypes({ type: 'bar', labels: ['Москва', 'Казань', 'Сочи'], values: [5, 8, 13] })
  assert.deepEqual(plain, ['bar'])
  assert.ok(suitableChartTypes({ type: 'line', labels: ['x', 'y'], values: [1, 2] }).includes('area'))
})

test('numeric cells: ranges and embedded digits are not numbers', () => {
  assert.deepEqual(parseNumericCell('45 мин'), { value: 45, unit: 'мин' })
  assert.deepEqual(parseNumericCell('95%'), { value: 95, unit: '%' })
  assert.equal(parseNumericCell('5–7 ч'), null)
  assert.equal(parseNumericCell('24/7'), null)
  assert.equal(parseNumericCell('высокая'), null)
})

test('metric charts only from same-unit numbers; shares become a doughnut', () => {
  const share = chartFromMetrics([
    { value: '60', unit: '%', description: 'Мобильные' },
    { value: '40', unit: '%', description: 'Десктоп' },
  ])
  assert.equal(share.type, 'doughnut')
  assert.deepEqual(share.values, [60, 40])
  const bar = chartFromMetrics([
    { value: '30', unit: '%', description: 'Конверсия' },
    { value: '12', unit: '%', description: 'Отток' },
  ])
  assert.equal(bar.type, 'bar')
  assert.equal(chartFromMetrics([{ value: '120', unit: '%', description: 'ROI' }, { value: '40', unit: '%', description: 'Рост' }]), null)
  assert.equal(chartFromMetrics([{ value: '3', unit: 'мин', description: 'Сборка' }, { value: '40', unit: '%', description: 'Рост' }]), null)
  assert.equal(chartFromMetrics([{ value: '3', unit: 'мин', description: 'Сборка' }]), null)
})

test('table charts use only numeric rows with a shared unit', () => {
  const grouped = chartFromTable({
    headers: ['Показатель', 'До', 'После'],
    rows: [['Время', '45 мин', '5 мин'], ['Ревизии', '4 мин', '1 мин'], ['Качество', 'среднее', 'высокое']],
  })
  assert.equal(grouped.type, 'bar')
  assert.deepEqual(grouped.labels, ['Время', 'Ревизии'])
  assert.deepEqual(grouped.series.map((item) => item.values), [[45, 4], [5, 1]])
  assert.equal(chartFromTable({ headers: ['A', 'B'], rows: [['x', '5–7 ч']] }), null)
  assert.deepEqual(deriveChartsFromSpec({ charts: [{ type: 'bar' }], metrics: [{ value: 1, unit: '%', description: 'a' }, { value: 2, unit: '%', description: 'b' }] }), [])
})


test('a baseline chart overlapping the placed title is refitted into free space', () => {
  const slide = {
    render: { slide_size_pt: { width: 960, height: 540 }, layers: [] },
    content_elements: [
      { element_id: 'title', kind: 'text', text: 'Заголовок', geometry_norm: { x: 0.05, y: 0.05, width: 0.9, height: 0.15 } },
      { element_id: 'chart', kind: 'chart', chart_type: 'bar', baseline_preview: {}, geometry_norm: { x: 0.05, y: 0.1, width: 0.9, height: 0.8 } },
    ],
  }
  const next = refitChartsClearOfText(report, slide)
  const chart = next.content_elements.find((item) => item.kind === 'chart')
  assert.equal(chart.chart_refit, true)
  assert.ok(chart.geometry_norm.y >= 0.2, `chart moved below the title (${chart.geometry_norm.y})`)
})

test('a chart overlapping the placed title is refitted into free space', () => {
  const slide = {
    render: { slide_size_pt: { width: 960, height: 540 }, layers: [] },
    content_elements: [
      { element_id: 'title', kind: 'text', text: 'Заголовок', geometry_norm: { x: 0.05, y: 0.05, width: 0.9, height: 0.15 } },
      { element_id: 'chart', kind: 'chart', chart_type: 'bar', component_data: {}, geometry_norm: { x: 0.05, y: 0.1, width: 0.9, height: 0.8 } },
    ],
  }
  const next = refitChartsClearOfText(report, slide)
  const chart = next.content_elements.find((item) => item.kind === 'chart')
  assert.equal(chart.chart_refit, true)
  assert.ok(chart.geometry_norm.y >= 0.2, `chart moved below the title (${chart.geometry_norm.y})`)
})

function variant(key, dataBlock, templateId, score) {
  return { key, role: 'alternative', dataBlock, catalogSlide: { slide_number: 1 }, componentId: key, templateId, score }
}

test('a valid chart takes the last slot instead of a weaker text layout', () => {
  const ranked = [
    variant('metrics', 'metrics', 'tmpl_a', 90),
    variant('cards', 'cards', 'tmpl_b', 80),
    variant('text', 'title_text', 'tmpl_c', 20),
    variant('chart', 'charts', 'tmpl_d', -80),
  ]
  assert.deepEqual(selectDiverseVariants(ranked, { limit: 3 }).map((item) => item.key), ['metrics', 'cards', 'chart'])
  assert.deepEqual(selectDiverseVariants(ranked, { limit: 3, ensureChart: false }).map((item) => item.key), ['metrics', 'cards', 'text'])
})

test('a chart on a picked template takes the paragraph slot only as a last resort (round 13)', () => {
  const ranked = [
    variant('metrics', 'metrics', 'tmpl_a', 90),
    variant('cards', 'cards', 'tmpl_b', 80),
    variant('text', 'title_text', 'tmpl_c', 20),
    variant('chart', 'charts', 'tmpl_a', -80),
  ]
  assert.deepEqual(selectDiverseVariants(ranked, { limit: 3 }).map((item) => item.key), ['metrics', 'cards', 'chart'])
  // A chart on the same template as another chart is still a duplicate.
  const twoCharts = [variant('bar', 'charts', 'tmpl_a', 90), variant('text', 'title_text', 'tmpl_c', 20), variant('line', 'charts', 'tmpl_a', -80)]
  assert.deepEqual(selectDiverseVariants(twoCharts, { limit: 3 }).map((item) => item.key), ['bar', 'text'])
})

const outputRoot = new URL('../../../output/', import.meta.url)
function loadDeck(prefix) {
  if (!fs.existsSync(outputRoot)) return null
  const id = fs.readdirSync(outputRoot).find((name) => name.startsWith(prefix)
    && fs.existsSync(new URL(`${name}/presentation.json`, outputRoot)) && fs.existsSync(new URL(`${name}/report.json`, outputRoot)))
  if (!id) return null
  const pres = JSON.parse(fs.readFileSync(new URL(`${id}/presentation.json`, outputRoot), 'utf8'))
  return {
    report: JSON.parse(fs.readFileSync(new URL(`${id}/report.json`, outputRoot), 'utf8')),
    presentation: pres.presentation || pres,
  }
}

test('real deck: chart slides and numeric table/metric slides show a chart', async (t) => {
  const deck = loadDeck('1974')
  if (!deck) return t.skip('deck 1974 not available')
  const { extractDesignTokens } = await import('../constructor/tokens.js')
  const { buildScenarioSlide } = await import('./build-slide.js')
  const { createCoverageContext, recordDisplayedVariants } = await import('./component-coverage.js')
  const tokens = extractDesignTokens(deck.report)
  const ctx = createCoverageContext(deck.report)
  const slides = deck.presentation.slides
  const shown = {}
  for (const [index, slide] of slides.entries()) {
    const res = buildScenarioSlide(deck.report, { ...slide }, tokens, {
      selectionContext: ctx,
      seed: `${deck.presentation.title || 'presentation'}|${slide.index ?? index + 1}|${slide.intent || ''}`,
      position: index,
      totalSlides: slides.length,
    })
    const variants = res.previewVariants.slice(0, 3)
    recordDisplayedVariants(ctx, variants)
    shown[index + 1] = variants.map((item) => item.dataBlock)
  }
  for (const slideNo of [2, 5, 9]) {
    assert.equal(shown[slideNo].length, 3)
    assert.ok(shown[slideNo].includes('charts'), `slide ${slideNo}: ${shown[slideNo].join('|')}`)
  }
})

test('a synthetic title whose frame runs onto a template picture is rejected', async () => {
  const { detectLayoutIssues } = await import('./slide-hit-test.js')
  const photo = { kind: 'image', layer_id: 'layout_pic_2', geometry_norm: { x: 0.44, y: 0, width: 0.56, height: 1 } }
  const titleEl = (width) => ({
    element_id: 'synthetic_slide_title_1', kind: 'text', synthetic: true, placeholder_type: 'title', vertical_anchor: 't',
    text: 'Динамика использования Flow',
    geometry_norm: { x: 0.054, y: 0.1, width, height: 0.2 },
    typography: { size_pt: 40, family: 'Arial', alignment: 'l', color: '#000000' },
  })
  const slideOf = (width) => ({ render: { slide_size_pt: { width: 960, height: 540 }, layers: [photo] }, content_elements: [titleEl(width)] })
  const over = detectLayoutIssues(report, slideOf(0.51), { titleIds: ['synthetic_slide_title_1'] })
  assert.ok(over.issues.some((issue) => issue.code === 'title_over_layer'), JSON.stringify(over.issues))
  const clear = detectLayoutIssues(report, slideOf(0.36), { titleIds: ['synthetic_slide_title_1'] })
  assert.equal(clear.issues.some((issue) => issue.code === 'title_over_layer'), false)
})

test('series colours that vanish on the slide surface move to the back of the palette', async () => {
  const { contrastingPalette } = await import('./materialize-chart-styles.js')
  assert.deepEqual(contrastingPalette(['#0077FF', '#262626', '#FDE53C'], '#0077FF'), ['#262626', '#FDE53C', '#0077FF'])
  assert.deepEqual(contrastingPalette(['#0077FF', '#262626'], '#FFFFFF'), ['#0077FF', '#262626'])
  assert.deepEqual(contrastingPalette(['#0077FF'], null), ['#0077FF'])
})
