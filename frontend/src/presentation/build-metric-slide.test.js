import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  buildScenarioMetricCatalogSlide,
  rankMetricLayoutCandidates,
} from './build-metric-slide.js'
import { buildScenarioSlide } from './build-slide.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const spatialReportPath = path.resolve(__dirname, '../../../output/b13e9370de41/report.json')
const metricReportPath = path.resolve(__dirname, '../../../output/163b2add7d59/report.json')

const metricsSpec = {
  intent: 'metrics',
  title: 'Ключевые показатели',
  text: '',
  metrics: [
    { title: '3×', text: 'быстрее подготовка' },
    { title: '50%', text: 'меньше правок стиля' },
  ],
  lists: [],
  tables: [],
  charts: [],
  diagrams: [],
  persons: [],
  quotes: [],
  snippets: [],
  images: [],
}

test('rankMetricLayoutCandidates returns distinct KPI layout variants', () => {
  if (!fs.existsSync(spatialReportPath)) return

  const report = JSON.parse(fs.readFileSync(spatialReportPath, 'utf8'))
  const ranked = rankMetricLayoutCandidates(report, metricsSpec)

  assert.ok(ranked.length >= 2)
  assert.ok(ranked[0].score >= ranked[ranked.length - 1].score)
  assert.ok(ranked.some((item) => item.selection.includes('metric_repeat')))
})

test('buildScenarioMetricCatalogSlide builds KPI preview with variants', () => {
  if (!fs.existsSync(spatialReportPath)) return

  const report = JSON.parse(fs.readFileSync(spatialReportPath, 'utf8'))
  const result = buildScenarioMetricCatalogSlide(report, metricsSpec)

  assert.ok(result.catalogSlide)
  assert.ok(result.metricMeta)
  assert.equal(result.metricMeta.selectionStrategy, 'metric_layout_first')
  assert.ok(result.variants.length >= 2)
  assert.ok(result.filled.includes('metrics'))

  const generated = (result.catalogSlide.content_elements || []).filter((element) => (
    element.kind === 'text' && element.text
  ))
  assert.ok(generated.some((element) => element.text.includes('3×')))
  assert.ok(generated.some((element) => element.text.includes('50%')))
  assert.ok(generated
    .filter((element) => element.text.includes('3×') || element.text.includes('50%'))
    .every((element) => element.component_data))
})

test('metric preview keeps KPI content separate from narrative paragraphs', () => {
  if (!fs.existsSync(spatialReportPath)) return

  const report = JSON.parse(fs.readFileSync(spatialReportPath, 'utf8'))
  const narrative = 'Этот параграф не должен попасть в KPI-слайд'
  const result = buildScenarioSlide(report, {
    ...metricsSpec,
    text: narrative,
  })
  const selected = result.previewVariants[0]

  assert.equal(selected?.dataBlock, 'metrics')
  const visibleText = (selected.catalogSlide?.content_elements || [])
    .filter((element) => element.kind === 'text')
    .map((element) => String(element.text || ''))
    .join('\n')

  assert.ok(visibleText.includes('3×'))
  assert.ok(visibleText.includes('50%'))
  assert.ok(!visibleText.includes(narrative))
})

test('buildScenarioSlide uses metric catalog when only metrics are requested', () => {
  if (!fs.existsSync(spatialReportPath)) return

  const report = JSON.parse(fs.readFileSync(spatialReportPath, 'utf8'))
  const result = buildScenarioSlide(report, metricsSpec)

  assert.equal(result.renderMode, 'catalog')
  assert.ok(result.match.metricMeta)
  assert.ok(result.metricTemplateVariants?.length >= 2)
  assert.ok(result.filled.includes('metrics'))
})

test('ranking exposes measured expanded hero capacity to the scenario pipeline', () => {
  if (!fs.existsSync(metricReportPath)) return

  const report = JSON.parse(fs.readFileSync(metricReportPath, 'utf8'))
  const spec = {
    ...metricsSpec,
    metrics: [
      { value: '91', unit: '%', description: 'Первый' },
      { value: '72', unit: '%', description: 'Второй' },
    ],
  }
  const ranked = rankMetricLayoutCandidates(report, spec, { limit: 20 })
  const expandedHero = ranked.find((item) => item.selection === 'metric_hero_expanded')

  assert.ok(expandedHero)
  assert.equal(expandedHero.expanded, true)
  assert.ok(expandedHero.layout.capacity_expandable >= 2)
})

test('ranking uses unit-free layouts only for metrics with empty units', () => {
  if (!fs.existsSync(metricReportPath)) return

  const report = JSON.parse(fs.readFileSync(metricReportPath, 'utf8'))
  const unitFree = rankMetricLayoutCandidates(report, {
    metrics: [
      { value: '7', unit: '', description: 'Первый показатель' },
      { value: '10', unit: '', description: 'Второй показатель' },
    ],
  }, { limit: 20 })
  const withUnits = rankMetricLayoutCandidates(report, {
    metrics: [{ value: '7', unit: '%', description: 'Доля' }],
  }, { limit: 20 })

  assert.ok(unitFree.some((item) => item.layout.unit_mode === 'none' && item.slideNumber === 42))
  assert.notEqual(withUnits[0]?.layout.unit_mode, 'none')
  assert.ok(withUnits.some((item) => item.layout.unit_mode === 'none'))
})
