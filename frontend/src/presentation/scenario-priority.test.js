import test from 'node:test'
import assert from 'node:assert/strict'

import {
  hasNarrativeText,
  shouldUseSecondaryBlocks,
} from './scenario-priority.js'

test('shouldUseSecondaryBlocks skips graphics when title and text are present', () => {
  const spec = {
    intent: 'comparison',
    title: 'Flow vs вручную',
    text: 'Таблица и график',
    charts: [{ title: 'Chart' }],
    tables: [{ title: 'Table' }],
    diagrams: [],
    persons: [],
    metrics: [],
    lists: [],
    quotes: [],
  }

  assert.equal(hasNarrativeText(spec), true)
  assert.equal(shouldUseSecondaryBlocks(spec), false)
})

test('shouldUseSecondaryBlocks uses graphics when text components are unavailable', () => {
  const spec = {
    intent: 'comparison',
    title: 'Flow vs вручную',
    text: 'Таблица и график',
    charts: [{ title: 'Chart' }],
    tables: [{ title: 'Table' }],
    diagrams: [],
    persons: [],
    metrics: [],
    lists: [],
    quotes: [],
  }

  assert.equal(shouldUseSecondaryBlocks(spec, { textComponentsAvailable: false }), true)
})

test('shouldUseSecondaryBlocks allows repeat-only slides without body text', () => {
  const spec = {
    intent: 'team',
    title: 'Команда',
    text: '',
    persons: [{ name: 'Ann' }],
    charts: [],
    tables: [],
    diagrams: [],
    metrics: [],
    lists: [],
    quotes: [],
  }

  assert.equal(shouldUseSecondaryBlocks(spec), true)
})
