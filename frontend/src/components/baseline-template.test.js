import assert from 'node:assert/strict'
import test from 'node:test'
import {
  filterShellContentElements,
  resolveBaselinePreviewPlacement,
  resolveSpatialContentBBox,
} from './baseline-template.js'

function spatialFixture() {
  const counts = Array.from({ length: 4 }, (_, row) => (
    Array.from({ length: 8 }, (_, col) => (row >= 1 && row <= 2 && col >= 1 && col <= 6 ? 10 : 0))
  ))
  const freeRatios = counts.map((row) => row.map((value) => value ? 0.1 : 1))
  return {
    components: [
      { id: 'text_regions', heatmap: { cols: 8, rows: 4, counts, max_count: 10 } },
      { id: 'image_regions', heatmap: { cols: 8, rows: 4, counts, max_count: 10 } },
      { id: 'repeated_groups', heatmap: { cols: 8, rows: 4, counts, max_count: 10 } },
      { id: 'safe_space', heatmap: { cols: 8, rows: 4, free_ratios: freeRatios, mode: 'free_ratio' } },
    ],
  }
}

test('replace_fullwidth_content keeps only top title from source slide', () => {
  const slide = {
    content_elements: [
      { element_id: 'slide_pic_100', kind: 'image', geometry_norm: { x: 0, y: 0.27, width: 1, height: 0.66 } },
      { element_id: 'slide_text_101', kind: 'text', geometry_norm: { x: 0.07, y: 0.34, width: 0.47, height: 0.4 }, text: 'body css' },
      { element_id: 'slide_text_105', kind: 'text', geometry_norm: { x: 0.02, y: 0.06, width: 0.74, height: 0.12 }, text: 'Title' },
    ],
  }
  const kept = filterShellContentElements(slide, {}, {}, {
    match_strategy: 'replace_fullwidth_content',
    replaced_element_id: 'slide_pic_100',
  })
  assert.equal(kept.length, 1)
  assert.equal(kept[0].element_id, 'slide_text_105')
})

test('baseline cartesian chart fills the available canvas below the slide title', () => {
  const report = {
    typography: { visibility: { slide_size_pt: { width: 960, height: 540 } } },
    slides: {
      slides: [{
        slide_number: 1,
        layout_source: 'layout.xml',
        render: { slide_size_pt: { width: 960, height: 540 } },
        content_elements: [{
          element_id: 'title',
          kind: 'text',
          text_role: 'title',
          text: 'Slide title',
          geometry_norm: { x: 0.04, y: 0.06, width: 0.82, height: 0.1 },
        }],
      }],
    },
    slide_semantics: { shell_templates: [] },
  }

  const placement = resolveBaselinePreviewPlacement(report, {
    kind: 'chart',
    raw: {},
  })

  assert.equal(placement.match_strategy, 'title_top_canvas')
  assert.equal(placement.geometry_norm.height, placement.content_region.height)
})

test('legacy baseline chart placement is expanded from the old padded 82% geometry', () => {
  const placement = resolveBaselinePreviewPlacement({
    typography: { visibility: { slide_size_pt: { width: 960, height: 540 } } },
  }, {
    kind: 'chart',
    chartType: 'area',
    raw: {
      chart_type: 'area',
      baseline_preview: {
        match_strategy: 'replace_fullwidth_content',
        geometry_norm: { x: 0.03, y: 0.24, width: 0.94, height: 0.62 },
        geometry_pt: { x_pt: 28.8, y_pt: 129.6, width_pt: 902.4, height_pt: 334.8 },
      },
    },
  })

  assert.ok(placement.geometry_norm.height > 0.7)
  assert.ok(placement.geometry_norm.y < 0.24)
})



test('spatial heatmaps become the preferred bbox for baseline cartesian charts', () => {
  const report = {
    typography: {
      visibility: { slide_size_pt: { width: 960, height: 540 } },
      spatial: spatialFixture(),
    },
    layout: { content_margins: { left_norm: 0.04, right_norm: 0.04, top_norm: 0.05, bottom_norm: 0.08 } },
  }
  const bbox = resolveSpatialContentBBox(report)
  assert.ok(bbox)
  assert.ok(bbox.width > 0.8)
  assert.ok(bbox.y >= 0.1)

  const placement = resolveBaselinePreviewPlacement(report, {
    kind: 'chart',
    chartType: 'area',
    raw: {
      chart_type: 'area',
      baseline_preview: {
        match_strategy: 'replace_fullwidth_content',
        geometry_norm: { x: 0.1, y: 0.3, width: 0.7, height: 0.4 },
      },
    },
  })
  assert.equal(placement.geometry_source, 'spatial_heatmap')
  assert.deepEqual(placement.geometry_norm, {
    x: bbox.x,
    y: bbox.y,
    width: bbox.width,
    height: bbox.height,
  })
})

test('spatial chart bbox preserves the median deck gap below the slide title', () => {
  const report = {
    typography: {
      visibility: { slide_size_pt: { width: 960, height: 540 } },
      spatial: spatialFixture(),
    },
    layout: {
      content_margins: {
        left_norm: 0.04,
        right_norm: 0.04,
        bottom_norm: 0.08,
        title_content_gap_norm: 0.06,
      },
    },
    slides: {
      slides: [{
        slide_number: 7,
        content_elements: [{
          element_id: 'title',
          kind: 'text',
          placeholder_type: 'title',
          geometry_norm: { x: 0.05, y: 0.06, width: 0.9, height: 0.1 },
        }],
      }],
    },
  }
  const bbox = resolveSpatialContentBBox(report)
  const placement = resolveBaselinePreviewPlacement(report, {
    kind: 'chart',
    chartType: 'area',
    raw: {
      chart_type: 'area',
      baseline_preview: {
        slide_number: 7,
        match_strategy: 'replace_fullwidth_content',
        geometry_norm: { x: 0.1, y: 0.3, width: 0.7, height: 0.4 },
      },
    },
  })

  assert.ok(bbox.y < 0.22)
  assert.equal(placement.geometry_norm.y, 0.22)
  assert.equal(placement.geometry_norm.y + placement.geometry_norm.height, bbox.y + bbox.height)
  assert.equal(placement.title_clearance_norm, 0.06)
})

test('spatial chart shell keeps only the slide title outside the chart bbox', () => {
  const title = { element_id: 'title', kind: 'text', text_role: 'title', geometry_norm: { y: 0.05 } }
  const body = { element_id: 'body', kind: 'text', text_role: 'body', geometry_norm: { y: 0.4 } }
  const kept = filterShellContentElements({ content_elements: [title, body] }, {}, { kind: 'chart' }, {
    match_strategy: 'replace_split_graphic',
    geometry_source: 'spatial_heatmap',
  })
  assert.deepEqual(kept, [title])
})
