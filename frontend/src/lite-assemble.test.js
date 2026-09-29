import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { extractDesignTokens } from './constructor/tokens.js'
import { takeSlideVariants } from './lite-assemble.js'
import { buildScenarioSlide } from './presentation/build-slide.js'
import { createCoverageContext } from './presentation/component-coverage.js'

function loadFixtureReport() {
  const output = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../output')
  if (!fs.existsSync(output)) return null
  const preferred = path.join(output, '106a501b3801', 'report.json')
  const reportPath = fs.existsSync(preferred)
    ? preferred
    : fs.readdirSync(output)
      .map((name) => path.join(output, name, 'report.json'))
      .find((candidate) => fs.existsSync(candidate))
  return reportPath ? JSON.parse(fs.readFileSync(reportPath, 'utf8')) : null
}

test('takeSlideVariants returns three variants with different components and templates', () => {
  const report = loadFixtureReport()
  if (!report) return
  const tokens = extractDesignTokens(report)
  // Same context the worker uses (recordDisplayedVariants needs
  // lastTemplateByComponent / componentExposure).
  const context = createCoverageContext(report)
  const variants = takeSlideVariants(report, {
    index: 1,
    intent: 'features',
    title: 'Тема',
    text: 'Аннотация',
    context: {
      paragraphs: [{ heading: '', body: 'Текст абзаца для проверки варианта.' }],
      cards: [1, 2, 3, 4].map((index) => ({ heading: `Карточка ${index}`, body: `Описание ${index}` })),
      lists: [],
      timelines: [],
      icon_lists: [],
      metrics: [],
      tables: [],
      charts: [],
      diagrams: [],
      persons: [],
      quotes: [],
      snippets: [],
      images: [],
    },
  }, tokens, context, 'test|1|features')

  assert.equal(variants.length, 3)
  assert.deepEqual(
    variants.map((variant) => variant.label),
    variants.map((_, index) => `Вариант ${index + 1}`),
  )
  assert.ok(variants.every((variant) => variant.catalogSlide))
  assert.equal(new Set(variants.map((variant) => (
    variant.catalogSlide.template_id || variant.catalogSlide.layout_source
  ))).size, 3)
  assert.equal(new Set(variants.map((variant) => variant.componentId)).size, 3)
})

test('every populated context builds a local shortlist before global selection', () => {
  const report = loadFixtureReport()
  if (!report) return
  const result = buildScenarioSlide(report, {
    index: 2,
    intent: 'comparison',
    title: 'Flow',
    context: {
      paragraphs: [{ heading: '', body: 'Flow связывает данные брифа с компонентами.' }],
      metrics: [
        { value: '3', unit: '×', description: 'быстрее подготовка' },
        { value: '50', unit: '%', description: 'меньше правок стиля' },
      ],
      cards: [
        { heading: 'Автоматическая сборка', body: 'Данные распределяются по компонентам' },
        { heading: 'Редактируемый результат', body: 'Объекты остаются редактируемыми' },
      ],
      tables: [{
        title: 'Flow vs вручную',
        headers: ['Критерий', 'Flow', 'Вручную'],
        rows: [['Срок', '2 нед', '6 нед'], ['Ошибки', '2%', '18%']],
      }],
      charts: [{
        title: 'Время подготовки',
        type: 'bar',
        labels: ['Flow', 'Вручную'],
        values: [4, 12],
      }],
      lists: [], timelines: [], icon_lists: [], diagrams: [], persons: [], quotes: [], snippets: [], images: [],
    },
  }, null, { seed: 'all-contexts' })

  const contexts = new Map(result.candidatePipeline.contexts.map((item) => [item.block, item]))
  for (const block of ['title_text', 'metrics', 'cards', 'tables', 'charts']) {
    assert.ok(contexts.get(block)?.generated > 0, `${block} must generate candidates`)
  }
  assert.equal(result.previewVariants.length, 3)
  assert.equal(new Set(result.previewVariants.map((item) => item.componentId)).size, 3)
  assert.equal(new Set(result.previewVariants.map((item) => item.templateId)).size, 3)
})
