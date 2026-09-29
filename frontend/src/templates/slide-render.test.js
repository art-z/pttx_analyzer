import test from 'node:test'
import assert from 'node:assert/strict'

import { renderCatalogNonTextElement } from './slide-render.js'

function fakeNode(tagName = 'div') {
  return {
    tagName,
    attributes: {},
    style: {},
    children: [],
    className: '',
    classList: {
      add(...names) { this._owner.className = [this._owner.className, ...names].filter(Boolean).join(' ') },
      remove() {},
    },
    append(...items) { this.children.push(...items) },
    prepend(...items) { this.children.unshift(...items) },
    replaceChildren(...items) { this.children = items },
    setAttribute(name, value) { this.attributes[name] = String(value) },
    querySelector() { return null },
  }
}

function makeNode(tagName = 'div') {
  const node = fakeNode(tagName)
  node.classList._owner = node
  return node
}

test('chart export node keeps percentage geometry with inline absolute positioning', () => {
  const previousDocument = globalThis.document
  globalThis.document = {
    createElement(name) {
      if (name === 'canvas') return { getContext: () => null }
      return makeNode(name)
    },
    createElementNS(_namespace, name) { return makeNode(name) },
    createTextNode(text) { return { textContent: text } },
  }
  try {
    const node = renderCatalogNonTextElement({
      kind: 'chart',
      chart_type: 'bar',
      geometry_norm: { x: 0.1, y: 0.2, width: 0.6, height: 0.5 },
      geometry_pt: { width_pt: 576, height_pt: 270 },
      chart: {
        categories_preview: ['A'],
        series: [{ values_preview: [10] }],
      },
    }, null, { width: 960, height: 540 })

    assert.equal(node.style.position, 'absolute')
    assert.equal(node.style.left, '10%')
    assert.equal(node.style.top, '20%')
    assert.equal(node.style.width, '60%')
    assert.equal(node.style.height, '50%')
  } finally {
    globalThis.document = previousDocument
  }
})
