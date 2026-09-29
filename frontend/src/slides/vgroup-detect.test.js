import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  boxesNear,
  detectSlideVgroups,
  findBestSplit,
  inferGroupLayout,
  prepareUnits,
  resolveSlideAspect,
} from './vgroup-detect.js'
import {
  collectGraphicExcludedElementIds,
  isGraphicStructuralElement,
} from './graphic-region-exclude.js'
import { collectNodeElements, walkTree } from './vgroup-partition.js'
import { relativizeGeometryNorm } from './vgroup-geometry.js'
import { detectComponentsFromVgroups } from '../components/from-vgroups.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const chartReportPath = path.resolve(__dirname, '../../../output/b13e9370de41/report.json')
const spatialReportPath = chartReportPath
const spatialInferencePatchesPath = path.resolve(__dirname, '../../../tests/fixtures/spatial_slides_46_48_inference.json')

function applySpatialInferencePatches(report) {
  if (!fs.existsSync(spatialInferencePatchesPath)) return report
  const patches = JSON.parse(fs.readFileSync(spatialInferencePatchesPath, 'utf8'))
  return {
    ...report,
    slides: {
      ...report.slides,
      slides: report.slides.slides.map((slide) => {
        const patch = patches[String(slide.slide_number)]
        return patch ? { ...slide, ...patch } : slide
      }),
    },
  }
}

test('boxesNear joins adjacent blocks', () => {
  const left = { x: 0.1, y: 0.2, width: 0.2, height: 0.1 }
  const right = { x: 0.31, y: 0.2, width: 0.2, height: 0.1 }
  assert.equal(boxesNear(left, right, 0.04), true)
})

test('detectSlideVgroups builds nested groups for two columns', () => {
  const slide = {
    slide_number: 1,
    content_elements: [
      { element_id: 'n1', kind: 'text', z_index: 1, geometry_norm: { x: 0.1, y: 0.2, width: 0.2, height: 0.05 } },
      { element_id: 'n2', kind: 'text', z_index: 2, geometry_norm: { x: 0.1, y: 0.27, width: 0.2, height: 0.05 } },
      { element_id: 'n3', kind: 'text', z_index: 3, geometry_norm: { x: 0.1, y: 0.34, width: 0.2, height: 0.05 } },
      { element_id: 'n4', kind: 'fill', z_index: 4, geometry_norm: { x: 0.6, y: 0.2, width: 0.2, height: 0.05 } },
      { element_id: 'n5', kind: 'text', z_index: 5, geometry_norm: { x: 0.6, y: 0.27, width: 0.2, height: 0.05 } },
      { element_id: 'n6', kind: 'text', z_index: 6, geometry_norm: { x: 0.6, y: 0.34, width: 0.2, height: 0.05 } },
    ],
  }

  const result = detectSlideVgroups(slide)
  assert.equal(result.tree.kind, 'branch')
  assert.equal(result.tree.axis, 'x')
  assert.ok(result.summary.groupCount >= 3)
  assert.ok(result.groups.some((group) => group.id === 'g1' && group.layout === 'row' && group.flex))
  assert.ok(result.groups.some((group) => group.id === 'g1.1' && group.layout === 'column'))
  assert.ok(result.groups.some((group) => group.id === 'g1.2' && group.layout === 'column'))
  assert.equal(inferGroupLayout(result.groups.find((group) => group.id === 'g1.1').elements), 'column')
  assert.equal(result.summary.ungroupedElementCount, 0)
})

test('background plate becomes a container and does not block the inner column split', () => {
  const slide = {
    slide_number: 1,
    content_elements: [
      { element_id: 'bg', kind: 'fill', z_index: 0, geometry_norm: { x: 0.05, y: 0.15, width: 0.9, height: 0.7 } },
      { element_id: 'l1', kind: 'text', z_index: 2, geometry_norm: { x: 0.08, y: 0.2, width: 0.35, height: 0.05 } },
      { element_id: 'l2', kind: 'text', z_index: 3, geometry_norm: { x: 0.08, y: 0.28, width: 0.35, height: 0.05 } },
      { element_id: 'r1', kind: 'text', z_index: 4, geometry_norm: { x: 0.55, y: 0.2, width: 0.35, height: 0.05 } },
      { element_id: 'r2', kind: 'text', z_index: 5, geometry_norm: { x: 0.55, y: 0.28, width: 0.35, height: 0.05 } },
    ],
  }

  const result = detectSlideVgroups(slide)
  assert.equal(result.tree.kind, 'container')
  assert.equal(result.summary.containers, 1)
  assert.equal(result.tree.content.kind, 'branch')
  assert.equal(result.tree.content.axis, 'x')
  assert.ok(result.summary.groupCount >= 3)
  assert.equal(result.summary.ungroupedElementCount, 0)
})

test('title participates in partition analysis', () => {
  const slide = {
    slide_number: 1,
    content_elements: [
      {
        element_id: 'title',
        kind: 'text',
        placeholder_type: 'title',
        geometry_norm: { x: 0.05, y: 0.08, width: 0.9, height: 0.12 },
        typography: { size_pt: 48 },
      },
      { element_id: 'n1', kind: 'text', geometry_norm: { x: 0.6, y: 0.2, width: 0.2, height: 0.05 } },
      { element_id: 'n2', kind: 'text', geometry_norm: { x: 0.6, y: 0.27, width: 0.2, height: 0.05 } },
      { element_id: 'n3', kind: 'text', geometry_norm: { x: 0.6, y: 0.34, width: 0.2, height: 0.05 } },
    ],
  }

  const result = detectSlideVgroups(slide)
  assert.ok(result.slideTitle.elementIds.includes('title'))
  assert.equal(result.tree.children[0].pinned, true)
  const groupedIds = new Set(result.groups.flatMap((group) => group.elements.map((element) => element.element_id)))
  const allIds = new Set([...groupedIds, ...result.ungroupedElements.map((element) => element.element_id)])
  assert.ok(allIds.has('title'))
})

test('findBestSplit detects vertical valley between columns', () => {
  const { topLevel } = prepareUnits([
    { element_id: 'l1', kind: 'text', geometry_norm: { x: 0.08, y: 0.2, width: 0.3, height: 0.05 } },
    { element_id: 'r1', kind: 'text', geometry_norm: { x: 0.58, y: 0.2, width: 0.3, height: 0.05 } },
  ])
  const split = findBestSplit(topLevel, null, { aspect: 9 / 16 })
  assert.ok(split)
  assert.equal(split.axis, 'x')
  assert.equal(split.method, 'gap')
})

test('every element ends up exactly once in the tree, separators included', () => {
  const slide = {
    slide_number: 1,
    render: { slide_size_pt: { width: 960, height: 540 } },
    content_elements: [
      { element_id: 'title', kind: 'text', z_index: 1, geometry_norm: { x: 0.05, y: 0.1, width: 0.9, height: 0.1 } },
      { element_id: 'rule', kind: 'line', z_index: 2, geometry_norm: { x: 0.05, y: 0.3, width: 0.9, height: 0.001 } },
      { element_id: 'a', kind: 'text', z_index: 3, geometry_norm: { x: 0.05, y: 0.35, width: 0.4, height: 0.1 } },
      { element_id: 'b', kind: 'text', z_index: 4, geometry_norm: { x: 0.55, y: 0.35, width: 0.4, height: 0.1 } },
      { element_id: 'dot', kind: 'fill', z_index: 5, geometry_norm: { x: 0.05, y: 0.5, width: 0.002, height: 0.002 } },
    ],
  }
  const result = detectSlideVgroups(slide)
  assert.equal(resolveSlideAspect(slide), 540 / 960)
  const ids = collectNodeElements(result.tree).map((element) => element.element_id).sort()
  assert.deepEqual(ids, ['a', 'b', 'dot', 'rule', 'title'])
  assert.equal(result.summary.ungroupedElementCount, 0)
  let floating = 0
  walkTree(result.tree, (node) => { floating += node.floating.length })
  assert.equal(floating, 2)
})

test('thin decorative rule images are separators and do not break fill repeats', () => {
  const slide = {
    slide_number: 48,
    render: { slide_size_pt: { width: 960, height: 540 } },
    content_elements: [
      { element_id: 'rule', kind: 'image', z_index: 1, geometry_norm: { x: 0.034, y: 0.42, width: 0.9312, height: 0.018 } },
      { element_id: 'dot1', kind: 'fill', z_index: 2, geometry_norm: { x: 0.1, y: 0.45, width: 0.0199, height: 0.0355 } },
      { element_id: 'dot2', kind: 'fill', z_index: 3, geometry_norm: { x: 0.4, y: 0.45, width: 0.0199, height: 0.0355 } },
      { element_id: 'dot3', kind: 'fill', z_index: 4, geometry_norm: { x: 0.7, y: 0.45, width: 0.0199, height: 0.0355 } },
    ],
  }

  const { floating } = prepareUnits(slide.content_elements)
  assert.equal(floating.length, 1)
  assert.equal(floating[0].members[0].element_id, 'rule')

  const result = detectSlideVgroups(slide)
  const fillRepeat = result.groups.find((group) => group.repeat?.itemSig === 'f')
  assert.ok(fillRepeat)
  assert.equal(fillRepeat.repeat.count, 3)
})

test('collectGraphicExcludedElementIds gathers inferred chart and native graphic frames', () => {
  const slide = {
    inferred_chart: { confidence: 0.98, consumed_element_ids: ['bar1', 'axis1'] },
    inferred_circular_charts: [{ confidence: 0.8, consumed_element_ids: ['pie1', 'pie2'] }],
    content_elements: [
      { element_id: 'bar1', kind: 'fill' },
      { element_id: 'axis1', kind: 'text' },
      { element_id: 'tbl1', kind: 'table', inference: { consumed_element_ids: ['cell1', 'cell2'] } },
      { element_id: 'card1', kind: 'fill' },
    ],
  }

  const ids = collectGraphicExcludedElementIds(slide)
  assert.equal(ids.size, 7)
  assert.equal(isGraphicStructuralElement({ element_id: 'bar1', kind: 'fill' }, ids), true)
  assert.equal(isGraphicStructuralElement({ element_id: 'card1', kind: 'fill' }, ids), false)
  assert.equal(isGraphicStructuralElement({ element_id: 'tbl1', kind: 'table' }, ids), true)
})

test('low-confidence inferred chart does not exclude card-like repeats', () => {
  const slide = {
    slide_number: 17,
    inferred_chart: {
      confidence: 0.685,
      consumed_element_ids: ['bar1', 'axis1', 'axis2'],
    },
    content_elements: [
      { element_id: 'bar1', kind: 'fill', geometry_norm: { x: 0.1, y: 0.2, width: 0.1, height: 0.2 } },
      { element_id: 'axis1', kind: 'text', geometry_norm: { x: 0.1, y: 0.42, width: 0.1, height: 0.05 } },
      { element_id: 'axis2', kind: 'text', geometry_norm: { x: 0.3, y: 0.42, width: 0.1, height: 0.05 } },
      { element_id: 'bar2', kind: 'fill', geometry_norm: { x: 0.3, y: 0.2, width: 0.1, height: 0.2 } },
    ],
  }

  const ids = collectGraphicExcludedElementIds(slide)
  assert.equal(ids.size, 0)

  const result = detectSlideVgroups(slide)
  assert.ok(result.groups.some((group) => group.repeat?.count >= 2))
})

test('inferred chart region elements are excluded from vgroup partition and repeats', () => {
  const slide = {
    slide_number: 1,
    inferred_chart: {
      confidence: 0.98,
      consumed_element_ids: ['bar1', 'bar2', 'bar3', 'axis1', 'axis2', 'axis3', 'legend1'],
    },
    content_elements: [
      { element_id: 'bar1', kind: 'fill', z_index: 10, geometry_norm: { x: 0.1, y: 0.5, width: 0.05, height: 0.2 } },
      { element_id: 'bar2', kind: 'fill', z_index: 11, geometry_norm: { x: 0.2, y: 0.45, width: 0.05, height: 0.25 } },
      { element_id: 'bar3', kind: 'fill', z_index: 12, geometry_norm: { x: 0.3, y: 0.4, width: 0.05, height: 0.3 } },
      { element_id: 'axis1', kind: 'text', z_index: 13, geometry_norm: { x: 0.1, y: 0.72, width: 0.05, height: 0.03 } },
      { element_id: 'axis2', kind: 'text', z_index: 14, geometry_norm: { x: 0.2, y: 0.72, width: 0.05, height: 0.03 } },
      { element_id: 'axis3', kind: 'text', z_index: 15, geometry_norm: { x: 0.3, y: 0.72, width: 0.05, height: 0.03 } },
      { element_id: 'legend1', kind: 'text', z_index: 16, geometry_norm: { x: 0.7, y: 0.1, width: 0.2, height: 0.05 } },
      { element_id: 'c1f', kind: 'fill', z_index: 1, geometry_norm: { x: 0.1, y: 0.1, width: 0.15, height: 0.2 } },
      { element_id: 'c1t', kind: 'text', z_index: 2, geometry_norm: { x: 0.1, y: 0.12, width: 0.15, height: 0.05 } },
      { element_id: 'c2f', kind: 'fill', z_index: 3, geometry_norm: { x: 0.3, y: 0.1, width: 0.15, height: 0.2 } },
      { element_id: 'c2t', kind: 'text', z_index: 4, geometry_norm: { x: 0.3, y: 0.12, width: 0.15, height: 0.05 } },
    ],
  }

  const result = detectSlideVgroups(slide)
  const groupedIds = new Set(result.groups.flatMap((group) => group.elements.map((element) => element.element_id)))

  for (const id of slide.inferred_chart.consumed_element_ids) {
    assert.equal(groupedIds.has(id), false, `${id} should stay out of vgroups`)
  }

  assert.equal(result.summary.excludedGraphicElements, 7)
  assert.equal(result.groups.some((group) => group.repeat?.count >= 3 && group.elements.some((element) => (
    slide.inferred_chart.consumed_element_ids.includes(element.element_id)
  ))), false)
})

test('real inferred chart slide keeps chart primitives out of repeatable components', () => {
  if (!fs.existsSync(chartReportPath)) return

  const report = JSON.parse(fs.readFileSync(chartReportPath, 'utf8'))
  const slide = report.slides.slides.find((item) => item.slide_number === 43)
  assert.ok(slide?.inferred_chart)

  const consumed = new Set(slide.inferred_chart.consumed_element_ids || [])
  const result = detectSlideVgroups(slide, { report })
  const groupedIds = new Set(result.groups.flatMap((group) => group.elements.map((element) => element.element_id)))
  const overlap = [...consumed].filter((id) => groupedIds.has(id))

  assert.equal(overlap.length, 0)
  assert.ok(result.summary.excludedGraphicElements >= consumed.size)

  const catalog = detectComponentsFromVgroups(report)
  const chartLikeRepeat = catalog.components.find((component) => (
    component.instances.some((instance) => instance.slide_number === 43)
    && component.instances.some((instance) => (
      (instance.element_ids || []).some((id) => consumed.has(id))
    ))
  ))
  assert.equal(chartLikeRepeat, undefined)
})

test('inferred flow diagram keeps connectors and node boxes out of vgroup repeats', () => {
  const slide = {
    slide_number: 13,
    inferred_diagram: {
      confidence: 0.9,
      diagram_type_guess: 'flow',
      consumed_element_ids: ['box1', 'box1t', 'box2', 'box2t', 'arrow1', 'arrow2', 'arrow3'],
    },
    content_elements: [
      {
        element_id: 'title',
        kind: 'text',
        text: 'Оформление схем',
        geometry_norm: { x: 0.05, y: 0.08, width: 0.9, height: 0.1 },
      },
      {
        element_id: 'box1',
        kind: 'fill',
        geometry_norm: { x: 0.1, y: 0.3, width: 0.15, height: 0.12 },
      },
      {
        element_id: 'box1t',
        kind: 'text',
        text: 'Шаг 1',
        geometry_norm: { x: 0.11, y: 0.33, width: 0.13, height: 0.05 },
      },
      {
        element_id: 'box2',
        kind: 'fill',
        geometry_norm: { x: 0.35, y: 0.3, width: 0.15, height: 0.12 },
      },
      {
        element_id: 'box2t',
        kind: 'text',
        text: 'Шаг 2',
        geometry_norm: { x: 0.36, y: 0.33, width: 0.13, height: 0.05 },
      },
      {
        element_id: 'arrow1',
        kind: 'line',
        geometry_norm: { x: 0.25, y: 0.35, width: 0.1, height: 0.002 },
        stroke: { tail: { type: 'triangle' } },
      },
      {
        element_id: 'arrow2',
        kind: 'line',
        geometry_norm: { x: 0.5, y: 0.35, width: 0.1, height: 0.002 },
        stroke: { tail: { type: 'triangle' } },
      },
      {
        element_id: 'arrow3',
        kind: 'line',
        geometry_norm: { x: 0.25, y: 0.5, width: 0.002, height: 0.1 },
        stroke: { tail: { type: 'triangle' } },
      },
    ],
  }

  const result = detectSlideVgroups(slide)
  const groupedIds = new Set(result.groups.flatMap((group) => group.elements.map((element) => element.element_id)))

  for (const id of slide.inferred_diagram.consumed_element_ids) {
    assert.equal(groupedIds.has(id), false, `${id} should stay out of vgroups`)
  }

  assert.equal(result.summary.repeats, 0)
  assert.ok(!result.groups.some((group) => group.repeat?.count >= 2))
})

test('spatial slide 46 doughnut grid and captions stay out of vgroup repeats', () => {
  if (!fs.existsSync(spatialReportPath) || !fs.existsSync(spatialInferencePatchesPath)) return

  const report = applySpatialInferencePatches(JSON.parse(fs.readFileSync(spatialReportPath, 'utf8')))
  const slide = report.slides.slides.find((item) => item.slide_number === 46)
  assert.ok(slide?.inferred_circular_charts?.length)

  const consumed = new Set(
    slide.inferred_circular_charts.flatMap((chart) => chart.consumed_element_ids || []),
  )
  const result = detectSlideVgroups(slide, { report })
  const groupedIds = new Set(result.groups.flatMap((group) => group.elements.map((element) => element.element_id)))
  const overlap = [...consumed].filter((id) => groupedIds.has(id))

  assert.equal(overlap.length, 0)
  assert.equal(result.summary.repeats, 0)
  assert.ok(result.summary.excludedGraphicElements >= consumed.size)

  const catalog = detectComponentsFromVgroups(report)
  const iterableOnSlide = catalog.components.filter((component) => (
    component.iterability?.is_iterable
    && component.instances.some((instance) => instance.slide_number === 46)
  ))
  assert.equal(iterableOnSlide.length, 0)
})

test('spatial slide 48 legend plus chart image stays out of vgroup repeats', () => {
  if (!fs.existsSync(spatialReportPath) || !fs.existsSync(spatialInferencePatchesPath)) return

  const report = applySpatialInferencePatches(JSON.parse(fs.readFileSync(spatialReportPath, 'utf8')))
  const slide = report.slides.slides.find((item) => item.slide_number === 48)
  assert.ok(slide?.inferred_chart)

  const consumed = new Set(slide.inferred_chart.consumed_element_ids || [])
  const result = detectSlideVgroups(slide, { report })
  const groupedIds = new Set(result.groups.flatMap((group) => group.elements.map((element) => element.element_id)))
  const overlap = [...consumed].filter((id) => groupedIds.has(id))

  assert.equal(overlap.length, 0)
  assert.equal(result.summary.repeats, 0)
  assert.ok(result.summary.excludedGraphicElements >= consumed.size)

  const catalog = detectComponentsFromVgroups(report)
  const iterableOnSlide = catalog.components.filter((component) => (
    component.iterability?.is_iterable
    && component.instances.some((instance) => instance.slide_number === 48)
  ))
  assert.equal(iterableOnSlide.length, 0)
})

test('relativizeGeometryNorm preserves relative placement', () => {
  const container = { x: 0.5, y: 0.2, width: 0.4, height: 0.5 }
  const element = { x: 0.55, y: 0.25, width: 0.1, height: 0.1 }
  const relative = relativizeGeometryNorm(element, container)
  assert.ok(Math.abs(relative.x - 0.125) < 0.0001)
  assert.ok(Math.abs(relative.y - 0.1) < 0.0001)
})
