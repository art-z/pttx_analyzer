import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  buildTitleTextFromWords,
  defaultSlideTitleModel,
  listSlideTitleComponents,
} from './slide-title-catalog.js'
import { buildSlideTitlePreviewView } from './slide-title-render.js'
import { listAllComponents, resolveComponentPreviewContext } from './catalog.js'
import { buildComponentSlideView } from './render.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const sampleReportPath = path.resolve(__dirname, '../../../output/b80e2f13b5ec/report.json')
const spatialReportPath = path.resolve(__dirname, '../../../output/b13e9370de41/report.json')

function assetLayers() {
  return Array.from({ length: 14 }, (_, index) => ({
    layer_id: `asset_${index}`,
    kind: 'image',
    geometry_norm: {
      x: 0.06 + (index % 7) * 0.12,
      y: 0.08 + Math.floor(index / 7) * 0.18,
      width: 0.045,
      height: 0.055,
    },
  }))
}

function titleSlide(slideNumber, templateId, { asset = false } = {}) {
  return {
    slide_number: slideNumber,
    template_id: templateId,
    render: {
      slide_size_pt: { width: 960, height: 540 },
      layers: asset ? assetLayers() : [],
    },
    content_elements: [{
      element_id: `title_${slideNumber}`,
      kind: 'text',
      role: 'title',
      text: `Заголовок ${slideNumber}`,
      geometry_pt: { x_pt: 80, y_pt: 60, width_pt: 720, height_pt: 60 },
      geometry_norm: { x: 80 / 960, y: 60 / 540, width: 720 / 960, height: 60 / 540 },
      typography: { size_pt: 32, family: 'Play' },
    }],
  }
}

test('listSlideTitleComponents normalizes title with capacity and absolute placements', () => {
  if (!fs.existsSync(sampleReportPath)) return

  const report = JSON.parse(fs.readFileSync(sampleReportPath, 'utf8'))
  const items = listSlideTitleComponents(report)
  assert.ok(items.length >= 1)

  const title = items[0]
  assert.equal(title.component_id, 'title_001')
  assert.ok(title.capacity.word_count_max >= title.capacity.word_count_typical)
  assert.ok(title.placements.some((item) => item.source === 'absolute'))
  assert.ok(title.instances[0].placement?.coordinate_space === 'slide_absolute')
  assert.ok(title.instances[0].element_ids.length >= 1)
  assert.ok(title.default_phrase.length > 0)
})

test('slide title catalog suppresses asset-board templates when normal title templates exist', () => {
  const report = {
    slides: {
      slides: [
        titleSlide(1, 'tmpl_normal'),
        titleSlide(2, 'tmpl_normal'),
        titleSlide(3, 'tmpl_assets', { asset: true }),
        titleSlide(4, 'tmpl_assets', { asset: true }),
      ],
    },
    slide_templates: {
      templates: [
        { template_id: 'tmpl_normal', layout_name: 'Normal', editable_slots: [], render: { layers: [] } },
        { template_id: 'tmpl_assets', layout_name: 'Assets', editable_slots: [], render: { layers: assetLayers() } },
      ],
    },
  }

  const component = listAllComponents(report).find((item) => item.kind === 'slide_title')

  assert.ok(component)
  assert.deepEqual(component.templates, ['tmpl_normal'])
  assert.equal(component.instances.every((item) => item.template_id === 'tmpl_normal'), true)
  assert.deepEqual(component.assetTemplateSuppression.removed_templates, ['tmpl_assets'])
})

test('slide title catalog drops asset-board-only title components', () => {
  const report = {
    slides: {
      slides: [
        titleSlide(1, 'tmpl_assets', { asset: true }),
        titleSlide(2, 'tmpl_assets', { asset: true }),
      ],
    },
    slide_templates: {
      templates: [
        { template_id: 'tmpl_assets', layout_name: 'Assets', editable_slots: [], render: { layers: assetLayers() } },
      ],
    },
  }

  const component = listAllComponents(report).find((item) => item.kind === 'slide_title')

  assert.equal(component, undefined)
})

test('buildTitleTextFromWords fills title from default phrase', () => {
  const phrase = 'one two three four five'
  assert.equal(buildTitleTextFromWords(phrase, 3), 'one two three')
  assert.equal(buildTitleTextFromWords(phrase, 99), 'one two three four five')
})

test('slide title appears in Components catalog and preview updates text', () => {
  if (!fs.existsSync(sampleReportPath)) return

  const report = JSON.parse(fs.readFileSync(sampleReportPath, 'utf8'))
  const component = listAllComponents(report).find((item) => item.kind === 'slide_title')
  assert.ok(component)

  const model = {
    ...defaultSlideTitleModel(component),
    word_count: 10,
    text: buildTitleTextFromWords(component.defaultPhrase, 10),
  }
  const view = buildSlideTitlePreviewView(report, component, { modelData: model })
  assert.ok(view.slide)
  assert.ok(view.bboxPt?.width_pt > 0)

  const titleIds = new Set(view.instance.element_ids || [])
  const titleElements = view.slide.content_elements.filter((element) => titleIds.has(element.element_id))
  assert.ok(titleElements.length >= 1)
  assert.equal(titleElements[0].text, model.text)
  assert.equal(titleElements[0].text.split(/\s+/).length, 10)
})

test('slide title preview follows filtered template instance, not raw instance index', () => {
  if (!fs.existsSync(spatialReportPath)) return

  const report = JSON.parse(fs.readFileSync(spatialReportPath, 'utf8'))
  const component = listAllComponents(report).find((item) => item.kind === 'slide_title')
  assert.ok(component)

  const context = resolveComponentPreviewContext(report, component, {
    templateId: 'tmpl_027',
    instanceIndex: 5,
  })
  assert.ok(context.instance)

  const view = buildComponentSlideView(report, component, {
    templateId: 'tmpl_027',
    instanceIndex: context.instanceIndex,
    modelData: defaultSlideTitleModel(component, context.instance),
  })

  assert.equal(view.instance?.slide_number, context.instance.slide_number)
  assert.equal(view.slide?.slide_number, context.instance.slide_number)

  const titleView = buildSlideTitlePreviewView(report, component, {
    instance: context.instance,
    modelData: defaultSlideTitleModel(component, context.instance),
  })
  assert.equal(titleView.instance?.slide_number, context.instance.slide_number)
  assert.equal(titleView.slide?.slide_number, context.instance.slide_number)
})
