import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { listAllComponents } from './catalog.js'
import { defaultContainerModel } from './container-catalog.js'
import {
  buildContainerRepeatPreviewSlide,
  promoteMetricValueSlot,
  detectRepeatAlignment,
  layoutItemOriginsInBBox,
  measureRepeatPitch,
  normalizeRepeatModelData,
  repeatItemHasData,
  resolveFieldValue,
  sortItemBoxesLtr,
  topRowLayoutAnchor,
  unionBBoxPt,
} from './container-render.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const sampleReportPath = path.resolve(__dirname, '../../../output/4bbeea9db0ad/report.json')
const splitGridReportPath = path.resolve(__dirname, '../../../output/2a449c71b5a6/report.json')

function findRowTextSlide7(report) {
  return listAllComponents(report).find((item) => (
    item.instances.some((instance) => instance.slide_number === 7 && instance.vgroup_id === 'g1.2.1')
    && item.raw?.layout_splits?.some((split) => split.slide_number === 7 && split.item_count === 4)
  )) || null
}

function findColMediaComponent(report) {
  return listAllComponents(report).find((item) => (
    item.instances.some((instance) => instance.slide_number === 27 && instance.vgroup_id === 'g1.2.2')
    && item.raw?.layout_splits?.some((split) => split.slide_number === 26 && split.item_count === 3)
  )) || null
}

function findSplitGridSlide17(report) {
  return listAllComponents(report).find((item) => (
    item.instances.some((instance) => instance.slide_number === 17 && instance.vgroup_id === 'g1.2.1')
    && item.raw?.layout_splits?.some((split) => (
      split.slide_number === 17
      && split.item_count === 6
      && split.vgroup_ids?.includes('g1.2.1')
      && split.vgroup_ids?.includes('g1.2.2')
    ))
  )) || null
}

function itemBoxesFromSlide(slide, sourceItems, elementsById) {
  return sourceItems.map((item) => unionBBoxPt(
    item.element_ids
      .map((id) => {
        const element = elementsById.get(id)
        const geometry = element?.geometry_pt || {}
        if (!geometry.width_pt) return null
        return {
          x_pt: geometry.x_pt || 0,
          y_pt: geometry.y_pt || 0,
          width_pt: geometry.width_pt,
          height_pt: geometry.height_pt,
        }
      })
      .filter(Boolean),
  )).filter(Boolean)
}

function generatedItemBoxes(slide) {
  const generated = slide.content_elements.filter((element) => String(element.element_id).includes('__repeat_'))
  const bySuffix = new Map()
  for (const element of generated) {
    const match = String(element.element_id).match(/__repeat_(\d+)$/)
    if (!match) continue
    const suffix = match[1]
    if (!bySuffix.has(suffix)) bySuffix.set(suffix, [])
    bySuffix.get(suffix).push(element)
  }
  return [...bySuffix.values()].map((elements) => unionBBoxPt(
    elements.map((element) => ({
      x_pt: element.geometry_pt?.x_pt || 0,
      y_pt: element.geometry_pt?.y_pt || 0,
      width_pt: element.geometry_pt?.width_pt || 0,
      height_pt: element.geometry_pt?.height_pt || 0,
    })),
  ))
}

test('layoutItemOriginsInBBox places items left-to-right by default', () => {
  const origins = layoutItemOriginsInBBox({
    itemCount: 4,
    playgroundBBox: { x_pt: 0, y_pt: 100, width_pt: 400, height_pt: 120 },
    pitch: { stepX: 100, stepY: 60, itemWidth: 80, itemHeight: 50, cols: 4 },
    shape: { cols: 4, rows: 1 },
    alignment: 'start',
  })

  assert.deepEqual(origins.map((origin) => Math.round(origin.x_pt)), [0, 100, 200, 300])
  assert.ok(origins.every((origin) => origin.y_pt === 100))
})

test('layoutItemOriginsInBBox anchors vertical expansion to top row left edge', () => {
  const itemBoxes = [
    { x_pt: 52, y_pt: 200, width_pt: 80, height_pt: 40 },
    { x_pt: 152, y_pt: 200, width_pt: 80, height_pt: 40 },
    { x_pt: 0, y_pt: 260, width_pt: 80, height_pt: 40 },
    { x_pt: 100, y_pt: 260, width_pt: 80, height_pt: 40 },
  ]
  const pitch = measureRepeatPitch(itemBoxes, 'grid', { cols: 2 })
  const anchor = topRowLayoutAnchor(itemBoxes, { x_pt: 0, y_pt: 200, width_pt: 300, height_pt: 200 })
  assert.equal(anchor.x_pt, 52)

  const origins = layoutItemOriginsInBBox({
    itemCount: 6,
    playgroundBBox: { x_pt: 0, y_pt: 200, width_pt: 300, height_pt: 200 },
    pitch,
    shape: { cols: 2, rows: 3 },
    alignment: 'start',
    anchor,
  })

  assert.deepEqual(origins.slice(0, 2).map((origin) => Math.round(origin.x_pt)), [52, 152])
  assert.deepEqual(origins.slice(2, 4).map((origin) => Math.round(origin.x_pt)), [52, 152])
  assert.deepEqual(origins.slice(4, 6).map((origin) => Math.round(origin.x_pt)), [52, 152])
  assert.ok(origins[2].y_pt > origins[0].y_pt)
  assert.ok(origins[4].y_pt > origins[2].y_pt)
})

test('detectRepeatAlignment centers only with explicit hint and symmetric margins', () => {
  const playground = { x_pt: 0, y_pt: 0, width_pt: 500, height_pt: 200 }
  const centered = [
    { x_pt: 110, y_pt: 50, width_pt: 80, height_pt: 40 },
    { x_pt: 210, y_pt: 50, width_pt: 80, height_pt: 40 },
    { x_pt: 310, y_pt: 50, width_pt: 80, height_pt: 40 },
  ]
  assert.equal(detectRepeatAlignment(centered, playground, 'center'), 'center')
  assert.equal(detectRepeatAlignment(centered, playground, null), 'start')
})

test('expanded repeat preview keeps text group aligned with fill placement', () => {
  if (!fs.existsSync(sampleReportPath)) return

  const report = JSON.parse(fs.readFileSync(sampleReportPath, 'utf8'))
  const component = findRowTextSlide7(report)
  assert.ok(component)

  const instance = component.instances.find((item) => item.slide_number === 7 && item.vgroup_id === 'g1.2.1')
  const model = defaultContainerModel(component, instance)
  model.item_count = 6
  model.items = Array.from({ length: 6 }, (_, index) => ({
    index: index + 1,
    fields: { ...(model.items[index]?.fields || model.items[0]?.fields || {}) },
  }))

  const slide = buildContainerRepeatPreviewSlide(report, component, instance, { modelData: model })
  const generated = slide.content_elements.filter((element) => String(element.element_id).includes('__repeat_'))
  const bySuffix = new Map()
  for (const element of generated) {
    const match = String(element.element_id).match(/__repeat_(\d+)$/)
    if (!match) continue
    if (!bySuffix.has(match[1])) bySuffix.set(match[1], [])
    bySuffix.get(match[1]).push(element)
  }

  for (const elements of bySuffix.values()) {
    const fill = elements.find((element) => element.kind === 'fill')
    const texts = elements.filter((element) => element.kind === 'text')
    assert.ok(fill, 'each repeat item should include fill')
    assert.equal(texts.length, 2, 'each repeat item should include two text lines')

    const fillY = fill.geometry_norm?.y ?? 0
    for (const text of texts) {
      const textY = text.text_group_geometry_norm?.y ?? text.geometry_norm?.y ?? 0
      assert.ok(Math.abs(textY - fillY) < 0.02, `text y ${textY} should follow fill y ${fillY}`)
    }
  }

  const groupSizes = new Map()
  for (const element of generated.filter((item) => item.text_group_id)) {
    groupSizes.set(element.text_group_id, (groupSizes.get(element.text_group_id) || 0) + 1)
  }
  assert.ok([...groupSizes.values()].every((count) => count === 2), 'each text group should contain exactly two lines')
})

test('ROW_TEXT layout split copies fill and both text slots for every item', () => {
  if (!fs.existsSync(sampleReportPath)) return

  const report = JSON.parse(fs.readFileSync(sampleReportPath, 'utf8'))
  const component = findRowTextSlide7(report)
  assert.ok(component)

  const instance = component.instances.find((item) => item.slide_number === 7 && item.vgroup_id === 'g1.2.1')
  const model = defaultContainerModel(component, instance)
  const slide = buildContainerRepeatPreviewSlide(report, component, instance, { modelData: model })
  const generated = slide.content_elements.filter((element) => String(element.element_id).includes('__repeat_'))

  assert.equal(model.item_count, 4)
  assert.equal(generated.length, 12)
  assert.equal(generated.filter((element) => element.kind === 'fill').length, 4)
  assert.equal(generated.filter((element) => element.kind === 'text').length, 8)

  const bySuffix = new Map()
  for (const element of generated) {
    const match = String(element.element_id).match(/__repeat_(\d+)$/)
    if (!match) continue
    if (!bySuffix.has(match[1])) bySuffix.set(match[1], [])
    bySuffix.get(match[1]).push(element)
  }

  assert.equal(bySuffix.size, 4)
  for (const elements of bySuffix.values()) {
    assert.equal(elements.filter((element) => element.kind === 'fill').length, 1)
    assert.equal(elements.filter((element) => element.kind === 'text').length, 2)
    const texts = elements.filter((element) => element.kind === 'text').map((element) => element.text)
    assert.equal(new Set(texts).size, 2, 'heading and body texts should differ within one item')
  }
})

test('COL_MEDIA slide 26 places expanded items left-to-right, not stacked vertically', () => {
  if (!fs.existsSync(sampleReportPath)) return

  const report = JSON.parse(fs.readFileSync(sampleReportPath, 'utf8'))
  const component = findColMediaComponent(report)
  assert.ok(component)

  const instance = component.instances.find((item) => item.slide_number === 26 && item.vgroup_id === 'g1.2.2')
  const model = defaultContainerModel(component, instance)
  model.item_count = 2
  model.items = model.items.slice(0, 2)

  const slide = buildContainerRepeatPreviewSlide(report, component, instance, { modelData: model })
  const boxes = sortItemBoxesLtr(generatedItemBoxes(slide))

  assert.equal(boxes.length, 2)
  assert.ok(Math.abs(boxes[1].x_pt - boxes[0].x_pt) > 100, 'second column should sit to the right of the first')
  assert.ok(Math.abs(boxes[1].y_pt - boxes[0].y_pt) <= boxes[0].height_pt * 0.5, 'both columns should share one row')
})

test('layout split preview on slide 42 flows items LTR inside merged bbox', () => {
  if (!fs.existsSync(sampleReportPath)) return

  const report = JSON.parse(fs.readFileSync(sampleReportPath, 'utf8'))
  const component = listAllComponents(report).find((item) => (
    item.raw?.layout_splits?.some((split) => split.slide_number === 42)
  ))
  assert.ok(component)

  const instance = component.instances.find((item) => item.slide_number === 42)
  const model = defaultContainerModel(component, instance)
  const slide = buildContainerRepeatPreviewSlide(report, component, instance, { modelData: model })
  const playgroundBBox = component.raw.layout_splits.find((split) => split.slide_number === 42).container
  const boxes = sortItemBoxesLtr(generatedItemBoxes(slide))

  assert.equal(boxes.length, 7)
  for (let index = 1; index < boxes.length; index += 1) {
    const prev = boxes[index - 1]
    const next = boxes[index]
    const sameRow = Math.abs(next.y_pt - prev.y_pt) <= prev.height_pt * 0.5
    if (sameRow) assert.ok(next.x_pt >= prev.x_pt - 1, `item ${index} should be to the right of previous`)
  }

  const union = unionBBoxPt(boxes)
  assert.ok(union.x_pt >= playgroundBBox.x_pt - 1)
  assert.ok(union.x_pt + union.width_pt <= playgroundBBox.x_pt + playgroundBBox.width_pt + 1)
})

test('split grid slide 17 renders one card when item_count is 1', () => {
  if (!fs.existsSync(splitGridReportPath)) return

  const report = JSON.parse(fs.readFileSync(splitGridReportPath, 'utf8'))
  const component = findSplitGridSlide17(report)
  assert.ok(component)

  for (const vgroupId of ['g1.2.1', 'g1.2.2']) {
    const instance = component.instances.find((item) => item.slide_number === 17 && item.vgroup_id === vgroupId)
    const model = defaultContainerModel(component, instance)
    model.item_count = 1
    model.items = model.items.slice(0, 1)

    const slide = buildContainerRepeatPreviewSlide(report, component, instance, { modelData: model })
    const boxes = generatedItemBoxes(slide)
    assert.equal(boxes.length, 1, `${vgroupId} should render one visible card`)
  }
})

test('measureRepeatPitch infers column count from LTR item order', () => {
  const boxes = [
    { x_pt: 10, y_pt: 20, width_pt: 80, height_pt: 40 },
    { x_pt: 110, y_pt: 20, width_pt: 80, height_pt: 40 },
    { x_pt: 210, y_pt: 20, width_pt: 80, height_pt: 40 },
    { x_pt: 10, y_pt: 80, width_pt: 80, height_pt: 40 },
  ]
  const pitch = measureRepeatPitch(boxes, 'grid', null)
  assert.equal(pitch.cols, 3)
})

test('normalizeRepeatModelData keeps only items with field data', () => {
  assert.equal(repeatItemHasData({ fields: { heading: 'Ann' } }), true)
  assert.equal(repeatItemHasData({ fields: { heading: '  ' } }), false)

  const normalized = normalizeRepeatModelData({
    item_count: 4,
    items: [
      { index: 1, fields: { heading: 'One', body: 'A' } },
      { index: 2, fields: { heading: 'Two' } },
      { index: 3, fields: {} },
      { index: 4, fields: { body: '   ' } },
    ],
  })

  assert.equal(normalized.item_count, 2)
  assert.equal(normalized.items.length, 2)
  assert.equal(normalized.items[0].fields.heading, 'One')
})

test('canonical heading/body values fill legacy component slot roles', () => {
  const fields = { heading: 'Заголовок', body: 'Основной текст' }

  assert.equal(resolveFieldValue({ kind: 'text', role: 'title' }, fields), 'Заголовок')
  assert.equal(resolveFieldValue({ kind: 'text', role: 'description' }, fields), 'Основной текст')
  assert.equal(resolveFieldValue({ kind: 'text', role: 'text' }, fields), 'Основной текст')
})

test('repeat preview clears template text and renders only filled items', () => {
  if (!fs.existsSync(sampleReportPath)) return

  const report = JSON.parse(fs.readFileSync(sampleReportPath, 'utf8'))
  const component = findRowTextSlide7(report)
  assert.ok(component)

  const instance = component.instances.find((item) => item.slide_number === 7 && item.vgroup_id === 'g1.2.1')
  const model = defaultContainerModel(component, instance)
  model.item_count = 2
  model.items = [
    { index: 1, fields: { heading: 'Alice', body: 'PM' } },
    { index: 2, fields: { heading: 'Bob' } },
  ]

  const sourceSlide = report.slides.slides.find((item) => item.slide_number === 7)
  const templateTextCount = (sourceSlide.content_elements || []).filter((element) => (
    element.kind === 'text' && element.text
  )).length
  assert.ok(templateTextCount >= 4)

  const slide = buildContainerRepeatPreviewSlide(report, component, instance, { modelData: model })
  const generated = slide.content_elements.filter((element) => String(element.element_id).includes('__repeat_'))
  const visibleText = slide.content_elements.filter((element) => element.kind === 'text' && element.text)
  const outsideRepeat = slide.content_elements.filter((element) => (
    element.kind === 'text'
    && element.text
    && !String(element.element_id).includes('__repeat_')
  ))

  assert.equal(generatedItemBoxes(slide).length, 2)
  assert.equal(visibleText.length, 3)
  assert.equal(outsideRepeat.length, 0)
  assert.ok(generated.some((element) => element.text === 'Alice'))
  assert.ok(generated.some((element) => element.text === 'PM'))
  assert.ok(generated.some((element) => element.text === 'Bob'))
  assert.equal(generated.filter((element) => element.text === 'Bob').length, 1)
})

test('a metric item whose value box is tagged as body still gets the value', () => {
  const elements = [
    { kind: 'shape', element_id: 'card' },
    { kind: 'text', element_id: 'number', text: '2', typography: { size_pt: 36 } },
    { kind: 'text', element_id: 'caption', text: 'Второй этап', typography: { size_pt: 16 } },
  ]
  const slots = [{ role: 'background' }, { role: 'body' }, { role: 'body' }]
  const metricFields = { heading: '100%', body: 'соответствие фирменному стилю', metric_value: '100', metric_unit: '%' }

  assert.deepEqual(
    promoteMetricValueSlot(elements, slots, metricFields).map((slot) => slot.role),
    ['background', 'heading', 'body'],
  )
  assert.equal(promoteMetricValueSlot(elements, slots, { body: 'текст' }), slots)
})
