import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { buildTerminalSlideVariants } from './build-terminal-slide.js'
import { dedupeTerminalFamilies } from './build-slide.js'
import { contrastRatio } from './component-template-fit.js'
import {
  effectiveBackgroundUnder,
  inferTerminalSlotStyle,
  validateTerminalSlotStyle,
} from './terminal-slot-style.js'

const DARK = '#0B2A5B'
const SIZE = { width: 960, height: 540 }
const TITLE_BOX = { x: 0.08, y: 0.35, width: 0.7, height: 0.2 }
const BODY_BOX = { x: 0.08, y: 0.62, width: 0.6, height: 0.1 }

function background(color) {
  return { kind: 'fill', fill: { kind: 'solid', color }, geometry_norm: { x: 0, y: 0, width: 1, height: 1 }, z_index: 1, source_scope: 'layout_bg' }
}

function filledSlide(number, layoutName, title, { bg = DARK, color = '#FFFFFF' } = {}) {
  return {
    slide_number: number,
    layout_source: `layout-${number}`,
    layout_name: layoutName,
    template_id: `tmpl-${number}`,
    render: { slide_size_pt: SIZE, background_color: '#FFFFFF', layers: [background(bg)] },
    content_elements: [{
      element_id: `title-${number}`,
      kind: 'text',
      text: title,
      placeholder_type: 'title',
      geometry_norm: { ...TITLE_BOX },
      geometry_pt: { x_pt: 76.8, y_pt: 189, width_pt: 672, height_pt: 108 },
      typography: { family: 'Play', size_pt: 44, color },
    }, {
      element_id: `subtitle-${number}`,
      kind: 'text',
      text: 'Speaker name',
      placeholder_type: 'body',
      geometry_norm: { ...BODY_BOX },
      geometry_pt: { x_pt: 76.8, y_pt: 334.8, width_pt: 576, height_pt: 54 },
      typography: { family: 'Play', size_pt: 20, color },
    }],
  }
}

function emptySlide(number, layoutName, { bg = DARK, layers = [] } = {}) {
  return {
    slide_number: number,
    layout_source: `layout-${number}`,
    layout_name: layoutName,
    template_id: `tmpl-${number}`,
    render: { slide_size_pt: SIZE, background_color: '#FFFFFF', layers: [background(bg), ...layers] },
    content_elements: [],
  }
}

// Junk placeholder formatting as it often comes from a template: code font,
// text colour equal to the background.
function junkProfile(slide) {
  return {
    template_id: slide.template_id,
    layout_source: slide.layout_source,
    editable_slots: [
      { role: 'title', placeholder_type: 'title', geometry_norm: { ...TITLE_BOX }, empty: true,
        typography: { family: 'Consolas', size_pt: 60, color: DARK } },
      { role: 'body', placeholder_type: 'body', geometry_norm: { ...BODY_BOX }, empty: true,
        typography: { family: 'Consolas', size_pt: 11, color: DARK } },
    ],
  }
}

function makeReport(slides, { profiles = [], initial = [], final = [] } = {}) {
  return {
    slides: {
      slides,
      terminal_candidates: {
        initial,
        final,
        preferred: { initial_slide_number: initial[0]?.slide_number, final_slide_number: final[0]?.slide_number },
      },
    },
    slide_templates: { templates: profiles },
    typography: { spatial: { components: [] } },
    layout: { content_margins: {} },
  }
}

function textElements(variant) {
  return (variant.catalogSlide.content_elements || []).filter((element) => element.kind === 'text')
}

test('empty-text template becomes a cover candidate with an inferred, readable style', () => {
  const cover = filledSlide(1, '1_Title slide', 'Old cover')
  const empty = emptySlide(2, '2_Title slide')
  const ending = filledSlide(3, 'Final', 'Thanks')
  const report = makeReport([cover, empty, ending], {
    profiles: [junkProfile(empty)],
    initial: [{ slide_number: 1, score: 200 }],
    final: [{ slide_number: 3, score: 150 }],
  })

  const variants = buildTerminalSlideVariants(report, { title: 'New cover', text: 'Subtitle' }, 'initial')
  const inferred = variants.find((item) => item.slideNumber === 2)
  assert.ok(inferred, 'empty template is offered')
  assert.equal(inferred.inferredStyle, true)
  assert.ok(variants.findIndex((item) => item.slideNumber === 1) < variants.indexOf(inferred),
    'filled analyzer-approved cover ranks above the inferred one')
  const title = textElements(inferred).find((element) => element.text === 'New cover')
  assert.equal(title.style_source, 'inferred')
  assert.equal(title.style_evidence.font, 'slide:1')
  assert.equal(title.typography.family, 'Play')
  assert.equal(title.typography.color, '#FFFFFF')
  for (const element of textElements(inferred)) {
    assert.notEqual(element.typography.family, 'Consolas', 'junk slot font never leaks')
    assert.notEqual(element.typography.color, DARK, 'junk slot colour never leaks')
    assert.ok(contrastRatio(element.typography.color, DARK) >= 3)
  }
})

test('low-contrast reference colour is replaced from tokens, or the slot is rejected', () => {
  const cover = filledSlide(1, '1_Title slide', 'Old cover')
  const light = emptySlide(2, '2_Title slide', { bg: '#FFFFFF' })
  const report = makeReport([cover, light])

  const fixed = inferTerminalSlotStyle(report, light, {
    box: TITLE_BOX, role: 'title', tokens: { titleColors: ['#FFFFFF'], themeColors: { dk1: '#1A1A1A' } },
  })
  assert.equal(fixed.ok, true)
  assert.equal(fixed.typography.family, 'Play')
  assert.equal(fixed.typography.color, '#1A1A1A')
  assert.equal(fixed.evidence.color, 'tokens')

  const rejected = inferTerminalSlotStyle(report, light, {
    box: TITLE_BOX, role: 'title', tokens: { titleColors: ['#FFFFFF'], themeColors: { lt1: '#F4F4F4' } },
  })
  assert.equal(rejected.ok, false)
  assert.equal(rejected.reason, 'low_contrast')

  assert.equal(validateTerminalSlotStyle(light, TITLE_BOX, { family: 'Play', color: '#F4F4F4' }).ok, false)
  assert.equal(validateTerminalSlotStyle(light, TITLE_BOX, { family: 'Consolas', color: '#000000' }).reason, 'code_font')
})

test('template is excluded when its empty title sits on colour-unknown content art', () => {
  const cover = filledSlide(1, '1_Title slide', 'Old cover')
  const photo = emptySlide(2, 'Photo cover', {
    layers: [{ kind: 'image', asset: 'photo.jpg', decorative: false, source_scope: 'layout',
      geometry_norm: { x: 0, y: 0, width: 1, height: 1 }, z_index: 2 }],
  })
  const report = makeReport([cover, photo], {
    profiles: [junkProfile(photo)],
    initial: [{ slide_number: 1, score: 200 }],
  })
  assert.equal(effectiveBackgroundUnder(photo, TITLE_BOX).reliable, false)
  assert.equal(inferTerminalSlotStyle(report, photo, { box: TITLE_BOX, role: 'title' }).reason, 'unknown_background')
  const variants = buildTerminalSlideVariants(report, { title: 'New cover', text: '' }, 'initial')
  assert.deepEqual(variants.map((item) => item.slideNumber), [1])
})

test('filled templates render exactly as before when empty templates are added', () => {
  const cover = filledSlide(1, '1_Title slide', 'Old cover')
  const ending = filledSlide(3, 'Final', 'Thanks')
  const candidates = { initial: [{ slide_number: 1, score: 200 }], final: [{ slide_number: 3, score: 150 }] }
  const spec = { title: 'New cover', text: 'Subtitle' }
  const empty = emptySlide(2, '2_Title slide')
  for (const [role, numbers] of [['initial', [1]], ['final', [3, 1]]]) {
    const plain = buildTerminalSlideVariants(makeReport(
      [JSON.parse(JSON.stringify(cover)), JSON.parse(JSON.stringify(ending))], candidates,
    ), spec, role)
    const extended = buildTerminalSlideVariants(makeReport(
      [JSON.parse(JSON.stringify(cover)), JSON.parse(JSON.stringify(empty)), JSON.parse(JSON.stringify(ending))],
      { ...candidates, profiles: [junkProfile(empty)] },
    ), spec, role)
    assert.ok(extended.some((item) => item.slideNumber === 2), `${role}: empty template added`)
    for (const slideNumber of numbers) {
      const before = plain.find((item) => item.slideNumber === slideNumber)
      const after = extended.find((item) => item.slideNumber === slideNumber)
      assert.ok(before && after, `${role}: slide ${slideNumber}`)
      assert.deepEqual(after.catalogSlide, before.catalogSlide)
      assert.equal(after.styleSource, 'template')
      assert.ok(textElements(after).every((element) => !element.style_source))
    }
  }
})

test('approved template keeps its planned font and only gets an unreadable colour fixed', () => {
  const cover = filledSlide(1, '1_Title slide', 'Old cover')
  const blank = emptySlide(2, '1_Title slide')
  const report = makeReport([cover, blank], {
    initial: [{ slide_number: 2, score: 250, text_plan: {
      title: { geometry_norm: { ...TITLE_BOX }, typography: { family: 'Play', size_pt: 40, color: DARK } },
    } }, { slide_number: 1, score: 200 }],
  })
  const variant = buildTerminalSlideVariants(report, { title: 'New cover', text: '' }, 'initial')
    .find((item) => item.slideNumber === 2)
  const title = textElements(variant).find((element) => element.text === 'New cover')
  assert.equal(title.typography.family, 'Play')
  assert.equal(title.typography.color, '#FFFFFF')
  assert.equal(title.style_source, 'inferred')
  assert.equal(title.style_evidence.scope, 'color')
})

test('merged title builds keep one cover variant per visual family when possible', () => {
  const item = (key, visualFamily) => ({ key, terminalRole: 'initial', visualFamily })
  const ranked = [item('a', 'cover|dark'), item('b', 'cover|dark'), item('c', 'cover|light'), item('d', 'final|dark')]
  assert.deepEqual(dedupeTerminalFamilies(ranked).map((entry) => entry.key), ['a', 'c', 'd'])
  assert.deepEqual(dedupeTerminalFamilies(ranked.slice(0, 2)).map((entry) => entry.key), ['a', 'b'])
})

const deckReport = fileURLToPath(new URL('../../../output/f617017d34a7/report.json', import.meta.url))

test('real deck: empty cover/ending templates add diverse, readable bookends', { skip: !fs.existsSync(deckReport) }, () => {
  const report = JSON.parse(fs.readFileSync(deckReport, 'utf8'))
  const cover = buildTerminalSlideVariants(report, {
    title: 'Flow: AI-сервис для корпоративных презентаций', text: 'Короткое описание продукта',
  }, 'initial')
  assert.equal(cover.length, 3)
  assert.equal(new Set(cover.map((item) => item.visualFamily)).size, 3, 'three different visual families')
  assert.ok(cover.some((item) => item.inferredStyle), 'empty-text templates take part')
  const coverTemplate = cover[0].templateId

  const ending = buildTerminalSlideVariants(report, { title: 'Контакты и следующий шаг', text: 'Свяжитесь с нами' },
    'final', { selectionContext: { terminalTemplateUsage: { [coverTemplate]: 1 } } })
  assert.equal(ending.length, 3)
  assert.ok(!ending.some((item) => item.templateId === coverTemplate), 'ending does not repeat the cover template')
  assert.ok(ending.some((item) => /финальн/i.test(item.sublabel)), 'a real final layout is offered')

  for (const variant of [...cover, ...ending]) {
    for (const element of textElements(variant).filter((entry) => entry.style_source)) {
      const bg = effectiveBackgroundUnder(variant.catalogSlide, element.geometry_norm)
      assert.ok(!/consolas|mono/i.test(element.typography.family || ''))
      if (bg.reliable) assert.ok(contrastRatio(element.typography.color, bg.color) >= 3, `${variant.key} ${element.element_id}`)
    }
  }
})
