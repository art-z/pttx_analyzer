import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { detectDeckVgroups } from '../slides/vgroup-detect.js'
import { detectComponentsFromVgroups, assessComponentIterability, assessRepeatGroupPlausibility, buildContainerBounds, buildTextFields, isUniformLayoutWrapper } from './from-vgroups.js'
import { listAllComponents } from './catalog.js'
import { isIterableRepeatComponent, buildContainerCapacity, defaultContainerModel, splitInstanceIntoItems } from './container-catalog.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const sampleReportPath = path.resolve(__dirname, '../../../output/6ba0614b1aba/report.json')
const spatialReportPath = path.resolve(__dirname, '../../../output/b13e9370de41/report.json')
const freeformReportPath = path.resolve(__dirname, '../../../output/c3ea7b44a692/report.json')
const metricsReportPath = path.resolve(__dirname, '../../../output/226f37b5a6cd/report.json')

test('detectComponentsFromVgroups finds repeatable vgroup clusters', () => {
  if (!fs.existsSync(sampleReportPath)) return

  const report = JSON.parse(fs.readFileSync(sampleReportPath, 'utf8'))
  const catalog = detectComponentsFromVgroups(report)
  const sample = catalog.components.find((component) => component.iterability?.is_iterable)
    || catalog.components.find((component) => component.text_fields?.length)
    || catalog.components[0]

  assert.ok(catalog.summary.component_count >= 5)
  assert.ok(catalog.summary.instance_count >= catalog.summary.component_count)
  assert.ok(catalog.components.every((component) => component.source === 'vgroups'))
  assert.ok(catalog.components.every((component) => (
    component.iterability?.checks?.same_slide_repeat
    || (component.iterability?.max_repeat_count || 0) >= 2
  )))
  assert.ok(catalog.components.every((component) => (component.instances?.[0]?.element_ids?.length || 0) >= 2))
  assert.ok(sample.container_bounds?.max?.width_pt >= sample.container?.width_pt)
  assert.ok(sample.container_max?.element_count >= 2)
  assert.equal(sample.iterability?.is_iterable, true)
  assert.ok(sample.text_fields?.length >= 1)
})

test('component profile helpers expose bounds, iterability and text fields', () => {
  if (!fs.existsSync(sampleReportPath)) return

  const report = JSON.parse(fs.readFileSync(sampleReportPath, 'utf8'))
  const catalog = detectComponentsFromVgroups(report)
  const component = catalog.components.find((item) => item.iterability?.is_iterable)
  assert.ok(component)
  const instances = component.instances
  const bounds = buildContainerBounds(instances)
  const iter = assessComponentIterability(instances, component.signature)
  const textFields = buildTextFields(instances, component.slots)

  assert.ok(bounds.max.width_pt >= bounds.typical.width_pt)
  assert.ok(bounds.max.element_count >= bounds.min.element_count)
  assert.equal(iter.is_iterable, true)
  assert.equal(iter.checks.has_text, true)
  assert.ok(textFields.length >= 1)
})

test('listAllComponents uses vgroups and splits repeats into separate group', () => {
  if (!fs.existsSync(sampleReportPath)) return

  const report = JSON.parse(fs.readFileSync(sampleReportPath, 'utf8'))
  const items = listAllComponents(report)
  const vgroups = items.filter((item) => item.source === 'vgroups')
  const repeats = items.filter((item) => item.group === 'repeats')
  const containers = items.filter((item) => item.group === 'containers')

  assert.ok(vgroups.length >= 5)
  assert.ok(repeats.length >= 1)
  assert.ok(repeats.every((item) => isIterableRepeatComponent(item)))
  assert.ok(repeats.every((item) => item.textFields?.length > 0 || item.instances?.some((instance) => instance.slots?.some((slot) => slot.kind === 'text'))))
  assert.ok(repeats.every((item) => item.source === 'vgroups'))
  if (containers.length) {
    assert.ok(containers.every((item) => !isIterableRepeatComponent(item)))
  }
  assert.equal(items.some((item) => item.source === 'spatial'), false)
})

test('detectComponentsFromVgroups skips outer repeat when deep inner repeat clusters exist on slide 21', () => {
  if (!fs.existsSync(freeformReportPath)) return

  const report = JSON.parse(fs.readFileSync(freeformReportPath, 'utf8'))
  const deck = detectDeckVgroups(report.slides, report)
  const slide = deck.perSlide.find((item) => item.slideNumber === 21)
  const group = slide.groups.find((item) => item.id === 'g1.2')
  assert.ok(group)

  const plausibility = assessRepeatGroupPlausibility(group, slide.groups)
  assert.equal(plausibility.checks.nested_inner_repeat, true)
  assert.equal(plausibility.plausible, false)

  const items = listAllComponents(report)
  assert.equal(items.some((item) => (
    item.instances.some((instance) => instance.slide_number === 21 && instance.vgroup_id === 'g1.2')
    && item.group === 'repeats'
  )), false)
})

test('slide 21 nested g1.2.* leaf repeats stay out of catalog when outer group is rejected', () => {
  if (!fs.existsSync(freeformReportPath)) return

  const report = JSON.parse(fs.readFileSync(freeformReportPath, 'utf8'))
  const items = listAllComponents(report)
  assert.equal(items.filter((item) => (
    item.instances.some((instance) => instance.slide_number === 21)
    && item.group === 'repeats'
  )).length, 0, 'slide 21 should have no repeat catalog components')
})

test('assessComponentIterability requires same-slide repeat for iterable components', () => {
  const iterable = assessComponentIterability(
    [{ slide_number: 1, repeat: { count: 3 }, slots: [{ kind: 'text', size_pt: 14 }] }],
    'c(f{t10})[t10]',
  )

  assert.equal(iterable.is_iterable, true)
  assert.equal(iterable.method, 'repeat_series')
  assert.equal(iterable.checks.same_slide_repeat, true)
})

test('assessComponentIterability rejects icon-only repeat without text fields', () => {
  const iterable = assessComponentIterability(
    [{ slide_number: 7, repeat: { count: 4 }, slots: [{ kind: 'icon', role: 'icon' }] }],
    'i',
  )

  assert.equal(iterable.checks.same_slide_repeat, true)
  assert.equal(iterable.checks.has_media, true)
  assert.equal(iterable.checks.has_text, false)
  assert.equal(iterable.is_iterable, false)
})

test('assessComponentIterability rejects cross-slide singleton clusters', () => {
  const iter = assessComponentIterability(
    [
      { slide_number: 1, repeat: { count: 1 }, slots: [{ kind: 'text', size_pt: 14 }] },
      { slide_number: 2, repeat: { count: 1 }, slots: [{ kind: 'text', size_pt: 14 }] },
      { slide_number: 3, repeat: { count: 1 }, slots: [{ kind: 'text', size_pt: 14 }] },
    ],
    'c(f{t10})[t10]',
  )

  assert.equal(iter.is_iterable, false)
  assert.equal(iter.method, 'none')
  assert.equal(iter.checks.same_slide_repeat, false)
  assert.equal(iter.checks.cross_slide, true)
})

test('assessRepeatGroupPlausibility rejects deep peripheral grid cells on slide 37', () => {
  if (!fs.existsSync(freeformReportPath)) return

  const report = JSON.parse(fs.readFileSync(freeformReportPath, 'utf8'))
  const deck = detectDeckVgroups(report.slides, report)
  const slide = deck.perSlide.find((item) => item.slideNumber === 37)
  assert.ok(slide)

  const leaf = slide.groups.find((group) => group.id === 'g1.2.1.3.2.1')
  const grid = slide.groups.find((group) => group.id === 'g1.2.1.3.2')
  assert.ok(leaf)
  assert.ok(grid)

  assert.equal(assessRepeatGroupPlausibility(leaf, slide.groups).plausible, false)
  assert.equal(assessRepeatGroupPlausibility(leaf, slide.groups).checks.repeat_grid_cell, true)
  assert.equal(assessRepeatGroupPlausibility(grid, slide.groups).plausible, false)
  assert.ok(assessRepeatGroupPlausibility(grid, slide.groups).checks.narrow_strip
    || assessRepeatGroupPlausibility(grid, slide.groups).checks.peripheral_branch)
})

test('detectComponentsFromVgroups skips narrow peripheral ROW_FILLED bullet grid on slide 37', () => {
  if (!fs.existsSync(freeformReportPath)) return

  const report = JSON.parse(fs.readFileSync(freeformReportPath, 'utf8'))
  const items = listAllComponents(report)
  const rowFilled = items.find((item) => item.raw?.signature === 'c(f{t4})[t4]')

  assert.equal(rowFilled, undefined)
})

test('detectComponentsFromVgroups skips page-grid text repeats on slide 30', () => {
  if (!fs.existsSync(freeformReportPath)) return

  const report = JSON.parse(fs.readFileSync(freeformReportPath, 'utf8'))
  const deck = detectDeckVgroups(report.slides, report)
  const slide = deck.perSlide.find((item) => item.slideNumber === 30)
  assert.ok(slide)

  assert.equal(assessRepeatGroupPlausibility(slide.groups.find((group) => group.id === 'g1.1.2'), slide.groups).checks.page_grid_fragment, true)
  assert.equal(assessRepeatGroupPlausibility(slide.groups.find((group) => group.id === 'g1.2.2'), slide.groups).checks.page_grid_fragment, true)

  const items = listAllComponents(report)
  assert.equal(items.some((item) => item.instances.some((instance) => (
    instance.slide_number === 30 && (instance.vgroup_id === 'g1.1.2' || instance.vgroup_id === 'g1.2.2')
  )) && item.group === 'repeats'), false)
  assert.equal(items.some((item) => item.instances.some((instance) => (
    instance.slide_number === 30 && (instance.vgroup_id === 'g1.2.1' || instance.vgroup_id === 'g1.3.2')
  )) && item.group === 'repeats'), false)
})

test('isUniformLayoutWrapper detects row/column wrappers around repeat items', () => {
  const itemSig = 'y[i,y[t20,t14]]'
  const wrapperSig = 'x[y[i,y[t20,t14]],y[i,y[t20,t14]],y[i,y[t20,t14]],y[i,y[t20,t14]]]'
  assert.equal(isUniformLayoutWrapper(wrapperSig, itemSig), true)
  assert.equal(isUniformLayoutWrapper(itemSig, itemSig), false)
  assert.equal(isUniformLayoutWrapper('y[f,f]', 'f'), true)
  assert.equal(isUniformLayoutWrapper('y[i,y[y[t10,t10,t10],t6],y[x[f,t8],x[f,t8],x[f,t8]]]', 'x[f,t8]'), false)
})

test('detectComponentsFromVgroups skips outer repeat when deep inner repeat clusters exist on slide 13', () => {
  if (!fs.existsSync(freeformReportPath)) return

  const report = JSON.parse(fs.readFileSync(freeformReportPath, 'utf8'))
  const deck = detectDeckVgroups(report.slides, report)
  const slide = deck.perSlide.find((item) => item.slideNumber === 13)
  const group = slide.groups.find((item) => item.id === 'g1.2.2')
  assert.ok(group)

  const plausibility = assessRepeatGroupPlausibility(group, slide.groups)
  assert.equal(plausibility.checks.nested_inner_repeat, true)
  assert.equal(plausibility.plausible, false)

  const items = listAllComponents(report)
  assert.equal(items.some((item) => (
    item.instances.some((instance) => instance.slide_number === 13 && instance.vgroup_id === 'g1.2.2')
    && item.group === 'repeats'
  )), false)
})

test('detectComponentsFromVgroups rejects row segment repeat on slide 29 GRID_TEXT', () => {
  if (!fs.existsSync(freeformReportPath)) return

  const report = JSON.parse(fs.readFileSync(freeformReportPath, 'utf8'))
  const deck = detectDeckVgroups(report.slides, report)
  const slide = deck.perSlide.find((item) => item.slideNumber === 29)
  const group = slide.groups.find((item) => item.id === 'g1.2.3')
  assert.ok(group)

  const plausibility = assessRepeatGroupPlausibility(group, slide.groups)
  assert.equal(plausibility.checks.row_segment_fragment, true)
  assert.equal(plausibility.plausible, false)

  const items = listAllComponents(report)
  assert.equal(items.some((item) => (
    item.instances.some((instance) => instance.slide_number === 29 && instance.vgroup_id === 'g1.2.3')
    && item.group === 'repeats'
  )), false)
})

test('detectComponentsFromVgroups rejects column section ROW_MEDIA repeat on slide 49', () => {
  if (!fs.existsSync(freeformReportPath)) return

  const report = JSON.parse(fs.readFileSync(freeformReportPath, 'utf8'))
  const deck = detectDeckVgroups(report.slides, report)
  const slide = deck.perSlide.find((item) => item.slideNumber === 49)
  const group = slide.groups.find((item) => item.id === 'g1.2.2.2')
  assert.ok(group)

  const plausibility = assessRepeatGroupPlausibility(group, slide.groups)
  assert.equal(plausibility.checks.column_section_fragment, true)
  assert.equal(plausibility.plausible, false)

  const items = listAllComponents(report)
  assert.equal(items.some((item) => (
    item.instances.some((instance) => instance.slide_number === 49 && instance.vgroup_id === 'g1.2.2.2')
    && item.group === 'repeats'
  )), false)
})

test('detectComponentsFromVgroups rejects staggered GRID_TEXT repeat on slide 51', () => {
  if (!fs.existsSync(freeformReportPath)) return

  const report = JSON.parse(fs.readFileSync(freeformReportPath, 'utf8'))
  const deck = detectDeckVgroups(report.slides, report)
  const slide = deck.perSlide.find((item) => item.slideNumber === 51)
  const group = slide.groups.find((item) => item.id === 'g1.2')
  assert.ok(group)

  const plausibility = assessRepeatGroupPlausibility(group, slide.groups)
  assert.equal(plausibility.checks.inconsistent_slot_geometry, true)
  assert.equal(plausibility.plausible, false)

  const items = listAllComponents(report)
  assert.equal(items.some((item) => (
    item.instances.some((instance) => instance.slide_number === 51 && instance.vgroup_id === 'g1.2')
    && item.group === 'repeats'
  )), false)
})

test('slide 16 repeat grid multiplies rows by cols for playground items', () => {
  if (!fs.existsSync(freeformReportPath)) return

  const report = JSON.parse(fs.readFileSync(freeformReportPath, 'utf8'))
  const items = listAllComponents(report)
  const component = items.find((item) => (
    item.group === 'repeats'
    && item.instances.some((instance) => instance.slide_number === 16 && instance.vgroup_id === 'g1.2')
  ))
  assert.ok(component, 'expected g1.2 repeat grid component on slide 16')

  const instance = component.instances.find((item) => item.slide_number === 16)
  const signature = component.raw?.signature || component.variantSignature
  assert.equal(instance.repeat?.grid?.rows, 2)
  assert.equal(instance.repeat?.grid?.cols, 4)
  assert.equal(instance.repeat?.split_mode, 'page_grid')
  assert.equal(instance.repeat?.item_count, 8)
  assert.equal(signature.startsWith('x[c('), true)
  assert.equal(instance.layout, 'grid')
  assert.ok(instance.container?.width_pt >= 600)

  const capacity = buildContainerCapacity(component)
  assert.equal(capacity.item_count_known, 8)
  assert.equal(splitInstanceIntoItems(instance).length, 8)
  assert.equal(defaultContainerModel(component, instance).item_count, 8)
  assert.equal(defaultContainerModel(component, instance).grid?.rows, 2)
})

test('slide 20 keeps item-level repeat grid, not parent layout wrapper component', () => {
  if (!fs.existsSync(spatialReportPath)) return

  const report = JSON.parse(fs.readFileSync(spatialReportPath, 'utf8'))
  const catalog = detectComponentsFromVgroups(report)
  const slide20 = catalog.components.filter((component) => (
    component.instances.some((instance) => instance.slide_number === 20)
  ))

  const itemGrid = slide20.find((component) => component.signature === 'y[i,y[t20,t14]]')
  assert.ok(itemGrid, 'expected item-level repeat grid on slide 20')
  assert.equal(itemGrid.instances.filter((instance) => instance.slide_number === 20).length, 2)
  assert.equal(itemGrid.iterability?.method, 'repeat_grid')
  assert.ok((itemGrid.layout_splits || []).some((split) => split.slide_number === 20 && split.item_count === 8))

  const wrapper = slide20.find((component) => (
    component.signature === 'x[y[i,y[t20,t14]],y[i,y[t20,t14]],y[i,y[t20,t14]],y[i,y[t20,t14]]]'
  ))
  assert.equal(wrapper, undefined, 'parent layout wrapper must not become a separate component')
})
