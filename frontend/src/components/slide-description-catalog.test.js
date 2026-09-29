import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  buildDescriptionTextFromWords,
  defaultSlideDescriptionModel,
  listSlideDescriptionComponents,
} from './slide-description-catalog.js'
import { buildSlideDescriptionPreviewView } from './slide-description-render.js'
import { findSlideDescriptionElements } from '../slides/slide-description-detect.js'
import { listAllComponents } from './catalog.js'
import { matchSlideDescriptionComponent } from '../presentation/match-relevant-components.js'
import { normalizeSlideSpec } from '../presentation/slide-spec.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const spatialReportPath = path.resolve(__dirname, '../../../output/b13e9370de41/report.json')

function assetLayers() {
  return Array.from({ length: 14 }, (_, index) => ({
    layer_id: `asset_${index}`,
    kind: 'fill',
    geometry_norm: {
      x: 0.05 + (index % 7) * 0.12,
      y: 0.45 + Math.floor(index / 7) * 0.12,
      width: 0.035,
      height: 0.045,
    },
  }))
}

function descriptionSlide(slideNumber, templateId, { asset = false } = {}) {
  return {
    slide_number: slideNumber,
    template_id: templateId,
    render: {
      slide_size_pt: { width: 960, height: 540 },
      layers: asset ? assetLayers() : [],
    },
    content_elements: [
      {
        element_id: `title_${slideNumber}`,
        kind: 'text',
        role: 'title',
        text: `Заголовок ${slideNumber}`,
        geometry_pt: { x_pt: 80, y_pt: 60, width_pt: 720, height_pt: 60 },
        geometry_norm: { x: 80 / 960, y: 60 / 540, width: 720 / 960, height: 60 / 540 },
        typography: { size_pt: 32, family: 'Play' },
      },
      {
        element_id: `body_${slideNumber}`,
        kind: 'text',
        role: 'body',
        text: `Описание слайда ${slideNumber} с достаточно длинным текстом для определения абзаца.`,
        geometry_pt: { x_pt: 80, y_pt: 150, width_pt: 640, height_pt: 90 },
        geometry_norm: { x: 80 / 960, y: 150 / 540, width: 640 / 960, height: 90 / 540 },
        typography: { size_pt: 18, family: 'Play' },
      },
    ],
  }
}

test('listSlideDescriptionComponents detects intro paragraphs near titles', () => {
  if (!fs.existsSync(spatialReportPath)) return

  const report = JSON.parse(fs.readFileSync(spatialReportPath, 'utf8'))
  const items = listSlideDescriptionComponents(report)

  assert.ok(items.length >= 1)
  assert.equal(items[0].component_id, 'desc_001')
  assert.ok(items[0].instances.length >= 2)
  assert.ok(items[0].capacity.word_count_typical >= 8)
})

test('findSlideDescriptionElements skips speaker row text in image flex groups', () => {
  if (!fs.existsSync(spatialReportPath)) return

  const report = JSON.parse(fs.readFileSync(spatialReportPath, 'utf8'))
  const slide = report.slides.slides.find((item) => item.slide_number === 3)
  const result = findSlideDescriptionElements(slide, report)

  assert.equal(result.elementIds.length, 0)
  assert.equal(result.method, 'none')
})

test('findSlideDescriptionElements prefers wide paragraph under heading', () => {
  if (!fs.existsSync(spatialReportPath)) return

  const report = JSON.parse(fs.readFileSync(spatialReportPath, 'utf8'))
  const slide = report.slides.slides.find((item) => item.slide_number === 24)
  const result = findSlideDescriptionElements(slide, report)

  assert.ok(result.elementIds.length >= 1)
  assert.ok(result.score >= 40)
  assert.ok((result.primary.text || result.primary.text_sample || '').length >= 20)
})

test('slide description catalog drops asset-board-only text components', () => {
  const report = {
    slides: {
      slides: [
        descriptionSlide(1, 'tmpl_assets', { asset: true }),
        descriptionSlide(2, 'tmpl_assets', { asset: true }),
      ],
    },
    slide_templates: {
      templates: [
        { template_id: 'tmpl_assets', layout_name: 'Assets', editable_slots: [], render: { layers: assetLayers() } },
      ],
    },
  }

  const component = listAllComponents(report).find((item) => item.kind === 'slide_description')

  assert.equal(component, undefined)
})

test('slide description appears in catalog and preview updates paragraph text', () => {
  if (!fs.existsSync(spatialReportPath)) return

  const report = JSON.parse(fs.readFileSync(spatialReportPath, 'utf8'))
  const component = listAllComponents(report).find((item) => item.kind === 'slide_description')
  assert.ok(component)

  const model = {
    ...defaultSlideDescriptionModel(component),
    word_count: 24,
    text: buildDescriptionTextFromWords(component.defaultPhrase, 24),
  }
  const view = buildSlideDescriptionPreviewView(report, component, { modelData: model })
  assert.ok(view.slide)

  const descriptionIds = new Set(view.instance.element_ids || [])
  const patched = view.slide.content_elements.filter((element) => descriptionIds.has(element.element_id))
  const filled = patched.filter((element) => element.text)
  assert.ok(patched.length >= 1)
  assert.ok(filled.length >= 1)
  assert.equal(filled[0].text, model.text)
  if (patched.length > 1) {
    assert.ok(filled.length <= patched.length)
  }
})

test('matchSlideDescriptionComponent maps slide.text when title is present', () => {
  if (!fs.existsSync(spatialReportPath)) return

  const report = JSON.parse(fs.readFileSync(spatialReportPath, 'utf8'))
  const spec = normalizeSlideSpec({
    index: 1,
    intent: 'content',
    title: 'Заголовок',
    text: 'Вводный абзац с пояснением темы слайда и контекстом для аудитории.',
    context: {},
  })

  const match = matchSlideDescriptionComponent(report, spec)
  assert.ok(match?.component)
  assert.equal(match.component.kind, 'slide_description')
  assert.equal(match.payload.text, spec.text)
})
