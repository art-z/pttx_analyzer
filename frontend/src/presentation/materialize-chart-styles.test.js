import test from 'node:test'
import assert from 'node:assert/strict'

import { materializeChartStyles } from './materialize-chart-styles.js'

const report = {
  typography: {},
  theme: {
    themes: [{
      colors: {
        dk1: { value: '223344' },
        lt1: { value: 'FFFFFF' },
      },
    }],
  },
  colors: {
    resolved_palette: [
      { color: '#AA5500', alpha: 1 },
      { color: '#0088CC', alpha: 1 },
    ],
  },
  graphic_components: {
    chart_series_palette: {
      colors: ['#112233', '#445566', '#778899'],
      fill_variants: [],
    },
  },
}

test('materializeChartStyles stores report DS palette inside final chart element', () => {
  const slide = {
    content_elements: [{
      element_id: 'chart',
      kind: 'chart',
      chart_type: 'bar',
      chart: {
        type: 'bar',
        categories_preview: ['A', 'B'],
        series: [
          { name: 'One', values_preview: [1, 2] },
          { name: 'Two', values_preview: [2, 3] },
        ],
      },
    }],
  }

  const styled = materializeChartStyles(report, slide)
  assert.deepEqual(
    styled.content_elements[0].chart.style_tokens.series_palette,
    [{ color: '#112233' }, { color: '#445566' }, { color: '#778899' }],
  )
})

test('materializeChartStyles recolors dark baseline labels on a dark template fill', () => {
  const slide = {
    render: {
      background_color: '#FFFFFF',
      layers: [{
        kind: 'fill',
        z_index: 2,
        geometry_norm: { x: 0.5, y: 0, width: 0.5, height: 1 },
        fill: { kind: 'solid', color: '#262626', alpha: 1 },
      }],
    },
    content_elements: [{
      element_id: 'cht_baseline_line',
      kind: 'chart',
      is_baseline: true,
      chart_type: 'line',
      chart: {
        type: 'line',
        categories_preview: ['A', 'B'],
        series: [{ name: 'One', values_preview: [1, 2] }],
        style_tokens: {
          category_axis: { typography: { color: '#000000' } },
          value_axis: { typography: { color: '#000000' } },
          legend: { typography: { color: '#000000' } },
        },
      },
    }],
  }

  const styled = materializeChartStyles(report, slide)
  const tokens = styled.content_elements[0].chart.style_tokens
  assert.equal(tokens.category_axis.typography.color, '#FFFFFF')
  assert.equal(tokens.value_axis.typography.color, '#FFFFFF')
  assert.equal(tokens.legend.typography.color, '#FFFFFF')
})

test('materializeChartStyles includes enough DS colors for pie slices', () => {
  const slide = {
    content_elements: [{
      element_id: 'pie',
      kind: 'chart',
      chart_type: 'pie',
      chart: {
        type: 'pie',
        categories_preview: ['A', 'B', 'C'],
        series: [{ name: 'Share', values_preview: [1, 2, 3] }],
      },
    }],
  }

  const styled = materializeChartStyles(report, slide)
  assert.equal(styled.content_elements[0].chart.style_tokens.series_palette.length >= 3, true)
})

test('materializeChartStyles freezes preview DS colors for diagrams and tables', () => {
  const slide = {
    content_elements: [
      {
        element_id: 'diagram',
        kind: 'diagram',
        is_baseline: true,
        diagram: {
          style_tokens: {
            connector: { width_pt: 1 },
            node: { typography: {} },
          },
        },
      },
      {
        element_id: 'table',
        kind: 'table',
        table: { style_tokens: {} },
      },
    ],
  }

  const styled = materializeChartStyles(report, slide)
  const diagram = styled.content_elements[0].diagram.style_tokens
  const table = styled.content_elements[1].table.style_tokens

  assert.equal(diagram.connector.color.color, '#AA5500')
  assert.equal(diagram.node.border.color.color, '#AA5500')
  assert.equal(diagram.node.typography.color, '#223344')
  assert.equal(table.header_cell.typography.color, '#223344')
  assert.equal(table.body_cell.typography.color, '#223344')
})

test('materializeChartStyles assigns DS body size to table cells without typography size', () => {
  const styled = materializeChartStyles({
    ...report,
    typography: {
      scale_usage: {
        scale_roles: [{
          family: 'Inter',
          levels: [{ scale_level: 'body', size_pt: 15, role_hint: 'body', body_probability: 0.9 }],
        }],
      },
    },
  }, {
    content_elements: [{
      element_id: 'table',
      kind: 'table',
      table: { style_tokens: { body_cell: { typography: {} } } },
    }],
  })

  assert.equal(styled.content_elements[0].table.style_tokens.body_cell.typography.size_pt, 15)
})

test('materializeChartStyles expands narrow tables for wrapped cell text when right-side space is available', () => {
  const slide = {
    render: { slide_size_pt: { width: 960, height: 540 } },
    content_elements: [{
      element_id: 'table',
      kind: 'table',
      geometry_norm: { x: 0.1, y: 0.2, width: 0.25, height: 0.2 },
      geometry_pt: { x_pt: 96, y_pt: 108, width_pt: 240, height_pt: 108 },
      rows: 2,
      cols: 2,
      preview: [
        ['Канал', 'Описание'],
        ['Партнерская сеть', 'Автоматическая обработка тысяч корпоративных презентаций в месяц'],
      ],
      table: {
        layout_width_pt: 240,
        column_widths_pt: [100, 140],
        style_tokens: {
          body_cell: { typography: { family: 'Arial', size_pt: 14 } },
        },
      },
    }],
  }

  const styled = materializeChartStyles(report, slide)
  const table = styled.content_elements[0]

  assert.equal(table.table.text_fit.expanded_for_cell_text, true)
  assert.ok(table.table.layout_width_pt > 240)
  assert.ok(table.geometry_norm.width > 0.25)
  assert.ok(table.geometry_norm.x + table.geometry_norm.width <= 0.96 + 1e-6)
})
