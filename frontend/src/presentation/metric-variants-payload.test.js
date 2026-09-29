import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { extractDesignTokens } from '../constructor/tokens.js'
import { takeSlideVariants } from '../lite-assemble.js'
import { buildScenarioSlide } from './build-slide.js'
import { createCoverageContext } from './component-coverage.js'

const DECK = '51fb4e1edf14'
const output = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../output', DECK)

// Exact payload from the user report ("only 2 variants, one of them a
// yellow 10-line paragraph").
const PAYLOAD = {
  index: 2,
  intent: 'problem',
  purpose: 'Показать, почему ручная подготовка презентаций не масштабируется',
  title: 'Проблема ручной подготовки презентаций',
  text: 'Сложно поддерживать единый стиль и быстро реагировать на запросы',
  context: {
    paragraphs: [{ heading: '', body: 'В крупных компаниях каждый отдел использует собственные шаблоны, что приводит к несогласованности дизайна и затрудняет обновление контента.' }],
    metrics: [
      { value: '30', unit: '%', description: 'время, затрачиваемое на поиск и корректировку шаблонов' },
      { value: '25', unit: '%', description: 'потери времени из-за несогласованного дизайна' },
      { value: '15', unit: '%', description: 'снижение удовлетворенности заказчиков' },
    ],
    cards: [],
    lists: [],
    timelines: [],
    icon_lists: [],
    tables: [],
    charts: [],
    diagrams: [],
    persons: [],
    quotes: [],
    snippets: [],
    images: [],
  },
  title_options: {
    short: 'Проблема',
    middle: 'Проблема ручной подготовки презентаций',
    long: 'Проблема: ручная подготовка презентаций не масштабируется и приводит к потере времени и ресурсов',
  },
}

function loadDeck() {
  const reportPath = path.join(output, 'report.json')
  const presentationPath = path.join(output, 'presentation.json')
  if (!fs.existsSync(reportPath) || !fs.existsSync(presentationPath)) return null
  return {
    report: JSON.parse(fs.readFileSync(reportPath, 'utf8')),
    presentation: JSON.parse(fs.readFileSync(presentationPath, 'utf8')).presentation,
  }
}

test('problem slide with 3 metrics yields 3 diverse variants incl. two KPI components', () => {
  const deck = loadDeck()
  if (!deck) return
  const { report, presentation } = deck
  const tokens = extractDesignTokens(report)
  const context = createCoverageContext(report)
  const slides = presentation.slides || []
  const title = presentation.title || 'presentation'
  // Replay the deck up to the payload slide like the worker does.
  for (const [index, slide] of slides.entries()) {
    if ((slide.index ?? index + 1) >= PAYLOAD.index) break
    takeSlideVariants(report, slide, tokens, context, `${title}|${slide.index ?? index + 1}|${slide.intent || ''}`, {
      position: index,
      totalSlides: slides.length,
    })
  }
  const position = slides.findIndex((slide) => slide.index === PAYLOAD.index)
  const result = buildScenarioSlide(report, PAYLOAD, tokens, {
    selectionContext: context,
    seed: `${title}|${PAYLOAD.index}|${PAYLOAD.intent}`,
    position: Math.max(0, position),
    totalSlides: slides.length,
  })
  const variants = result.previewVariants

  assert.equal(variants.length, 3, variants.map((item) => item.sublabel).join(' / '))
  const placement = (item) => `${item.templateId || item.catalogSlide?.template_id}|${item.catalogSlide?.slide_number}`
  assert.equal(new Set(variants.map(placement)).size, 3)
  assert.equal(new Set(variants.map((item) => item.componentId)).size, 3)

  const metrics = variants.filter((item) => item.dataBlock === 'metrics')
  assert.ok(metrics.length >= 2, 'two KPI variants')
  assert.equal(new Set(metrics.map((item) => item.catalogSlide.slide_number)).size, metrics.length)
  for (const item of metrics) {
    // Metric contract: every KPI shows value+unit and description.
    assert.equal(item.catalogSlide.metric_contract?.rendered, 3)
    const texts = item.catalogSlide.content_elements
      .filter((element) => element.kind === 'text')
      .map((element) => String(element.text || '').replace(/\u00a0/g, ' '))
    for (const metric of PAYLOAD.context.metrics) {
      assert.ok(texts.includes(`${metric.value}${metric.unit}`))
      assert.ok(texts.includes(metric.description))
    }
  }

  // Round 12: same-unit KPIs are chart-able, so the third slot goes to a chart
  // drawn from exactly these numbers; otherwise a clean text variant.
  const chart = variants.find((item) => item.dataBlock === 'charts')
  const text = variants.find((item) => item.dataBlock === 'title_text')
  assert.ok(chart || text, 'a chart or text variant is present')
  if (chart) {
    const element = chart.catalogSlide.content_elements.find((item) => item.kind === 'chart')
    assert.ok(element, 'the chart variant renders a chart')
    assert.ok(!(chart.catalogSlide.layout_validation?.issues || [])
      .some((issue) => ['text_overlap', 'outside_slide'].includes(issue.code)))
  }
  if (text) {
    // Not the yellow code block from slide 32 and no blocking layout issues.
    assert.notEqual(text.catalogSlide.slide_number, 32)
    assert.ok(!(text.catalogSlide.layout_validation?.issues || [])
      .some((issue) => ['text_overflow', 'text_overlap', 'outside_slide'].includes(issue.code)))
  }
})
