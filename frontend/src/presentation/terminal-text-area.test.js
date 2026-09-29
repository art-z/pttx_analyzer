import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import {
  applyTerminalTextAreas,
  layoutTerminalText,
  normalizeSlotBox,
  terminalObstacles,
  terminalTextAreas,
  titleFontFloor,
  wrapLineCount,
} from './terminal-text-area.js'

const report = { layout: { content_margins: { left_norm: 0.05, right_norm: 0.05, top_norm: 0.05, bottom_norm: 0.05 } } }
const size = { width: 960, height: 540 }
const bounds = { x: 0.05, y: 0.05, width: 0.9, height: 0.9 }
const right = (box) => box.x + box.width
const bottom = (box) => box.y + box.height
const overlaps = (a, b) => Math.min(right(a), right(b)) - Math.max(a.x, b.x) > 0.002 && Math.min(bottom(a), bottom(b)) - Math.max(a.y, b.y) > 0.002

function slideWith(layers = [], elements = []) {
  return {
    slide_number: 1,
    render: {
      slide_size_pt: size,
      layers: [{ kind: 'fill', z_index: 0, geometry_norm: { x: 0, y: 0, width: 1, height: 1 }, fill: { color: '#0A0A0A' } }, ...layers],
    },
    content_elements: elements,
  }
}
const art = (box, extra = {}) => ({ kind: 'image', source_scope: 'layout', decorative: true, z_index: 2, geometry_norm: box, asset: 'art.png', ...extra })
const title = (box, text, font = 54, extra = {}) => ({
  element_id: 'title', kind: 'text', text, synthetic: true, geometry_norm: { ...box },
  typography: { size_pt: font, line_height_ratio: 0.9, color: '#FFFFFF', alignment: 'l' }, ...extra,
})
const body = (box, text, font = 18) => ({
  element_id: 'body', kind: 'text', text, synthetic: true, geometry_norm: { ...box },
  typography: { size_pt: font, color: '#DDDDDD', alignment: 'l' },
})

test('wrap: no-break spaces glue words, breakable spaces wrap', () => {
  assert.equal(wrapLineCount('для\u00a0презентаций', 100, 20), 2 + 0, 'long glued word is split only when wider than a line')
  assert.equal(wrapLineCount('один два три', 1000, 20), 1)
  assert.ok(wrapLineCount('один два три четыре пять шесть', 120, 20) >= 3)
})

test('obstacles: backdrop is a surface, art/photo/plates/logos are obstacles', () => {
  const slide = slideWith([
    art({ x: 0, y: 0, width: 1, height: 0.95 }),
    art({ x: 0.5, y: 0, width: 0.5, height: 1 }),
    { kind: 'text', name: 'Logo', z_index: 3, geometry_norm: { x: 0.05, y: 0.05, width: 0.1, height: 0.05 } },
  ], [{ element_id: 'plate', kind: 'fill', geometry_norm: { x: 0.1, y: 0.8, width: 0.2, height: 0.1 }, fill: { color: '#333333' } }])
  const kinds = terminalObstacles(slide).map((item) => item.kind).sort()
  assert.deepEqual(kinds, ['art', 'logo', 'plate'])
})

test('normalize: an oversized title slot running under art is clipped to the free side, keeping its left edge', () => {
  const obstacles = [{ box: { x: 0.5, y: 0, width: 0.5, height: 1 }, kind: 'art', id: 'art' }]
  const slot = { x: 0.05, y: 0.35, width: 0.85, height: 0.25 }
  const result = normalizeSlotBox(slot, { obstacles, bounds, size })
  assert.equal(result.changed, true)
  assert.ok(result.reasons.includes('obstacle:art'))
  assert.equal(result.box.x, 0.05)
  assert.ok(right(result.box) <= 0.5 - 8 / 960 + 1e-4, JSON.stringify(result.box))
  assert.ok(result.box.width > 0.4)
})

test('normalize: an off-slide slot is clipped into the slide and safe area', () => {
  const slot = { x: -0.1, y: 0.3, width: 1.3, height: 0.8 }
  const result = normalizeSlotBox(slot, { obstacles: [], bounds, size })
  assert.ok(result.reasons.includes('off_slide'))
  assert.ok(result.box.x >= 0.05 - 1e-6 && right(result.box) <= 0.95 + 1e-6)
  assert.ok(bottom(result.box) <= 0.95 + 1e-6)
})

test('normalize: a slot mostly on a photo moves off it; a slot inside its own plate stays inside', () => {
  const photo = { box: { x: 0.3, y: 0.2, width: 0.65, height: 0.6 }, kind: 'picture', id: 'photo' }
  const onPhoto = normalizeSlotBox({ x: 0.25, y: 0.4, width: 0.5, height: 0.15 }, { obstacles: [photo], bounds, size })
  assert.ok(!overlaps(onPhoto.box, photo.box), JSON.stringify(onPhoto.box))
  const band = { box: { x: 0.05, y: 0.3, width: 0.5, height: 0.3 }, kind: 'plate', id: 'band' }
  const inBand = normalizeSlotBox({ x: 0.08, y: 0.35, width: 0.4, height: 0.15 }, { obstacles: [band], bounds, size })
  assert.equal(inBand.container, 'band')
  assert.ok(inBand.box.x >= 0.05 && right(inBand.box) <= 0.55 && inBand.box.y >= 0.3 && bottom(inBand.box) <= 0.6)
})

test('stacking: a long title grows, shrinks to its floor at most, and stays above the subtitle with a gap', () => {
  const slide = slideWith([art({ x: 0.55, y: 0, width: 0.45, height: 1 })], [
    title({ x: 0.05, y: 0.35, width: 0.85, height: 0.2 }, 'Стратегия развития цифровых сервисов компании на 2026–2028 годы: цели, задачи и ресурсы'),
    body({ x: 0.05, y: 0.5, width: 0.85, height: 0.1 }, 'Отчёт для руководства и ключевых партнёров'),
  ])
  const result = applyTerminalTextAreas(report, slide, { titleIds: ['title'], bodyIds: ['body'] })
  assert.equal(result.applied, true)
  assert.equal(result.fits, true)
  const t = result.slide.content_elements.find((element) => element.element_id === 'title')
  const b = result.slide.content_elements.find((element) => element.element_id === 'body')
  assert.ok(right(t.geometry_norm) <= 0.55 && right(b.geometry_norm) <= 0.55, 'both stay left of the art')
  assert.ok(t.typography.size_pt <= 54 && t.typography.size_pt >= titleFontFloor(54))
  assert.ok(b.geometry_norm.y >= bottom(t.geometry_norm) - 1e-6 || b.geometry_norm.y >= result.titleArea.box.y + 0.01)
  assert.ok(!overlaps(t.geometry_norm, b.geometry_norm), `${JSON.stringify(t.geometry_norm)} vs ${JSON.stringify(b.geometry_norm)}`)
  assert.equal(t.text_area_normalized, true)
})

test('capacity: a tiny free area takes only short titles; a roomy one takes any', () => {
  const tight = slideWith([art({ x: 0.25, y: 0, width: 0.75, height: 1 }), art({ x: 0, y: 0.45, width: 0.25, height: 0.55 })])
  const small = terminalTextAreas(report, tight, {
    titleBox: { x: 0.05, y: 0.3, width: 0.6, height: 0.1 },
    titleStyle: { typography: { size_pt: 60, line_height_ratio: 0.9, alignment: 'l' } },
  })
  assert.notEqual(small.capacity.label, 'any')
  assert.equal(small.capacity.short.fits, true)
  const roomy = terminalTextAreas(report, slideWith(), {
    titleBox: { x: 0.05, y: 0.3, width: 0.9, height: 0.3 },
    titleStyle: { typography: { size_pt: 48, line_height_ratio: 0.9, alignment: 'l' } },
  })
  assert.equal(roomy.capacity.label, 'any')
})

test('layout: a real title that cannot fit legibly reports fits=false', () => {
  const tight = slideWith([art({ x: 0.3, y: 0, width: 0.7, height: 1 }), art({ x: 0, y: 0.5, width: 0.3, height: 0.5 })])
  const areas = terminalTextAreas(report, tight, {
    titleBox: { x: 0.05, y: 0.35, width: 0.6, height: 0.1 },
    titleStyle: { typography: { size_pt: 60, alignment: 'l' } },
  })
  const layout = layoutTerminalText(areas, { title: 'Очень длинный заголовок презентации, который никак не помещается в маленькую свободную область слева' })
  assert.equal(layout.fits, false)
})

// ---- real decks (skipped when missing) ----
const outputRoot = new URL('../../../output/', import.meta.url)
const deckIds = fs.existsSync(outputRoot) ? fs.readdirSync(outputRoot).filter((name) => (
  fs.existsSync(new URL(`${name}/presentation.json`, outputRoot)) && fs.existsSync(new URL(`${name}/report.json`, outputRoot))
)) : []

test('real decks: cover/ending title and subtitle never run over art/photos, off the slide, or into each other', { skip: !deckIds.length && 'no decks in output/' }, async () => {
  const { buildTerminalSlideVariants } = await import('./build-terminal-slide.js')
  const { normalizeSlideSpec } = await import('./slide-spec.js')
  const { typographSlideSpec } = await import('../slides/text-typographer.js')
  let checked = 0
  for (const id of deckIds) {
    const deckReport = JSON.parse(fs.readFileSync(new URL(`${id}/report.json`, outputRoot), 'utf8'))
    const slides = JSON.parse(fs.readFileSync(new URL(`${id}/presentation.json`, outputRoot), 'utf8')).presentation.slides
    for (const [role, raw] of [['initial', slides[0]], ['final', slides[slides.length - 1]]]) {
      const spec = typographSlideSpec(normalizeSlideSpec({ ...raw, title: raw.title_options?.middle || raw.title }))
      const variants = buildTerminalSlideVariants(deckReport, spec, role, { limit: 3 })
      assert.ok(variants.length >= 3, `${id} ${role}: ${variants.length} variants`)
      for (const variant of variants.filter((item) => item.titleFits)) {
        const slide = variant.catalogSlide
        const texts = slide.content_elements.filter((element) => element.text_area_normalized)
        const obstacles = terminalObstacles(slide, { excludeIds: texts.map((element) => element.element_id) })
        for (const text of texts) {
          const box = text.geometry_norm
          assert.ok(box.x >= -0.001 && box.y >= -0.001 && right(box) <= 1.001 && bottom(box) <= 1.001, `${id} ${variant.key} off slide`)
          for (const obstacle of obstacles) {
            const inside = Math.max(0, Math.min(right(box), right(obstacle.box)) - Math.max(box.x, obstacle.box.x))
              * Math.max(0, Math.min(bottom(box), bottom(obstacle.box)) - Math.max(box.y, obstacle.box.y))
            const container = inside >= 0.85 * box.width * box.height
            assert.ok(container || !overlaps(box, obstacle.box), `${id} ${variant.key} ${text.element_id} over ${obstacle.id}`)
          }
        }
        if (texts.length === 2) assert.ok(!overlaps(texts[0].geometry_norm, texts[1].geometry_norm), `${id} ${variant.key} title/subtitle overlap`)
        checked += 1
      }
    }
  }
  assert.ok(checked > 0)
})
