import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { detectSlideVgroups } from './vgroup-detect.js'
import { findSlideTitleElements } from './slide-title-detect.js'

test('findSlideTitleElements prefers top placeholder title', () => {
  const slide = {
    slide_number: 1,
    content_elements: [
      {
        element_id: 'title',
        kind: 'text',
        placeholder_type: 'title',
        geometry_norm: { x: 0.05, y: 0.08, width: 0.9, height: 0.12 },
        typography: { size_pt: 48 },
        text: 'Главный заголовок',
      },
      {
        element_id: 'body',
        kind: 'text',
        geometry_norm: { x: 0.1, y: 0.28, width: 0.35, height: 0.08 },
        typography: { size_pt: 16 },
        text: 'Пункт списка',
      },
    ],
  }

  const result = findSlideTitleElements(slide)
  assert.equal(result.primary.element_id, 'title')
  assert.equal(result.method, 'placeholder')
})

test('detectSlideVgroups includes title in partition analysis', () => {
  const slide = {
    slide_number: 1,
    content_elements: [
      {
        element_id: 'title',
        kind: 'text',
        placeholder_type: 'title',
        geometry_norm: { x: 0.05, y: 0.08, width: 0.9, height: 0.12 },
        typography: { size_pt: 48 },
        text: 'Заголовок',
      },
      { element_id: 'n1', kind: 'text', z_index: 1, geometry_norm: { x: 0.1, y: 0.28, width: 0.2, height: 0.05 } },
      { element_id: 'n2', kind: 'text', z_index: 2, geometry_norm: { x: 0.1, y: 0.35, width: 0.2, height: 0.05 } },
      { element_id: 'n3', kind: 'text', z_index: 3, geometry_norm: { x: 0.1, y: 0.42, width: 0.2, height: 0.05 } },
    ],
  }

  const result = detectSlideVgroups(slide)
  const allIds = new Set([
    ...result.groups.flatMap((group) => group.elements.map((element) => element.element_id)),
    ...result.ungroupedElements.map((element) => element.element_id),
  ])
  assert.ok(allIds.has('title'))
})

test('findSlideTitleElements uses spatial report when available', () => {
  const report = JSON.parse(readFileSync(new URL('../../../output/625114b1c763/report.json', import.meta.url)))
  const slide = report.slides.slides.find((item) => item.slide_number === 3)
  const result = findSlideTitleElements(slide, report)
  assert.ok(result.elementIds.size >= 1)
  assert.notEqual(result.method, 'none')
})
