import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { listAllComponents } from './catalog.js'
import {
  inferTableStylePattern,
  rebuildCellStylesFromPattern,
  describeTableStylePattern,
  completeCellStyleTypography,
  cellHasVisibleText,
  listBlankStubCells,
  clearBlankStubCellsInMatrix,
} from './table-style-pattern.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const sampleReportPath = path.resolve(__dirname, '../../../output/b80e2f13b5ec/report.json')
const inferredGridReportPath = path.resolve(__dirname, '../../../output/2a449c71b5a6/report.json')

function loadTable(tid) {
  const report = JSON.parse(fs.readFileSync(sampleReportPath, 'utf8'))
  const component = listAllComponents(report).find((item) => item.id === tid)
  const instance = component.instances[0]
  const slide = report.slides.slides.find((item) => item.slide_number === instance.slide_number)
  const element = slide.content_elements.find((item) => item.element_id === instance.element_id)
  return { component, element }
}

function loadInferredGridTable(tid) {
  const report = JSON.parse(fs.readFileSync(inferredGridReportPath, 'utf8'))
  const component = listAllComponents(report).find((item) => item.id === tid)
  const instance = component.instances[0]
  const slide = report.slides.slides.find((item) => item.slide_number === instance.slide_number)
  const element = slide.content_elements.find((item) => item.element_id === instance.element_id)
  return { component, element }
}

test('inferTableStylePattern detects row band on tbl_001', () => {
  if (!fs.existsSync(sampleReportPath)) return

  const { element } = loadTable('tbl_001')
  const pattern = inferTableStylePattern(element.table.cell_styles, element.table)
  assert.ok(pattern)
  assert.equal(pattern.rows.prefix.length, 2)
  assert.equal(pattern.rows.body.period, 2)
  assert.ok(pattern.confidence >= 0.85)
  assert.match(describeTableStylePattern(pattern).summary, /rows prefix 2, body period 2/)
})

test('inferTableStylePattern detects footer row on tbl_002', () => {
  if (!fs.existsSync(sampleReportPath)) return

  const { element } = loadTable('tbl_002')
  const pattern = inferTableStylePattern(element.table.cell_styles, element.table)
  assert.ok(pattern)
  assert.equal(pattern.rows.prefix.length, 2)
  assert.equal(pattern.rows.body.period, 1)
  assert.equal(pattern.rows.suffix.length, 1)
  assert.equal(pattern.roles.last_row, true)
})

test('inferTableStylePattern detects last column accent on tbl_003', () => {
  if (!fs.existsSync(sampleReportPath)) return

  const { element } = loadTable('tbl_003')
  const pattern = inferTableStylePattern(element.table.cell_styles, element.table)
  assert.ok(pattern)
  assert.equal(pattern.columns.suffix.length, 1)
  assert.equal(pattern.roles.last_col, true)
})

test('tbl_002 row resize keeps header, band, body and footer roles', () => {
  if (!fs.existsSync(sampleReportPath)) return

  const { element } = loadTable('tbl_002')
  const pattern = inferTableStylePattern(element.table.cell_styles, element.table)
  const styles = rebuildCellStylesFromPattern(element.table.cell_styles, 14, 4, element.table, pattern)

  assert.equal(styles[1][0]?.fill?.color, '#EBF3F9')
  assert.equal(styles[2][0]?.fill?.color, undefined)
  assert.equal(styles[13][0]?.fill?.color, '#0077FF')
})

test('tbl_003 column resize keeps accent only on trailing edge', () => {
  if (!fs.existsSync(sampleReportPath)) return

  const { element } = loadTable('tbl_003')
  const pattern = inferTableStylePattern(element.table.cell_styles, element.table)
  const expanded = rebuildCellStylesFromPattern(element.table.cell_styles, 7, 14, element.table, pattern)
  const shrunk = rebuildCellStylesFromPattern(element.table.cell_styles, 7, 10, element.table, pattern)

  assert.equal(expanded[1][13]?.fill?.color, '#0077FF')
  assert.equal(expanded[1][12]?.fill?.color, undefined)
  assert.equal(shrunk[1][9]?.fill?.color, '#0077FF')
  assert.equal(shrunk[1][8]?.fill?.color, undefined)
})

test('completeCellStyleTypography strips typography from empty cells', () => {
  const style = {
    fill: { color: '#0077FF' },
    typography: { color: '#FFFFFF', size_pt: 12, family: 'Arial', alignment: 'r' },
  }
  const tableMeta = {
    preview_matrix: [['', 'Header']],
    cell_text: [[null, { text: 'Header', typography: { color: '#000000', size_pt: 11 } }]],
  }
  const sourceGrid = [[style, { typography: { color: '#000000', size_pt: 11 } }]]

  const emptyCell = completeCellStyleTypography(
    style,
    tableMeta,
    0,
    0,
    1,
    2,
    sourceGrid,
  )
  assert.equal(emptyCell.typography, undefined)

  const textCell = completeCellStyleTypography(
    { fill: { color: '#0077FF' } },
    tableMeta,
    0,
    1,
    1,
    2,
    sourceGrid,
  )
  assert.equal(textCell.typography?.color, '#000000')
  assert.equal(textCell.typography?.size_pt, 11)
})

test('blank stub corner stays empty even when data tries to fill it', () => {
  const tableMeta = {
    structure: { header_row: 0 },
    data_preview: { rows: [['', 'Заголовок столбца, млн', 'Заголовок столбца, млн']] },
    cell_text: [
      [
        { text: '' },
        { text: 'Заголовок столбца, млн', typography: { color: '#FFFFFF', size_pt: 16, family: 'Arial' } },
        { text: 'Заголовок столбца, млн', typography: { color: '#FFFFFF', size_pt: 16, family: 'Arial' } },
      ],
    ],
    cell_styles: [
      [
        { fill: { color: '#0077FF' } },
        { fill: { color: '#0077FF' }, typography: { color: '#FFFFFF', size_pt: 16, family: 'Arial' } },
        { fill: { color: '#0077FF' }, typography: { color: '#FFFFFF', size_pt: 16, family: 'Arial' } },
      ],
    ],
  }

  assert.deepEqual(listBlankStubCells(tableMeta), [[0, 0]])
  assert.deepEqual(listBlankStubCells({
    ...tableMeta,
    structure: { ...tableMeta.structure, blank_stub_cells: [[0, 0]] },
    data_preview: { rows: [['Текст модели', 'Заголовок', 'Заголовок']] },
  }), [[0, 0]])
  assert.deepEqual(
    clearBlankStubCellsInMatrix(
      [['Метрика', 'Заголовок столбца, млн', 'Заголовок столбца, млн']],
      tableMeta,
    ),
    [['', 'Заголовок столбца, млн', 'Заголовок столбца, млн']],
  )

  const filled = completeCellStyleTypography(
    tableMeta.cell_styles[0][0],
    { ...tableMeta, preview_matrix: [['Метрика', 'Заголовок столбца, млн', 'Заголовок столбца, млн']] },
    0,
    0,
    1,
    3,
    tableMeta.cell_styles,
  )
  assert.equal(filled.typography, undefined)
})

test('inferred_grid tbl_001 column resize keeps first-column typography', () => {
  if (!fs.existsSync(inferredGridReportPath)) return

  const { element } = loadInferredGridTable('tbl_001')
  const pattern = inferTableStylePattern(element.table.cell_styles, element.table)
  assert.ok(pattern)
  assert.equal(pattern.roles.first_col, true)

  const styles = rebuildCellStylesFromPattern(element.table.cell_styles, 10, 5, element.table, pattern)
  assert.equal(styles[2][0]?.typography?.color, '#0077FF')
  assert.equal(styles[6][0]?.typography?.color, '#0077FF')
  assert.equal(styles[2][1]?.typography?.color, '#000000')
})

test('inferred_grid tbl_001 row resize keeps first-column typography beyond source rows', () => {
  if (!fs.existsSync(inferredGridReportPath)) return

  const { element } = loadInferredGridTable('tbl_001')
  const sourceRows = element.table.cell_styles.length
  const previewMatrix = Array.from({ length: 13 }, (_, rowIndex) => (
    Array.from({ length: 3 }, (_, colIndex) => (
      element.table.cell_text?.[rowIndex]?.[colIndex]?.text ?? `row_${rowIndex}_col_${colIndex}`
    ))
  ))
  const tableMeta = {
    ...element.table,
    preview_matrix: previewMatrix,
  }
  const pattern = inferTableStylePattern(tableMeta.cell_styles, tableMeta)
  const styles = rebuildCellStylesFromPattern(tableMeta.cell_styles, 13, 3, tableMeta, pattern)

  assert.equal(styles[2][0]?.typography?.color, '#0077FF')
  assert.equal(styles[9][0]?.typography?.color, '#0077FF')
  assert.equal(styles[10][0]?.typography?.color, '#0077FF')
  assert.equal(styles[12][0]?.typography?.color, '#0077FF')
  assert.ok(sourceRows <= 10)
})

test('inferred_grid tbl_002 column resize keeps last-column typography', () => {
  if (!fs.existsSync(inferredGridReportPath)) return

  const { element } = loadInferredGridTable('tbl_002')
  const sourceCols = element.table.cell_styles[0].length
  const previewMatrix = Array.from({ length: 10 }, (_, rowIndex) => (
    Array.from({ length: 10 }, (_, colIndex) => (
      element.table.cell_text?.[rowIndex]?.[colIndex]?.text
      ?? element.table.data_preview?.rows?.[rowIndex]?.[colIndex]
      ?? `row_${rowIndex}_col_${colIndex}`
    ))
  ))
  const tableMeta = {
    ...element.table,
    preview_matrix: previewMatrix,
  }
  const pattern = inferTableStylePattern(tableMeta.cell_styles, tableMeta)
  assert.ok(pattern)
  assert.equal(pattern.roles.last_col, true)

  const styles = rebuildCellStylesFromPattern(tableMeta.cell_styles, 10, 10, tableMeta, pattern)
  assert.equal(styles[2][9]?.typography?.color, '#0077FF')
  assert.equal(styles[6][9]?.typography?.color, '#0077FF')
  assert.equal(styles[2][sourceCols - 1]?.typography?.color, '#000000')
  assert.equal(styles[2][8]?.typography?.color, '#000000')
})

test('cellHasVisibleText ignores empty and transparent text', () => {
  assert.equal(cellHasVisibleText(''), false)
  assert.equal(cellHasVisibleText('value'), true)
  assert.equal(cellHasVisibleText({ text: '', typography: { color: '#FFF' } }), false)
  assert.equal(cellHasVisibleText({ text: 'x', typography: { alpha: 0 } }), false)
  assert.equal(cellHasVisibleText({ text: 'x', typography: { color: '#000000' } }), true)
})
