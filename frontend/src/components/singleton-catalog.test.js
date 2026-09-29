import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  assessComponentIterability,
  isUniformTextContentRepeat,
} from './from-vgroups.js'
import { isIterableRepeatComponent } from './container-catalog.js'
import { listAllComponents } from './catalog.js'
import { detectSlideSingletons, SINGLETON_PATTERNS } from '../slides/singleton-detect.js'
import { decomposeSlideByNumber } from '../slides/slide-decomposition.js'
import { listSingletonComponents } from './singleton-catalog.js'
import { collectRepeatElementIds } from './from-vgroups.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const spatialReportPath = path.resolve(__dirname, '../../../output/b13e9370de41/report.json')

test('isUniformTextContentRepeat demotes single-style text-only signatures', () => {
  assert.equal(isUniformTextContentRepeat('s[t16]'), true)
  assert.equal(isUniformTextContentRepeat('tg[t16,t16,t16]'), true)
  assert.equal(isUniformTextContentRepeat('s[t18,t14]'), false)
  assert.equal(isUniformTextContentRepeat('y[i,y[t20,t14]]'), false)
  assert.equal(isUniformTextContentRepeat('x[f,t16]'), false)
})

test('assessComponentIterability marks uniform text-only repeats as non-iterable', () => {
  const iter = assessComponentIterability(
    [{ slide_number: 1, repeat: { count: 4 }, slots: [{ kind: 'text', size_pt: 16 }] }],
    's[t16]',
  )

  assert.equal(iter.checks.text_content_only, true)
  assert.equal(iter.is_iterable, false)
})

test('singleton metric classification accepts a sufficiently large bare number with description', () => {
  const fill = { kind: 'fill', element_id: 'fill', geometry_norm: { x: 0.1, y: 0.2, width: 0.3, height: 0.3 } }
  const caption = { kind: 'text', element_id: 'caption', text: 'Рост', typography: { size_pt: 16 } }
  const group = {
    id: 'card',
    layout: 'column',
    bboxNorm: { x: 0.1, y: 0.2, width: 0.3, height: 0.3 },
    kindCounts: { fill: 1, image: 0 },
    elements: [
      fill,
      { kind: 'text', element_id: 'value', text: '43', typography: { size_pt: 32 } },
      caption,
    ],
  }
  const options = {
    vgroupResult: { groups: [group], ungroupedElements: [] },
    titleResult: { elementIds: [] },
  }

  assert.equal(detectSlideSingletons({ content_elements: group.elements }, {}, options).singletons.length, 0)
  group.elements[1].typography.size_pt = 64
  const result = detectSlideSingletons({ content_elements: group.elements }, {}, options)
  assert.equal(result.singletons[0]?.pattern, SINGLETON_PATTERNS.metric_card)
})

test('detectSlideSingletons finds metric card on slide 18 g1.2.1', () => {
  if (!fs.existsSync(spatialReportPath)) return

  const report = JSON.parse(fs.readFileSync(spatialReportPath, 'utf8'))
  const slide = report.slides.slides.find((item) => item.slide_number === 18)
  const repeatElementIds = collectRepeatElementIds(report, 18)
  const result = detectSlideSingletons(slide, report, { repeatElementIds })
  const metric = result.singletons.find((item) => item.pattern === SINGLETON_PATTERNS.metric_card)

  assert.ok(metric)
  assert.equal(metric.vgroup_id, 'g1.2.1')
  assert.ok(metric.element_ids.some((id) => id.includes('slide_text_106')))
  assert.ok(metric.element_ids.some((id) => id.includes('slide_text_107')))
  assert.ok(metric.element_ids.some((id) => id.includes('slide_shape_100')))
})

test('decomposeSlideByNumber keeps KPI card out of slide_description on slide 18', () => {
  if (!fs.existsSync(spatialReportPath)) return

  const report = JSON.parse(fs.readFileSync(spatialReportPath, 'utf8'))
  const decomposition = decomposeSlideByNumber(report, 18)

  assert.ok(decomposition.singletons.some((item) => item.pattern === SINGLETON_PATTERNS.metric_card))
  assert.equal(decomposition.description, null)
  assert.equal(decomposition.uncovered.length, 0)
})

test('detectSlideSingletons finds speaker card on slide 3', () => {
  if (!fs.existsSync(spatialReportPath)) return

  const report = JSON.parse(fs.readFileSync(spatialReportPath, 'utf8'))
  const slide = report.slides.slides.find((item) => item.slide_number === 3)
  const result = detectSlideSingletons(slide, report)

  const speaker = result.singletons.find((item) => item.pattern === SINGLETON_PATTERNS.speaker_card)
  assert.ok(speaker)
  assert.ok(speaker.element_ids.some((id) => id.includes('slide_text_100')))
  assert.ok(speaker.element_ids.some((id) => id.includes('slide_pic_102')))
})

test('decomposeSlideByNumber covers speaker card and excludes it from slide_description', () => {
  if (!fs.existsSync(spatialReportPath)) return

  const report = JSON.parse(fs.readFileSync(spatialReportPath, 'utf8'))
  const decomposition = decomposeSlideByNumber(report, 3)

  assert.ok(decomposition.title)
  assert.equal(decomposition.description, null)
  assert.ok(decomposition.singletons.some((item) => item.pattern === SINGLETON_PATTERNS.speaker_card))
  assert.equal(decomposition.uncovered.length, 0)
  assert.equal(decomposition.coverage.ratio, 1)
})

test('listSingletonComponents exposes speaker singleton in catalog', () => {
  if (!fs.existsSync(spatialReportPath)) return

  const report = JSON.parse(fs.readFileSync(spatialReportPath, 'utf8'))
  const items = listSingletonComponents(report)
  const speaker = items.find((item) => item.pattern === SINGLETON_PATTERNS.speaker_card)

  assert.ok(speaker)
  assert.ok(speaker.instances.some((item) => item.slide_number === 3))
})

test('text-only uniform repeats move from repeats to containers group', () => {
  if (!fs.existsSync(spatialReportPath)) return

  const report = JSON.parse(fs.readFileSync(spatialReportPath, 'utf8'))
  const items = listAllComponents(report)
  const uniformText = items.find((item) => item.variantSignature === 's[t16]' || item.raw?.signature === 's[t16]')

  if (uniformText) {
    assert.equal(isIterableRepeatComponent(uniformText), false)
    assert.equal(uniformText.group, 'containers')
    assert.equal(uniformText.raw?.iterability?.checks?.text_content_only, true)
  }
})
