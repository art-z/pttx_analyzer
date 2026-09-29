// Round 9: word wrap without mid-word breaks, orphans, title gap, paragraph
// fallback to 3 variants, and stripping of donor component remnants.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { fontTableKeys, glueOrphans, measureTextWidthPt, textAreaWidthPt, wrapText } from './text-measure.js'
import { estimateTextInkHeightPt } from './separate-vertical-text.js'
import { detectLayoutIssues, resolveSlideLayout } from './slide-hit-test.js'
import { TITLE_GAP_FLOOR_PT, requiredTitleGapPt, templateTitleGapPt } from './title-gap.js'
import { paragraphFallbackItems, splitHeadingBody } from './paragraph-fallback.js'
import { collectComponentRemnantIds } from './finalize-scenario-preview.js'
import { applyItemFieldsToElements } from '../components/container-render.js'

const report = {
  layout: { content_margins: { left_norm: 0.05, right_norm: 0.05, top_norm: 0.05, bottom_norm: 0.05 } },
}
const W = 960
const H = 540

function slideWith(elements) {
  return {
    slide_number: 1,
    render: {
      slide_size_pt: { width: W, height: H },
      layers: [{ kind: 'fill', geometry_norm: { x: 0, y: 0, width: 1, height: 1 }, fill: { color: '#FFFFFF' } }],
    },
    content_elements: elements,
  }
}

function text(id, x, y, width, height, value, { size = 20, family = 'Arial', align = 'l', anchor = 't' } = {}) {
  return {
    element_id: id,
    kind: 'text',
    text: value,
    vertical_anchor: anchor,
    geometry_norm: { x, y, width, height },
    typography: { size_pt: size, family, alignment: align, color: '#000000' },
  }
}

const codes = (issues) => issues.map((issue) => issue.code)

// ---- 1. wrap model ----
test('font tables measure real advance widths (Arial 12pt "Hello world" ~ 60pt)', () => {
  const width = measureTextWidthPt('Hello world', 12, { family: 'Arial' })
  assert.ok(width > 58 && width < 62, `width ${width}`)
  const regular = measureTextWidthPt('Презентация', 20, { family: 'Arial' })
  const heavy = measureTextWidthPt('Презентация', 20, { family: 'Montserrat ExtraBold' })
  assert.ok(heavy > regular * 1.1, 'Montserrat ExtraBold is wider than Arial')
  assert.deepEqual(fontTableKeys({ family: 'Play' }), ['vk-sans-display'])
  assert.deepEqual(fontTableKeys({ family: 'Montserrat ExtraBold' }), ['montserrat-extrabold', 'arial-bold'])
})

test('wrapText breaks only between words and reports a word wider than the box', () => {
  const wrap = wrapText('Автоматизация корпоративных презентаций', 140, 20, { family: 'Arial' })
  const words = 'Автоматизация корпоративных презентаций'.split(' ')
  assert.deepEqual(wrap.lines.map((line) => line.text).join(' ').split(' '), words, 'every word stays whole')
  const narrow = wrapText('Автоматизация', 60, 20, { family: 'Arial' })
  assert.equal(narrow.overflowWord, true)
  assert.equal(narrow.lineCount, 1, 'no mid-word line break')
  const glued = wrapText('для\u00a0презентаций', 120, 20, { family: 'Arial' })
  assert.equal(glued.lineCount, 1, 'a no-break space glues')
  assert.equal(glued.overflowWord, true)
})

test('orphans of 1-2 characters are found and glued with a no-break space', () => {
  const value = 'Подготовка слайдов занимает часы и'
  const widthPt = measureTextWidthPt('Подготовка слайдов занимает часы', 20, {}) + 4
  const wrap = wrapText(value, widthPt, 20, {})
  assert.equal(wrap.orphans.length, 1)
  assert.equal(wrap.orphans[0].text.trim(), 'и')
  const glued = glueOrphans(value, widthPt, 20, {})
  assert.ok(glued && glued.includes('\u00a0и'))
  assert.equal(wrapText(glued, widthPt, 20, {}).orphans.length, 0)
})

test('ink height estimate follows the font and subtracts body insets', () => {
  const base = text('t', 0, 0, 0.2, 0.2, 'Сократите время подготовки презентаций без потери стиля', { size: 16 })
  const arial = estimateTextInkHeightPt(base, 0.2 * W)
  const heavy = estimateTextInkHeightPt({ ...base, typography: { ...base.typography, family: 'Montserrat ExtraBold' } }, 0.2 * W)
  assert.ok(heavy > arial, 'wider glyphs wrap into more lines')
  const padded = { ...base, body_insets_pt: { left: 30, right: 30 } }
  assert.equal(textAreaWidthPt(padded, 0.2 * W), 0.2 * W - 60)
  assert.ok(estimateTextInkHeightPt(padded, 0.2 * W) >= arial)
})

// ---- 1b. renderer agrees with the estimator ----
test('slide text renderers no longer break inside words', () => {
  for (const file of ['../templates/slide-render.js', '../slides/design-system-render.js', '../slides/text-list.js']) {
    const source = fs.readFileSync(new URL(file, import.meta.url), 'utf8')
    assert.ok(!/\.style\.wordBreak = 'break-word'/.test(source), `${file} still uses break-word`)
    assert.ok(/\.style\.overflowWrap = 'normal'/.test(source) && /\.style\.hyphens = 'manual'/.test(source), `${file} sets normal wrapping`)
  }
})

// ---- 1c. hit-test: word too wide, orphan ----
test('a word wider than its box is widened into free space, keeping alignment', () => {
  const slide = slideWith([text('w__repeat_1', 0.3, 0.3, 0.08, 0.1, 'Автоматизация', { size: 20, align: 'l' })])
  assert.ok(codes(detectLayoutIssues(report, slide).issues).includes('word_too_wide'))
  const { slide: fixed, validation } = resolveSlideLayout(report, slide)
  assert.ok(!codes(validation.errors).includes('word_too_wide'), JSON.stringify(validation.errors))
  const box = fixed.content_elements[0].geometry_norm
  assert.ok(Math.abs(box.x - 0.3) < 1e-6, 'left edge kept for left alignment')
  assert.ok(box.width > 0.08)
  assert.equal(fixed.content_elements[0].typography.size_pt, 20, 'font untouched when widening suffices')
  assert.ok(validation.corrections.some((item) => item.op === 'widen'))
})

test('blocked on both sides the font shrinks to its floor; below the floor it stays an error', () => {
  // Card plates right next to the box leave no room to widen.
  const plate = (id, x, width) => ({ element_id: id, kind: 'fill', geometry_norm: { x, y: 0.28, width, height: 0.2 }, fill: { color: '#EEEEEE' } })
  const neighbours = [plate('l__repeat_2', 0.05, 0.244), plate('r__repeat_3', 0.386, 0.2)]
  const fits = slideWith([text('w__repeat_1', 0.3, 0.3, 0.08, 0.1, 'Автоматизация', { size: 12 }), ...neighbours])
  const shrunk = resolveSlideLayout(report, fits)
  assert.ok(!codes(shrunk.validation.errors).includes('word_too_wide'), JSON.stringify(shrunk.validation.errors))
  assert.ok(shrunk.slide.content_elements[0].typography.size_pt < 12)
  // Inside its own card plate the text may only widen to the plate; a word
  // that does not fit even at the font floor stays an error.
  const card = { element_id: 'c__repeat_1', kind: 'fill', geometry_norm: { x: 0.29, y: 0.28, width: 0.1, height: 0.2 }, fill: { color: '#EEEEEE' } }
  const tooLong = slideWith([card, text('w__repeat_1', 0.3, 0.3, 0.08, 0.1, 'Высокотехнологичность', { size: 20 })])
  const result = resolveSlideLayout(report, tooLong)
  assert.ok(codes(result.validation.errors).includes('word_too_wide'), JSON.stringify(result.validation.errors))
  const box = result.slide.content_elements.find((element) => element.element_id === 'w__repeat_1').geometry_norm
  assert.ok(box.x >= 0.29 - 1e-6 && box.x + box.width <= 0.39 + 1e-6, 'never wider than its card')
})

test('a one-letter last line is detected and fixed by gluing it to the previous word', () => {
  const value = 'Подготовка слайдов занимает часы и'
  const widthNorm = (measureTextWidthPt('Подготовка слайдов занимает часы', 20, {}) + 4) / W
  const slide = slideWith([text('o__repeat_1', 0.1, 0.3, widthNorm, 0.3, value, { size: 20 })])
  assert.ok(codes(detectLayoutIssues(report, slide).issues).includes('text_orphan'))
  const { slide: fixed, validation } = resolveSlideLayout(report, slide)
  assert.ok(!codes(validation.errors).includes('text_orphan'), JSON.stringify(validation.errors))
  assert.ok(fixed.content_elements[0].text.includes('\u00a0и'))
})

// ---- 2. title gap ----
test('a 2-char first line of a big metric ("30 / мин") is glued, then the box is widened into free space', () => {
  const el = text('m__metric_1', 0.0838, 0.4, 0.4443, 0.3554, '30 мин', { size: 148.11 })
  const neighbour = text('n__metric_2', 0.665, 0.31, 0.3, 0.15, '3 ч', { size: 88 })
  const result = resolveSlideLayout(report, slideWith([el, neighbour]))
  assert.deepEqual(codes(result.validation.errors), [])
  const fixed = result.slide.content_elements.find((element) => element.element_id === 'm__metric_1')
  assert.equal(fixed.text, '30\u00a0мин')
  assert.ok(fixed.geometry_norm.x + fixed.geometry_norm.width < 0.665, 'stays left of the neighbour')
  const ops = result.validation.corrections.map((c) => c.op)
  assert.ok(ops.includes('glue_orphan') && ops.includes('widen'), JSON.stringify(ops))
})

test('content too close under the title is moved down to the required gap', () => {
  const title = text('title', 0.1, 0.1, 0.8, 0.1, 'Заголовок слайда', { size: 32 })
  const body = text('body__repeat_1', 0.1, 0.1 + 38 / H + 2 / H, 0.8, 0.1, 'Текст под заголовком', { size: 16 })
  const slide = slideWith([title, body])
  const issues = detectLayoutIssues(report, slide, { titleIds: ['title'] }).issues
  const gapIssue = issues.find((issue) => issue.code === 'title_gap')
  assert.ok(gapIssue, JSON.stringify(issues))
  const required = requiredTitleGapPt(report, slide, title)
  assert.ok(required >= TITLE_GAP_FLOOR_PT && required >= 0.8 * 32 * 1.15 - 0.01)
  const { slide: fixed, validation } = resolveSlideLayout(report, slide, { titleIds: ['title'] })
  assert.ok(!codes(validation.errors).includes('title_gap'), JSON.stringify(validation.errors))
  const moved = fixed.content_elements.find((element) => element.element_id === 'body__repeat_1').geometry_norm
  assert.ok(moved.y > body.geometry_norm.y)
  assert.ok(validation.corrections.some((item) => item.op === 'title_gap'))
})

test('no room below or above the title leaves a title_gap error', () => {
  const title = text('title', 0.1, 0.05, 0.8, 0.08, 'Заголовок', { size: 32 })
  // 24 lines: the body ink fills the safe area down to its bottom edge.
  const body = text('body__repeat_1', 0.1, 0.05 + 37 / H, 0.8, 0.95 - 0.05 - 37 / H, Array(24).fill('Строка').join('\n'), { size: 16 })
  const { validation } = resolveSlideLayout(report, slideWith([title, body]), { titleIds: ['title'] })
  assert.ok(codes(validation.errors).includes('title_gap'))
})

test('the required gap is learned from the template (median over donor slides)', () => {
  const donor = (number, gapPt) => ({
    slide_number: number,
    template_id: 'tmpl_x',
    content_elements: [
      { ...text(`s${number}_title`, 0.1, 0.1, 0.8, 0.08, 'Заголовок', { size: 30 }), placeholder_type: 'title', role: 'title' },
      text(`s${number}_body`, 0.1, 0.1 + (30 * 1.15) / H + gapPt / H, 0.8, 0.2, 'Основной текст', { size: 16 }),
    ],
  })
  const deck = { ...report, slides: { slides: [donor(1, 40), donor(2, 44), donor(3, 48)] } }
  const learned = templateTitleGapPt(deck, { template_id: 'tmpl_x' })
  assert.ok(learned > 38 && learned < 50, `learned ${learned}`)
  const required = requiredTitleGapPt(deck, { template_id: 'tmpl_x' }, { typography: { size_pt: 30 } })
  assert.ok(required > requiredTitleGapPt(report, {}, { typography: { size_pt: 30 } }))
})

// ---- 5. paragraph fallback items ----
test('paragraph headings come from the paragraph itself (first clause / sentence)', () => {
  assert.deepEqual(splitHeadingBody('Процесс состоит из трёх этапов: загрузка, анализ и генерация.'), {
    heading: 'Процесс состоит из трёх этапов',
    body: 'Загрузка, анализ и генерация.',
  })
  assert.deepEqual(splitHeadingBody('Первое предложение здесь. Второе предложение там.'), {
    heading: 'Первое предложение здесь',
    body: 'Второе предложение там.',
  })
  // An enumeration comma does not end a clause.
  assert.deepEqual(splitHeadingBody('Ключевые даты включают подготовку, обучение и запуск.'), {
    heading: '',
    body: 'Ключевые даты включают подготовку, обучение и запуск.',
  })
  const { items, usesSummary } = paragraphFallbackItems({
    paragraphs: [{ heading: '', body: 'Процесс состоит из трёх этапов: загрузка, анализ и генерация.' }],
    summary_text: 'Flow анализирует шаблон, а затем собирает презентацию.',
  })
  assert.equal(usesSummary, true)
  assert.equal(items.length, 2)
  const words = (value) => value.toLowerCase().replace(/[^\p{L}\p{N}\s-]/gu, ' ').split(/\s+/).filter(Boolean)
  const source = new Set(words('Процесс состоит из трёх этапов: загрузка, анализ и генерация. Flow анализирует шаблон, а затем собирает презентацию.'))
  for (const item of items) {
    for (const word of words(`${item.heading} ${item.body}`)) assert.ok(source.has(word), `invented word ${word}`)
  }
})

// ---- 4. component remnants ----
test('a card body split into donor lines gets the paragraph once, not once per line', () => {
  const line = (index, size) => ({
    element_id: `body_line_${index}`, kind: 'text', text: 'old', text_group_id: 'body', text_line_index: index,
    typography: { size_pt: size }, geometry_norm: { x: 0.1, y: 0.4, width: 0.3, height: 0.2 },
  })
  const heading = { element_id: 'head', kind: 'text', text: 'old', typography: { size_pt: 20 }, geometry_norm: { x: 0.1, y: 0.3, width: 0.3, height: 0.05 } }
  const elements = [heading, line(3, 12), line(1, 12), line(2, 12)]
  const slots = [{ role: 'heading' }, { role: 'body' }, { role: 'body' }, { role: 'body' }]
  const out = applyItemFieldsToElements(elements, slots, { heading: 'Внедрение за 3 месяца', body: 'Начиная с подготовки шаблонов.' })
  assert.deepEqual(out.map((element) => [element.element_id, element.text.replace(/[\u00a0\u202f]/g, ' ')]), [
    ['head', 'Внедрение за 3 месяца'],
    ['body_line_1', 'Начиная с подготовки шаблонов.'],
  ])
})

test('plates of a component whose text is dropped are stripped; backdrops, logos and text backgrounds stay', () => {
  const donorSlide = {
    slide_number: 7,
    content_elements: [
      { element_id: 'plate', kind: 'fill', geometry_norm: { x: 0.1, y: 0.5, width: 0.2, height: 0.2 } },
      { element_id: 'avatar', kind: 'fill', geometry_norm: { x: 0.12, y: 0.52, width: 0.05, height: 0.08 } },
      text('card_text', 0.12, 0.62, 0.16, 0.06, 'Имя Фамилия'),
      { element_id: 'backdrop', kind: 'fill', geometry_norm: { x: 0, y: 0, width: 1, height: 1 } },
      { element_id: 'logo_mark', kind: 'image', name: 'Logo', geometry_norm: { x: 0.9, y: 0.9, width: 0.05, height: 0.05 } },
      { element_id: 'desc_plate', kind: 'fill', geometry_norm: { x: 0.5, y: 0.5, width: 0.3, height: 0.2 } },
      text('desc_text', 0.52, 0.52, 0.26, 0.1, 'Описание'),
    ],
    component_instances: [
      { name: 'PERSON_CARD', element_ids: ['plate', 'avatar', 'card_text', 'backdrop', 'logo_mark'] },
      { name: 'TEXT_BLOCK', element_ids: ['desc_plate', 'desc_text'] },
    ],
  }
  const deck = { slides: { slides: [donorSlide] } }
  const generated = {
    slide_number: 7,
    content_elements: [
      ...donorSlide.content_elements.filter((element) => !['card_text', 'desc_text'].includes(element.element_id)),
      { ...text('synthetic_slide_description_7', 0.55, 0.55, 0.2, 0.08, 'Новый текст'), synthetic: true },
    ],
  }
  const keep = new Set(generated.content_elements.map((element) => element.element_id))
  const removed = collectComponentRemnantIds(deck, generated, keep)
  assert.deepEqual([...removed].sort(), ['avatar', 'plate'])
})

test('pictures the caller keeps on purpose (decoration photos) are not remnants; explicitly kept plates still are', () => {
  const donorSlide = {
    slide_number: 8,
    content_elements: [
      { element_id: 'photo_1', kind: 'image', geometry_norm: { x: 0.55, y: 0.3, width: 0.18, height: 0.3 } },
      { element_id: 'plate_1', kind: 'fill', geometry_norm: { x: 0.55, y: 0.62, width: 0.18, height: 0.1 } },
      text('caption_1', 0.56, 0.63, 0.16, 0.06, 'Подпись'),
      { element_id: 'photo_2', kind: 'image', geometry_norm: { x: 0.76, y: 0.3, width: 0.18, height: 0.3 } },
      { element_id: 'plate_2', kind: 'fill', geometry_norm: { x: 0.76, y: 0.62, width: 0.18, height: 0.1 } },
      text('caption_2', 0.77, 0.63, 0.16, 0.06, 'Подпись'),
    ],
    component_instances: [
      { name: 'PHOTO_CARD', element_ids: ['photo_1', 'plate_1', 'caption_1'] },
      { name: 'PHOTO_CARD', element_ids: ['photo_2', 'plate_2', 'caption_2'] },
    ],
  }
  const deck = { slides: { slides: [donorSlide] } }
  const generated = { slide_number: 8, content_elements: donorSlide.content_elements.filter((element) => element.kind !== 'text') }
  const keep = new Set(generated.content_elements.map((element) => element.element_id))
  const exempt = new Set(['photo_1', 'photo_2', 'plate_1'])
  assert.deepEqual([...collectComponentRemnantIds(deck, generated, keep, exempt)].sort(), ['plate_1', 'plate_2'])
  assert.deepEqual([...collectComponentRemnantIds(deck, generated, keep)].sort(), ['photo_1', 'photo_2', 'plate_1', 'plate_2'])
})

// ---- real decks (skipped when missing) ----
const outputRoot = new URL('../../../output/', import.meta.url)
const hasDeck = (id) => fs.existsSync(new URL(`${id}/presentation.json`, outputRoot)) && fs.existsSync(new URL(`${id}/report.json`, outputRoot))

async function assembleDeck(id) {
  const report = JSON.parse(fs.readFileSync(new URL(`${id}/report.json`, outputRoot), 'utf8'))
  const presentation = JSON.parse(fs.readFileSync(new URL(`${id}/presentation.json`, outputRoot), 'utf8'))
  const { extractDesignTokens } = await import('../constructor/tokens.js')
  const { createCoverageContext } = await import('./component-coverage.js')
  const { takeSlideVariants } = await import('../lite-assemble.js')
  const slides = presentation.presentation.slides
  const tokens = extractDesignTokens(report)
  const context = createCoverageContext(report)
  const title = presentation.presentation?.title || 'presentation'
  return slides.map((slide, index) => ({
    slide,
    variants: takeSlideVariants(report, slide, tokens, context, `${title}|${slide.index ?? index + 1}|${slide.intent || ''}`, { position: index, totalSlides: slides.length }),
  }))
}

test('real deck ba2e: every slide reaches 3 variants; paragraph fallbacks come after real ones and are clean', { skip: !hasDeck('ba2e55fb74eb') && 'deck missing' }, async () => {
  const rows = await assembleDeck('ba2e55fb74eb')
  let fallbacks = 0
  for (const [index, { variants }] of rows.entries()) {
    assert.equal(variants.length, 3, `slide ${index + 1}: ${variants.length}`)
    const firstFallback = variants.findIndex((variant) => variant.fallback)
    if (firstFallback >= 0) {
      assert.ok(variants.slice(firstFallback).every((variant) => variant.fallback), `slide ${index + 1}: real variant after a fallback`)
      fallbacks += variants.length - firstFallback
    }
    const templates = variants.map((variant) => `${variant.templateId}|${variant.catalogSlide.slide_number}|${variant.componentId || ''}`)
    assert.equal(new Set(templates).size, templates.length, `slide ${index + 1}: duplicate variant`)
    for (const variant of variants) {
      const errors = (variant.catalogSlide.layout_validation?.errors || []).map((issue) => issue.code)
      if (variant.fallback) assert.deepEqual(errors, [], `slide ${index + 1} fallback errors ${errors}`)
    }
  }
  assert.ok(fallbacks > 0, 'fallbacks were needed on this deck')
})

test('real deck ac62: empty repeat plates of tmpl_034#3 no longer leak onto the cover', { skip: !hasDeck('ac622c83fcd7') && 'deck missing' }, async () => {
  const rows = await assembleDeck('ac622c83fcd7')
  const leaked = ['102', '103', '104', '105', '106'].map((n) => `slide3_slide_shape_${n}`)
  let checked = 0
  for (const { variants } of rows) {
    for (const variant of variants.filter((item) => item.catalogSlide.slide_number === 3)) {
      const ids = new Set(variant.catalogSlide.content_elements.map((element) => element.element_id))
      assert.ok(leaked.every((id) => !ids.has(id)), 'plates stripped')
      checked += 1
    }
  }
  assert.ok(checked > 0)
})
