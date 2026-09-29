import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  buildScenarioTextCatalogSlide,
  buildTextCatalogSlideFromPick,
  descriptionPlacementIssue,
  descriptionPlacementKey,
  rankTextTemplateCandidates,
  TEXT_TEMPLATE_VARIANT_LIMIT,
} from './build-text-slide.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const spatialReportPath = path.resolve(__dirname, '../../../output/b13e9370de41/report.json')
const syntheticReportPath = path.resolve(__dirname, '../../../output/f7f5c7202d32/report.json')

const narrativeSpec = {
  intent: 'content',
  title: 'Стратегия продукта',
  text: 'Длинный вводный абзац с пояснением темы слайда, контекстом для аудитории и несколькими деталями для проверки ёмкости текста.',
  metrics: [],
  lists: [],
  tables: [],
  charts: [],
  diagrams: [],
  persons: [],
  quotes: [],
  snippets: [],
  images: [],
}

test('rankTextTemplateCandidates prefers description layouts with different placement keys', () => {
  if (!fs.existsSync(spatialReportPath)) return

  const report = JSON.parse(fs.readFileSync(spatialReportPath, 'utf8'))
  const ranked = rankTextTemplateCandidates(report, narrativeSpec, null, { limit: TEXT_TEMPLATE_VARIANT_LIMIT })

  assert.ok(ranked.length >= 2)
  assert.equal(ranked[0].selection, 'description_first')
  assert.ok(ranked[0].descriptionInstance)
  assert.equal(
    new Set(ranked.map((item) => descriptionPlacementKey(item.descriptionInstance))).size,
    ranked.length,
  )
  assert.notEqual(ranked[0].score, ranked[ranked.length - 1].score)
})

test('buildTextCatalogSlideFromPick applies description before title', () => {
  if (!fs.existsSync(spatialReportPath)) return

  const report = JSON.parse(fs.readFileSync(spatialReportPath, 'utf8'))
  const [picked] = rankTextTemplateCandidates(report, narrativeSpec, null, { limit: 1 })
  assert.ok(picked)

  const built = buildTextCatalogSlideFromPick(report, narrativeSpec, picked)
  assert.ok(built.catalogSlide)
  assert.ok(built.filled.indexOf('text') < built.filled.indexOf('title'))

  const descIds = new Set(picked.descriptionInstance.element_ids)
  const titleIds = new Set(picked.titleInstance?.element_ids || [])
  const descEl = built.catalogSlide.content_elements.find((el) => descIds.has(el.element_id) && el.text)
  const titleEl = built.catalogSlide.content_elements.find((el) => titleIds.has(el.element_id) && el.text)

  assert.equal(descEl?.text, narrativeSpec.text)
  if (titleEl) assert.equal(titleEl.text, narrativeSpec.title)

  const templateTextElements = built.catalogSlide.content_elements.filter((element) => (
    element.kind === 'text'
    && !descIds.has(element.element_id)
    && !titleIds.has(element.element_id)
  ))
  assert.ok(templateTextElements.every((element) => !element.text))
})

test('buildScenarioTextCatalogSlide exposes description-driven variants', () => {
  if (!fs.existsSync(spatialReportPath)) return

  const report = JSON.parse(fs.readFileSync(spatialReportPath, 'utf8'))
  const result = buildScenarioTextCatalogSlide(report, narrativeSpec)

  assert.ok(result.catalogSlide)
  assert.equal(result.textMeta.selectionStrategy, 'description_first')
  assert.ok(result.variants.length >= 2)
  assert.ok(result.variants.some((item) => item.placementLabel?.includes('строк')))
  assert.ok(result.textMeta.alternatives.length >= 1)
})

test('buildTextCatalogSlideFromPick materializes a synthetic description element', () => {
  if (!fs.existsSync(syntheticReportPath)) return

  const report = JSON.parse(fs.readFileSync(syntheticReportPath, 'utf8'))
  const [picked] = rankTextTemplateCandidates(report, narrativeSpec, null, { limit: 1 })
  assert.ok(picked?.descriptionInstance?.synthetic)
  assert.equal(picked.descriptionInstance.element_ids.length, 0)

  const built = buildTextCatalogSlideFromPick(report, narrativeSpec, picked)
  assert.ok(built.catalogSlide)
  assert.ok(built.filled.includes('text'))
  assert.ok(!built.gaps.includes('text: компонент описания не найден'))

  const synthetic = built.catalogSlide.content_elements.find((element) => (
    element.synthetic
    && element.element_id.startsWith('synthetic_slide_description_')
  ))
  assert.ok(synthetic)
  assert.equal(synthetic.text, narrativeSpec.text)
  assert.deepEqual(synthetic.geometry_norm, picked.descriptionInstance.container_norm)
  assert.equal(synthetic.typography.family, picked.descriptionInstance.typography.family)
  assert.equal(synthetic.typography.size_pt, picked.descriptionInstance.typography.size_pt)
})

function contrastReport({ color = '#FFD91D', family = 'Play', layers = [] } = {}) {
  return {
    slides: {
      slides: [{
        slide_number: 1,
        render: { background_color: '#FAFCFF', layers },
        content_elements: [{
          element_id: 'body',
          kind: 'text',
          typography: { color, family, size_pt: 14 },
          geometry_norm: { x: 0.1, y: 0.3, width: 0.45, height: 0.4 },
        }],
      }],
    },
  }
}

test('description slots whose colour vanishes on the template background are rejected', () => {
  const instance = { slide_number: 1, element_ids: ['body'] }
  assert.equal(descriptionPlacementIssue(contrastReport(), instance), 'low_contrast')
  assert.equal(descriptionPlacementIssue(contrastReport({ color: '#000000' }), instance), null)
  const darkPanel = {
    kind: 'fill',
    z_index: 1,
    geometry_norm: { x: 0, y: 0.2, width: 1, height: 0.7 },
    fill: { kind: 'solid', color: '#1A1A2E', alpha: 1 },
  }
  assert.equal(descriptionPlacementIssue(contrastReport({ layers: [darkPanel] }), instance), null)
  assert.equal(descriptionPlacementIssue(contrastReport({ color: '#000000', family: 'Consolas' }), instance), 'code_text')
})

test('code snippet slide is not used as a paragraph slot (deck 51fb4e1edf14, slide 32)', () => {
  const file = path.resolve(__dirname, '../../../output/51fb4e1edf14/report.json')
  if (!fs.existsSync(file)) return
  const report = JSON.parse(fs.readFileSync(file, 'utf8'))
  const ranked = rankTextTemplateCandidates(report, {
    title: 'Проблема ручной подготовки презентаций',
    text: 'В крупных компаниях каждый отдел использует собственные шаблоны, что приводит к несогласованности дизайна и затрудняет обновление контента.',
  }, null, { limit: 10 })
  assert.ok(ranked.length > 0)
  assert.ok(!ranked.some((item) => item.slideNumber === 32))
})
