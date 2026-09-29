import test from 'node:test'
import assert from 'node:assert/strict'

import { estimateTextInkHeightPt } from './separate-vertical-text.js'
import { bodySafeAreaFor, buildLayoutUnits, measureTextInk, resolveSlideLayout } from './slide-hit-test.js'
import { titleRejectReason } from './build-scenario-preview-variants.js'

const report = {
  layout: { content_margins: { left_norm: 0.08, right_norm: 0.08, top_norm: 0.1, bottom_norm: 0.1 } },
  slide_templates: { templates: [] },
}
const SIZE = { width: 720, height: 405 }

test('line spacing marked not applicable is measured at the normal line height', () => {
  const value = {
    kind: 'text', text: '70%',
    typography: { size_pt: 24, pptx_line_spacing_ratio: 0.375, line_height_applicable: false },
    paragraph_spacing_pt: { line_spacing_ratio: 0.375, line_height_applicable: false },
  }
  assert.ok(estimateTextInkHeightPt(value, 200) >= 24, 'a 24pt line is at least 24pt tall')
  const applied = { ...value, typography: { size_pt: 12, line_height_pt: 12.6, line_height_applicable: true }, paragraph_spacing_pt: {} }
  assert.equal(estimateTextInkHeightPt(applied, 200), 12.6)
})

function metric(index, y) {
  const group = `metric_${index}`
  const geometry = { x: 0.05, y, width: 0.18, height: 0.116 }
  return [
    {
      element_id: `value_${index}`, kind: 'text', text: `${60 + index * 10}%`, text_group_id: group, text_line_index: 0,
      text_group_geometry_norm: geometry, vertical_anchor: 'ctr',
      geometry_norm: { x: 0.05, y, width: 0.18, height: 0.059 },
      typography: { size_pt: 24, line_height_applicable: false }, paragraph_spacing_pt: { line_spacing_ratio: 0.375, line_height_applicable: false },
    },
    {
      element_id: `label_${index}`, kind: 'text', text: 'сокращение времени подготовки', text_group_id: group, text_line_index: 1,
      text_group_geometry_norm: geometry,
      geometry_norm: { x: 0.05, y: y + 0.048, width: 0.18, height: 0.068 },
      typography: { size_pt: 12, line_height_pt: 12.6, line_height_applicable: true },
    },
  ]
}

test('stacked KPI groups whose real text height collides are detected and separated', () => {
  const slide = {
    render: { slide_size_pt: SIZE, layers: [] },
    content_elements: [...metric(1, 0.555), ...metric(2, 0.649), ...metric(3, 0.743)],
  }
  const before = buildLayoutUnits(slide, report)
  assert.ok(before.entities.some((entity) => entity.overflowPt > 2), 'the crammed stack overflows its group boxes')
  const { slide: fixed, validation } = resolveSlideLayout(report, slide)
  const after = buildLayoutUnits(fixed, report)
  const inks = after.entities.map((entity) => ({
    top: Math.min(...entity.members.map((member) => member.ink.y)),
    bottom: Math.max(...entity.members.map((member) => member.ink.y + member.ink.height)),
  })).sort((a, b) => a.top - b.top)
  const collide = inks.some((ink, index) => index > 0 && ink.top < inks[index - 1].bottom - 2 / SIZE.height)
  assert.ok(!validation.valid || !collide, 'either rejected or the groups no longer collide')
})

test('a right-aligned title in a full-width template slot is kept inside the body safe area', () => {
  const title = {
    element_id: 'slide2_slide_text_100', kind: 'text', placeholder_type: 'title', text: 'Динамика использования Flow',
    geometry_norm: { x: 0.025, y: 0.067, width: 0.95, height: 0.111 }, vertical_anchor: 't',
    body_insets_pt: { left: 7.2, right: 7.2, top: 7.2, bottom: 7.2 },
    typography: { size_pt: 26, alignment: 'r', line_height_pt: 22.1 },
  }
  const slide = { render: { slide_size_pt: SIZE, layers: [] }, content_elements: [title] }
  const { slide: fixed } = resolveSlideLayout(report, slide, { titleIds: [title.element_id] })
  const element = fixed.content_elements[0]
  const ink = measureTextInk(element, element.geometry_norm, SIZE)
  const safe = bodySafeAreaFor(report, fixed)
  assert.ok(ink.x + ink.width <= safe.x + safe.width + 2 / SIZE.width, `ink right ${ink.x + ink.width} inside ${safe.x + safe.width}`)
  assert.ok(element.geometry_norm.x >= safe.x - 1e-6, 'frame starts inside the safe area')
})

test('a variant without the slide title, or with a caption-sized title, is rejected', () => {
  const spec = { title: 'Динамика использования Flow', title_options: { long: 'Динамика использования Flow: рост по кварталам' } }
  const variant = (elements) => ({ templateId: 'tmpl_t', catalogSlide: { content_elements: elements } })
  const withSlot = { slide_templates: { templates: [{ template_id: 'tmpl_t', editable_slots: [{ role: 'title' }] }] } }
  const quote = variant([{ kind: 'text', text: '«Цитата»', placeholder_type: 'body', typography: { size_pt: 40 } }])
  assert.equal(titleRejectReason(quote, spec, withSlot), 'title_missing')
  assert.equal(titleRejectReason(quote, spec, { slide_templates: { templates: [{ template_id: 'tmpl_t', editable_slots: [] }] } }), null, 'a layout without a title slot may omit it')
  assert.equal(titleRejectReason(variant([{ kind: 'text', text: 'Динамика использования Flow: рост по кварталам', placeholder_type: 'title', typography: { size_pt: 10 } }]), spec), 'title_too_small')
  assert.equal(titleRejectReason(variant([{ kind: 'text', text: 'Динамика использования Flow', typography: { size_pt: 32 } }]), spec), null)
  assert.equal(titleRejectReason(variant([]), { title: '' }), null)
})

test('a layout whose only title placeholder is a 10pt caption takes no content', async () => {
  const { templateHasCaptionTitle, probeComponentOnTemplate } = await import('./component-template-fit.js')
  const caption = { template_id: 't', editable_slots: [{ role: 'title', geometry_norm: { x: 0.13, y: 0.72, width: 0.25, height: 0.09 }, typography: { size_pt: 10 } }], render: { layers: [] } }
  assert.equal(templateHasCaptionTitle(caption), true)
  assert.equal(probeComponentOnTemplate({ flexible: 'chart', chartType: 'bar' }, caption, report).fail_reason, 'caption_title')
  assert.equal(templateHasCaptionTitle({ editable_slots: [{ role: 'title', typography: { size_pt: 28 } }] }), false)
})

test('when the only chart layout is the table variant\'s template, the chart still replaces a second paragraph', async () => {
  const { selectDiverseVariants } = await import('./build-scenario-preview-variants.js')
  const v = (key, dataBlock, templateId, score, extra = {}) => ({ key, role: 'alternative', dataBlock, catalogSlide: { slide_number: 2 }, componentId: key, templateId, score, ...extra })
  const ranked = [
    v('table', 'tables', 'tmpl_020', 150),
    v('text-a', 'title_text', 'tmpl_011', 20, { catalogSlide: { slide_number: 11 } }),
    v('text-b', 'title_text', 'tmpl_005', 15, { catalogSlide: { slide_number: 6 } }),
    v('chart', 'charts', 'tmpl_020', -80, { derivedChart: true }),
  ]
  assert.deepEqual(selectDiverseVariants(ranked, { limit: 3 }).map((item) => item.key), ['table', 'text-a', 'chart'])
})
