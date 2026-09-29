import test from 'node:test'
import assert from 'node:assert/strict'

import { prepareGeneratedSlide, GENERATED_SCENE_VERSION } from './generated-export-scene.js'

const report = {
  typography: {},
  colors: { resolved_palette: [{ color: '#1188CC' }] },
  graphic_components: {
    chart_series_palette: {
      colors: ['#1188CC', '#FF7733'],
      fill_variants: [{
        kind: 'linear_gradient',
        stops: [{ position: 0, color: '#224466' }, { position: 1, color: '#6688AA' }],
      }],
    },
  },
}

test('generated preview and export share resolved editable slide data', () => {
  const source = {
    render: { slide_size_pt: { width: 960, height: 540 } },
    content_elements: [{
      kind: 'chart',
      chart_type: 'bar',
      chart: {
        categories_preview: ['До', 'После'],
        series: [{ name: 'Время', values_preview: [12, 4] }],
      },
    }],
  }

  const prepared = prepareGeneratedSlide(report, source)
  const style = prepared.content_elements[0].chart.style_tokens
  assert.equal(prepared.export_scene_version, GENERATED_SCENE_VERSION)
  assert.equal(style.series_fill_variants[0].kind, 'solid')
  assert.equal(style.series_fill_variants[0].color, '#224466')
  assert.equal(style.series_palette[0].color, '#224466')
  assert.equal(source.content_elements[0].chart.style_tokens, undefined)
  const preparedAgain = prepareGeneratedSlide(report, prepared)
  assert.equal(preparedAgain.export_scene_version, GENERATED_SCENE_VERSION)
  assert.deepEqual(preparedAgain.content_elements[0].chart.style_tokens, style)
})

test('generated scene replays hit-test layout before export', () => {
  const prepared = prepareGeneratedSlide(report, {
    export_scene_version: GENERATED_SCENE_VERSION,
    render: { slide_size_pt: { width: 960, height: 540 } },
    content_elements: [
      {
        element_id: 'slide_title',
        kind: 'text',
        role: 'title',
        text: 'Доли использования по отделам',
        geometry_norm: { x: 0.18, y: 0.31, width: 0.41, height: 0.31 },
        geometry_pt: { x_pt: 173, y_pt: 166, width_pt: 392, height_pt: 166 },
        typography: { size_pt: 48, family: 'Play' },
      },
      {
        element_id: 'chart',
        kind: 'chart',
        chart_type: 'doughnut',
        component_data: true,
        geometry_norm: { x: 0.18, y: 0.26, width: 0.41, height: 0.65 },
        geometry_pt: { x_pt: 173, y_pt: 140, width_pt: 394, height_pt: 350 },
        chart: {
          categories_preview: ['Маркетинг', 'Коммуникации', 'Дизайн'],
          series: [{ values_preview: [60, 30, 10] }],
        },
      },
    ],
  })

  const byId = new Map(prepared.content_elements.map((element) => [element.element_id, element]))
  const title = byId.get('slide_title')
  const chart = byId.get('chart')
  assert.ok(title.geometry_norm.y < 0.2)
  assert.ok(chart.geometry_norm.y >= title.geometry_norm.y + title.geometry_norm.height)
  assert.deepEqual(chart.geometry_pt, {
    x_pt: chart.geometry_norm.x * 960,
    y_pt: chart.geometry_norm.y * 540,
    width_pt: chart.geometry_norm.width * 960,
    height_pt: chart.geometry_norm.height * 540,
  })
})

test('generated scene freezes slide dimensions before DOM preview', () => {
  const prepared = prepareGeneratedSlide({
    typography: { visibility: { slide_size_pt: { width: 1280, height: 720 } } },
  }, { content_elements: [] })
  assert.deepEqual(prepared.render.slide_size_pt, { width: 1280, height: 720 })
})

test('generated scene promotes inserted graphics above template fills', () => {
  const prepared = prepareGeneratedSlide(report, {
    render: {
      slide_size_pt: { width: 960, height: 540 },
      layers: [
        { kind: 'fill', z_index: 0, geometry_norm: { x: 0, y: 0, width: 1, height: 1 } },
        { kind: 'fill', z_index: 80, geometry_norm: { x: 0.1, y: 0.1, width: 0.8, height: 0.8 } },
      ],
    },
    content_elements: [
      { element_id: 'donor-decor', kind: 'fill', z_index: 81 },
      {
        element_id: 'chart',
        kind: 'chart',
        z_index: 1,
        component_data: true,
        chart_type: 'bar',
        chart: {
          categories_preview: ['A'],
          series: [{ name: 'Value', values_preview: [1] }],
        },
      },
      { element_id: 'label', kind: 'text', z_index: 2, placement_content: true },
    ],
  })

  const byId = new Map(prepared.content_elements.map((element) => [element.element_id, element]))
  assert.equal(byId.get('donor-decor').z_index, 81)
  assert.ok(byId.get('chart').z_index > 80)
  assert.ok(byId.get('label').z_index > byId.get('chart').z_index)
})

test('generated scene syncs point geometry from DOM preview geometry', () => {
  const prepared = prepareGeneratedSlide(report, {
    render: { slide_size_pt: { width: 960, height: 540 } },
    content_elements: [{
      element_id: 'text',
      kind: 'text',
      text: 'Moved by hit-test',
      geometry_norm: { x: 0.25, y: 0.2, width: 0.5, height: 0.1 },
      geometry_pt: { x_pt: 1, y_pt: 2, width_pt: 3, height_pt: 4 },
      text_group_id: 'g1',
      text_group_geometry_norm: { x: 0.2, y: 0.18, width: 0.6, height: 0.2 },
      text_group_geometry_pt: { x_pt: 5, y_pt: 6, width_pt: 7, height_pt: 8 },
      placement_content: true,
    }],
  })

  const [text] = prepared.content_elements
  assert.deepEqual(text.geometry_pt, {
    x_pt: 240,
    y_pt: 108,
    width_pt: 480,
    height_pt: 54,
  })
  assert.deepEqual(text.text_group_geometry_pt, {
    x_pt: 192,
    y_pt: 97.2,
    width_pt: 576,
    height_pt: 108,
  })
})
