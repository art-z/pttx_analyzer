import test from 'node:test'
import assert from 'node:assert/strict'

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  applyMetricsToLayout,
  computeMetricPreviewBBox,
  computeMetricRepeatRowCapacity,
  estimateMetricTextLines,
  metricLayoutMaxItems,
  METRIC_ROW_MIN_SCALE,
} from './metric-render.js'
import { listMetricLayoutCatalog } from './metric-catalog.js'
import { METRIC_PATTERNS } from '../slides/metric-detect.js'

function metricFixture(pattern = METRIC_PATTERNS.hero) {
  const value = {
    kind: 'text',
    element_id: 'value',
    text: '43%',
    text_sample: '43%',
    text_runs: [
      { text: '43', paragraph_index: 0 },
      { text: '%', paragraph_index: 0 },
    ],
    typography: { size_pt: 48 },
    geometry_pt: { x_pt: 100, y_pt: 150, width_pt: 110, height_pt: 60 },
    geometry_norm: { x: 0.104, y: 0.278, width: 0.115, height: 0.111 },
    metric: {
      value: '43',
      unit: '%',
      value_typography: { size_pt: 48 },
      unit_typography: { size_pt: 20 },
    },
  }
  const caption = {
    kind: 'text',
    element_id: 'caption',
    text: 'Показатель',
    text_sample: 'Показатель',
    typography: { size_pt: 16 },
    geometry_pt: { x_pt: 100, y_pt: 220, width_pt: 150, height_pt: 30 },
    geometry_norm: { x: 0.104, y: 0.407, width: 0.156, height: 0.056 },
  }
  const hero = {
    vgroup_id: 'hero',
    element_ids: ['value', 'caption'],
    pair: {
      valueElementId: 'value',
      captionElementId: 'caption',
    },
    container_norm: { x: 0.1, y: 0.27, width: 0.18, height: 0.2 },
  }
  const slide = {
    slide_number: 1,
    render: { slide_size_pt: { width: 960, height: 540 } },
    content_elements: [value, caption],
  }
  const layout = {
    pattern,
    slide_number: 1,
    vgroup_id: 'hero',
    element_ids: hero.element_ids,
    container_norm: hero.container_norm,
    item_capacity: 1,
    capacity_visible: 1,
    capacity_expandable: 3,
    hero_region: hero,
    metric_slots: [hero],
  }
  return {
    report: { slides: { slides: [slide] } },
    layout,
  }
}

test('hero flex assembly wires cloned value/caption stacks with translated ids', () => {
  const { report, layout } = metricFixture()
  const slide = applyMetricsToLayout(report, layout, [
    { title: '91%', text: 'Первый' },
    { title: '72%', text: 'Второй' },
  ], { flexAssembly: true })

  assert.ok(slide)
  const values = slide.content_elements.filter((element) => element.element_id.startsWith('value__metric_'))
  const captions = slide.content_elements.filter((element) => element.element_id.startsWith('caption__metric_'))
  assert.equal(values.length, 2)
  assert.equal(captions.length, 2)
  assert.ok(values.every((element) => element.text_group_id))
  assert.deepEqual(
    values.map((element) => element.text_group_id),
    captions.map((element) => element.text_group_id),
  )
  assert.deepEqual(values.map((element) => element.metric.value), ['91', '72'])
  assert.deepEqual(values.map((element) => element.metric.unit), ['%', '%'])

  const bbox = computeMetricPreviewBBox(slide)
  assert.ok(bbox.bboxPt.width_pt > 250)
  assert.ok(bbox.bboxNorm.width > layout.container_norm.width)
})

test('metric rendering replaces export value and unit metadata', () => {
  const { report, layout } = metricFixture()
  const slide = applyMetricsToLayout(report, layout, [
    {
      value: '6',
      unit: 'нед',
      description: 'средний срок подготовки одной презентации вручную',
    },
  ])
  const valueElement = slide.content_elements.find((element) => element.element_id === 'value')

  assert.equal(valueElement.text, '6 нед')
  assert.equal(valueElement.metric.value, '6')
  assert.equal(valueElement.metric.unit, 'нед')
  assert.deepEqual(valueElement.text_runs.map((run) => run.text), ['6', ' нед'])
  assert.equal(valueElement.metric.value_typography.size_pt, 48)
  assert.equal(valueElement.metric.unit_typography.size_pt, 20)
})

test('expanded split renders every metric instead of overwriting hero text', () => {
  const { report, layout } = metricFixture(METRIC_PATTERNS.split)
  layout.secondary_region = {
    element_ids: ['secondary'],
    container_norm: { x: 0.4, y: 0.27, width: 0.3, height: 0.2 },
  }

  const slide = applyMetricsToLayout(report, layout, [
    { title: '91%', text: 'Первый' },
    { title: '72%', text: 'Второй' },
  ], { expanded: true })

  const texts = slide.content_elements.map((element) => element.text)
  assert.ok(texts.includes('91%'))
  assert.ok(texts.includes('72%'))
})

test('renderer drops incomplete metrics and caps multiplication at layout capacity', () => {
  const { report, layout } = metricFixture()
  layout.capacity_expandable = 2
  // Wide items: a third one would need a scale below METRIC_ROW_MIN_SCALE.
  for (const element of report.slides.slides[0].content_elements) {
    element.geometry_pt.width_pt = 500
    element.geometry_norm.width = 500 / 960
  }
  const metrics = [
    { title: '91%', text: 'Первый' },
    { title: '72', text: '' },
    { value: '43', unit: '%', description: 'Третий' },
    { title: '15%', text: 'Сверх ёмкости' },
  ]
  assert.equal(metricLayoutMaxItems(report, layout, { expanded: true }), 2)
  // Contract: three valid metrics do not fit two slots, so the layout is rejected...
  assert.equal(applyMetricsToLayout(report, layout, metrics, { flexAssembly: true, expanded: true }), null)
  // ...unless a partial render is explicitly allowed.
  const slide = applyMetricsToLayout(report, layout, metrics, { flexAssembly: true, expanded: true, allowPartial: true })

  const values = slide.content_elements
    .filter((element) => element.element_id.startsWith('value__metric_'))
    .map((element) => element.text)
  assert.deepEqual(values, ['91%', '43%'])
})

test('expanded repeat clones the complete value+unit+description atom beyond visible slots', () => {
  const { report, layout } = metricFixture(METRIC_PATTERNS.repeat)
  const sourceSlide = report.slides.slides[0]
  const secondValue = JSON.parse(JSON.stringify(sourceSlide.content_elements[0]))
  const secondCaption = JSON.parse(JSON.stringify(sourceSlide.content_elements[1]))
  secondValue.element_id = 'value2'
  secondValue.geometry_pt.x_pt = 320
  secondValue.geometry_norm.x = 320 / 960
  secondCaption.element_id = 'caption2'
  secondCaption.geometry_pt.x_pt = 320
  secondCaption.geometry_norm.x = 320 / 960
  sourceSlide.content_elements.push(secondValue, secondCaption)

  layout.metric_slots = [
    layout.hero_region,
    {
      vgroup_id: 'metric2',
      element_ids: ['value2', 'caption2'],
      pair: { valueElementId: 'value2', captionElementId: 'caption2' },
      container_norm: { x: 320 / 960, y: 0.27, width: 0.18, height: 0.2 },
    },
  ]
  layout.item_capacity = 2
  layout.capacity_visible = 2
  layout.capacity_expandable = computeMetricRepeatRowCapacity(sourceSlide, layout)

  assert.ok(layout.capacity_expandable >= 3)
  const slide = applyMetricsToLayout(report, layout, [
    { title: '91%', text: 'Первый' },
    { title: '72%', text: 'Второй' },
    { title: '43%', text: 'Третий' },
  ], { flexAssembly: true, expanded: true })

  const generatedValues = slide.content_elements.filter((element) => (
    element.element_id.startsWith('value') && element.element_id.includes('__metric_')
  ))
  const generatedCaptions = slide.content_elements.filter((element) => (
    element.element_id.startsWith('caption') && element.element_id.includes('__metric_')
  ))
  assert.equal(generatedValues.length, 3)
  assert.equal(generatedCaptions.length, 3)
  assert.ok(generatedValues.every((element) => element.text_group_id))
})

test('unit-free source layout folds supplied units into combined value display', () => {
  const { report, layout } = metricFixture()
  layout.unit_mode = 'none'

  assert.ok(applyMetricsToLayout(report, layout, [
    { value: '7', unit: '', description: 'Количество' },
  ], { flexAssembly: true }))
  const slide = applyMetricsToLayout(report, layout, [
    { value: '7', unit: '%', description: 'Доля' },
  ], { flexAssembly: true })
  assert.ok(slide)
  assert.ok(slide.content_elements.some((element) => element.text === '7%'))
})

const MODEL_METRICS_WITH_UNITS = [
  { value: '90', unit: '%', description: 'сокращение времени' },
  { value: '100', unit: '%', description: 'соответствие фирменному стилю' },
  { value: '25', unit: 'мин', description: 'экономия времени на правки' },
]

test('model metrics with a separate unit render value, unit and description on a hero', () => {
  const { report, layout } = metricFixture()
  // The non-flex hero shows one metric; without allowPartial the contract
  // rejects it for three metrics.
  assert.equal(applyMetricsToLayout(report, layout, MODEL_METRICS_WITH_UNITS), null)
  const slide = applyMetricsToLayout(report, layout, MODEL_METRICS_WITH_UNITS, { allowPartial: true })
  assert.deepEqual(slide.metric_contract, { requested: 3, rendered: 1, placeholders_cleared: 0 })
  const value = slide.content_elements.find((element) => element.element_id === 'value')
  const caption = slide.content_elements.find((element) => element.element_id === 'caption')

  assert.equal(value.text, '90%')
  assert.deepEqual(value.text_runs.map((run) => run.text), ['90', '%'])
  assert.equal(value.metric.value, '90')
  assert.equal(value.metric.unit, '%')
  assert.equal(caption.text, 'сокращение времени')
})

test('model metrics with a separate unit render every value and unit in a flex assembly', () => {
  const { report, layout } = metricFixture()
  const slide = applyMetricsToLayout(report, layout, MODEL_METRICS_WITH_UNITS, { flexAssembly: true })
  const values = slide.content_elements.filter((element) => element.element_id.startsWith('value__metric_'))
  const captions = slide.content_elements.filter((element) => element.element_id.startsWith('caption__metric_'))

  assert.deepEqual(values.map((element) => element.text), ['90%', '100%', '25 мин'])
  assert.deepEqual(values.map((element) => element.text_runs.map((run) => run.text)), [
    ['90', '%'],
    ['100', '%'],
    ['25', ' мин'],
  ])
  assert.deepEqual(values.map((element) => [element.metric.value, element.metric.unit]), [
    ['90', '%'],
    ['100', '%'],
    ['25', 'мин'],
  ])
  assert.deepEqual(captions.map((element) => element.text), MODEL_METRICS_WITH_UNITS.map((item) => item.description))
})

test('a single-run metric template keeps the unit in its only run', () => {
  const { report, layout } = metricFixture()
  const templateValue = report.slides.slides[0].content_elements[0]
  templateValue.text_runs = [{ text: '43%', paragraph_index: 0 }]
  const slide = applyMetricsToLayout(report, layout, [MODEL_METRICS_WITH_UNITS[2]])
  const value = slide.content_elements.find((element) => element.element_id === 'value')

  assert.deepEqual(value.text_runs.map((run) => run.text), ['25 мин'])
  assert.equal(value.metric.unit, 'мин')
})

// ---- Metric contract ------------------------------------------------------

function textOf(slide) {
  return (slide.content_elements || [])
    .filter((element) => element.kind === 'text' && String(element.text || '').trim())
    .map((element) => String(element.text).replace(/\u00a0/g, ' '))
}

function twoSlotRepeatFixture() {
  const { report, layout } = metricFixture(METRIC_PATTERNS.repeat)
  const sourceSlide = report.slides.slides[0]
  const secondValue = JSON.parse(JSON.stringify(sourceSlide.content_elements[0]))
  const secondCaption = JSON.parse(JSON.stringify(sourceSlide.content_elements[1]))
  secondValue.element_id = 'value2'
  secondValue.geometry_pt.x_pt = 320
  secondValue.geometry_norm.x = 320 / 960
  secondCaption.element_id = 'caption2'
  secondCaption.geometry_pt.x_pt = 320
  secondCaption.geometry_norm.x = 320 / 960
  sourceSlide.content_elements.push(secondValue, secondCaption)
  layout.detection_method = 'vgroup_metric_flex_row'
  layout.metric_slots = [
    layout.hero_region,
    {
      vgroup_id: 'metric2',
      element_ids: ['value2', 'caption2'],
      pair: { valueElementId: 'value2', captionElementId: 'caption2' },
      container_norm: { x: 320 / 960, y: 0.27, width: 0.18, height: 0.2 },
    },
  ]
  layout.item_capacity = 2
  layout.capacity_visible = 2
  layout.capacity_expandable = 2
  return { report, layout }
}

test('metric contract: every metric shows value+unit and description in one adapter', () => {
  const { report, layout } = metricFixture()
  const metrics = [
    { value: '30', unit: '%', description: 'время на поиск шаблонов' },
    { value: '25', unit: '%', description: 'потери времени' },
    { value: '15', unit: '%', description: 'снижение удовлетворенности' },
  ]
  const slide = applyMetricsToLayout(report, layout, metrics, { flexAssembly: true, expanded: true })
  assert.ok(slide)
  assert.deepEqual(slide.metric_contract, { requested: 3, rendered: 3, placeholders_cleared: 0 })
  const texts = textOf(slide)
  for (const metric of metrics) {
    assert.ok(texts.includes(`${metric.value}${metric.unit}`), metric.value)
    assert.ok(texts.includes(metric.description), metric.description)
  }
  assert.ok(!texts.some((text) => text === '43%' || text === 'Показатель'))
})

test('metric contract: unused template slots are hidden, no placeholder text is left', () => {
  const { report, layout } = twoSlotRepeatFixture()
  const slide = applyMetricsToLayout(report, layout, [
    { value: '30', unit: '%', description: 'время на поиск шаблонов' },
  ])
  assert.ok(slide)
  const texts = textOf(slide)
  assert.deepEqual(texts.sort(), ['30%', 'время на поиск шаблонов'].sort())
  assert.equal(slide.metric_contract.rendered, 1)
  assert.equal(slide.metric_contract.placeholders_cleared, 2)
})

test('metric contract: extra text in a slot gets the optional label or is cleared', () => {
  const build = (metric) => {
    const { report, layout } = metricFixture()
    const extra = {
      kind: 'text',
      element_id: 'badge',
      text: 'Новинка',
      text_sample: 'Новинка',
      typography: { size_pt: 10 },
      geometry_pt: { x_pt: 100, y_pt: 130, width_pt: 80, height_pt: 16 },
      geometry_norm: { x: 100 / 960, y: 130 / 540, width: 80 / 960, height: 16 / 540 },
    }
    report.slides.slides[0].content_elements.push(extra)
    layout.hero_region.element_ids.push('badge')
    return applyMetricsToLayout(report, layout, [metric], { flexAssembly: true })
  }
  const withoutLabel = build({ value: '30', unit: '%', description: 'время' })
  assert.ok(!textOf(withoutLabel).includes('Новинка'))
  const withLabel = build({ value: '30', unit: '%', description: 'время', label: 'Поиск' })
  assert.ok(textOf(withLabel).includes('Поиск'))
  assert.ok(!textOf(withLabel).includes('Новинка'))
})

test('metric contract: captions grow to their lines, long values shrink to one line', () => {
  const { report, layout } = metricFixture()
  const description = 'время, затрачиваемое на поиск и корректировку шаблонов в отделах'
  const slide = applyMetricsToLayout(report, layout, [
    { value: '1250000', unit: '₽', description },
  ], { flexAssembly: true })
  const caption = slide.content_elements.find((element) => element.text === description)
  const lines = estimateMetricTextLines(description, caption.geometry_pt.width_pt, caption.typography.size_pt)
  assert.ok(caption.geometry_pt.height_pt >= lines * caption.typography.size_pt * 1.15 - 0.01)
  const value = slide.content_elements.find((element) => element.metric?.value === '1250000')
  assert.ok(value.typography.size_pt < 48)
  assert.ok(value.typography.size_pt >= 48 * 0.55 - 0.01)
})

test('metric contract: a split/hero row shrinks items to fit instead of dropping metrics', () => {
  const { report, layout } = metricFixture(METRIC_PATTERNS.split)
  for (const element of report.slides.slides[0].content_elements) {
    element.geometry_pt.width_pt = 300
    element.geometry_norm.width = 300 / 960
  }
  layout.capacity_expandable = 2
  assert.ok(metricLayoutMaxItems(report, layout, { expanded: true }) >= 3)
  const slide = applyMetricsToLayout(report, layout, MODEL_METRICS_WITH_UNITS, { flexAssembly: true, expanded: true })
  assert.ok(slide)
  const values = slide.content_elements.filter((element) => element.element_id.startsWith('value__metric_'))
  assert.equal(values.length, 3)
  const right = Math.max(...slide.content_elements.map((element) => element.geometry_pt.x_pt + element.geometry_pt.width_pt))
  assert.ok(right <= 960 * 0.98 + 0.5)
  assert.ok(values.every((element) => element.typography.size_pt < 48 && element.typography.size_pt >= 48 * METRIC_ROW_MIN_SCALE - 0.01))
})

function loadDeckReport(id) {
  const file = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../output', id, 'report.json')
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null
}

test('metric contract: slide-23 combo renders all metrics or is rejected, never partial with placeholders', () => {
  const report = loadDeckReport('f617017d34a7')
  if (!report) return
  const combo = listMetricLayoutCatalog(report).layouts
    .find((layout) => layout.slide_number === 23 && String(layout.pattern).includes('combo'))
  if (!combo) return
  const metrics = [
    { value: '30', unit: '%', description: 'время на поиск шаблонов' },
    { value: '25', unit: '%', description: 'потери из-за дизайна' },
    { value: '15', unit: '%', description: 'снижение удовлетворенности' },
  ]
  for (const flexAssembly of [true, false]) {
    const slide = applyMetricsToLayout(report, combo, metrics, { flexAssembly })
    assert.ok(slide, `flex=${flexAssembly}`)
    assert.equal(slide.metric_contract.rendered, 3)
    const texts = textOf(slide)
    assert.ok(!texts.some((text) => /Описание|^[5-8]$/.test(text)), texts.join(' | '))
  }
  // A repeat part that cannot be resolved leaves only the hero: rejected.
  const broken = {
    ...combo,
    repeat_component_id: null,
    repeat_instance: null,
    repeat: null,
    repeat_region: { ...(combo.repeat_region || {}), vgroup_id: 'g9.9' },
  }
  assert.equal(applyMetricsToLayout(report, broken, metrics, { flexAssembly: false }), null)
  const partial = applyMetricsToLayout(report, broken, metrics, { flexAssembly: false, allowPartial: true })
  assert.ok(partial)
  assert.ok(partial.metric_contract.rendered < 3)
  assert.ok(!textOf(partial).some((text) => /Описание/.test(text)), textOf(partial).join(' | '))
})
