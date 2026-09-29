import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { extractMetricPair, detectSlideMetricLayouts, METRIC_PATTERNS } from './metric-detect.js'
import { collectRepeatElementIds } from './slide-decomposition.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const spatialReportPath = path.resolve(__dirname, '../../../output/163b2add7d59/report.json')
const legacyReportPath = path.resolve(__dirname, '../../../output/b13e9370de41/report.json')

test('extractMetricPair accepts large value with caption', () => {
  const pair = extractMetricPair([
    { kind: 'text', element_id: 'a', typography: { size_pt: 88 }, text: '43%' },
    { kind: 'text', element_id: 'b', typography: { size_pt: 16 }, text: 'Описание показателя' },
  ])
  assert.ok(pair)
  assert.equal(pair.valueElementId, 'a')
  assert.equal(pair.captionElementId, 'b')
})

test('extractMetricPair rejects a bare timeline year without metric semantics', () => {
  const pair = extractMetricPair([
    { kind: 'text', element_id: 'y', typography: { size_pt: 32 }, text: '2010' },
    { kind: 'text', element_id: 'c', typography: { size_pt: 16 }, text: 'Событие компании' },
  ])
  assert.equal(pair, null)
})

test('extractMetricPair accepts a large bare number with caption but requires the caption', () => {
  const bareNumber = extractMetricPair([
    { kind: 'text', element_id: 'value', typography: { size_pt: 88 }, text: '43' },
    { kind: 'text', element_id: 'caption', typography: { size_pt: 16 }, text: 'Рост' },
  ])
  assert.equal(bareNumber?.valueElementId, 'value')
  assert.equal(bareNumber?.captionElementId, 'caption')
  assert.equal(extractMetricPair([
    { kind: 'text', element_id: 'value', typography: { size_pt: 88 }, text: '43%' },
  ]), null)
})

test('extractMetricPair uses structured metric signal with equal-size caption', () => {
  const pair = extractMetricPair([
    {
      kind: 'text',
      element_id: 'value',
      typography: { size_pt: 20 },
      text: '43%',
      metric: { value: '43', unit: '%' },
      geometry_norm: { x: 0.1, y: 0.2, width: 0.1, height: 0.05 },
    },
    {
      kind: 'text',
      element_id: 'caption',
      typography: { size_pt: 20 },
      text: 'Рост',
      geometry_norm: { x: 0.1, y: 0.26, width: 0.1, height: 0.05 },
    },
  ])
  assert.deepEqual(pair, {
    valueElementId: 'value',
    captionElementId: 'caption',
    valueRole: 'heading',
    captionRole: 'body',
    unitPresent: true,
    unitSample: '%',
  })
})

test('extractMetricPair selects the geometrically closest caption instead of second-largest text', () => {
  const pair = extractMetricPair([
    {
      kind: 'text',
      element_id: 'value',
      typography: { size_pt: 48 },
      text: '91%',
      geometry_norm: { x: 0.1, y: 0.2, width: 0.1, height: 0.08 },
    },
    {
      kind: 'text',
      element_id: 'unrelated',
      typography: { size_pt: 24 },
      text: 'Большой посторонний текст',
      geometry_norm: { x: 0.7, y: 0.7, width: 0.2, height: 0.08 },
    },
    {
      kind: 'text',
      element_id: 'caption',
      typography: { size_pt: 16 },
      text: 'Удовлетворённость',
      geometry_norm: { x: 0.1, y: 0.29, width: 0.18, height: 0.05 },
    },
  ])
  assert.equal(pair?.captionElementId, 'caption')
})

test('repeat metric slots are partitioned by geometry, not source array order', () => {
  const value1 = {
    kind: 'text',
    element_id: 'v1',
    text: '91%',
    typography: { size_pt: 42 },
    geometry_norm: { x: 0.1, y: 0.3, width: 0.12, height: 0.08 },
  }
  const caption1 = {
    kind: 'text',
    element_id: 'c1',
    text: 'Первый',
    typography: { size_pt: 16 },
    geometry_norm: { x: 0.1, y: 0.39, width: 0.12, height: 0.05 },
  }
  const value2 = {
    kind: 'text',
    element_id: 'v2',
    text: '72%',
    typography: { size_pt: 42 },
    geometry_norm: { x: 0.55, y: 0.3, width: 0.12, height: 0.08 },
  }
  const caption2 = {
    kind: 'text',
    element_id: 'c2',
    text: 'Второй',
    typography: { size_pt: 16 },
    geometry_norm: { x: 0.55, y: 0.39, width: 0.12, height: 0.05 },
  }
  const shuffled = [value1, value2, caption1, caption2]
  const slide = {
    slide_number: 1,
    content_elements: shuffled,
  }
  const group = {
    id: 'repeat',
    layout: 'row',
    bboxNorm: { x: 0.1, y: 0.3, width: 0.57, height: 0.14 },
    partition: { axis: 'x' },
    repeat: { count: 2 },
    elements: shuffled,
  }

  const result = detectSlideMetricLayouts(slide, {}, {
    vgroupResult: { groups: [group] },
    titleResult: { elementIds: [] },
    singletonResult: { singletons: [] },
  })
  const repeat = result.layouts.find((layout) => layout.detection_method === 'vgroup_metric_repeat')
  assert.ok(repeat)
  assert.deepEqual(repeat.metric_slots.map((slot) => slot.pair.valueElementId), ['v1', 'v2'])
  assert.ok(repeat.metric_slots[0].container_norm.x < repeat.metric_slots[1].container_norm.x)
})

test('detectSlideMetricLayouts finds hero, repeat and combo on slide 18', () => {
  if (!fs.existsSync(legacyReportPath)) return

  const report = JSON.parse(fs.readFileSync(legacyReportPath, 'utf8'))
  const slide = report.slides.slides.find((item) => item.slide_number === 18)
  const repeatElementIds = collectRepeatElementIds(report, 18)
  const { layouts } = detectSlideMetricLayouts(slide, report, { repeatElementIds })

  assert.ok(layouts.some((item) => item.pattern === METRIC_PATTERNS.hero))
  assert.ok(layouts.some((item) => item.pattern === METRIC_PATTERNS.repeat))
  assert.ok(layouts.some((item) => item.pattern === METRIC_PATTERNS.combo))
})

test('detectSlideMetricLayouts finds hero + pseudo-table split on slide 33', () => {
  if (!fs.existsSync(spatialReportPath)) return

  const report = JSON.parse(fs.readFileSync(spatialReportPath, 'utf8'))
  const slide = report.slides.slides.find((item) => item.slide_number === 33)
  const { layouts } = detectSlideMetricLayouts(slide, report)

  assert.ok(layouts.some((item) => item.pattern === METRIC_PATTERNS.hero))
  const split = layouts.find((item) => item.pattern === METRIC_PATTERNS.split)
  assert.ok(split)
  assert.equal(split.capacity_visible, 1)
  assert.equal(split.capacity_expandable, 2)
  assert.equal(split.secondary_region?.kind, 'pseudo_table')
})

test('detectSlideMetricLayouts treats a large numeric flex row as unit-free KPI', () => {
  if (!fs.existsSync(spatialReportPath)) return

  const report = JSON.parse(fs.readFileSync(spatialReportPath, 'utf8'))
  const slide = report.slides.slides.find((item) => item.slide_number === 42)
  const { layouts } = detectSlideMetricLayouts(slide, report)
  const repeatLayouts = layouts.filter((item) => item.pattern === METRIC_PATTERNS.repeat)

  assert.equal(repeatLayouts.length, 1)
  assert.equal(repeatLayouts[0].detection_method, 'vgroup_metric_flex_row')
  assert.equal(repeatLayouts[0].item_capacity, 2)
  assert.equal(repeatLayouts[0].unit_mode, 'none')
  assert.equal(repeatLayouts[0].has_units, false)
  assert.ok(!layouts.some((item) => item.pattern === METRIC_PATTERNS.split))
  assert.ok(!layouts.some((item) => item.pattern === METRIC_PATTERNS.combo))
})

test('detectSlideMetricLayouts finds repeat KPI row on slide 42 timeline (legacy deck)', () => {
  if (!fs.existsSync(legacyReportPath)) return

  const report = JSON.parse(fs.readFileSync(legacyReportPath, 'utf8'))
  const slide = report.slides.slides.find((item) => item.slide_number === 42)
  const repeatElementIds = collectRepeatElementIds(report, 42)
  const { layouts } = detectSlideMetricLayouts(slide, report, { repeatElementIds })
  const repeatLayouts = layouts.filter((item) => item.pattern === METRIC_PATTERNS.repeat)

  assert.ok(repeatLayouts.length >= 1)
  assert.ok(repeatLayouts.some((item) => item.item_capacity >= 4))
})
