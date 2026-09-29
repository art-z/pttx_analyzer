import test from 'node:test'
import assert from 'node:assert/strict'

import { buildTokensForTemplate, extractDesignTokens } from '../constructor/tokens.js'
import { getRoleColorOptions, resolveRoleTextColor } from '../constructor/templates.js'
import { createSlideRenderContext, resolveCatalogTextStyle } from './resolve-element-style.js'

const template = {
  layout_source: 'dark-layout',
  render: { background_color: '#000000' },
  colors: {
    background: '#000000',
    text_styles: {
      body: {
        primary: '#000000',
        layout: null,
        candidates: ['#FFFFFF', '#0077FF'],
        source: 'background_image_usage',
      },
      title: {
        primary: '#000000',
        layout: '#FFFFFF',
        candidates: ['#FFFFFF', '#0077FF'],
        source: 'background_image_usage',
      },
    },
  },
  editable_slots: [],
}

const report = {
  theme: { themes: [{ colors: { dk1: { rgb: '000000' }, lt1: { rgb: 'FFFFFF' } } }] },
  typography: {
    visibility: { slide_size_pt: { width: 960, height: 540 } },
    type_scales: [],
    scale_usage: { scale_roles: [] },
  },
  slide_templates: { templates: [template] },
  slides: { slides: [], patterns: [] },
  colors: { resolved_palette: [{ color: '#000000' }, { color: '#FFFFFF' }] },
}

test('dark catalog templates prefer a readable candidate over black background-image fallback text', () => {
  const tokens = buildTokensForTemplate(extractDesignTokens(report), template)

  assert.equal(resolveRoleTextColor(template, 'body', tokens), '#FFFFFF')
  assert.deepEqual(getRoleColorOptions(template, 'body', tokens).slice(0, 2), ['#FFFFFF', '#000000'])
  assert.equal(tokens.defaultTextColor, '#FFFFFF')
})

test('catalog text style keeps generated body text readable on black slides', () => {
  const slide = {
    slide_number: 1,
    layout_source: 'dark-layout',
    render: { background_color: '#000000', slide_size_pt: { width: 960, height: 540 } },
    content_elements: [],
  }
  const element = {
    element_id: 'text-1',
    kind: 'text',
    text: 'Белый текст',
    geometry_norm: { x: 0.1, y: 0.3, width: 0.4, height: 0.1 },
    typography: { size_pt: 20 },
  }

  const resolved = resolveCatalogTextStyle(element, slide, createSlideRenderContext(report))

  assert.equal(resolved.typography.color, '#FFFFFF')
})

test('synthetic titles use design-system line height for the matched font size', () => {
  const dsReport = {
    ...report,
    typography: {
      visibility: { slide_size_pt: { width: 960, height: 540 } },
      type_scales: [{
        family: 'Arial',
        levels: [{
          scale_level: 'title',
          size_pt: 40,
          line_height_ratio: 1.08,
          slide_title_probability: 0.9,
        }],
      }],
      scale_usage: {
        scale_roles: [{
          family: 'Arial',
          levels: [{
            scale_level: 'title',
            size_pt: 40,
            line_height_ratio: 1.08,
            role_hint: 'slide_title',
            slide_title_probability: 0.9,
          }],
        }],
      },
    },
  }
  const slide = {
    slide_number: 1,
    layout_source: 'dark-layout',
    render: { background_color: '#000000', slide_size_pt: { width: 960, height: 540 } },
    content_elements: [],
  }
  const element = {
    element_id: 'synthetic_slide_title_1',
    kind: 'text',
    role: 'title',
    synthetic: true,
    text: 'Синтетический заголовок',
    geometry_norm: { x: 0.1, y: 0.08, width: 0.7, height: 0.12 },
    typography: {
      family: 'Arial',
      size_pt: 40,
      line_height_ratio: 0.6,
      line_height_pt: 24,
      line_height_applicable: true,
    },
  }

  const resolved = resolveCatalogTextStyle(element, slide, createSlideRenderContext(dsReport))

  assert.equal(resolved.typography.lineHeightRatio, 1.08)
  assert.equal(resolved.typography.lineHeightPt, 43.2)
})
