import assert from 'node:assert/strict'
import test from 'node:test'

import { buildTerminalSlideVariants } from './build-terminal-slide.js'
import { prioritizeTerminalVariant, resolveTerminalRole } from './build-slide.js'

function sourceSlide(number, title) {
  return {
    slide_number: number,
    layout_source: `layout-${number}`,
    template_id: `tmpl-${number}`,
    render: {
      slide_size_pt: { width: 960, height: 540 },
      background_color: '#101820',
      layers: [],
    },
    content_elements: [
      {
        element_id: `title-${number}`,
        kind: 'text',
        text: title,
        placeholder_type: 'title',
        geometry_norm: { x: 0.1, y: 0.15, width: 0.7, height: 0.18 },
        geometry_pt: { x_pt: 96, y_pt: 81, width_pt: 672, height_pt: 97.2 },
        typography: { size_pt: 42, color: '#FFFFFF' },
      },
      {
        element_id: `decor-${number}`,
        kind: 'fill',
        geometry_norm: { x: 0.08, y: 0.7, width: 0.18, height: 0.04 },
        geometry_pt: { x_pt: 76.8, y_pt: 378, width_pt: 172.8, height_pt: 21.6 },
        fill: { kind: 'solid', color: '#00AEEF', alpha: 1 },
      },
    ],
  }
}

test('terminal variants follow parser markings and replace the source title', () => {
  const initial = sourceSlide(1, 'Old cover')
  const final = sourceSlide(4, 'Old ending')
  const report = {
    slides: {
      slides: [initial, final],
      terminal_candidates: {
        initial: [{ slide_number: 1, layout_source: 'layout-1', score: 200 }],
        final: [{ slide_number: 4, layout_source: 'layout-4', score: 180 }],
        preferred: { initial_slide_number: 1, final_slide_number: 4 },
      },
    },
    typography: { spatial: { components: [] } },
    layout: { content_margins: {} },
  }

  const variants = buildTerminalSlideVariants(report, { title: 'New ending', text: '' }, 'final')

  assert.equal(variants.length, 2)
  assert.deepEqual(variants.map((item) => item.slideNumber), [4, 1])
  assert.equal(variants[0].terminalRole, 'final')
  assert.equal(variants[0].slideNumber, 4)
  assert.equal(variants[0].catalogSlide.content_elements.find((item) => item.kind === 'text').text, 'New ending')
  assert.ok(variants[0].catalogSlide.content_elements.some((item) => item.element_id === 'decor-4'))
})

test('final variants reuse initial candidates when no final candidates exist', () => {
  const initial = sourceSlide(1, 'Old cover')
  const report = {
    slides: {
      slides: [initial],
      terminal_candidates: {
        initial: [{ slide_number: 1, layout_source: 'layout-1', score: 200 }],
        final: [],
        preferred: { initial_slide_number: 1, final_slide_number: 1 },
      },
    },
    typography: { spatial: { components: [] } },
    layout: { content_margins: {} },
  }

  const variants = buildTerminalSlideVariants(report, { title: 'Thanks', text: '' }, 'final')

  assert.equal(variants[0].slideNumber, 1)
  assert.equal(variants[0].terminalRole, 'final')
})

test('generation assigns terminal templates strictly by slide position', () => {
  assert.equal(resolveTerminalRole(0, 7), 'initial')
  assert.equal(resolveTerminalRole(6, 7), 'final')
  assert.equal(resolveTerminalRole(3, 7), null)
  assert.equal(resolveTerminalRole(0, 1), 'initial')

  const regular = { key: 'regular' }
  const terminal = { key: 'terminal', terminalRole: 'final' }
  assert.deepEqual(prioritizeTerminalVariant([regular, terminal], 'final'), [terminal, regular])
})

test('blank cover uses parser text boxes and removes stale background text and pagination', () => {
  const source = sourceSlide(1, 'Old cover')
  source.content_elements = [{
    element_id: 'page-number', kind: 'text', text: '1', placeholder_type: 'sldNum',
    geometry_norm: { x: 0.94, y: 0.93, width: 0.03, height: 0.04 },
    typography: { size_pt: 10 },
  }]
  source.render.layers = [
    { kind: 'text', text: 'Old layout label', source_scope: 'layout', decorative: true },
    { kind: 'fill', decorative: true, source_scope: 'layout' },
  ]
  const title = { geometry_norm: { x: .12, y: .2, width: .7, height: .18 }, typography: { size_pt: 38 }, max_chars: 45 }
  const text = { geometry_norm: { x: .12, y: .43, width: .7, height: .14 }, typography: { size_pt: 18 }, max_chars: 100 }
  const report = {
    slides: { slides: [source], terminal_candidates: {
      initial: [{ slide_number: 1, layout_source: 'layout-1', score: 200, text_plan: { title, text, person_supported: false } }],
      final: [], preferred: { initial_slide_number: 1, final_slide_number: 1 },
    } },
    typography: { spatial: { components: [] } },
    layout: { content_margins: {} },
  }

  const [variant] = buildTerminalSlideVariants(report, { title: 'New cover', text: 'A short description' }, 'initial')
  assert.ok(variant)
  const rendered = variant.catalogSlide
  assert.deepEqual(rendered.content_elements.filter((item) => item.kind === 'text').map((item) => item.text).sort(), ['A short description', 'New cover'])
  assert.equal(rendered.render.layers.some((layer) => layer.kind === 'text'), false)
  assert.equal(rendered.content_elements.find((item) => item.text === 'New cover').geometry_norm.x, .12)
})

test('terminal rendering follows parser order used for pre-request text limits', () => {
  const slides = [1, 3, 16, 39].map((number) => sourceSlide(number, `Old ${number}`))
  const report = {
    slides: { slides, terminal_candidates: {
      initial: [1, 16, 39, 3].map((number) => ({ slide_number: number, layout_source: `layout-${number}`, score: 100 - number })),
      final: [], preferred: { initial_slide_number: 1, final_slide_number: 1 },
    } },
    typography: { spatial: { components: [] } }, layout: { content_margins: {} },
  }
  const variants = buildTerminalSlideVariants(report, { title: 'Title', text: 'Text' }, 'initial')
  assert.deepEqual(variants.map((item) => item.slideNumber), [1, 16, 39])
})

test('title copy is above full-slide background layers in preview and export scene', () => {
  const source = sourceSlide(1, 'Old')
  source.render.layers = [
    { kind: 'fill', z_index: 80, geometry_norm: { x: 0, y: 0, width: 1, height: 1 } },
    { kind: 'text', name: 'Slide number', placeholder_type: 'sldNum', z_index: 81,
      geometry_norm: { x: 0.9, y: 0.9, width: 0.06, height: 0.03 } },
  ]
  const report = {
    slides: { slides: [source], terminal_candidates: {
      initial: [{ slide_number: 1 }], final: [], preferred: { initial_slide_number: 1 },
    } },
    typography: { spatial: { components: [] } }, layout: { content_margins: {} },
  }
  const [variant] = buildTerminalSlideVariants(report, { title: 'Visible title' }, 'initial')
  assert.ok(variant)
  const title = variant.catalogSlide.content_elements.find((element) => element.text === 'Visible title')
  assert.ok(title.z_index > 80)
  assert.equal(variant.catalogSlide.render.layers.some((layer) => layer.placeholder_type === 'sldNum'), false)
})

test('clean terminal candidate can outrank a cluttered preferred source slide', () => {
  const cluttered = sourceSlide(1, 'Old')
  cluttered.content_elements.push(...Array.from({ length: 40 }, (_, index) => ({
    element_id: `junk-${index}`, kind: 'fill',
    geometry_norm: { x: 0.05 + index * 0.001, y: 0.88, width: 0.01, height: 0.01 },
  })))
  const clean = sourceSlide(2, 'Old')
  const report = {
    slides: { slides: [cluttered, clean], terminal_candidates: {
      initial: [{ slide_number: 1 }, { slide_number: 2 }], final: [],
      preferred: { initial_slide_number: 1 },
    } },
    typography: { spatial: { components: [] } }, layout: { content_margins: {} },
  }
  const variants = buildTerminalSlideVariants(report, { title: 'Cover' }, 'initial')
  assert.equal(variants[0].slideNumber, 2)
  assert.ok(variants.some((variant) => variant.slideNumber === 1))
})

test('cover and ending resolve title/body bbox collisions before preview', () => {
  const source = sourceSlide(1, 'Old cover')
  source.content_elements.push({
    element_id: 'body-1', kind: 'text', text: 'Old body', placeholder_type: 'body',
    geometry_norm: { x: .1, y: .28, width: .7, height: .22 },
    geometry_pt: { x_pt: 96, y_pt: 151.2, width_pt: 672, height_pt: 118.8 },
    typography: { size_pt: 20, color: '#FFFFFF' },
  })
  const report = {
    slides: { slides: [source], terminal_candidates: {
      initial: [{ slide_number: 1 }], final: [{ slide_number: 1 }],
      preferred: { initial_slide_number: 1, final_slide_number: 1 },
    } },
    typography: { spatial: { components: [] } }, layout: { content_margins: {} },
  }
  for (const role of ['initial', 'final']) {
    const [variant] = buildTerminalSlideVariants(report, {
      title: 'Новая тема', text: 'Краткое описание презентации',
    }, role)
    assert.ok(variant)
    const issues = variant.catalogSlide.layout_validation.issues
    assert.equal(issues.some((issue) => issue.code === 'text_overlap' || issue.code === 'outside_slide'), false)
  }
})
