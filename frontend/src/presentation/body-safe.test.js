import test from 'node:test'
import assert from 'node:assert/strict'
import {
  bodySafeAreaFor,
  detectLayoutIssues,
  measureTextInk,
  resolveSlideLayout,
  safeAreaFor,
} from './slide-hit-test.js'
import { layoutTerminalText, terminalTextAreas } from './terminal-text-area.js'

// Body / paragraph text (not only titles) must stay inside the body safe area:
// widen sideways into free space first, then grow, then shrink, else reject.

const report = {
  layout: { content_margins: { left_norm: 0.05, right_norm: 0.05, top_norm: 0.05, bottom_norm: 0.1 } },
}
const SIZE = { width: 960, height: 540 }
const PARA = 'Сервис автоматически анализирует корпоративный шаблон, понимает структуру и дизайн‑систему, а затем генерирует новые презентации с сохранением фирменного оформления.'

function slideWith(elements, layers = []) {
  return {
    slide_number: 1,
    render: {
      slide_size_pt: { ...SIZE },
      layers: [
        { kind: 'fill', source_scope: 'master', z_index: 0, geometry_norm: { x: 0, y: 0, width: 1, height: 1 }, fill: { color: '#FFFFFF' } },
        ...layers,
      ],
    },
    content_elements: elements,
  }
}

function text(id, box, content, size = 14, extra = {}) {
  return {
    element_id: id,
    kind: 'text',
    text: content,
    geometry_norm: { ...box },
    vertical_anchor: 't',
    z_index: 10,
    ...extra,
    typography: { size_pt: size, color: '#111111', ...(extra.typography || {}) },
  }
}

const byId = (slide, id) => slide.content_elements.find((element) => element.element_id === id)
const errors = (validation) => validation.issues.filter((issue) => issue.severity === 'error').map((issue) => issue.code)
const right = (box) => box.x + box.width
const bottom = (box) => box.y + box.height
const TOL = 2.5 / SIZE.height
// A narrow generated paragraph whose frame runs past the bottom margin (0.9).
const NARROW = { x: 0.3, y: 0.62, width: 0.15, height: 0.33 }

function inkOf(slide, id) {
  const element = byId(slide, id)
  return measureTextInk(element, element.geometry_norm, SIZE)
}

test('body safe area: margins + body slots, a full-height title slot is left out', () => {
  const withSlots = {
    ...report,
    slide_templates: {
      templates: [{
        layout_source: 'L1',
        editable_slots: [
          { role: 'title', placeholder_type: 'ctrTitle', geometry_norm: { x: 0.6, y: 0.02, width: 0.3, height: 0.96 } },
          { role: 'subtitle', placeholder_type: 'subTitle', geometry_norm: { x: 0.02, y: 0.5, width: 0.3, height: 0.2 } },
        ],
      }],
    },
  }
  const slide = { ...slideWith([]), layout_source: 'L1' }
  const loose = safeAreaFor(withSlots, slide)
  const body = bodySafeAreaFor(withSlots, slide)
  assert.ok(bottom(loose) > 0.97, 'the generic safe area includes the title slot')
  assert.ok(Math.abs(bottom(body) - 0.9) < 1e-6, 'body text keeps the bottom margin')
  assert.ok(Math.abs(body.x - 0.02) < 1e-6, 'a body slot still widens the body safe area')
  assert.ok(Math.abs(body.y - 0.05) < 1e-6)
})

test('detect: generated text whose ink crosses the margin is an error', () => {
  const slide = slideWith([text('para', { x: 0.3, y: 0.84, width: 0.3, height: 0.14 }, PARA, 14, { synthetic: true })])
  assert.ok(errors(detectLayoutIssues(report, slide)).includes('text_outside_safe_area'))
})

test('fix: a narrow paragraph is widened sideways (not shrunk) to stay inside the safe area', () => {
  const slide = slideWith([text('para', NARROW, PARA, 14, { synthetic: true })])
  const { slide: fixed, validation } = resolveSlideLayout(report, slide)
  assert.deepEqual(errors(validation), [])
  const element = byId(fixed, 'para')
  const box = element.geometry_norm
  assert.ok(validation.corrections.some((item) => item.op === 'widen_text' && item.element_id === 'para'))
  assert.ok(box.width > NARROW.width + 0.02, `widened: ${box.width}`)
  assert.ok(Math.abs(box.x - NARROW.x) < 1e-6, 'left-aligned text keeps its left edge')
  assert.equal(element.typography.size_pt, 14, 'widening comes before shrinking')
  const ink = inkOf(fixed, 'para')
  assert.ok(bottom(ink) <= 0.9 + TOL, `ink bottom ${bottom(ink)} inside the margin`)
  assert.ok(right(box) <= 0.95 + 1e-6)
})

test('fix: widening keeps the alignment side (right and centre)', () => {
  for (const alignment of ['r', 'ctr']) {
    const slide = slideWith([text('para', NARROW, PARA, 14, { synthetic: true, typography: { alignment } })])
    const { slide: fixed, validation } = resolveSlideLayout(report, slide)
    assert.deepEqual(errors(validation), [], alignment)
    const box = byId(fixed, 'para').geometry_norm
    assert.ok(box.width > NARROW.width + 0.02, `${alignment} widened`)
    if (alignment === 'r') assert.ok(Math.abs(right(box) - right(NARROW)) < 1e-4, 'right edge kept')
    else assert.ok(Math.abs(box.x + box.width / 2 - (NARROW.x + NARROW.width / 2)) < 1e-4, 'centre kept')
  }
})

test('fix: widening stops at a neighbouring text and at layout art', () => {
  const neighbour = text('side', { x: 0.49, y: 0.6, width: 0.3, height: 0.25 }, 'Соседний блок текста', 14)
  const cases = [
    { name: 'text', slide: slideWith([text('para', NARROW, PARA, 14, { synthetic: true }), neighbour]), edge: 0.49 },
    {
      name: 'layer',
      slide: slideWith([text('para', NARROW, PARA, 14, { synthetic: true })], [
        { kind: 'shape', layer_id: 'art', z_index: 1, geometry_norm: { x: 0.49, y: 0.55, width: 0.3, height: 0.35 }, fill: { color: '#3355AA' } },
      ]),
      edge: 0.49,
    },
  ]
  for (const { name, slide, edge } of cases) {
    const { slide: fixed, validation } = resolveSlideLayout(report, slide)
    assert.deepEqual(errors(validation), [], name)
    const box = byId(fixed, 'para').geometry_norm
    assert.ok(box.width > NARROW.width, `${name}: widened into the free gap`)
    assert.ok(right(box) <= edge - 4 / SIZE.width, `${name}: right edge ${right(box)} stops before the obstacle`)
    assert.ok(bottom(inkOf(fixed, 'para')) <= 0.9 + TOL, `${name}: still inside the safe area`)
  }
})

test('fix: template text may keep its own frame beyond the margin, but not grow further', () => {
  const frame = { x: 0.3, y: 0.8, width: 0.3, height: 0.12 }
  const slide = slideWith([text('tpl', frame, 'Короткая подпись', 14)])
  const { validation } = resolveSlideLayout(report, slide)
  assert.ok(!errors(validation).includes('text_outside_safe_area'))
})

test('terminal: a subtitle under the title takes the title column instead of running to the edge', () => {
  const deckReport = {
    layout: { content_margins: { left_norm: 0.0771, top_norm: 0.1049, right_norm: 0.0774, bottom_norm: 0.1059 } },
    slide_templates: {
      templates: [{
        layout_source: 'L1',
        editable_slots: [
          { role: 'title', placeholder_type: 'ctrTitle', geometry_norm: { x: 0.55, y: 0.0874, width: 0.35, height: 0.8251 } },
          { role: 'subtitle', placeholder_type: 'subTitle', geometry_norm: { x: 0.1822, y: 0.529, width: 0.1856, height: 0.3677 } },
        ],
      }],
    },
  }
  const slide = { ...slideWith([]), layout_source: 'L1', render: { slide_size_pt: { width: 720, height: 405 }, layers: [] } }
  const titleBox = { x: 0.1808, y: 0.3968, width: 0.3471, height: 0.0789 }
  const areas = terminalTextAreas(deckReport, slide, {
    titleBox,
    subtitleBox: { x: 0.1822, y: 0.529, width: 0.1856, height: 0.3677 },
    titleStyle: { typography: { size_pt: 34, font_family: 'Red Hat Mono' } },
    subtitleStyle: { typography: { size_pt: 15, font_family: 'Archivo' } },
  })
  const laid = layoutTerminalText(areas, {
    title: 'Flow',
    subtitle: 'Flow автоматически анализирует корпоративный PPTX‑шаблон, понимает структуру и дизайн‑систему, а затем генерирует новые презентации с сохранением фирменного оформления.',
  })
  assert.ok(laid.fits)
  const box = laid.subtitle.box
  assert.ok(box.width > 0.3, `subtitle widened to the title column: ${box.width}`)
  assert.ok(box.width <= titleBox.width + 1e-3, 'but not wider than needed')
  assert.ok(bottom(box) <= 1 - 0.1059 + 1e-3, `bottom ${bottom(box)} keeps the bottom margin`)
})
