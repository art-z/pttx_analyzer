import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { listAllComponents, resolveComponentPreviewContext } from './catalog.js'
import {
  buildContainerCapacity,
  buildContainerCapacityForInstance,
  defaultContainerModel,
  getPlaygroundInstanceBBox,
  hasRepeatTextSlots,
  isIterableRepeatComponent,
  resolveRepeatPlaygroundAnchor,
  resizeContainerModel,
  splitInstanceIntoItems,
} from './container-catalog.js'
import { buildContainerRepeatPreviewSlide, normalizeRepeatModelForRender } from './container-render.js'
import { buildComponentSlideView } from './render.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const sampleReportPath = path.resolve(__dirname, '../../../output/4bbeea9db0ad/report.json')
const freeformReportPath = path.resolve(__dirname, '../../../output/c3ea7b44a692/report.json')

function repeatGridComponentOnSlide(report, slideNumber) {
  return listAllComponents(report).find((item) => (
    item.group === 'repeats'
    && item.instances.some((instance) => instance.slide_number === slideNumber && instance.repeat?.grid)
  )) || null
}

function findColMediaComponent(report) {
  return listAllComponents(report).find((item) => (
    item.instances.some((instance) => instance.slide_number === 27 && instance.vgroup_id === 'g1.2.2')
    && item.raw?.layout_splits?.some((split) => split.slide_number === 27 && split.item_count === 3)
  )) || null
}

test('isIterableRepeatComponent detects repeat_grid and repeat_series', () => {
  if (!fs.existsSync(sampleReportPath)) return

  const report = JSON.parse(fs.readFileSync(sampleReportPath, 'utf8'))
  const grid = repeatGridComponentOnSlide(report, 21)
  const row = listAllComponents(report).find((item) => (
    item.group === 'repeats'
    && item.instances.some((instance) => instance.repeat?.count >= 2 && !instance.repeat?.grid)
  ))
  assert.equal(isIterableRepeatComponent(grid), true)
  assert.equal(isIterableRepeatComponent(row), true)
})

test('repeat components without text are grouped as containers', () => {
  if (!fs.existsSync(sampleReportPath)) return

  const report = JSON.parse(fs.readFileSync(sampleReportPath, 'utf8'))
  const items = listAllComponents(report)
  const repeats = items.filter((item) => item.group === 'repeats')
  const fillOnly = items.find((item) => item.id === 'vg_001')

  assert.ok(repeats.every((item) => hasRepeatTextSlots(item)))
  assert.ok(repeats.every((item) => isIterableRepeatComponent(item)))
  assert.ok(repeats.every((item) => item.iterability?.checks?.same_slide_repeat))
  if (fillOnly) {
    assert.equal(fillOnly.group, 'containers')
    assert.equal(isIterableRepeatComponent(fillOnly), false)
  }
})

test('icon-only repeat is not iterable without text slots', () => {
  const component = {
    slots: {
      required: [{ kind: 'icon', role: 'icon' }],
      optional: [],
    },
    iterability: {
      is_iterable: true,
      method: 'repeat_series',
      checks: { same_slide_repeat: true },
    },
    instances: [{
      repeat: { count: 3 },
      slots: [{ kind: 'icon', role: 'icon' }],
    }],
  }

  assert.equal(hasRepeatTextSlots(component), false)
  assert.equal(isIterableRepeatComponent(component), false)
})

test('COL_MEDIA merges split columns on slides 26-27 into one 3-item component', () => {
  if (!fs.existsSync(sampleReportPath)) return

  const report = JSON.parse(fs.readFileSync(sampleReportPath, 'utf8'))
  const component = findColMediaComponent(report)
  assert.ok(component)

  const capacity = buildContainerCapacity(component)
  assert.equal(capacity.item_count_known, 3)
  assert.equal(capacity.layout_splits.find((split) => split.slide_number === 26)?.item_count, 3)
  assert.equal(capacity.layout_splits.find((split) => split.slide_number === 27)?.item_count, 3)

  const context = resolveComponentPreviewContext(report, component, { templateId: 'tmpl_027', instanceIndex: 0 })
  assert.equal(context.instance?.vgroup_id, 'g1.2.1.1')
  assert.equal(context.instance?.repeat?.count, 2)

  const bbox = getPlaygroundInstanceBBox(component, context.instance)
  assert.ok(bbox.width_pt >= 500)

  const view = buildComponentSlideView(report, component, {
    templateId: 'tmpl_027',
    instanceIndex: 0,
    modelData: defaultContainerModel(component, resolveRepeatPlaygroundAnchor(component, context.instance)),
  })
  assert.ok(view.bboxPt.width_pt >= 500)
})

test('buildContainerCapacity exposes known and max item counts', () => {
  if (!fs.existsSync(sampleReportPath)) return

  const report = JSON.parse(fs.readFileSync(sampleReportPath, 'utf8'))
  const component = repeatGridComponentOnSlide(report, 21)
  const capacity = buildContainerCapacity(component)
  assert.ok(capacity.item_count_known >= 4)
  assert.ok(capacity.item_count_max >= 5)
})

test('splitInstanceIntoItems groups slots by repeat count', () => {
  if (!fs.existsSync(sampleReportPath)) return

  const report = JSON.parse(fs.readFileSync(sampleReportPath, 'utf8'))
  const component = repeatGridComponentOnSlide(report, 21)
  const instance = component.instances.find((item) => item.slide_number === 21)
  const items = splitInstanceIntoItems(instance)
  assert.equal(items.length, 4)
  assert.equal(items[0].element_ids.length, 3)
})

test('container repeat preview expands item count on slide 21', () => {
  if (!fs.existsSync(sampleReportPath)) return

  const report = JSON.parse(fs.readFileSync(sampleReportPath, 'utf8'))
  const component = repeatGridComponentOnSlide(report, 21)
  const instance = component.instances.find((item) => item.slide_number === 21)
  const model = resizeContainerModel(defaultContainerModel(component, instance), 6, component, instance)
  const slide = buildContainerRepeatPreviewSlide(report, component, instance, { modelData: model })
  const generated = slide.content_elements.filter((element) => String(element.element_id).includes('__repeat_'))
  assert.equal(generated.length, 18)
  assert.equal(model.item_count, 6)
})

test('buildComponentSlideView uses repeat playground model for containers', () => {
  if (!fs.existsSync(sampleReportPath)) return

  const report = JSON.parse(fs.readFileSync(sampleReportPath, 'utf8'))
  const component = repeatGridComponentOnSlide(report, 21)
  const instanceIndex = component.instances.findIndex((item) => item.slide_number === 21)
  const instance = component.instances[instanceIndex]
  const model = resizeContainerModel(defaultContainerModel(component, instance), 5, component, instance)
  const view = buildComponentSlideView(report, component, { instanceIndex, modelData: model })
  const generated = view.slide.content_elements.filter((element) => String(element.element_id).includes('__repeat_'))
  assert.equal(generated.length, 15)
})

test('GRID_MEDIA row_card grid treats each row as one icon+text item', () => {
  if (!fs.existsSync(freeformReportPath)) return

  const report = JSON.parse(fs.readFileSync(freeformReportPath, 'utf8'))
  const component = listAllComponents(report).find((item) => (
    item.instances.some((instance) => instance.slide_number === 20 && instance.vgroup_id === 'g1.2')
  ))
  assert.ok(component, 'expected g1.2 GRID_MEDIA component on slide 20')
  const instance = component.instances.find((item) => item.slide_number === 20)

  assert.equal(instance.repeat?.split_mode, 'row_card')
  assert.equal(instance.repeat?.item_count, 3)

  const items = splitInstanceIntoItems(instance)
  assert.equal(items.length, 3)
  assert.equal(items[0].element_ids.length, 4)
  assert.equal(items[0].slots.some((slot) => slot.kind === 'text'), true)
  assert.equal(items[0].fields.body, 'Пункт')
  assert.equal(items[0].fields.text, undefined)

  const capacity = buildContainerCapacityForInstance(component, instance)
  assert.equal(capacity.item_count_known, 3)
  assert.equal(capacity.item_count_max, 6)

  const model = resizeContainerModel(defaultContainerModel(component, instance), 4, component, instance)
  assert.equal(model.item_count, 4)
  assert.equal(model.grid.rows, 4)
  assert.equal(model.split_mode, 'row_card')

  const normalized = normalizeRepeatModelForRender(model)
  assert.equal(normalized.item_count, 4)

  const slide = buildContainerRepeatPreviewSlide(report, component, instance, { modelData: normalized })
  const generated = slide.content_elements.filter((element) => String(element.element_id).includes('__repeat_'))
  assert.equal(generated.length, 16)
  assert.ok(generated.some((element) => element.kind === 'text'))
})
