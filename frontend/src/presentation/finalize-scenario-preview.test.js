import test from 'node:test'
import assert from 'node:assert/strict'

import { finalizeScenarioPreviewSlide } from './finalize-scenario-preview.js'

test('explicit visual finalization keeps template images that sit beside the content', () => {
  const slide = {
    slide_number: 3,
    content_elements: [
      {
        element_id: 'synthetic_slide_title_3',
        kind: 'text',
        text: 'Title',
        synthetic: true,
        geometry_norm: { x: 0.08, y: 0.08, width: 0.4, height: 0.12 },
      },
      {
        element_id: 'side-photo',
        kind: 'image',
        geometry_norm: { x: 0.62, y: 0.2, width: 0.3, height: 0.5 },
      },
      {
        element_id: 'covering-photo',
        kind: 'image',
        geometry_norm: { x: 0.05, y: 0.05, width: 0.5, height: 0.3 },
      },
      {
        element_id: 'hairline',
        kind: 'image',
        geometry_norm: { x: 0.05, y: 0.9, width: 0.9, height: 0.01 },
      },
    ],
  }

  const finalized = finalizeScenarioPreviewSlide(
    null,
    slide,
    { title: '', text: '' },
    null,
    { mode: 'text', preserveFreeImages: true },
  )
  const ids = finalized.content_elements.map((element) => element.element_id)

  assert.ok(ids.includes('synthetic_slide_title_3'))
  assert.ok(ids.includes('side-photo'))
  assert.equal(ids.includes('covering-photo'), false)
  assert.equal(ids.includes('hairline'), false)
})

test('default finalization removes unrequested donor images', () => {
  const finalized = finalizeScenarioPreviewSlide(null, {
    slide_number: 4,
    content_elements: [
      {
        element_id: 'synthetic_slide_title_4',
        kind: 'text',
        text: 'Title',
        synthetic: true,
        geometry_norm: { x: 0.08, y: 0.08, width: 0.4, height: 0.12 },
      },
      {
        element_id: 'old-photo',
        kind: 'image',
        geometry_norm: { x: 0.62, y: 0.2, width: 0.3, height: 0.5 },
      },
    ],
  }, { title: '', text: '' }, null, { mode: 'text' })

  assert.deepEqual(
    finalized.content_elements.map((element) => element.element_id),
    ['synthetic_slide_title_4'],
  )
})

test('graphic finalization removes unrelated source graphics from the template canvas', () => {
  const slide = {
    slide_number: 42,
    content_elements: [
      { element_id: 'old-diagram', kind: 'diagram' },
      { element_id: 'old-chart', kind: 'chart' },
      { element_id: 'selected-diagram', kind: 'diagram' },
      { element_id: 'template-copy', kind: 'text', text: 'Old label' },
    ],
  }

  const finalized = finalizeScenarioPreviewSlide(
    null,
    slide,
    { title: '', text: '' },
    null,
    { mode: 'graphic', keepElementIds: ['selected-diagram'] },
  )

  assert.deepEqual(
    finalized.content_elements.map((element) => element.element_id),
    ['selected-diagram'],
  )
})

test('text finalization keeps only active synthetic text components', () => {
  const slide = {
    slide_number: 7,
    content_elements: [
      { element_id: 'old-label', kind: 'text', text: 'Old label' },
      { element_id: 'old-shape', kind: 'shape' },
      {
        element_id: 'synthetic_slide_title_7',
        kind: 'text',
        text: 'Title',
        synthetic: true,
      },
      {
        element_id: 'synthetic_slide_description_7',
        kind: 'text',
        text: 'Body',
        synthetic: true,
      },
    ],
  }

  const finalized = finalizeScenarioPreviewSlide(
    null,
    slide,
    { title: '', text: '' },
    null,
    { mode: 'text' },
  )

  assert.deepEqual(
    finalized.content_elements.map((element) => element.element_id),
    ['synthetic_slide_title_7', 'synthetic_slide_description_7'],
  )
})

test('metric finalization keeps component data and removes donor-slide garbage', () => {
  const slide = {
    slide_number: 8,
    content_elements: [
      { element_id: 'metric-value', kind: 'text', text: '42', component_data: true },
      { element_id: 'metric-caption', kind: 'text', text: 'Growth', component_data: true },
      { element_id: 'old-chart', kind: 'chart' },
      { element_id: 'old-note', kind: 'text', text: 'Remove me' },
    ],
  }

  const finalized = finalizeScenarioPreviewSlide(
    null,
    slide,
    { title: '', text: '' },
    null,
    { mode: 'metric' },
  )

  assert.deepEqual(
    finalized.content_elements.map((element) => element.element_id),
    ['metric-value', 'metric-caption'],
  )
})

test('metric finalization does not duplicate KPI values into a description', () => {
  const slide = {
    slide_number: 8,
    content_elements: [
      { element_id: 'metric-value', kind: 'text', text: '42', component_data: true },
      { element_id: 'metric-caption', kind: 'text', text: 'Growth', component_data: true },
    ],
  }

  const finalized = finalizeScenarioPreviewSlide(
    null,
    slide,
    {
      title: '',
      text: 'Narrative must stay out',
      metrics: [{ title: '42', text: 'Growth' }],
      lists: [],
      persons: [],
      quotes: [],
      snippets: [],
    },
    null,
    { mode: 'metric', includeDescription: false },
  )

  assert.deepEqual(
    finalized.content_elements.map((element) => element.element_id),
    ['metric-value', 'metric-caption'],
  )
})

test('text finalization is idempotent for synthetic fallback elements', () => {
  const slide = {
    slide_number: 9,
    content_elements: [{
      element_id: 'synthetic_slide_description_9',
      kind: 'text',
      role: 'body',
      text: 'Body',
      synthetic: true,
      geometry_pt: { x_pt: 100, y_pt: 100, width_pt: 400, height_pt: 100 },
      geometry_norm: { x: 0.1, y: 0.2, width: 0.4, height: 0.2 },
    }],
  }

  const finalized = finalizeScenarioPreviewSlide(
    null,
    slide,
    {
      title: '',
      text: 'Updated body',
      lists: [],
      metrics: [],
      quotes: [],
      persons: [],
      snippets: [],
    },
    null,
    { mode: 'text', includeDescription: true },
  )

  assert.equal(finalized.content_elements.length, 1)
  assert.equal(finalized.content_elements[0].element_id, 'synthetic_slide_description_9')
  assert.equal(finalized.content_elements[0].text, 'Updated body')
})

test('repeat finalization never mixes paragraphs or card bullets into description', () => {
  const slide = {
    slide_number: 10,
    content_elements: [
      {
        element_id: 'synthetic_slide_description_10',
        kind: 'text',
        role: 'body',
        text: 'Старое описание',
        synthetic: true,
        geometry_norm: { x: 0.1, y: 0.1, width: 0.5, height: 0.1 },
      },
      {
        element_id: 'card_heading__repeat_1',
        kind: 'text',
        text: 'Карточка',
        geometry_norm: { x: 0.1, y: 0.35, width: 0.3, height: 0.1 },
      },
    ],
  }

  const finalized = finalizeScenarioPreviewSlide(
    null,
    slide,
    {
      title: '',
      text: 'Параграф не должен попасть в repeat',
      paragraphs: [{ heading: '', body: 'Параграф' }],
      cards: [{ heading: 'Карточка', body: 'Описание' }],
      lists: [],
      timelines: [],
      icon_lists: [],
      metrics: [],
      persons: [],
      quotes: [],
      snippets: [],
    },
    null,
    { mode: 'repeat', includeDescription: false },
  )

  assert.deepEqual(
    finalized.content_elements.map((element) => element.element_id),
    ['card_heading__repeat_1'],
  )
  assert.equal(finalized.content_elements.some((element) => (
    String(element.text).includes('Параграф')
  )), false)
})
