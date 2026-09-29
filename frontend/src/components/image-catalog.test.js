import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  defaultSlideImageModel,
  listSlideImageComponents,
} from './image-catalog.js'
import { buildSlideImagePreviewView } from './image-render.js'
import { findSlideHeroImageElements } from '../slides/slide-image-detect.js'
import { listAllComponents } from './catalog.js'
import { payloadKeyForComponent, slideImageToDataPayload } from './model-data.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const imageReportPath = path.resolve(__dirname, '../../../output/163b2add7d59/report.json')

test('listSlideImageComponents groups hero slides with title and large image', () => {
  if (!fs.existsSync(imageReportPath)) return

  const report = JSON.parse(fs.readFileSync(imageReportPath, 'utf8'))
  const items = listSlideImageComponents(report)

  assert.ok(items.length >= 1)
  assert.ok(items[0].instances.length >= 2)
  assert.equal(items[0].kind, 'slide_image')
  assert.ok(items[0].behavior?.requires_title)
  assert.ok(items[0].capacity?.image_area_typical >= 0.08)

  const ids = items.map((item) => item.component_id)
  assert.equal(new Set(ids).size, ids.length)
})

test('findSlideHeroImageElements requires title and skips image grids', () => {
  if (!fs.existsSync(imageReportPath)) return

  const report = JSON.parse(fs.readFileSync(imageReportPath, 'utf8'))
  const heroSlides = report.slides.slides.filter((slide) => {
    const hero = findSlideHeroImageElements(slide, report)
    return hero.method !== 'none'
  })

  assert.ok(heroSlides.length >= 2)
  heroSlides.forEach((slide) => {
    const hero = findSlideHeroImageElements(slide, report)
    assert.ok(['title_plus_hero_image', 'title_plus_background_image'].includes(hero.method))
    assert.ok(hero.primary?.kind === 'image')
    assert.ok(hero.title?.primary)
    assert.ok(hero.score >= 40)
  })
})

test('background hero slides 31-36 are included in image catalog', () => {
  if (!fs.existsSync(imageReportPath)) return

  const report = JSON.parse(fs.readFileSync(imageReportPath, 'utf8'))
  const components = listSlideImageComponents(report)
  const coveredSlides = new Set(components.flatMap((item) => item.instances.map((instance) => instance.slide_number)))

  for (const slideNumber of [31, 32, 33, 34, 35, 36]) {
    assert.ok(coveredSlides.has(slideNumber), `slide ${slideNumber} should be in image catalog`)
  }

  assert.ok(!coveredSlides.has(30), 'slide 30 has no hero image and should stay out')
})

test('slide image appears in catalog and preview isolates title plus hero image', () => {
  if (!fs.existsSync(imageReportPath)) return

  const report = JSON.parse(fs.readFileSync(imageReportPath, 'utf8'))
  const component = listAllComponents(report).find((item) => item.kind === 'slide_image')
  assert.ok(component)

  const model = defaultSlideImageModel(component)
  const payload = slideImageToDataPayload(component)
  assert.equal(payloadKeyForComponent(component), 'slide_images')
  assert.equal(payload.component_id, component.id)
  assert.ok(payload.asset || model.asset || component.instances?.[0]?.asset)

  const view = buildSlideImagePreviewView(report, component, { modelData: model })
  assert.ok(view.slide)

  const keepIds = new Set([
    ...(view.instance.title_element_ids || []),
    ...(view.instance.description_element_ids || []),
    ...(view.instance.element_ids || []),
    view.instance.element_id,
  ].filter(Boolean))

  const visible = view.slide.content_elements.filter((element) => keepIds.has(element.element_id))
  assert.ok(visible.some((element) => element.kind === 'image'))
  assert.equal(view.slide.content_elements.length, visible.length)
})
