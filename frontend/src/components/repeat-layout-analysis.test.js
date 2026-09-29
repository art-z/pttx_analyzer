import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { detectDeckVgroups } from '../slides/vgroup-detect.js'
import { detectComponentsFromVgroups } from './from-vgroups.js'
import { analyzeSlideRepeatSplits, boxesShareHorizontalBand, findLayoutSplitForInstance, hasInconsistentRepeatSlotGeometry, instancesShareRepeatAxis, isRepeatRowSegmentFragment, normalizeClusterSignature, resolveGridRepeatMeta, resolvePageGridCellSignature } from './repeat-layout-analysis.js'
import { buildContainerCapacity, defaultContainerModel, getPlaygroundInstanceBBox } from './container-catalog.js'
import { listAllComponents, getInstanceBBox } from './catalog.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const sampleReportPath = path.resolve(__dirname, '../../../output/4bbeea9db0ad/report.json')
const splitGridReportPath = path.resolve(__dirname, '../../../output/2a449c71b5a6/report.json')
const freeformReportPath = path.resolve(__dirname, '../../../output/c3ea7b44a692/report.json')

test('resolveGridRepeatMeta distinguishes page grid from row-card grid', () => {
  if (!fs.existsSync(freeformReportPath)) return

  const report = JSON.parse(fs.readFileSync(freeformReportPath, 'utf8'))
  const deck = detectDeckVgroups(report.slides, report)
  const slide16 = deck.perSlide.find((item) => item.slideNumber === 16)
  const slide20 = deck.perSlide.find((item) => item.slideNumber === 20)
  const slide29 = deck.perSlide.find((item) => item.slideNumber === 29)
  const pageGrid = slide16.groups.find((group) => group.id === 'g1.2')
  const rowCards = slide20.groups.find((group) => group.id === 'g1.2')
  const horizontal = slide29.groups.find((group) => group.id === 'g1.2.3')

  assert.equal(resolveGridRepeatMeta(pageGrid, slide16.groups).splitMode, 'page_grid')
  assert.equal(resolveGridRepeatMeta(pageGrid, slide16.groups).itemCount, 8)
  assert.equal(resolveGridRepeatMeta(rowCards, slide20.groups).splitMode, 'row_card')
  assert.equal(resolveGridRepeatMeta(rowCards, slide20.groups).itemCount, 3)
  assert.equal(resolveGridRepeatMeta(horizontal, slide29.groups).splitMode, 'horizontal_series')
  assert.equal(resolveGridRepeatMeta(horizontal, slide29.groups).itemCount, 2)
  assert.equal(isRepeatRowSegmentFragment(horizontal, slide29.groups), true)
  assert.equal(hasInconsistentRepeatSlotGeometry(horizontal, slide29.groups), false)

  const slide51 = deck.perSlide.find((item) => item.slideNumber === 51)
  const staggered = slide51.groups.find((group) => group.id === 'g1.2')
  assert.equal(hasInconsistentRepeatSlotGeometry(staggered, slide51.groups), true)
})

test('grid with repeated row wrappers resolves to page-grid cells', () => {
  const parent = {
    id: 'g1.2',
    layout: 'grid',
    repeat: { count: 2, itemSig: 'x[s[t18,t14],s[t18,t14]]', grid: { rows: 2, cols: 2 } },
    bboxPt: { x_pt: 50, y_pt: 140, width_pt: 856, height_pt: 349 },
    bboxNorm: { x: 0.05, y: 0.26, width: 0.89, height: 0.65 },
  }
  const groups = [
    parent,
    {
      id: 'g1.2.1',
      parentId: 'g1.2',
      layout: 'row',
      repeat: { count: 2, itemSig: 's[t18,t14]' },
      bboxPt: { x_pt: 50, y_pt: 140, width_pt: 856, height_pt: 170 },
      bboxNorm: { x: 0.05, y: 0.26, width: 0.89, height: 0.31 },
      elements: [],
    },
    {
      id: 'g1.2.2',
      parentId: 'g1.2',
      layout: 'row',
      repeat: { count: 2, itemSig: 's[t18,t14]' },
      bboxPt: { x_pt: 50, y_pt: 318, width_pt: 856, height_pt: 170 },
      bboxNorm: { x: 0.05, y: 0.59, width: 0.89, height: 0.31 },
      elements: [],
    },
  ]

  assert.equal(resolvePageGridCellSignature(parent, groups), 's[t18,t14]')
  assert.deepEqual(resolveGridRepeatMeta(parent, groups), {
    itemCount: 4,
    splitMode: 'page_grid',
    rows: 2,
    cols: 2,
    cardCols: 1,
  })
  assert.equal(hasInconsistentRepeatSlotGeometry(parent, groups), false)
})

test('row-wrapper page grid becomes one repeat component with cell capacity', () => {
  const makeText = (id, x, y, size) => ({
    element_id: id,
    kind: 'text',
    text: id,
    typography: { size_pt: size },
    geometry_norm: { x, y, width: 0.35, height: 0.05 },
  })
  const elements = [
    makeText('h1', 0.08, 0.30, 18), makeText('b1', 0.08, 0.37, 14),
    makeText('h2', 0.53, 0.30, 18), makeText('b2', 0.53, 0.37, 14),
    makeText('h3', 0.08, 0.63, 18), makeText('b3', 0.08, 0.70, 14),
    makeText('h4', 0.53, 0.63, 18), makeText('b4', 0.53, 0.70, 14),
  ]
  const parent = {
    id: 'g1.2', parentId: 'g1', depth: 2, layout: 'grid', elementCount: 8,
    signature: 'y[x[s[t18,t14],s[t18,t14]],x[s[t18,t14],s[t18,t14]]]',
    repeat: { count: 2, itemSig: 'x[s[t18,t14],s[t18,t14]]', grid: { rows: 2, cols: 2 } },
    bboxPt: { x_pt: 50, y_pt: 140, width_pt: 856, height_pt: 349 },
    bboxNorm: { x: 0.05, y: 0.26, width: 0.89, height: 0.65 },
    elements,
  }
  const groups = [
    parent,
    {
      id: 'g1.2.1', parentId: 'g1.2', depth: 3, layout: 'row', elementCount: 4,
      signature: 'x[s[t18,t14],s[t18,t14]]', repeat: { count: 2, itemSig: 's[t18,t14]' },
      bboxPt: { x_pt: 50, y_pt: 140, width_pt: 856, height_pt: 170 },
      bboxNorm: { x: 0.05, y: 0.26, width: 0.89, height: 0.31 }, elements: elements.slice(0, 4),
    },
    {
      id: 'g1.2.2', parentId: 'g1.2', depth: 3, layout: 'row', elementCount: 4,
      signature: 'x[s[t18,t14],s[t18,t14]]', repeat: { count: 2, itemSig: 's[t18,t14]' },
      bboxPt: { x_pt: 50, y_pt: 318, width_pt: 856, height_pt: 170 },
      bboxNorm: { x: 0.05, y: 0.59, width: 0.89, height: 0.31 }, elements: elements.slice(4),
    },
  ]
  const report = {
    slides: { slides: [{ slide_number: 7, content_elements: elements, render: { slide_size_pt: { width: 960, height: 540 } } }] },
  }
  const deck = {
    perSlide: [{ slideNumber: 7, groups, slideTitle: { elementIds: [] } }],
    summary: { slideCount: 1 },
  }

  const catalog = detectComponentsFromVgroups(report, deck)
  const component = catalog.components.find((item) => item.instances.some((instance) => instance.vgroup_id === 'g1.2'))
  const instance = component?.instances.find((item) => item.vgroup_id === 'g1.2')

  assert.ok(component)
  assert.equal(component.signature, 's[t18,t14]')
  assert.equal(component.iterability.is_iterable, true)
  assert.equal(instance.repeat.split_mode, 'page_grid')
  assert.equal(instance.repeat.item_count, 4)
})

test('analyzeSlideRepeatSplits detects split grids on slide 42', () => {
  if (!fs.existsSync(sampleReportPath)) return

  const report = JSON.parse(fs.readFileSync(sampleReportPath, 'utf8'))
  const deck = detectDeckVgroups(report.slides, report)
  const slide = deck.perSlide.find((item) => item.slideNumber === 42)
  assert.ok(slide)

  const splits = analyzeSlideRepeatSplits(slide.groups)
  assert.equal(splits.length, 1)
  assert.deepEqual(splits[0].groupIds, ['g1.2', 'g1.3'])
  assert.equal(splits[0].itemCount, 7)
  assert.equal(splits[0].itemSig, 'y[f,y[t32,t16]]')
})

test('detectLayoutSplitsFromInstances merges COL_MEDIA grid and sibling column', () => {
  if (!fs.existsSync(sampleReportPath)) return

  const report = JSON.parse(fs.readFileSync(sampleReportPath, 'utf8'))
  const catalog = detectComponentsFromVgroups(report)
  const component = catalog.components.find((item) => (
    item.instances.some((instance) => instance.slide_number === 27 && instance.vgroup_id === 'g1.2.2')
  ))
  assert.ok(component)
  assert.equal(component.signature, 'y[c({i})[i],t16]')

  const split26 = component.layout_splits.find((split) => split.slide_number === 26)
  const split27 = component.layout_splits.find((split) => split.slide_number === 27)
  assert.equal(split26?.item_count, 3)
  assert.equal(split27?.item_count, 3)
  assert.deepEqual(split27?.vgroup_ids, ['g1.2.1.1', 'g1.2.2'])
  assert.ok(Math.round(split27.container.width_pt) >= 800)
})

test('normalizeClusterSignature treats icon fill variants as one column signature', () => {
  assert.equal(
    normalizeClusterSignature('y[c(f{i})[i],t16]'),
    normalizeClusterSignature('y[c(i{i})[i],t16]'),
  )
})

test('instancesShareRepeatAxis requires row repeats to stay on one horizontal band', () => {
  assert.equal(boxesShareHorizontalBand([
    { x: 0.52, y: 0.08, width: 0.42, height: 0.08 },
    { x: 0.05, y: 0.50, width: 0.89, height: 0.11 },
  ]), false)

  assert.equal(instancesShareRepeatAxis([
    {
      slide_number: 30,
      layout: 'row',
      repeat: { count: 2 },
      container_norm: { x: 0.52, y: 0.08, width: 0.42, height: 0.08 },
    },
    {
      slide_number: 30,
      layout: 'row',
      repeat: { count: 3 },
      container_norm: { x: 0.05, y: 0.50, width: 0.89, height: 0.11 },
    },
  ]), false)

  assert.equal(instancesShareRepeatAxis([
    {
      slide_number: 30,
      layout: 'row',
      repeat: { count: 2 },
      container_norm: { x: 0.52, y: 0.08, width: 0.19, height: 0.08 },
    },
    {
      slide_number: 30,
      layout: 'row',
      repeat: { count: 2 },
      container_norm: { x: 0.75, y: 0.08, width: 0.19, height: 0.04 },
    },
  ]), true)
})

test('detectComponentsFromVgroups merges split grids and skips nested leaf duplicates', () => {
  if (!fs.existsSync(sampleReportPath)) return

  const report = JSON.parse(fs.readFileSync(sampleReportPath, 'utf8'))
  const catalog = detectComponentsFromVgroups(report)
  const splitComponent = catalog.components.find((component) => (
    component.layout_splits?.some((split) => split.slide_number === 42)
  ))

  assert.ok(splitComponent)
  assert.equal(splitComponent.layout_splits.find((split) => split.slide_number === 42)?.item_count, 7)
  assert.equal(catalog.components.some((component) => component.signature === 'y[t32,t16]'), false)

  const normalized = listAllComponents(report).find((item) => item.id === splitComponent.component_id)
  const capacity = buildContainerCapacity(normalized)
  assert.equal(capacity.item_count_known, 7)

  const instance = splitComponent.instances.find((item) => item.slide_number === 42)
  const model = defaultContainerModel(normalized, instance)
  assert.equal(model.item_count, 7)

  const insts = splitComponent.instances.filter((item) => item.slide_number === 42)
  const single = getInstanceBBox(insts[0])
  const merged = getPlaygroundInstanceBBox(normalized, instance)
  assert.ok(merged.width_pt > single.width_pt || merged.height_pt > single.height_pt)
  assert.equal(Math.round(merged.width_pt), 853)
  assert.equal(Math.round(merged.height_pt), 304)
})

test('findLayoutSplitForInstance resolves split from either grid on slide 17', () => {
  if (!fs.existsSync(splitGridReportPath)) return

  const report = JSON.parse(fs.readFileSync(splitGridReportPath, 'utf8'))
  const component = listAllComponents(report).find((item) => (
    item.instances.some((instance) => instance.slide_number === 17 && instance.vgroup_id === 'g1.2.1')
    && item.raw?.layout_splits?.some((split) => split.slide_number === 17 && split.item_count === 6)
  ))
  assert.ok(component)

  const split = component.raw.layout_splits.find((item) => item.slide_number === 17)
  assert.equal(split?.item_count, 6)
  assert.deepEqual(split?.vgroup_ids, ['g1.2.1', 'g1.2.2'])

  for (const vgroupId of ['g1.2.1', 'g1.2.2']) {
    const instance = component.instances.find((item) => item.slide_number === 17 && item.vgroup_id === vgroupId)
    assert.equal(findLayoutSplitForInstance(component, instance)?.item_count, 6)
  }
})
