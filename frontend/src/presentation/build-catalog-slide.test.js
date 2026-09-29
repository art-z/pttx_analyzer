import test from 'node:test'
import assert from 'node:assert/strict'

import { patchCatalogSlideText } from './build-catalog-slide.js'

const report = {
  theme: { themes: [{ colors: { dk1: { rgb: '000000' }, lt1: { rgb: 'FFFFFF' } } }] },
  typography: {
    visibility: { slide_size_pt: { width: 960, height: 540 } },
    type_scales: [],
    scale_usage: { scale_roles: [] },
  },
  colors: { resolved_palette: [{ color: '#000000' }, { color: '#FFFFFF' }] },
  slides: { slides: [], patterns: [] },
  slide_templates: {
    templates: [{
      layout_source: 'dark-layout',
      render: { background_color: '#000000' },
      colors: {
        background: '#000000',
        text_styles: {
          title: {
            primary: '#FFFFFF',
            layout: '#FFFFFF',
            candidates: ['#FFFFFF', '#0077FF'],
            source: 'layout',
          },
          body: {
            primary: '#FFFFFF',
            candidates: ['#FFFFFF', '#E4E7EA'],
            source: 'contrast_fallback',
          },
        },
      },
      editable_slots: [],
    }],
  },
}

test('patched title text repairs missing color on dark faithful catalog slides', () => {
  const slide = {
    slide_number: 5,
    layout_source: 'dark-layout',
    render: { background_color: '#000000', slide_size_pt: { width: 960, height: 540 } },
    content_elements: [{
      element_id: 'title',
      kind: 'text',
      role: 'title',
      text: 'Old',
      geometry_norm: { x: 0.04, y: 0.2, width: 0.4, height: 0.2 },
      typography: { family: 'Play', size_pt: 66 },
    }],
  }

  const patched = patchCatalogSlideText(slide, {
    report,
    title: 'Внедрение Flow в компании',
    titleElementIds: ['title'],
  })

  assert.equal(patched.content_elements[0].text, 'Внедрение Flow в\u00a0компании')
  assert.equal(patched.content_elements[0].typography.color, '#FFFFFF')
})

test('patched title text repairs low-contrast black color on dark faithful catalog slides', () => {
  const slide = {
    slide_number: 5,
    layout_source: 'dark-layout',
    render: { background_color: '#000000', slide_size_pt: { width: 960, height: 540 } },
    content_elements: [{
      element_id: 'title',
      kind: 'text',
      role: 'title',
      text: 'Old',
      geometry_norm: { x: 0.04, y: 0.2, width: 0.4, height: 0.2 },
      typography: { family: 'Play', size_pt: 66, color: '#000000' },
    }],
  }

  const patched = patchCatalogSlideText(slide, {
    report,
    title: 'Внедрение Flow в компании',
    titleElementIds: ['title'],
  })

  assert.equal(patched.content_elements[0].typography.color, '#FFFFFF')
})
