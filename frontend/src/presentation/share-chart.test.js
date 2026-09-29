import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

import { normalizeChartType, suitableChartTypes } from './graphic-contract.js'

// The exact chart shape the backend prompt asks for (prompts/create_presentation.md, "# charts").
const shareChart = (type) => ({
  title: 'Структура бюджета проекта',
  text: 'Доли статей расходов, % (пример)',
  type,
  unit: '%',
  labels: ['Разработка', 'Маркетинг', 'Поддержка', 'Инфраструктура'],
  values: [40, 25, 20, 15],
})

test('prompt share shape: pie/doughnut types are kept and shares suit circular charts', () => {
  assert.equal(normalizeChartType('pie'), 'pie')
  assert.equal(normalizeChartType('doughnut'), 'doughnut')
  for (const type of ['pie', 'doughnut']) {
    const suitable = suitableChartTypes(shareChart(type))
    assert.equal(suitable[0], type)
    assert.ok(suitable.includes('pie') && suitable.includes('doughnut'), suitable.join(','))
  }
})

const outputRoot = new URL('../../../output/', import.meta.url)
function loadDeck(prefix) {
  if (!fs.existsSync(outputRoot)) return null
  const id = fs.readdirSync(outputRoot).find((name) => name.startsWith(prefix)
    && fs.existsSync(new URL(`${name}/presentation.json`, outputRoot)) && fs.existsSync(new URL(`${name}/report.json`, outputRoot)))
  if (!id) return null
  const pres = JSON.parse(fs.readFileSync(new URL(`${id}/presentation.json`, outputRoot), 'utf8'))
  return {
    report: JSON.parse(fs.readFileSync(new URL(`${id}/report.json`, outputRoot), 'utf8')),
    presentation: pres.presentation || pres,
  }
}

const chartElementOf = (variant) => (variant.catalogSlide?.content_elements || []).find((element) => element.kind === 'chart')

for (const [prefix, type] of [['51fb', 'pie'], ['1974', 'doughnut']]) {
  test(`real deck ${prefix}: share data on every content slide shows a hit-tested ${type} variant`, async (t) => {
    const deck = loadDeck(prefix)
    if (!deck) return t.skip(`deck ${prefix} not available`)
    const { extractDesignTokens } = await import('../constructor/tokens.js')
    const { buildScenarioSlide } = await import('./build-slide.js')
    const { createCoverageContext, recordDisplayedVariants } = await import('./component-coverage.js')
    const tokens = extractDesignTokens(deck.report)
    const ctx = createCoverageContext(deck.report)
    const slides = deck.presentation.slides
    let checked = 0
    for (const [index, slide] of slides.entries()) {
      if (index === 0 || index === slides.length - 1) continue
      const spec = { ...slide, context: { ...(slide.context || {}), charts: [shareChart(type)] } }
      const res = buildScenarioSlide(deck.report, spec, tokens, {
        selectionContext: ctx,
        seed: `share|${index}`,
        position: index,
        totalSlides: slides.length,
      })
      const shown = res.previewVariants.filter((item) => item.catalogSlide).slice(0, 3)
      recordDisplayedVariants(ctx, res.previewVariants.slice(0, 3))
      // The first chart shown is the requested circular kind, even on later
      // slides where deck coverage would favour a still-unused bar component.
      const firstChart = shown.map(chartElementOf).find(Boolean)
      assert.ok(firstChart, `slide ${index + 1}: no chart among ${shown.map((item) => item.dataBlock).join('|')}`)
      assert.ok(['pie', 'doughnut'].includes(firstChart.chart_type), `slide ${index + 1}: ${firstChart.chart_type}`)
      const circular = shown.find((item) => ['pie', 'doughnut'].includes(chartElementOf(item)?.chart_type))
      assert.notEqual(circular.catalogSlide.layout_validation?.valid, false, `slide ${index + 1}`)
      assert.deepEqual(chartElementOf(circular).chart.series[0].values, [40, 25, 20, 15])
      assert.deepEqual(chartElementOf(circular).chart.categories_preview, shareChart(type).labels)
      checked++
    }
    assert.ok(checked >= 5, `checked ${checked}`)
  })
}
