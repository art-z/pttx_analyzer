import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { listAllComponents } from './catalog.js'
import { listSlideDescriptionComponents } from './slide-description-catalog.js'
import { buildSlideDescriptionPreviewView } from './slide-description-render.js'
import { patchCatalogSlideScenarioText } from '../presentation/build-catalog-slide.js'
import {
  buildSyntheticSlideDescriptionInstances,
  resolveDeckForVerticalRepeatText,
  textColumnFromRepeatItems,
} from './vertical-repeat-text-catalog.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const colMediaReportPath = path.resolve(__dirname, '../../../output/f7f5c7202d32/report.json')

test('text fallback copies the repeat body style and text column', () => {
  const column = textColumnFromRepeatItems([
    {
      elements: [
        { kind: 'image', geometry_norm: { x: 0.05, y: 0.2, width: 0.12, height: 0.12 } },
        {
          kind: 'text',
          text_line_index: 0,
          typography: { family: 'Play', size_pt: 18, color: '#0077FF' },
          geometry_norm: { x: 0.44, y: 0.12, width: 0.48, height: 0.25 },
          geometry_pt: { x_pt: 422, y_pt: 65, width_pt: 461, height_pt: 135 },
        },
        {
          kind: 'text',
          text_line_index: 1,
          typography: {
            family: 'Play',
            size_pt: 14,
            color: '#E4E7EA',
            alignment: 'l',
            line_height_pt: 14,
            line_height_ratio: 1,
          },
          geometry_norm: { x: 0.44, y: 0.12, width: 0.48, height: 0.25 },
          geometry_pt: { x_pt: 422, y_pt: 65, width_pt: 461, height_pt: 135 },
        },
      ],
    },
    {
      elements: [
        {
          kind: 'text',
          text_line_index: 1,
          typography: { family: 'Play', size_pt: 14, color: '#E4E7EA', alignment: 'l' },
          geometry_norm: { x: 0.44, y: 0.66, width: 0.48, height: 0.25 },
          geometry_pt: { x_pt: 422, y_pt: 356, width_pt: 461, height_pt: 135 },
        },
      ],
    },
  ], { width: 960, height: 540 })

  assert.equal(column.typography.size_pt, 14)
  assert.equal(column.typography.color, '#E4E7EA')
  assert.equal(column.typography.family, 'Play')
  assert.equal(column.bboxPt.x_pt, 422)
  assert.ok(column.bboxPt.height_pt > 300)
  assert.ok(column.bboxPt.x_pt > 100)
})

test('creates synthetic slide_description component from vertical repeats when detection finds nothing', () => {
  if (!fs.existsSync(colMediaReportPath)) return

  const report = JSON.parse(fs.readFileSync(colMediaReportPath, 'utf8'))
  const deck = resolveDeckForVerticalRepeatText(report)
  const synthetic = buildSyntheticSlideDescriptionInstances(report, deck)

  assert.ok(synthetic.length >= 2)
  assert.ok(synthetic.every((item) => item.synthetic))
  assert.ok(synthetic.every((item) => item.detection_method === 'under_title'))
  assert.ok(synthetic.every((item) => item.typography?.color))
  assert.ok(synthetic.every((item) => item.container?.width_pt > 0))

  const components = listSlideDescriptionComponents(report, { deck })
  assert.equal(components.length, 1)
  assert.equal(components[0].component_id, 'desc_synthetic_001')
  assert.equal(components[0].behavior?.synthetic_from_vertical_repeat, true)
  assert.ok(components[0].instances.some((item) => item.slide_number === 5))
  assert.ok(components[0].instances.some((item) => item.slide_number === 10))

  const catalog = listAllComponents(report)
  assert.equal(catalog.filter((item) => item.kind === 'slide_description').length, 1)

  const component = catalog.find((item) => item.kind === 'slide_description')
  const preview = buildSlideDescriptionPreviewView(report, component, {
    instance: component.instances.find((item) => item.slide_number === 5),
  })
  assert.ok(preview.slide)
  assert.ok(preview.bboxPt?.width_pt > 400)

  const sourceSlide = report.slides.slides.find((item) => item.slide_number === 5)
  const patched = patchCatalogSlideScenarioText(report, structuredClone(sourceSlide), {
    title: '',
    text: 'Synthetic fallback для сценарного слайда',
    lists: [],
    metrics: [],
    quotes: [],
    persons: [],
    snippets: [],
  })
  const fallbackElement = patched.content_elements.find((element) => (
    element.synthetic && element.element_id.startsWith('synthetic_slide_description_')
  ))
  assert.ok(fallbackElement)
  assert.equal(fallbackElement.text, 'Synthetic fallback для сценарного слайда')
})
