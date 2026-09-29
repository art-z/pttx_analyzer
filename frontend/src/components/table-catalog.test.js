import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { listAllComponents } from './catalog.js'
import {
  buildTableCapacity,
  defaultTableModel,
  listGraphicTables,
  inferRowStylePattern,
  describeRowStylePattern,
  resizeTableMatrix,
  resizeTableModelData,
} from './table-catalog.js'
import { applyModelDataToComponent } from './model-data.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const sampleReportPath = path.resolve(__dirname, '../../../output/b80e2f13b5ec/report.json')

test('listGraphicTables hides baseline tables when detected tables exist', () => {
  if (!fs.existsSync(sampleReportPath)) return

  const report = JSON.parse(fs.readFileSync(sampleReportPath, 'utf8'))
  const rawCount = report.graphic_components.tables.length
  const filtered = listGraphicTables(report)
  assert.ok(rawCount >= 3)
  assert.equal(filtered.length, rawCount - 2)
  assert.ok(filtered.every((item) => !item.is_baseline))

  const catalogTables = listAllComponents(report).filter((item) => item.kind === 'table')
  assert.equal(catalogTables.length, filtered.length)
  assert.ok(catalogTables.every((item) => !item.isBaseline))
})

test('buildTableCapacity exposes known size and playground range', () => {
  const component = {
    raw: {
      default_size: { rows: 7, cols: 12 },
      data_preview: { rows: Array.from({ length: 7 }, () => Array(12).fill('x')) },
      column_widths_pt: Array(12).fill(60),
      structure: { header_row: 0 },
    },
  }
  const capacity = buildTableCapacity(component)
  assert.equal(capacity.row_count_known, 7)
  assert.equal(capacity.col_count_known, 12)
  assert.ok(capacity.row_count_max >= 7)
  assert.ok(capacity.col_count_max >= 12)
  assert.ok(capacity.row_count_min <= 7)
})

test('resizeTableMatrix grows and shrinks grid', () => {
  const matrix = [
    ['H1', 'H2'],
    ['A', '1'],
    ['B', '2'],
  ]
  const bigger = resizeTableMatrix(matrix, 5, 4, { header_row: 0 })
  assert.equal(bigger.length, 5)
  assert.equal(bigger[0].length, 4)
  assert.equal(bigger[4][0], 'Строка 4')

  const smaller = resizeTableMatrix(matrix, 2, 1, { header_row: 0 })
  assert.deepEqual(smaller, [['H1'], ['A']])
})

test('table playground model updates preview element rows/cols', () => {
  if (!fs.existsSync(sampleReportPath)) return

  const report = JSON.parse(fs.readFileSync(sampleReportPath, 'utf8'))
  const component = listAllComponents(report).find((item) => item.id === 'tbl_003')
  assert.ok(component)

  const instance = component.instances[0]
  const model = defaultTableModel(component, instance, report)
  const resized = resizeTableModelData(model, 4, 5, component.raw.structure || {})
  const applied = applyModelDataToComponent(component, resized, { report, instance })
  assert.ok(applied.ok)
  assert.equal(applied.element.rows, 4)
  assert.equal(applied.element.cols, 5)
  assert.equal(applied.element.preview.length, 4)
  assert.equal(applied.element.preview[0].length, 5)
  assert.equal(applied.element.table.column_widths_pt.length, 5)
})

test('added columns inherit table cell styles and rich text metadata', () => {
  if (!fs.existsSync(sampleReportPath)) return

  const report = JSON.parse(fs.readFileSync(sampleReportPath, 'utf8'))
  const component = listAllComponents(report).find((item) => item.id === 'tbl_003')
  assert.ok(component)

  const instance = component.instances[0]
  const model = defaultTableModel(component, instance, report)
  const resized = resizeTableModelData(model, 7, 14, component.raw.structure || {})
  const applied = applyModelDataToComponent(component, resized, { report, instance })
  assert.ok(applied.ok)

  const tableMeta = applied.element.table
  assert.equal(tableMeta.cell_styles[0].length, 14)
  assert.equal(tableMeta.cell_text[0].length, 14)
  assert.equal(typeof tableMeta.cell_text[1][13], 'object')
  assert.equal(tableMeta.cell_text[1][13].typography?.family, 'Arial')
  assert.deepEqual(tableMeta.cell_styles[1][13]?.borders, tableMeta.cell_styles[1][1]?.borders)
  assert.equal(tableMeta.column_widths_pt[13], tableMeta.column_widths_pt[1])
})

test('last column accent follows edge when column count changes', () => {
  if (!fs.existsSync(sampleReportPath)) return

  const report = JSON.parse(fs.readFileSync(sampleReportPath, 'utf8'))
  const component = listAllComponents(report).find((item) => item.id === 'tbl_003')
  assert.ok(component)

  const instance = component.instances[0]
  const structure = component.raw.structure || {}
  const model = defaultTableModel(component, instance, report)

  const expanded = applyModelDataToComponent(
    component,
    resizeTableModelData(model, 7, 13, structure),
    { report, instance },
  )
  assert.ok(expanded.ok)
  assert.equal(expanded.element.table.cell_styles[1][12]?.fill?.color, '#0077FF')
  assert.equal(expanded.element.table.cell_text[1][12]?.typography?.color, '#EBF3F9')
  assert.notEqual(expanded.element.table.cell_styles[1][11]?.fill?.color, '#0077FF')

  const shrunk = applyModelDataToComponent(
    component,
    resizeTableModelData(model, 7, 10, structure),
    { report, instance },
  )
  assert.ok(shrunk.ok)
  assert.equal(shrunk.element.table.cell_styles[1][9]?.fill?.color, '#0077FF')
  assert.equal(shrunk.element.table.cell_text[1][9]?.typography?.color, '#EBF3F9')
  assert.equal(shrunk.element.table.cell_styles[1][8]?.fill?.color, undefined)
})

test('style_rules table keeps baked cell_styles when size is unchanged', () => {
  if (!fs.existsSync(sampleReportPath)) return

  const report = JSON.parse(fs.readFileSync(sampleReportPath, 'utf8'))
  const component = listAllComponents(report).find((item) => item.id === 'tbl_001')
  assert.ok(component)

  const instance = component.instances[0]
  const model = defaultTableModel(component, instance, report)
  const applied = applyModelDataToComponent(component, model, { report, instance })
  assert.ok(applied.ok)
  assert.equal(applied.element.table.cell_styles[2][0]?.fill?.color, '#E6EBFF')
  assert.equal(applied.element.table.cell_styles[0][0]?.fill?.color, '#0077FF')
  assert.notEqual(applied.element.table.cell_styles[0][0], null)
})

test('inferRowStylePattern detects fixed prefix and 2-row band on tbl_001', () => {
  if (!fs.existsSync(sampleReportPath)) return

  const report = JSON.parse(fs.readFileSync(sampleReportPath, 'utf8'))
  const component = listAllComponents(report).find((item) => item.id === 'tbl_001')
  const instance = component.instances[0]
  const slide = report.slides.slides.find((item) => item.slide_number === instance.slide_number)
  const element = slide.content_elements.find((item) => item.element_id === instance.element_id)
  const pattern = inferRowStylePattern(element.table.cell_styles, element.table)
  assert.ok(pattern)
  assert.equal(pattern.type, 'row_band_2')
  assert.equal(pattern.prefix_length, 2)
  assert.equal(pattern.band_a_fill, '#E6EBFF')
  assert.equal(pattern.band_b_fill, '#CAD5FF')

  const description = describeRowStylePattern(pattern)
  assert.match(description.summary, /строки 1–2/)
})

test('expanded body columns inherit baked text color in cell_styles', () => {
  if (!fs.existsSync(sampleReportPath)) return

  const report = JSON.parse(fs.readFileSync(sampleReportPath, 'utf8'))
  const component = listAllComponents(report).find((item) => item.id === 'tbl_003')
  const instance = component.instances[0]
  const model = defaultTableModel(component, instance, report)
  const applied = applyModelDataToComponent(
    component,
    resizeTableModelData(model, 7, 14, component.raw.structure || {}),
    { report, instance },
  )

  assert.equal(applied.element.table.cell_styles[1][12]?.typography?.color, '#000000')
  assert.equal(applied.element.table.cell_text[1][12]?.typography?.color, '#000000')
  assert.equal(applied.element.table.cell_styles[1][13]?.typography?.color, '#EBF3F9')
})

test('tbl_001 empty header cell keeps no typography when columns expand', () => {
  if (!fs.existsSync(sampleReportPath)) return

  const report = JSON.parse(fs.readFileSync(sampleReportPath, 'utf8'))
  const component = listAllComponents(report).find((item) => item.id === 'tbl_001')
  const instance = component.instances[0]
  const model = defaultTableModel(component, instance, report)
  const applied = applyModelDataToComponent(
    component,
    resizeTableModelData(model, 6, 4, component.raw.structure || {}),
    { report, instance },
  )

  assert.equal(applied.element.table.cell_styles[0][0]?.typography, undefined)
  assert.equal(applied.element.table.cell_text[0][0]?.text, '')
  assert.equal(applied.element.table.cell_styles[1][0]?.typography?.color, '#FFFFFF')
  assert.equal(applied.element.table.cell_text[0][3]?.text, 'Column 4')
  assert.equal(applied.element.table.cell_styles[0][3]?.typography?.color, '#000000')
})

test('tbl_001 row resize extends alternating band after prefix block', () => {
  if (!fs.existsSync(sampleReportPath)) return

  const report = JSON.parse(fs.readFileSync(sampleReportPath, 'utf8'))
  const component = listAllComponents(report).find((item) => item.id === 'tbl_001')
  const instance = component.instances[0]
  const model = defaultTableModel(component, instance, report)
  const applied = applyModelDataToComponent(
    component,
    resizeTableModelData(model, 8, 3, component.raw.structure || {}),
    { report, instance },
  )
  assert.ok(applied.ok)
  const styles = applied.element.table.cell_styles
  assert.equal(styles[0][0]?.fill?.color, '#0077FF')
  assert.equal(styles[1][0]?.fill?.color, '#0077FF')
  assert.equal(styles[2][0]?.fill?.color, '#E6EBFF')
  assert.equal(styles[3][0]?.fill?.color, '#CAD5FF')
  assert.equal(styles[6][0]?.fill?.color, '#E6EBFF')
  assert.equal(styles[7][0]?.fill?.color, '#CAD5FF')
})
