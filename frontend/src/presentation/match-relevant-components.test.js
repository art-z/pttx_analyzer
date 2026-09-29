import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  matchGraphicComponents,
  matchSlideTitleComponent,
  resolvePresentationRelevantComponents,
  resolveSlideRelevantComponents,
} from './match-relevant-components.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const spatialReportPath = path.resolve(__dirname, '../../../output/b13e9370de41/report.json')

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

test('resolveSlideRelevantComponents ranks title before repeat blocks', () => {
  if (!fs.existsSync(spatialReportPath)) return

  const report = JSON.parse(fs.readFileSync(spatialReportPath, 'utf8'))
  const result = resolveSlideRelevantComponents(report, teamSlide())
  const repeat = result.recommendations.find((item) => item.context_block === 'persons')

  assert.ok(repeat?.best)
  assert.equal(repeat.best.kind, 'container')
  assert.ok(repeat.best.score >= 40)
  assert.ok(repeat.best.payload?.items?.length >= 2)
  assert.equal(repeat.best.payload.items[0].fields.heading, 'Анна Иванова')
  assert.ok(result.recommendations.some((item) => item.slot === 'slide_title'))
  assert.equal(result.primary?.kind, 'slide_title')
})

test('resolveSlideRelevantComponents returns graphic matches for comparison slide', () => {
  if (!fs.existsSync(spatialReportPath)) return

  const report = JSON.parse(fs.readFileSync(spatialReportPath, 'utf8'))
  const result = resolveSlideRelevantComponents(report, comparisonSlide())

  const table = result.recommendations.find((item) => item.context_block === 'tables')
  const chart = result.recommendations.find((item) => item.context_block === 'charts')

  assert.ok(table?.best)
  assert.equal(table.best.kind, 'table')
  assert.ok(table.best.payload?.rows?.length >= 1)

  assert.ok(chart?.best)
  assert.equal(chart.best.kind, 'chart')
  assert.ok(chart.best.payload?.categories?.length >= 2)

  const metric = result.recommendations.find((item) => item.slot === 'metric')
  assert.ok(metric?.best)
  assert.equal(metric.best.group, 'metrics')
  assert.ok(metric.best.payload?.metrics?.length >= 1)
  assert.ok(!result.gaps.some((gap) => /^нет компонента для (metrics|charts|tables)/.test(gap)))
})

test('resolvePresentationRelevantComponents maps all slides', () => {
  if (!fs.existsSync(spatialReportPath)) return

  const report = JSON.parse(fs.readFileSync(spatialReportPath, 'utf8'))
  const mapped = resolvePresentationRelevantComponents(report, {
    presentation: {
      title: 'Demo',
      slides: [teamSlide(), comparisonSlide()],
    },
  })

  assert.equal(mapped.slides.length, 2)
  assert.ok(mapped.slides[0].recommendations.length >= 2)
  assert.ok(mapped.slides[1].recommendations.length >= 2)
})

test('matchSlideTitleComponent returns payload for slide title', () => {
  if (!fs.existsSync(spatialReportPath)) return

  const report = JSON.parse(fs.readFileSync(spatialReportPath, 'utf8'))
  const match = matchSlideTitleComponent(report, {
    title: 'Заголовок слайда',
    text: 'Описание',
  })

  assert.ok(match?.component)
  assert.equal(match.component.kind, 'slide_title')
  assert.equal(match.payload.text, 'Заголовок слайда')
})

test('requested chart type outranks generic chart popularity', () => {
  const report = {
    graphic_components: {
      charts: ['line', 'area', 'bar', 'pie'].map((type) => ({
        component_id: `cht_${type}`,
        chart_type: type,
        is_baseline: true,
      })),
    },
  }

  const lineMatches = matchGraphicComponents(report, {
    charts: [{ type: 'line', title: 'Динамика', labels: ['Q1', 'Q2'], values: [2, 5] }],
  }, 'charts')
  assert.equal(lineMatches[0].component.chartType, 'area')
  assert.equal(lineMatches[0].payload.chart_type, 'area')

  const pieMatches = matchGraphicComponents(report, {
    charts: [{ type: 'pie', title: 'Доли', labels: ['A', 'B'], values: [2, 5] }],
  }, 'charts')
  assert.equal(pieMatches[0].component.chartType, 'pie')
  assert.equal(pieMatches[0].payload.chart_type, 'pie')
})

test('matchGraphicComponents prefers chart type from context', () => {
  if (!fs.existsSync(spatialReportPath)) return

  const report = JSON.parse(fs.readFileSync(spatialReportPath, 'utf8'))
  const matches = matchGraphicComponents(report, comparisonSlide(), 'charts')
  assert.ok(matches.length >= 1)
  assert.equal(matches[0].payload.chart_type, 'bar')
})

test('baseline charts and native tables retain their own source template', () => {
  const report = {
    layout: { content_margins: {
      left_norm: 0.04, right_norm: 0.04, top_norm: 0.04, bottom_norm: 0.04,
    } },
    slides: { slides: [{ slide_number: 7, template_id: 'tmpl_graphic' }] },
    slide_templates: { templates: [
      { template_id: 'tmpl_graphic', layout_name: 'Graphic', editable_slots: [], render: { layers: [] } },
      { template_id: 'tmpl_other', layout_name: 'Other', editable_slots: [], render: { layers: [] } },
    ] },
    graphic_components: {
      tables: [{
        component_id: 'tbl_native',
        frequency: { template_ids: ['tmpl_graphic'], instance_count: 1 },
        instances: [{
          template_id: 'tmpl_graphic',
          geometry_norm: { x: 0, y: 0.2, width: 1, height: 0.79 },
        }],
      }],
      charts: [{
        component_id: 'cht_baseline_bar',
        is_baseline: true,
        chart_type: 'bar',
        baseline_preview: {
          slide_number: 7,
          geometry_norm: { x: 0, y: 0.2, width: 1, height: 0.79 },
        },
        instances: [],
      }],
    },
  }
  const spec = comparisonSlide()
  const tableMatches = matchGraphicComponents(report, spec, 'tables')
  const chartMatches = matchGraphicComponents(report, spec, 'charts')

  assert.equal(tableMatches[0]?.templateId, 'tmpl_graphic')
  assert.equal(chartMatches[0]?.templateId, 'tmpl_graphic')
  const resolved = resolveSlideRelevantComponents(report, spec)
  assert.ok(resolved.recommendations.some((item) => item.context_block === 'tables'))
  assert.ok(resolved.recommendations.some((item) => item.context_block === 'charts'))
  assert.ok(!resolved.gaps.some((gap) => gap.includes('graphic-компонент не найден')))
})
