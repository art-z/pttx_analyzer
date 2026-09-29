import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { buildScenarioSlide, promoteChartPrimaryVariant, resolveTitleVariants } from './build-slide.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const spatialReportPath = path.resolve(__dirname, '../../../output/b13e9370de41/report.json')
const metricReportPath = path.resolve(__dirname, '../../../output/163b2add7d59/report.json')


test('chart variant becomes primary when the slide has explicit or derived chart data', () => {
  const variants = [
    { key: 'text', dataBlock: 'title_text', catalogSlide: { slide_number: 1 } },
    { key: 'chart', dataBlock: 'charts', catalogSlide: { slide_number: 2 } },
    { key: 'metrics', dataBlock: 'metrics', catalogSlide: { slide_number: 3 } },
  ]
  assert.deepEqual(
    promoteChartPrimaryVariant({ charts: [{ type: 'area' }], derived_charts: [] }, variants).map((item) => item.key),
    ['chart', 'text', 'metrics'],
  )
  assert.deepEqual(
    promoteChartPrimaryVariant({ charts: [], derived_charts: [{ type: 'bar' }] }, variants).map((item) => item.key),
    ['chart', 'text', 'metrics'],
  )
  assert.deepEqual(
    promoteChartPrimaryVariant({ charts: [{ type: 'area' }] }, variants, { terminalRole: 'initial' }).map((item) => item.key),
    ['text', 'chart', 'metrics'],
  )
})

function teamSlide() {
  return {
    index: 5,
    intent: 'team',
    purpose: 'Показать команду',
    title: 'Команда проекта',
    text: 'Ключевые участники',
    context: {
      metrics: [],
      lists: [],
      tables: [],
      charts: [],
      diagrams: [],
      persons: [
        { name: 'Анна Иванова', bio: 'PM' },
        { name: 'Иван Петров', bio: 'Design' },
        { name: 'Мария Сидорова', bio: 'Dev' },
      ],
      quotes: [],
      snippets: [],
      images: [],
    },
  }
}

function comparisonSlide() {
  return {
    index: 6,
    intent: 'comparison',
    purpose: 'Сравнение подходов',
    title: 'Flow vs вручную',
    text: 'Таблица и график',
    context: {
      metrics: [{ title: '3×', text: 'быстрее' }],
      lists: [],
      tables: [{
        title: 'Сравнение',
        headers: ['Критерий', 'Flow', 'Вручную'],
        rows: [['Срок', '2 нед', '6 нед']],
      }],
      charts: [{
        title: 'Время подготовки',
        type: 'bar',
        labels: ['Flow', 'Вручную'],
        values: [4, 12],
      }],
      diagrams: [],
      persons: [],
      quotes: [],
      snippets: [],
      images: [],
    },
  }
}

test('buildScenarioSlide renders team slide with sequential text and persons steps', () => {
  if (!fs.existsSync(spatialReportPath)) return

  const report = JSON.parse(fs.readFileSync(spatialReportPath, 'utf8'))
  const result = buildScenarioSlide(report, teamSlide())

  assert.equal(result.renderMode, 'catalog')
  assert.ok(result.catalogSlide)
  assert.ok(result.filled.includes('title'))
  assert.ok(result.filled.includes('text'))
  assert.ok(result.dataSteps.some((step) => step.key === 'title_text'))
  assert.ok(result.dataSteps.some((step) => step.key === 'persons'))
})

test('buildScenarioSlide accepts the three-title object from create_presentation', () => {
  const titles = resolveTitleVariants({
    title: { short: 'Команда', middle: 'Команда проекта', long: 'Команда проекта Flow' },
  })
  assert.deepEqual(titles, [
    { key: 'middle', title: 'Команда проекта' },
    { key: 'short', title: 'Команда' },
    { key: 'long', title: 'Команда проекта Flow' },
  ])
})

test('buildScenarioSlide renders comparison slide with sequential data steps', () => {
  if (!fs.existsSync(spatialReportPath)) return

  const report = JSON.parse(fs.readFileSync(spatialReportPath, 'utf8'))
  const result = buildScenarioSlide(report, comparisonSlide())

  assert.equal(result.renderMode, 'catalog')
  assert.ok(result.catalogSlide)
  assert.ok(result.dataSteps.length >= 2)
  assert.ok(result.dataSteps.some((step) => step.key === 'title_text'))
  assert.ok(result.dataSteps.some((step) => step.key === 'tables' || step.key === 'charts'))
})

test('comparison preview keeps table content separate from paragraphs and metrics', () => {
  if (!fs.existsSync(spatialReportPath)) return

  const report = JSON.parse(fs.readFileSync(spatialReportPath, 'utf8'))
  const result = buildScenarioSlide(report, comparisonSlide())
  const tableVariant = result.previewVariants.find((variant) => variant.dataBlock === 'tables')

  assert.ok(tableVariant?.catalogSlide)
  assert.ok(tableVariant.catalogSlide.content_elements.some((element) => element.kind === 'table'))

  const visibleText = tableVariant.catalogSlide.content_elements
    .filter((element) => element.kind === 'text')
    .map((element) => String(element.text || ''))
    .join('\n')

  assert.ok(!visibleText.includes('Таблица и график'))
  assert.ok(!visibleText.includes('3×'))
  assert.ok(!visibleText.includes('быстрее'))
})

test('buildScenarioSlide returns up to three distinct variants and keeps data steps for diagnostics', () => {
  if (!fs.existsSync(spatialReportPath)) return

  const report = JSON.parse(fs.readFileSync(spatialReportPath, 'utf8'))
  const result = buildScenarioSlide(report, comparisonSlide())

  assert.ok(result.dataSteps.length >= 2)
  for (let index = 1; index < result.dataSteps.length; index += 1) {
    assert.ok(result.dataSteps[index].order > result.dataSteps[index - 1].order)
  }
  assert.ok(result.dataSteps.every((step) => step.catalogSlide))
  assert.ok(result.previewVariants.length >= 1 && result.previewVariants.length <= 3)
  assert.equal(new Set(result.previewVariants.map((variant) => variant.key)).size, result.previewVariants.length)
  assert.ok(result.previewVariants.every((variant) => variant.catalogSlide && !variant.fallbackClone))
  assert.equal(result.selectedVariantKey, result.previewVariants[0].key)
})

test('buildScenarioSlide renders lists via repeat or text fallback', () => {
  if (!fs.existsSync(metricReportPath)) return

  const report = JSON.parse(fs.readFileSync(metricReportPath, 'utf8'))
  const result = buildScenarioSlide(report, {
    index: 4,
    intent: 'features',
    title: 'Преимущества',
    text: '',
    context: {
      metrics: [],
      lists: [
        { title: 'Быстро', text: 'Развёртывание за минуты' },
        { title: 'Надёжно', text: 'Проверенные шаблоны' },
        { title: 'Просто', text: 'Без ручной верстки' },
      ],
      tables: [],
      charts: [],
      diagrams: [],
      persons: [],
      quotes: [],
      snippets: [],
      images: [],
    },
  })

  assert.equal(result.renderMode, 'catalog')
  const listsStep = result.dataSteps.find((step) => step.key === 'lists')
  assert.ok(listsStep?.catalogSlide, 'lists step should render preview')
  assert.ok(result.filled.includes('lists'))
  assert.ok(!result.gaps.some((gap) => /lists: не удалось собрать preview/.test(gap)))
})

test('buildScenarioSlide renders tables with component playground rules', () => {
  if (!fs.existsSync(metricReportPath)) return

  const report = JSON.parse(fs.readFileSync(metricReportPath, 'utf8'))
  const result = buildScenarioSlide(report, {
    index: 6,
    intent: 'comparison',
    title: 'Таблица сценария',
    text: '',
    context: {
      metrics: [],
      lists: [],
      tables: [{
        title: 'Сравнение',
        headers: ['Критерий', 'Flow', 'Manual'],
        rows: [['Срок', '2 нед', '6 нед']],
      }],
      charts: [],
      diagrams: [],
      persons: [],
      quotes: [],
      snippets: [],
      images: [],
    },
  })

  const tableStep = result.dataSteps.find((step) => step.key === 'tables')
  assert.ok(tableStep?.catalogSlide, 'table step should render preview')

  const tableElement = (tableStep.catalogSlide.content_elements || []).find((element) => element.kind === 'table')
  assert.ok(tableElement, 'expected styled table element from component catalog')
  assert.ok(Array.isArray(tableElement.preview) && tableElement.preview.length >= 2)
  assert.ok(tableElement.table?.column_widths_pt?.length >= 2, 'expected OOXML table structure')
})

test('buildScenarioSlide never falls back to constructor assembly', () => {
  if (!fs.existsSync(spatialReportPath)) return

  const report = JSON.parse(fs.readFileSync(spatialReportPath, 'utf8'))
  const result = buildScenarioSlide(report, {
    index: 99,
    intent: 'unknown',
    title: '',
    text: '',
    context: {
      metrics: [{ value: '999', unit: '%', description: 'Невалидный KPI для теста' }],
      lists: [],
      tables: [],
      charts: [],
      diagrams: [],
      persons: [],
      quotes: [],
      snippets: [],
      images: [],
    },
  })

  assert.notEqual(result.renderMode, 'constructor')
  assert.equal(result.slide, null)
  if (!result.dataSteps.length) {
    assert.equal(result.renderMode, 'none')
    assert.ok(result.gaps.length >= 1)
  }
})

test('buildScenarioSlide patches scenario title on every data step preview', () => {
  if (!fs.existsSync(spatialReportPath)) return

  const report = JSON.parse(fs.readFileSync(spatialReportPath, 'utf8'))
  const scenarioTitle = 'Заголовок из сценария LLM'
  const result = buildScenarioSlide(report, {
    index: 6,
    intent: 'comparison',
    title: scenarioTitle,
    text: 'Описание слайда',
    context: {
      metrics: [{ title: '3×', text: 'быстрее' }],
      lists: [],
      tables: [],
      charts: [{
        title: 'Время',
        type: 'bar',
        labels: ['Flow', 'Manual'],
        values: [4, 12],
      }],
      diagrams: [],
      persons: [],
      quotes: [],
      snippets: [],
      images: [],
    },
  })

  for (const step of result.dataSteps) {
    const titleElements = (step.catalogSlide?.content_elements || []).filter((element) => (
      element.kind === 'text'
      && (element.geometry_norm?.y || 0) < 0.25
      && String(element.text || '').includes(scenarioTitle)
    ))
    assert.ok(titleElements.length >= 1, `expected scenario title on step ${step.key}`)
  }
})
