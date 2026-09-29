import assert from 'node:assert/strict'
import test from 'node:test'

import { mountDiagram, resolveDiagramRenderStyle } from './diagram-render.js'

function fakeNode(tagName = 'div') {
  return {
    tagName,
    attributes: {},
    style: {},
    children: [],
    className: '',
    textContent: '',
    dataset: {},
    classList: {
      values: [],
      add(...items) { this.values.push(...items) },
    },
    append(...items) { this.children.push(...items) },
    setAttribute(name, value) {
      this.attributes[name] = String(value)
      if (name === 'class') this.className = String(value)
    },
  }
}

function collect(node, predicate) {
  return [
    ...(predicate(node) ? [node] : []),
    ...(node.children || []).flatMap((child) => collect(child, predicate)),
  ]
}

test('unstyled diagram baseline falls back to design-system colors and typography', () => {
  const style = resolveDiagramRenderStyle({
    is_baseline: true,
    style_tokens: {
      connector: { color: { color: '#0077FF' } },
      node: { fill: { color: '#F4F7FA' } },
    },
  }, {
    palette: ['#C04080'],
    defaultBackground: '#FFFDF8',
    defaultTextColor: '#222222',
    bodyTypographyOptions: [{ family: 'PT Root UI', sizePt: 12, color: '#334455' }],
  })

  assert.equal(style.connector.color, '#C04080')
  assert.equal(style.node.fill, '#FFFDF8')
  assert.equal(style.typography.family, 'PT Root UI')
  assert.equal(style.typography.sizePt, 12)
  assert.equal(style.typography.color, '#334455')
})

test('deck-inferred diagram style has priority over design-system fallback', () => {
  const style = resolveDiagramRenderStyle({
    is_baseline: true,
    deck_style_source: { slide_number: 13 },
    diagram: {
      style_tokens: {
        connector: {
          color: { color: '#123456' },
          width_pt: 2.25,
          dash: 'dash',
          cap: 'round',
        },
        node: {
          fill: { color: '#EEDDCC' },
          border: { color: { color: '#654321' }, width_pt: 1.5 },
          typography: { family: 'Manrope', size_pt: 15, color: '#101010', bold: true },
        },
        arrow: { head_type: 'none', tail_type: 'diamond' },
      },
    },
  }, {
    palette: ['#C04080'],
    bodyTypographyOptions: [{ family: 'Arial', sizePt: 10, color: '#333333' }],
  })

  assert.equal(style.connector.color, '#123456')
  assert.equal(style.connector.widthPt, 2.25)
  assert.equal(style.connector.dash, 'dash')
  assert.equal(style.connector.tailType, 'diamond')
  assert.equal(style.node.fill, '#EEDDCC')
  assert.equal(style.node.borderColor, '#654321')
  assert.equal(style.typography.family, 'Manrope')
  assert.equal(style.typography.sizePt, 15)
})

test('legacy independently aggregated ends do not create a fake double arrow', () => {
  const style = resolveDiagramRenderStyle({
    style_tokens: {
      arrow: { head_type: 'triangle', tail_type: 'triangle' },
    },
  })
  assert.equal(style.connector.headType, 'none')
  assert.equal(style.connector.tailType, 'triangle')

  const observedDouble = resolveDiagramRenderStyle({
    style_tokens: {
      arrow: { head_type: 'triangle', tail_type: 'triangle', bidirectional: true },
    },
  })
  assert.equal(observedDouble.connector.headType, 'triangle')
  assert.equal(observedDouble.connector.tailType, 'triangle')
})

test('diagram canvas contains nodes and SVG connectors but no technical title badge', () => {
  const previousDocument = globalThis.document
  globalThis.document = {
    createElement(name) { return fakeNode(name) },
    createElementNS(_namespace, name) { return fakeNode(name) },
  }
  try {
    const root = fakeNode()
    mountDiagram(root, {
      diagram_type: 'flow',
      preview_texts: ['Первый', 'Второй', 'Третий'],
    }, { width: 960, height: 540 }, {
      tokens: { palette: ['#445566'], defaultBackground: '#FFFFFF' },
    })

    const badges = collect(root, (item) => String(item.className).includes('diagram-badge'))
    const nodes = collect(root, (item) => item.className === 'catalog-diagram-node')
    const connectors = collect(root, (item) => (
      String(item.className).startsWith('catalog-diagram-connector')
      && !String(item.className).includes('shaft')
      && !String(item.className).includes('arrow')
    ))
    const shafts = collect(root, (item) => String(item.className).includes('catalog-diagram-connector-shaft'))
    const arrows = collect(root, (item) => String(item.className) === 'catalog-diagram-arrow')
    const lines = collect(root, (item) => item.tagName === 'line')
    assert.equal(badges.length, 0)
    assert.equal(nodes.length, 3)
    assert.equal(connectors.length, 2)
    assert.equal(shafts.length, 2)
    assert.equal(arrows.length, 2)
    assert.equal(lines.length, 2)
    assert.equal(lines[0].attributes.stroke, '#445566')
    assert.equal(arrows[0].attributes.preserveAspectRatio, 'xMidYMid meet')
    assert.equal(shafts[0].attributes.preserveAspectRatio, 'none')
  } finally {
    globalThis.document = previousDocument
  }
})

test('five flow steps stay on one track without a fixed min-width', () => {
  const previousDocument = globalThis.document
  globalThis.document = {
    createElement(name) { return fakeNode(name) },
    createElementNS(_namespace, name) { return fakeNode(name) },
  }
  try {
    const root = fakeNode()
    mountDiagram(root, {
      diagram_type: 'flow',
      preview_texts: ['A', 'B', 'C', 'D', 'E'],
    }, { width: 960, height: 540 })

    const track = collect(root, (item) => String(item.className).includes('catalog-diagram-track'))[0]
    const nodes = collect(root, (item) => item.className === 'catalog-diagram-node')
    const connectors = collect(root, (item) => String(item.className).includes('catalog-diagram-connector')
      && !String(item.className).includes('shaft'))
    assert.equal(track.dataset.steps, '5')
    assert.equal(nodes.length, 5)
    assert.equal(connectors.length, 4)
    assert.ok(nodes[0].style.padding)
  } finally {
    globalThis.document = previousDocument
  }
})
