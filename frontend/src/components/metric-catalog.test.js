import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { listAllComponents, listComponentGroups } from './catalog.js'
import { defaultMetricModel, listMetricComponents, listMetricLayoutCatalog } from './metric-catalog.js'
import { buildComponentSlideView } from './render.js'
import { applyMetricsToLayout } from './metric-render.js'
import { METRIC_PATTERNS } from '../slides/metric-detect.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const spatialReportPath = path.resolve(__dirname, '../../../output/163b2add7d59/report.json')
const verticalMetricReportPath = path.resolve(__dirname, '../../../output/2daf9bc11086/report.json')

test('listMetricComponents collapses placements into visual KPI styles', () => {
  if (!fs.existsSync(spatialReportPath)) return

  const report = JSON.parse(fs.readFileSync(spatialReportPath, 'utf8'))
  const components = listMetricComponents(report)

  assert.equal(components.length, 3)
  assert.ok(components.every((item) => item.component_id.startsWith('metric_style_')))
  assert.ok(components.every((item) => item.instances.length === 1))
  assert.ok(components.every((item) => item.placement?.layout))
  assert.ok(components.every((item) => item.style_profile?.value?.size_pt))
  assert.ok(components.every((item) => item.frequency.instance_count === 1))
  assert.equal(
    components.reduce((sum, item) => sum + item.behavior.detected_placement_count, 0),
    15,
  )
  assert.ok(!components.some((item) => item.placement.slide_number === 46))
  const unitFree = components.find((item) => item.style_profile.unit_present === false)
  const withUnits = components.find((item) => item.style_profile.unit_present === true)
  assert.ok(unitFree)
  assert.ok(withUnits)
  assert.ok(defaultMetricModel(unitFree, unitFree.instances[0]).metrics.every((metric) => metric.unit === ''))
  assert.ok(defaultMetricModel(withUnits, withUnits.instances[0]).metrics.every((metric) => metric.unit))
  assert.deepEqual(
    Object.keys(defaultMetricModel(withUnits, withUnits.instances[0]).metrics[0]).sort(),
    ['description', 'unit', 'value'],
  )
})

test('listAllComponents exposes metrics tab without singleton metric_card duplicate', () => {
  if (!fs.existsSync(spatialReportPath)) return

  const report = JSON.parse(fs.readFileSync(spatialReportPath, 'utf8'))
  const all = listAllComponents(report)
  const metrics = all.filter((item) => item.group === 'metrics')
  const groups = listComponentGroups(report, all)

  assert.equal(metrics.length, 3)
  assert.ok(!all.some((item) => item.id === 'sing_metric_001'))
  assert.equal(groups.find((item) => item.id === 'metrics')?.count, metrics.length)
})

test('canonical KPI component can multiply with the slider model', () => {
  if (!fs.existsSync(spatialReportPath)) return

  const report = JSON.parse(fs.readFileSync(spatialReportPath, 'utf8'))
  const metricComponent = listMetricComponents(report).find((item) => (
    item.capacity.item_count_max > item.placement.capacity_visible
    && item.placement.capacity_visible === 1
  ))
  assert.ok(metricComponent)
  assert.ok(metricComponent.capacity.item_count_max >= 2)

  const model = {
    metrics: [
      { title: '91%', text: 'Первый' },
      { title: '72%', text: 'Второй' },
    ],
  }
  const view = buildComponentSlideView(report, metricComponent, { instanceIndex: 0, modelData: model })
  assert.ok(view.slide)
  const base = metricComponent.container_norm || {}
  const grewHorizontally = view.bboxNorm.width > base.width * 1.5
  const grewVertically = view.bboxNorm.height > base.height * 1.5
  assert.ok(grewHorizontally || grewVertically)
  assert.ok((view.slide.content_elements || []).some((element) => String(element.element_id).includes('__metric_2')))
})

test('flexAssembly preview keeps only KPI elements and wires flex stacks', () => {
  if (!fs.existsSync(spatialReportPath)) return

  const report = JSON.parse(fs.readFileSync(spatialReportPath, 'utf8'))
  const hero = listAllComponents(report).find((item) => (
    item.group === 'metrics'
    && item.pattern === METRIC_PATTERNS.hero
    && item.placement?.layout?.hero_region?.pair?.valueElementId
    && item.placement?.layout?.hero_region?.pair?.captionElementId
  ))
  assert.ok(hero)

  const view = buildComponentSlideView(report, hero, { instanceIndex: 0 })
  assert.ok(view.slide)
  const elementIds = (view.slide.content_elements || []).map((element) => element.element_id)
  assert.ok(!elementIds.some((id) => id.includes('inferred_table')))
  assert.ok((view.slide.content_elements || []).some((element) => element.text_group_id))

  const split = listMetricLayoutCatalog(report).layouts.find((item) => item.pattern === METRIC_PATTERNS.split)
  const flexSlide = applyMetricsToLayout(
    report,
    split,
    [{ title: '91%', text: 'Первый' }],
    { flexAssembly: true },
  )
  assert.ok(flexSlide)
  assert.ok((flexSlide.content_elements || []).every((element) => element.kind === 'text'))
})

test('metric catalog excludes peripheral one-off chart annotations', () => {
  if (!fs.existsSync(spatialReportPath)) return

  const report = JSON.parse(fs.readFileSync(spatialReportPath, 'utf8'))
  const layouts = listMetricLayoutCatalog(report).layouts

  assert.ok(!layouts.some((layout) => (
    layout.slide_number === 46
    && layout.capacity_expandable === 1
    && layout.container_norm?.x >= 0.7
  )))
})

test('vertical contents metrics stay a five-item column instead of a duplicated six-item combo', () => {
  if (!fs.existsSync(verticalMetricReportPath)) return

  const report = JSON.parse(fs.readFileSync(verticalMetricReportPath, 'utf8'))
  const component = listMetricComponents(report).find((item) => item.placement.slide_number === 2)

  assert.ok(component)
  assert.equal(component.pattern, METRIC_PATTERNS.repeat)
  assert.equal(component.layout, 'column')
  assert.equal(component.capacity.item_count_known, 5)
  assert.equal(component.capacity.item_count_max, 5)
  assert.equal(component.placement.layout.metric_slots.length, 5)
  assert.ok(!listMetricLayoutCatalog(report).layouts.some((layout) => (
    layout.slide_number === 2 && layout.pattern === METRIC_PATTERNS.combo
  )))

  const model = defaultMetricModel(component, component.instances[0])
  const view = buildComponentSlideView(report, component, { instanceIndex: 0, modelData: model })
  const values = view.slide.content_elements.filter((element) => (
    String(element.element_id).includes('slide_text_10')
    && (element.typography?.size_pt || 0) === 40
  ))
  assert.equal(model.metrics.length, 5)
  assert.equal(values.length, 5)
  assert.ok(values.every((element) => (
    element.text_group_spacing_pt?.flex_stack_direction === 'row'
  )))
  assert.ok(values.every((element) => (
    element.text_group_spacing_pt?.flex_stack_align_items === 'center'
  )))
  assert.ok(values.every((element, index) => (
    index === 0 || element.geometry_norm.y > values[index - 1].geometry_norm.y
  )))
})
