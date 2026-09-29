import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import {
  HIT_ENGINE,
  MIN_GAP_PT,
  buildLayoutUnits,
  detectLayoutIssues,
  resolveSlideLayout,
  safeAreaFor,
} from './slide-hit-test.js'

const report = {
  layout: { content_margins: { left_norm: 0.05, right_norm: 0.05, top_norm: 0.05, bottom_norm: 0.1 } },
}

function slideWith(elements, layers = []) {
  return {
    slide_number: 1,
    render: {
      slide_size_pt: { width: 960, height: 540 },
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
    typography: { size_pt: size, color: '#111111', ...(extra.typography || {}) },
    vertical_anchor: 't',
    z_index: 10,
    ...extra,
  }
}

function plate(id, box, color = '#EEEEEE', extra = {}) {
  return { element_id: id, kind: 'fill', geometry_norm: { ...box }, fill: { color }, z_index: 5, ...extra }
}

const byId = (slide, id) => slide.content_elements.find((element) => element.element_id === id)
const codes = (validation) => validation.issues.filter((issue) => issue.severity === 'error').map((issue) => issue.code)
const bottom = (box) => box.y + box.height
const LONG = 'Мы собрали данные по всем подразделениям и видим устойчивый рост выручки, сокращение издержек и улучшение удержания клиентов во всех регионах присутствия компании. '

test('units: a component plate and its text form one rigid unit', () => {
  const slide = slideWith([
    plate('card_plate__repeat_1', { x: 0.05, y: 0.3, width: 0.3, height: 0.3 }),
    text('card_text__repeat_1', { x: 0.07, y: 0.33, width: 0.26, height: 0.08 }, 'Выручка'),
    plate('card_plate__repeat_2', { x: 0.4, y: 0.3, width: 0.3, height: 0.3 }),
    text('card_text__repeat_2', { x: 0.42, y: 0.33, width: 0.26, height: 0.08 }, 'Затраты'),
  ])
  const { units } = buildLayoutUnits(slide, report)
  assert.equal(units.length, 2)
  assert.deepEqual(units.map((unit) => unit.items.length), [2, 2])
})

test('overlap: plate and text move together away from the title', () => {
  const slide = slideWith([
    text('tpl_title', { x: 0.05, y: 0.05, width: 0.9, height: 0.12 }, 'Итоги квартала', 28, { role: 'title' }),
    plate('card_plate__repeat_1', { x: 0.05, y: 0.09, width: 0.3, height: 0.3 }),
    text('card_text__repeat_1', { x: 0.07, y: 0.12, width: 0.26, height: 0.08 }, 'Выручка выросла'),
  ])
  assert.ok(codes(detectLayoutIssues(report, slide)).includes('text_overlap'))
  const { slide: fixed, validation } = resolveSlideLayout(report, slide, { titleIds: ['tpl_title'] })
  assert.equal(validation.engine, HIT_ENGINE)
  assert.equal(validation.valid, true, JSON.stringify(validation.issues))
  const movedPlate = byId(fixed, 'card_plate__repeat_1').geometry_norm
  const movedText = byId(fixed, 'card_text__repeat_1').geometry_norm
  assert.ok(movedPlate.y > 0.09)
  assert.ok(Math.abs((movedText.y - movedPlate.y) - 0.03) < 1e-6, 'text keeps its offset inside the plate')
  assert.ok(Math.abs((movedText.x - movedPlate.x) - 0.02) < 1e-6)
  assert.deepEqual(byId(fixed, 'tpl_title').geometry_norm, slide.content_elements[0].geometry_norm, 'title stays put')
})

test('text fitting prefers vertical wrap over widening a normal body caption', () => {
  const slide = slideWith([
    text('caption__repeat_1', { x: 0.28, y: 0.48, width: 0.2, height: 0.04 }, 'Автоматическая обработка тысяч корпоративных презентаций в месяц', 14, {
      typography: { size_pt: 14, color: '#111111', family: 'Arial', line_height_pt: 19.6, alignment: 'l' },
      component_data: true,
    }),
  ])

  const { slide: fixed, validation } = resolveSlideLayout(report, slide)
  const caption = byId(fixed, 'caption__repeat_1')

  assert.equal(validation.valid, true, JSON.stringify(validation.issues))
  assert.equal(validation.corrections.some((item) => item.op === 'widen_text' || item.op === 'widen'), false)
  assert.ok(caption.geometry_norm.height > slide.content_elements[0].geometry_norm.height)
  assert.ok(Math.abs(caption.geometry_norm.x - slide.content_elements[0].geometry_norm.x) < 1e-6)
  assert.ok(caption.geometry_norm.width <= slide.content_elements[0].geometry_norm.width + 0.002)
})

test('text fitting prefers title wrapping over shifting the title left to the safe area', () => {
  const slide = slideWith([
    text('tpl_title', { x: 0.12, y: 0.12, width: 0.5, height: 0.11 }, 'План развития продукта Flow на ближайшие 2 года', 42, {
      role: 'title',
      typography: { size_pt: 42, color: '#111111', family: 'Play', line_height_pt: 37.8, alignment: 'l' },
      vertical_anchor: 'b',
    }),
  ])

  const { slide: fixed, validation } = resolveSlideLayout(report, slide, { titleIds: ['tpl_title'] })
  const title = byId(fixed, 'tpl_title')

  assert.equal(validation.valid, true, JSON.stringify(validation.issues))
  assert.equal(validation.corrections.some((item) => item.op === 'widen_text' || item.op === 'fit_into_safe'), false)
  assert.ok(title.geometry_norm.height > slide.content_elements[0].geometry_norm.height)
  assert.ok(Math.abs(title.geometry_norm.x - slide.content_elements[0].geometry_norm.x) < 1e-6)
  assert.ok(title.geometry_norm.width <= slide.content_elements[0].geometry_norm.width + 0.002)
})


test('title overlapping a component is lifted to the top safe area before resolving layout', () => {
  const slide = slideWith([
    text('tpl_title', { x: 0.06, y: 0.34, width: 0.62, height: 0.12 }, 'Заголовок не сверху', 28, { role: 'title' }),
    plate('card_plate__repeat_1', { x: 0.05, y: 0.3, width: 0.46, height: 0.25 }),
    text('card_text__repeat_1', { x: 0.08, y: 0.38, width: 0.4, height: 0.08 }, 'Контент компонента', 16),
  ])
  const { slide: fixed, validation } = resolveSlideLayout(report, slide, { titleIds: ['tpl_title'] })
  assert.equal(validation.valid, true, JSON.stringify(validation.issues))
  assert.ok(validation.corrections.some((item) => item.op === 'lift_title'))
  assert.ok(Math.abs(byId(fixed, 'tpl_title').geometry_norm.y - report.layout.content_margins.top_norm) < 1e-6)
  assert.equal(codes(detectLayoutIssues(report, fixed, { titleIds: ['tpl_title'] })).includes('text_overlap'), false)
})



test('lifting a title moves the whole dynamic component group together', () => {
  const slide = slideWith([
    text('tpl_title', { x: 0.36, y: 0.33, width: 0.35, height: 0.12 }, 'Заголовок', 28, { role: 'title' }),
    plate('card_plate__repeat_1', { x: 0.05, y: 0.42, width: 0.25, height: 0.2 }),
    text('card_text__repeat_1', { x: 0.07, y: 0.48, width: 0.2, height: 0.06 }, 'Первый', 16),
    plate('card_plate__repeat_2', { x: 0.35, y: 0.3, width: 0.25, height: 0.2 }),
    text('card_text__repeat_2', { x: 0.37, y: 0.36, width: 0.2, height: 0.06 }, 'Второй', 16),
  ])
  const beforeGap = byId(slide, 'card_plate__repeat_2').geometry_norm.y - byId(slide, 'card_plate__repeat_1').geometry_norm.y
  const { slide: fixed, validation } = resolveSlideLayout(report, slide, { titleIds: ['tpl_title'] })
  assert.equal(validation.valid, true, JSON.stringify(validation.issues))
  assert.ok(validation.corrections.some((item) => item.op === 'move_group'))
  const afterGap = byId(fixed, 'card_plate__repeat_2').geometry_norm.y - byId(fixed, 'card_plate__repeat_1').geometry_norm.y
  assert.ok(Math.abs(afterGap - beforeGap) < 1e-6)
})

test('title collision moves a repeated text row together instead of making a staircase', () => {
  const slide = slideWith([
    text('tpl_title', { x: 0.04, y: 0.08, width: 0.28, height: 0.16 }, 'Функции', 36, { role: 'title' }),
    text('card_title_1', { x: 0.05, y: 0.23, width: 0.2, height: 0.05 }, 'Анализ шаблона', 18),
    text('card_title_2', { x: 0.35, y: 0.19, width: 0.2, height: 0.05 }, 'Генерация слайдов', 18),
    text('card_title_3', { x: 0.65, y: 0.19, width: 0.2, height: 0.05 }, 'Сохранение стиля', 18),
  ])

  const { slide: fixed, validation } = resolveSlideLayout(report, slide, { titleIds: ['tpl_title'] })
  const first = byId(fixed, 'card_title_1').geometry_norm
  const second = byId(fixed, 'card_title_2').geometry_norm
  const third = byId(fixed, 'card_title_3').geometry_norm

  assert.equal(validation.valid, true, JSON.stringify(validation.issues))
  assert.ok(validation.corrections.some((item) => item.op === 'align_text_row'))
  assert.ok(Math.abs(first.y - second.y) < 1e-6)
  assert.ok(Math.abs(first.y - third.y) < 1e-6)
})

test('unmarked large title overlapping a baseline chart is lifted before layout checks', () => {
  const slide = slideWith([
    {
      element_id: 'baseline_chart',
      kind: 'chart',
      chart_type: 'doughnut',
      baseline_preview: {},
      geometry_norm: { x: 0.175217, y: 0.255122, width: 0.413967, height: 0.648978 },
      z_index: 102,
    },
    text('catalog_title', { x: 0.178342, y: 0.308056, width: 0.407717, height: 0.306667 }, 'Доли использования по отделам', 48, { z_index: 103 }),
  ], [{ kind: 'image', layer_id: 'right_photo', geometry_norm: { x: 0.7224, y: 0, width: 0.2784, height: 1 } }])
  const { slide: fixed, validation } = resolveSlideLayout(report, slide)
  assert.equal(validation.valid, true, JSON.stringify(validation.issues))
  assert.ok(validation.corrections.some((item) => item.op === 'lift_title'))
  assert.ok(byId(fixed, 'catalog_title').geometry_norm.y <= 0.051)
  assert.ok(byId(fixed, 'baseline_chart').geometry_norm.y > byId(fixed, 'catalog_title').geometry_norm.y + byId(fixed, 'catalog_title').geometry_norm.height)
})

test('title over a generated chart is rejected as a graphic hit', () => {
  const slide = slideWith([
    text('tpl_title', { x: 0.05, y: 0.08, width: 0.45, height: 0.14 }, 'Динамика продукта', 30, { role: 'title' }),
    {
      element_id: 'chart',
      kind: 'chart',
      chart_type: 'area',
      component_data: true,
      geometry_norm: { x: 0.05, y: 0.1, width: 0.42, height: 0.42 },
      z_index: 20,
    },
  ], [{ kind: 'image', layer_id: 'right_photo', geometry_norm: { x: 0.44, y: 0, width: 0.5637, height: 1 } }])

  assert.ok(codes(detectLayoutIssues(report, slide, { titleIds: ['tpl_title'] })).includes('title_over_graphic'))
})

test('overflow: text grows into free space before any font change', () => {
  const slide = slideWith([text('body', { x: 0.1, y: 0.3, width: 0.4, height: 0.05 }, LONG, 16, { synthetic: true })])
  assert.ok(codes(detectLayoutIssues(report, slide)).includes('text_overflow'))
  const { slide: fixed, validation } = resolveSlideLayout(report, slide)
  assert.equal(validation.valid, true, JSON.stringify(validation.issues))
  const body = byId(fixed, 'body')
  assert.equal(body.typography.size_pt, 16)
  assert.ok(body.geometry_norm.height > 0.05)
  assert.equal(body.geometry_norm.y, 0.3)
})

test('overflow: without free space the font shrinks down to its floor and fits', () => {
  const slide = slideWith([
    text('above', { x: 0.1, y: 0.2, width: 0.5, height: 0.05 }, 'Сверху', 16, { synthetic: true }),
    text('body', { x: 0.1, y: 0.3, width: 0.5, height: 0.05 }, LONG.repeat(2), 16, { synthetic: true }),
    text('below', { x: 0.1, y: 0.42, width: 0.5, height: 0.05 }, 'Снизу', 16, { synthetic: true }),
  ])
  const { slide: fixed, validation } = resolveSlideLayout(report, slide)
  const body = byId(fixed, 'body')
  assert.ok(body.typography.size_pt < 16 && body.typography.size_pt >= 12, `font ${body.typography.size_pt}`)
  assert.equal(validation.valid, true, JSON.stringify(validation.issues))
  assert.ok(validation.corrections.some((item) => item.op === 'shrink'))
})

test('safe area: an oversized unit is clamped and scaled uniformly, plate and text together', () => {
  const slide = slideWith([
    plate('panel__repeat_1', { x: 0.1, y: 0.05, width: 0.4, height: 0.9 }),
    text('panel_text__repeat_1', { x: 0.12, y: 0.1, width: 0.36, height: 0.1 }, 'Панель', 14),
  ])
  const safe = safeAreaFor(report, slide)
  assert.ok(codes(detectLayoutIssues(report, slide)).includes('outside_safe_area'))
  const { slide: fixed, validation } = resolveSlideLayout(report, slide)
  assert.equal(validation.valid, true, JSON.stringify(validation.issues))
  const panel = byId(fixed, 'panel__repeat_1').geometry_norm
  const label = byId(fixed, 'panel_text__repeat_1')
  assert.ok(bottom(panel) <= bottom(safe) + 0.003)
  const factor = panel.height / 0.9
  assert.ok(factor < 1 && factor >= 0.6)
  assert.ok(Math.abs(label.typography.size_pt - 14 * factor) < 0.05)
  assert.ok(Math.abs(label.geometry_norm.width - 0.36 * factor) < 1e-6)
})

test('safe area: metric flex-stack groups clamp to the slide safe zone', () => {
  const group = { x: 0.08, y: 0.74, width: 0.47, height: 0.2 }
  const groupFields = {
    text_group_id: 'metric_stack_slide18_slide_text_106',
    text_group_geometry_norm: { ...group },
    text_group_spacing_pt: { flex_stack_direction: 'column', line_gap_pt: 2 },
    vertical_anchor: 'ctr',
  }
  const slide = slideWith([
    text('metric_value', { x: 0.08, y: 0.74, width: 0.47, height: 0.14 }, '3 ч', 70, {
      ...groupFields,
      text_line_index: 0,
      typography: { size_pt: 70, color: '#0077FF', family: 'Play', line_height_pt: 63 },
    }),
    text('metric_caption', { x: 0.08, y: 0.88, width: 0.47, height: 0.05 }, 'время на создание одной презентации', 24, {
      ...groupFields,
      text_line_index: 1,
      typography: { size_pt: 24, color: '#111111', family: 'Play', line_height_pt: 24 },
    }),
  ])
  const safe = safeAreaFor(report, slide)
  assert.ok(codes(detectLayoutIssues(report, slide)).includes('outside_safe_area'))

  const { slide: fixed, validation } = resolveSlideLayout(report, slide)
  const caption = byId(fixed, 'metric_caption')

  assert.equal(validation.valid, true, JSON.stringify(validation.issues))
  assert.ok(validation.corrections.some((item) => item.op === 'clamp'))
  assert.ok(bottom(caption.text_group_geometry_norm) <= bottom(safe) + 0.003)
})

test('column overlap: metric units are restacked with a minimum gap inside the safe area', () => {
  const elements = []
  for (let index = 1; index <= 3; index += 1) {
    const y = 0.2 + (index - 1) * 0.14
    elements.push(text(`value__metric_${index}`, { x: 0.1, y, width: 0.3, height: 0.12 }, `${index * 40}%`, 40, { component_data: true }))
    elements.push(text(`caption__metric_${index}`, { x: 0.1, y: y + 0.12, width: 0.3, height: 0.05 }, 'подпись к значению', 12, { component_data: true }))
  }
  const slide = slideWith(elements)
  assert.ok(codes(detectLayoutIssues(report, slide)).includes('text_overlap'))
  const { slide: fixed, validation } = resolveSlideLayout(report, slide)
  assert.equal(validation.valid, true, JSON.stringify(validation.issues))
  const units = buildLayoutUnits(fixed, report).units.sort((left, right) => left.occ.y - right.occ.y)
  assert.equal(units.length, 3)
  for (let index = 1; index < units.length; index += 1) {
    const gapPt = (units[index].occ.y - bottom(units[index - 1].occ)) * 540
    assert.ok(gapPt >= MIN_GAP_PT - 0.5, `gap ${gapPt}`)
  }
  assert.ok(bottom(units[2].occ) <= bottom(safeAreaFor(report, fixed)) + 0.003)
})

test('contrast: white text on a white background is an error, dark text is fine', () => {
  const white = slideWith([text('v__metric_1', { x: 0.1, y: 0.3, width: 0.3, height: 0.1 }, '42%', 32, { typography: { color: '#FFFFFF' } })])
  const result = resolveSlideLayout(report, white)
  assert.equal(result.validation.valid, false)
  assert.equal(result.validation.reject_reason, 'low_contrast')
  const dark = slideWith([text('v__metric_1', { x: 0.1, y: 0.3, width: 0.3, height: 0.1 }, '42%', 32)])
  assert.equal(resolveSlideLayout(report, dark).validation.valid, true)
  const onPlate = slideWith([
    plate('p__metric_1', { x: 0.08, y: 0.28, width: 0.34, height: 0.14 }, '#0055AA'),
    text('v__metric_1', { x: 0.1, y: 0.3, width: 0.3, height: 0.1 }, '42%', 32, { typography: { color: '#FFFFFF' } }),
  ])
  assert.equal(resolveSlideLayout(report, onPlate).validation.valid, true, 'white text on its own dark plate is readable')
})

test('images: decorative art under text is allowed, a picture is moved off', () => {
  const art = { kind: 'image', source_scope: 'layout', decorative: true, z_index: 2, geometry_norm: { x: 0.5, y: 0.2, width: 0.4, height: 0.5 }, asset: 'art.png' }
  const body = () => text('body', { x: 0.55, y: 0.3, width: 0.3, height: 0.08 }, 'Текст поверх картинки', 14, { synthetic: true })
  const withArt = detectLayoutIssues(report, slideWith([body()], [art]))
  assert.ok(!withArt.issues.some((issue) => issue.code === 'text_over_image'))
  const picture = { ...art, decorative: false, asset: 'photo.jpg' }
  const slide = slideWith([body()], [picture])
  assert.ok(codes(detectLayoutIssues(report, slide)).includes('text_over_image'))
  const { slide: fixed, validation } = resolveSlideLayout(report, slide)
  assert.equal(validation.valid, true, JSON.stringify(validation.issues))
  assert.ok(!validation.issues.some((issue) => issue.code === 'text_over_image'))
  assert.ok(validation.corrections.some((item) => item.op === 'move'))
  assert.notDeepEqual(byId(fixed, 'body').geometry_norm, byId(slide, 'body').geometry_norm)
})

test('text groups: a stale group box (plate moved, text left behind) is detected and re-synced', () => {
  const group = { x: 0.1, y: 0.1, width: 0.3, height: 0.12 }
  const member = (id, y, line) => text(id, { x: 0.1, y, width: 0.3, height: 0.06 }, `Строка ${line}`, 14, {
    text_group_id: 'g1', text_line_index: line, text_group_geometry_norm: { ...group }, placement_content: true,
  })
  const slide = slideWith([member('line_1__repeat_1', 0.5, 0), member('line_2__repeat_1', 0.56, 1)])
  assert.ok(codes(detectLayoutIssues(report, slide)).includes('stale_group_geometry'))
  const { slide: fixed, validation } = resolveSlideLayout(report, slide)
  assert.ok(!codes(validation).includes('stale_group_geometry'))
  const synced = byId(fixed, 'line_1__repeat_1').text_group_geometry_norm
  assert.ok(Math.abs(synced.y - 0.5) < 1e-6 && Math.abs(synced.height - 0.12) < 1e-6)
  assert.ok(validation.corrections.some((item) => item.op === 'sync_group'))
})

test('rejection is precise: only a genuinely unfixable slide is invalid, with its reason', () => {
  // Body text is widened into free space before shrinking, so the text must exceed even the
  // widest safe frame at the minimum font to be genuinely unfixable.
  const huge = slideWith([text('body', { x: 0.1, y: 0.1, width: 0.3, height: 0.3 }, LONG.repeat(60), 14, { synthetic: true })])
  const result = resolveSlideLayout(report, huge)
  assert.equal(result.validation.valid, false)
  assert.match(result.validation.reject_reason, /text_overflow/)
})

// ---- Regressions on real decks (skipped when the deck is not present) ----

const outputRoot = new URL('../../../output/', import.meta.url)
function loadDeck(prefix) {
  if (!fs.existsSync(outputRoot)) return null
  const id = fs.readdirSync(outputRoot).find((name) => name.startsWith(prefix)
    && fs.existsSync(new URL(`${name}/presentation.json`, outputRoot)) && fs.existsSync(new URL(`${name}/report.json`, outputRoot)))
  if (!id) return null
  return {
    report: JSON.parse(fs.readFileSync(new URL(`${id}/report.json`, outputRoot), 'utf8')),
    presentation: JSON.parse(fs.readFileSync(new URL(`${id}/presentation.json`, outputRoot), 'utf8')).presentation,
  }
}

async function displayed(deck, slideNumber) {
  const { extractDesignTokens } = await import('../constructor/tokens.js')
  const { buildScenarioSlide } = await import('./build-slide.js')
  const slides = deck.presentation.slides
  const slide = slides[slideNumber - 1]
  const seed = `${deck.presentation.title || 'presentation'}|${slide.index ?? slideNumber}|${slide.intent || ''}`
  const result = buildScenarioSlide(deck.report, slide, extractDesignTokens(deck.report), {
    seed, position: slideNumber - 1, totalSlides: slides.length,
  })
  return (result.previewVariants || []).filter((variant) => variant.catalogSlide).slice(0, 3)
}

const BROKEN = new Set(['stale_group_geometry', 'text_overlap', 'unit_overlap', 'outside_slide', 'collapsed_text_box', 'low_contrast', 'text_over_image'])
function assertClean(deck, variants) {
  for (const variant of variants) {
    const errors = detectLayoutIssues(deck.report, variant.catalogSlide).issues
      .filter((issue) => issue.severity === 'error' && BROKEN.has(issue.code))
    assert.deepEqual(errors.map((issue) => issue.code), [], `${variant.key}: ${JSON.stringify(errors)}`)
  }
}

const ba2e = loadDeck('ba2e55fb74eb')
test('real deck ba2e: TOC-as-metric row is no longer rejected as overlapping the title', { skip: !ba2e && 'deck ba2e55fb74eb missing' }, async () => {
  const variants = await displayed(ba2e, 2)
  assert.ok(variants.length >= 2)
  assert.ok(variants.some((variant) => variant.dataBlock === 'metrics'), variants.map((variant) => variant.key).join(', '))
  assertClean(ba2e, variants)
})

const deck51 = loadDeck('51fb4e1edf14')
test('real deck 51fb: metric column (slide 50) fits the safe area; cover/ending clean', { skip: !deck51 && 'deck 51fb4e1edf14 missing' }, async () => {
  for (const number of [1, 2, deck51.presentation.slides.length]) {
    const variants = await displayed(deck51, number)
    assert.ok(variants.length >= 1)
    assertClean(deck51, variants)
    for (const variant of variants.filter((item) => item.dataBlock === 'metrics')) {
      const outside = detectLayoutIssues(deck51.report, variant.catalogSlide).issues
        .filter((issue) => issue.severity === 'error' && issue.code === 'outside_safe_area')
      assert.deepEqual(outside, [], variant.key)
    }
  }
})

const f617 = loadDeck('f617017d34a7')
test('real deck f617: no white-on-white metrics, no stale card text, cover/ending clean', { skip: !f617 && 'deck f617017d34a7 missing' }, async () => {
  for (const number of [1, 2, 3, 6, f617.presentation.slides.length]) {
    const variants = await displayed(f617, number)
    assert.ok(variants.length >= 1)
    assertClean(f617, variants)
  }
})
