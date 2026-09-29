import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildCartesianLayout,
  buildMonotoneChartPath,
  computeCenterMetricFitScale,
  mountChart,
  resolveBaseChartLabelTypography,
  resolveChartTextColor,
  resolveDoughnutHoleSize,
  resolveSeriesDisplayColor,
} from './chart-render.js'

test('doughnut hole expands to contain the center metric', () => {
  const small = resolveDoughnutHoleSize({
    subtype: { hole_size: 50 },
    geometry_pt: { width_pt: 180 },
  }, {
    value: '100',
    unit: '%',
    valueTypography: { size_pt: 34 },
    unitTypography: { size_pt: 18 },
  })
  assert.ok(small > 50)

  const large = resolveDoughnutHoleSize({
    subtype: { hole_size: 50 },
    geometry_pt: { width_pt: 420 },
  }, {
    value: '42',
    unit: '%',
    valueTypography: { size_pt: 24 },
    unitTypography: { size_pt: 14 },
  })
  assert.equal(large, 64)
})

test('center metric fit never enlarges type and shrinks unsafe text', () => {
  assert.equal(computeCenterMetricFitScale({
    diameter: 300,
    holeSize: 64,
    contentWidth: 120,
    contentHeight: 60,
  }), 1)
  const scale = computeCenterMetricFitScale({
    diameter: 180,
    holeSize: 64,
    contentWidth: 180,
    contentHeight: 80,
  })
  assert.ok(scale < 1)
  assert.ok(scale > 0)
})

function fakeNode(tagName = 'div') {
  return {
    tagName,
    attributes: {},
    style: {},
    children: [],
    className: '',
    classList: { add() {} },
    append(...items) { this.children.push(...items) },
    prepend(...items) { this.children.unshift(...items) },
    setAttribute(name, value) { this.attributes[name] = String(value) },
    querySelector() { return null },
  }
}

test('resolveChartTextColor prefers body text over series palette accents', () => {
  const tokens = {
    defaultTextColor: '#FF3885',
    bodyTypographyOptions: [{ color: '#333333' }],
    palette: ['#FF3885', '#00AEE8'],
    chartSeriesPalette: ['#FF3885'],
  }
  const styleTokens = {
    series_palette: [{ color: '#FF3885' }],
    category_axis: { typography: { color: '#FF3885' } },
  }
  const color = resolveChartTextColor(tokens, styleTokens, {
    tokenKey: 'category_axis',
    preferBody: true,
  })
  assert.equal(color, '#333333')
})

test('inferred pseudo-chart axis color takes priority over generic body color', () => {
  const color = resolveChartTextColor({
    bodyTypographyOptions: [{ color: '#333333' }],
  }, {
    inference: { source: 'pseudo_chart' },
  }, {
    typography: { color: '#FFFFFF' },
    tokenKey: 'category_axis',
    preferBody: true,
  })
  assert.equal(color, '#FFFFFF')
})

test('a dark template fill recolors chart labels that have no plate', () => {
  const color = resolveChartTextColor({
    titleColors: ['#000000', '#FFFFFF'],
    defaultTextColor: '#111111',
    bodyTypographyOptions: [{ color: '#111111' }],
    themeColors: { lt2: '#FFFFFF', dk1: '#000000' },
  }, {
    category_axis: { typography: { color: '#111111' } },
    is_baseline: true,
  }, {
    tokenKey: 'category_axis',
    surfaceColor: '#262626',
  })
  assert.equal(color, '#FFFFFF')
})

test('a label plate keeps dark chart text on a dark template fill', () => {
  const color = resolveChartTextColor({
    titleColors: ['#FFFFFF'],
    themeColors: { lt2: '#FFFFFF' },
  }, {
    category_axis: {
      typography: { color: '#111111' },
      fill: { kind: 'solid', color: '#FFFFFF', alpha: 1 },
    },
  }, {
    tokenKey: 'category_axis',
    surfaceColor: '#262626',
  })
  assert.equal(color, '#111111')
})

test('chart labels fall back to the design-system body typography', () => {
  assert.deepEqual(resolveBaseChartLabelTypography({
    defaultFontFamily: 'Fallback',
    defaultTextColor: '#111111',
    bodyTypographyOptions: [{ family: 'Play', sizePt: 14, color: '#334455' }],
  }), {
    family: 'Play',
    size_pt: 14,
    color: '#334455',
    bold: false,
  })
})

test('resolveSeriesDisplayColor uses fill variants before palette list', () => {
  const palette = ['#B3D1E8', '#7CEDF8']
  const fillVariants = [
    { kind: 'solid', color: '#0077FF' },
    { kind: 'solid', color: '#FF3885' },
  ]
  assert.equal(resolveSeriesDisplayColor(fillVariants, palette, 0), '#0077FF')
  assert.equal(resolveSeriesDisplayColor(fillVariants, palette, 1), '#FF3885')
})

test('line and area charts use a smooth monotone path without invalid coordinates', () => {
  const path = buildMonotoneChartPath([
    { x: 0, y: 80 },
    { x: 25, y: 20 },
    { x: 50, y: 60 },
    { x: 75, y: 35 },
  ])
  assert.match(path, /^M 0 80 C /)
  assert.equal((path.match(/ C /g) || []).length, 3)
  assert.ok(!path.includes('NaN'))
  assert.ok(!path.includes('Infinity'))
})

test('cartesian layout adapts its left gutter to rendered y-axis values', () => {
  const compact = buildCartesianLayout(['A', 'B'], [{ values_preview: [5, 10] }], {
    chartWidthPt: 600,
    chartHeightPt: 300,
  })
  const wide = buildCartesianLayout(['A', 'B'], [{ values_preview: [500000, 1000000] }], {
    chartWidthPt: 600,
    chartHeightPt: 300,
  })
  assert.ok(compact.plot.left < 5)
  assert.ok(wide.plot.left > compact.plot.left)
})

test('x-axis uses a compact adaptive band instead of the old fixed 24 percent', () => {
  const tall = buildCartesianLayout(['Q1', 'Q2', 'Q3'], [{ values_preview: [1, 2, 3] }], {
    chartWidthPt: 600,
    chartHeightPt: 360,
  })
  const short = buildCartesianLayout(['Q1', 'Q2', 'Q3'], [{ values_preview: [1, 2, 3] }], {
    chartWidthPt: 600,
    chartHeightPt: 160,
  })
  assert.ok(tall.plot.bottom < 8)
  assert.ok(short.plot.bottom > tall.plot.bottom)
})

test('mountChart resolves axis and legend visibility in chart runtime scope', () => {
  const previousDocument = globalThis.document
  globalThis.document = {
    createElement(name) {
      if (name === 'canvas') return { getContext: () => null }
      return fakeNode(name)
    },
    createElementNS(_namespace, name) { return fakeNode(name) },
    createTextNode(text) { return { textContent: text } },
  }
  try {
    const root = fakeNode()
    const result = mountChart(root, {
      chart_type: 'bar',
      geometry_pt: { width_pt: 600, height_pt: 300 },
      chart: {
        type: 'bar',
        categories_preview: ['Q1', 'Q2'],
        series: [
          { name: 'A', values_preview: [10, 20] },
          { name: 'B', values_preview: [15, 18] },
        ],
        style_tokens: { legend: { visible: true } },
      },
    }, { width: 960, height: 540 })
    assert.equal(result, root)
    assert.ok(root.children.length >= 2)
  } finally {
    globalThis.document = previousDocument
  }
})

test('doughnut preview applies regular font weight explicitly', () => {
  const previousDocument = globalThis.document
  globalThis.document = {
    createElement(name) { return fakeNode(name) },
    createElementNS(_namespace, name) { return fakeNode(name) },
    createTextNode(text) { return { textContent: text } },
  }
  const collectByClass = (node, className) => [
    ...(node.className === className ? [node] : []),
    ...(node.children || []).flatMap((child) => collectByClass(child, className)),
  ]
  try {
    const root = fakeNode()
    mountChart(root, {
      chart_type: 'doughnut',
      geometry_pt: { width_pt: 300, height_pt: 348 },
      center_metric_preview: { value: '22', unit: '%' },
      style_tokens: { circular_layout: { center_metric: {
        enabled: true,
        value_typography: { family: 'Play', size_pt: 88, bold: false },
        unit_typography: { family: 'Play', size_pt: 60, bold: false },
      } } },
    }, { width: 960, height: 540 })
    assert.equal(collectByClass(root, 'catalog-chart-center-metric-value')[0].style.fontWeight, '400')
    assert.equal(collectByClass(root, 'catalog-chart-center-metric-unit')[0].style.fontWeight, '400')
  } finally {
    globalThis.document = previousDocument
  }
})

test('doughnut svg fills the full square diameter', () => {
  const previousDocument = globalThis.document
  globalThis.document = {
    createElement(name) { return fakeNode(name) },
    createElementNS(_namespace, name) { return fakeNode(name) },
    createTextNode(text) { return { textContent: text } },
  }
  const collect = (node, tagName) => [
    ...(node.tagName === tagName ? [node] : []),
    ...(node.children || []).flatMap((child) => collect(child, tagName)),
  ]
  try {
    const root = fakeNode()
    mountChart(root, {
      chart_type: 'doughnut',
      geometry_pt: { width_pt: 349, height_pt: 404 },
      center_metric_preview: { value: '22', unit: '%' },
      style_tokens: { circular_layout: { center_metric: { enabled: true } } },
    }, { width: 960, height: 540 })
    const firstSegment = collect(root, 'path')[0]
    assert.match(firstSegment.attributes.d, /^M 50 0(?:\.0+)? A 50 50 /)
  } finally {
    globalThis.document = previousDocument
  }
})

test('single-series bar chart uses the design-system palette per category', () => {
  const previousDocument = globalThis.document
  globalThis.document = {
    createElement(name) {
      if (name === 'canvas') return { getContext: () => null }
      return fakeNode(name)
    },
    createElementNS(_namespace, name) { return fakeNode(name) },
    createTextNode(text) { return { textContent: text } },
  }
  const collect = (node, tagName) => [
    ...(node.tagName === tagName ? [node] : []),
    ...(node.children || []).flatMap((child) => collect(child, tagName)),
  ]
  try {
    const root = fakeNode()
    mountChart(root, {
      chart_type: 'bar',
      geometry_pt: { width_pt: 600, height_pt: 300 },
      chart: {
        categories_preview: ['Flow', 'Manual'],
        series: [{ name: 'Hours', values_preview: [4, 12] }],
        style_tokens: {
          series_palette: [{ color: '#00AEE8' }, { color: '#EE5959' }],
        },
      },
    }, { width: 960, height: 540 })

    assert.deepEqual(collect(root, 'rect').map((rect) => rect.attributes.fill), [
      '#00AEE8',
      '#EE5959',
    ])
  } finally {
    globalThis.document = previousDocument
  }
})

test('bar chart applies the inferred rectangle corner ratio', () => {
  const previousDocument = globalThis.document
  globalThis.document = {
    createElement(name) {
      if (name === 'canvas') return { getContext: () => null }
      return fakeNode(name)
    },
    createElementNS(_namespace, name) { return fakeNode(name) },
    createTextNode(text) { return { textContent: text } },
  }
  const collect = (node, tagName) => [
    ...(node.tagName === tagName ? [node] : []),
    ...(node.children || []).flatMap((child) => collect(child, tagName)),
  ]
  try {
    const root = fakeNode()
    mountChart(root, {
      chart_type: 'bar',
      geometry_pt: { width_pt: 600, height_pt: 300 },
      chart: {
        categories_preview: ['A', 'B'],
        series: [{ values_preview: [10, 20] }],
        style_tokens: { series_geometry: { corner_radius_ratio: 0.2 } },
      },
    }, { width: 960, height: 540 })
    const bars = collect(root, 'rect')
    assert.ok(bars.length >= 2)
    assert.ok(bars.every((bar) => Number(bar.attributes.rx) > 0))
    assert.ok(bars.every((bar) => Number(bar.attributes.ry) > Number(bar.attributes.rx)))
    assert.ok(bars.every((bar) => Math.abs(Number(bar.attributes.rx) * 600 - Number(bar.attributes.ry) * 300) < 0.6))
  } finally {
    globalThis.document = previousDocument
  }
})

test('baseline chart renders only inferred grid directions with one shared line style', () => {
  const previousDocument = globalThis.document
  globalThis.document = {
    createElement(name) {
      if (name === 'canvas') return { getContext: () => null }
      return fakeNode(name)
    },
    createElementNS(_namespace, name) { return fakeNode(name) },
    createTextNode(text) { return { textContent: text } },
  }
  const collect = (node, tagName) => [
    ...(node.tagName === tagName ? [node] : []),
    ...(node.children || []).flatMap((child) => collect(child, tagName)),
  ]
  try {
    const root = fakeNode()
    mountChart(root, {
      is_baseline: true,
      chart_type: 'bar',
      geometry_pt: { width_pt: 600, height_pt: 300 },
      chart: {
        categories_preview: ['Q1', 'Q2'],
        series: [{ name: 'A', values_preview: [10, 20] }],
        style_tokens: {
          category_axis: { visible: true },
          value_axis: { visible: true },
          axis_line: { visible: false },
          grid_line: {
            visible: true,
            horizontal_visible: true,
            vertical_visible: false,
            color: '#FFFFFF',
            width_pt: 0.5,
          },
        },
      },
    }, { width: 960, height: 540 })
    const lines = collect(root, 'line')
    assert.ok(lines.length >= 4)
    assert.deepEqual(new Set(lines.map((line) => line.attributes.stroke)), new Set(['#FFFFFF']))
    assert.equal(new Set(lines.map((line) => line.attributes['stroke-width'])).size, 1)
  } finally {
    globalThis.document = previousDocument
  }
})
