import test from 'node:test'
import assert from 'node:assert/strict'

import {
  llmChartToModelData,
  llmDiagramToModelData,
  llmTableToModelData,
  normalizeChartType,
} from './graphic-contract.js'

test('normalizeChartType maps column to bar', () => {
  assert.equal(normalizeChartType('column'), 'bar')
  assert.equal(normalizeChartType('line'), 'line')
})

test('llmChartToModelData converts labels and values', () => {
  const data = llmChartToModelData({
    title: 'Этапы внедрения',
    type: 'line',
    labels: ['Анализ', 'Настройка', 'Обучение', 'Запуск'],
    values: [1, 2, 3, 4],
  }, 'cht_line')

  assert.equal(data.component_id, 'cht_line')
  assert.equal(data.chart_type, 'line')
  assert.deepEqual(data.categories, ['Анализ', 'Настройка', 'Обучение', 'Запуск'])
  assert.deepEqual(data.series[0].values, [1, 2, 3, 4])
  assert.equal(data.series[0].label, 'Этапы внедрения')
})

test('llmTableToModelData converts headers and rows', () => {
  const data = llmTableToModelData({
    title: 'Сравнение',
    headers: ['A', 'B'],
    rows: [['1', '2']],
  }, 'tbl_001')

  assert.equal(data.component_id, 'tbl_001')
  assert.equal(data.columns.length, 2)
  assert.equal(data.row_count, 2)
  assert.equal(data.col_count, 2)
  assert.deepEqual(data.rows[0], { a: '1', b: '2' })
})

test('llmTableToModelData removes empty rows and columns', () => {
  const data = llmTableToModelData({
    headers: ['Критерий', 'Flow', '', '  '],
    rows: [
      ['Срок', '2 недели', '', ''],
      ['', ' ', null, undefined],
      ['Стоимость', 'Средняя', '', ''],
    ],
  }, 'tbl_compact')

  assert.equal(data.row_count, 3)
  assert.equal(data.col_count, 2)
  assert.deepEqual(data.columns.map((column) => column.label), ['Критерий', 'Flow'])
  assert.deepEqual(data.rows, [
    { col_0: 'Срок', flow: '2 недели' },
    { col_0: 'Стоимость', flow: 'Средняя' },
  ])
})

test('llmTableToModelData keeps a column with data even when its header is blank', () => {
  const data = llmTableToModelData({
    headers: ['A', '', ''],
    rows: [['1', 'kept', '']],
  }, 'tbl_blank_header')

  assert.equal(data.col_count, 2)
  assert.equal(data.row_count, 2)
  assert.deepEqual(data.columns.map((column) => column.label), ['A', ''])
  assert.equal(data.rows[0].column_2, 'kept')
})

test('llmDiagramToModelData converts nodes', () => {
  const data = llmDiagramToModelData({
    title: 'Процесс',
    nodes: [{ label: 'Start' }, { label: 'End' }],
  }, 'dgr_001')

  assert.equal(data.component_id, 'dgr_001')
  assert.deepEqual(data.nodes.map((node) => node.label), ['Start', 'End'])
})
