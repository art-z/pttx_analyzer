import test from 'node:test'
import assert from 'node:assert/strict'

import {
  applyChartDataToElement,
  applyContainerDataToInstance,
  applyDiagramDataToElement,
  applyModelData,
  applyModelDataToComponent,
  applyTableDataToElement,
  buildBaselineGraphicElement,
  tableDataToMatrix,
  tableMatrixToDataPayload,
} from './model-data.js'

test('table roundtrip matrix -> data -> matrix', () => {
  const matrix = [
    ['Product', 'Q1'],
    ['A', '10'],
    ['B', '20'],
  ]
  const data = tableMatrixToDataPayload(matrix, { header_row: 0 }, { componentId: 'tbl_001' })
  const restored = tableDataToMatrix(data, { header_row: 0 })
  assert.deepEqual(restored, matrix)
})

test('applyTableDataToElement keeps blank stub corner empty', () => {
  const element = {
    kind: 'table',
    rows: 2,
    cols: 3,
    table: {
      structure: { header_row: 0 },
      style_tokens: {
        header_cell: { typography: { color: '#FFFFFF', size_pt: 16, family: 'Arial' } },
      },
      column_widths_pt: [80, 120, 120],
      row_heights_pt: [40, 40],
      data_preview: { rows: [['', 'Col A', 'Col B'], ['r1', '1', '2']] },
      cell_styles: [
        [
          { fill: { color: '#0077FF' } },
          { fill: { color: '#0077FF' }, typography: { color: '#FFFFFF', size_pt: 16, family: 'Arial' } },
          { fill: { color: '#0077FF' }, typography: { color: '#FFFFFF', size_pt: 16, family: 'Arial' } },
        ],
        [
          { typography: { color: '#000000', size_pt: 12 } },
          { typography: { color: '#000000', size_pt: 12 } },
          { typography: { color: '#000000', size_pt: 12 } },
        ],
      ],
      cell_text: [
        [
          { text: '' },
          { text: 'Col A', typography: { color: '#FFFFFF', size_pt: 16, family: 'Arial' } },
          { text: 'Col B', typography: { color: '#FFFFFF', size_pt: 16, family: 'Arial' } },
        ],
        [
          { text: 'r1', typography: { color: '#000000', size_pt: 12 } },
          { text: '1', typography: { color: '#000000', size_pt: 12 } },
          { text: '2', typography: { color: '#000000', size_pt: 12 } },
        ],
      ],
    },
    preview: [['', 'Col A', 'Col B'], ['r1', '1', '2']],
  }

  const applied = applyTableDataToElement(element, {
    columns: [
      { id: 'c0', label: 'Метрика', type: 'text' },
      { id: 'c1', label: 'Col A', type: 'text' },
      { id: 'c2', label: 'Col B', type: 'text' },
    ],
    rows: [{ c0: 'row', c1: '10', c2: '20' }],
  })

  assert.deepEqual(applied.preview[0], ['', 'Col A', 'Col B'])
  assert.deepEqual(applied.table.structure.blank_stub_cells, [[0, 0]])
  assert.equal(applied.table.cell_styles[0][0].typography, undefined)
  assert.equal(applied.table.cell_text[0][0].text, '')
  assert.equal(applied.table.cell_text[0][0].typography, undefined)
})

test('applyTableDataToElement updates preview rows only', () => {
  const element = {
    kind: 'table',
    rows: 2,
    cols: 2,
    table: {
      structure: { header_row: 0 },
      style_tokens: { header_cell: { typography: { bold: true } } },
      column_widths_pt: [100, 100],
      data_preview: { rows: [['H1', 'H2'], ['a', 'b']] },
    },
    preview: [['H1', 'H2'], ['a', 'b']],
  }

  const applied = applyTableDataToElement(element, {
    columns: [
      { id: 'h1', label: 'H1', type: 'text' },
      { id: 'h2', label: 'H2', type: 'number' },
    ],
    rows: [{ h1: 'X', h2: '42' }],
  })

  assert.deepEqual(applied.preview, [['H1', 'H2'], ['X', '42']])
  assert.equal(applied.table.style_tokens.header_cell.typography.bold, true)
  assert.deepEqual(applied.table.column_widths_pt, [100, 100])
})

test('applyModelDataToComponent shrinks a table to explicit model dimensions', () => {
  const component = {
    id: 'tbl_compact',
    source: 'graphic',
    kind: 'table',
    raw: { structure: { header_row: 0 } },
    capacity: { row_count_typical: 5, col_count_typical: 4 },
  }
  const baseElement = {
    kind: 'table',
    rows: 5,
    cols: 4,
    preview: [
      ['H1', 'H2', 'H3', 'H4'],
      ['1', '2', '3', '4'],
      ['5', '6', '7', '8'],
      ['9', '10', '11', '12'],
      ['13', '14', '15', '16'],
    ],
    table: {
      structure: { header_row: 0 },
      column_widths_pt: [100, 100, 100, 100],
      row_heights_pt: [20, 20, 20, 20, 20],
    },
  }
  const result = applyModelDataToComponent(component, {
    component_id: 'tbl_compact',
    columns: [
      { id: 'a', label: 'A', type: 'text' },
      { id: 'b', label: 'B', type: 'text' },
    ],
    rows: [{ a: '1', b: '2' }],
    row_count: 2,
    col_count: 2,
  }, { report: {}, baseElement })

  assert.equal(result.ok, true)
  assert.equal(result.element.rows, 2)
  assert.equal(result.element.cols, 2)
  assert.deepEqual(result.element.preview, [['A', 'B'], ['1', '2']])
  assert.equal(result.element.table.column_widths_pt.length, 2)
  assert.equal(result.element.table.row_heights_pt.length, 2)
})

test('applyChartDataToElement updates series values', () => {
  const element = {
    kind: 'chart',
    chart_type: 'bar',
    chart: { type: 'bar', style_tokens: { legend: { visible: true } }, series: [], categories_preview: [] },
  }

  const applied = applyChartDataToElement(element, {
    chart_type: 'bar',
    categories: ['A', 'B'],
    series: [{ id: 's1', label: 'Sales', values: [1, 2] }],
  })

  assert.deepEqual(applied.chart.categories_preview, ['A', 'B'])
  assert.deepEqual(applied.chart.series[0].values_preview, [1, 2])
  assert.equal(applied.chart.style_tokens.legend.visible, true)
})

test('applyDiagramDataToElement updates node labels', () => {
  const element = {
    kind: 'diagram',
    diagram: { diagram_type: 'flow', preview_texts: ['Old'] },
    preview_texts: ['Old'],
  }

  const applied = applyDiagramDataToElement(element, {
    diagram_type: 'flow',
    nodes: [{ id: 'n1', label: 'New 1' }, { id: 'n2', label: 'New 2' }],
  })

  assert.deepEqual(applied.preview_texts, ['New 1', 'New 2'])
})

test('diagram baseline carries inferred style tokens into the renderer payload', () => {
  const styleTokens = {
    connector: { color: { color: '#445566' }, width_pt: 2, dash: 'dash' },
    node: { fill: { color: '#EEF2F5' }, typography: { family: 'Inter', size_pt: 13 } },
  }
  const element = buildBaselineGraphicElement({
    typography: { visibility: { slide_size_pt: { width: 960, height: 540 } } },
  }, {
    id: 'dgm_baseline_flow',
    kind: 'diagram',
    raw: {
      is_baseline: true,
      diagram_type: 'flow',
      deck_style_source: { slide_number: 52, confidence: 0.9 },
      style_tokens: styleTokens,
      preview_texts: ['A', 'B'],
    },
  })

  assert.deepEqual(element.style_tokens, styleTokens)
  assert.deepEqual(element.diagram.style_tokens, styleTokens)
  assert.equal(element.deck_style_source.slide_number, 52)
})

test('applyContainerDataToInstance fills slot texts', () => {
  const instance = {
    slots: [
      { role: 'title', kind: 'text', text: 'Old title' },
      { role: 'description', kind: 'text', text: 'Old body' },
    ],
  }

  const applied = applyContainerDataToInstance(instance, {
    title: 'New title',
    text: 'New body',
    fields: {},
  })

  assert.equal(applied.slots[0].text, 'New title')
  assert.equal(applied.slots[1].text, 'New body')
})

test('applyModelData iterates all payload groups', () => {
  const components = [
    { id: 'tbl_001', source: 'graphic', kind: 'table', raw: { structure: { header_row: 0 }, data_preview: { rows: [['H'], ['1']] } }, instances: [] },
    { id: 'cht_001', source: 'graphic', kind: 'chart', raw: { chart_type: 'bar' }, instances: [] },
    { id: 'cmp_001', source: 'spatial', kind: 'container', name: 'CARD', instances: [{ slots: [{ role: 'title', kind: 'text', text: 'T' }] }] },
  ]

  const report = { typography: { visibility: { slide_size_pt: { width: 960, height: 540 } } } }
  const result = applyModelData({
    tables: [{ component_id: 'tbl_001', columns: [{ id: 'h', label: 'H', type: 'text' }], rows: [{ h: '9' }] }],
    charts: [{ component_id: 'cht_001', chart_type: 'line', categories: ['Q1'], series: [{ id: 's1', label: 'S', values: [5] }] }],
    containers: [{ component_id: 'cmp_001', title: 'Hello', text: 'World', fields: {} }],
  }, { report, components })

  assert.equal(result.applied.length, 3)
  assert.equal(result.skipped.length, 0)
  assert.equal(result.applied[0].kind, 'table')
  assert.equal(result.applied[1].kind, 'chart')
  assert.equal(result.applied[2].kind, 'container')
})
