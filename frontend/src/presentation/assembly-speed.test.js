import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { freeRectangles } from './terminal-text-area.js'
import { detectSlideVgroups } from '../slides/vgroup-detect.js'
import { listDeckMetricLayouts } from '../components/metric-render.js'
import { listMetricComponents } from '../components/metric-catalog.js'
import { buildScenarioSlide } from './build-slide.js'
import { createCoverageContext } from './component-coverage.js'
import { extractDesignTokens } from '../constructor/tokens.js'

// Reference: the original free-rectangle sweep with the quadratic
// maximal-rectangle filter. The fast version must return the same list.
function referenceFreeRectangles(bounds, obstacles) {
  const right = (box) => box.x + box.width
  const bottom = (box) => box.y + box.height
  const area = (box) => Math.max(0, box.width) * Math.max(0, box.height)
  const xs = [...new Set([bounds.x, right(bounds), ...obstacles.flatMap((item) => [item.x, right(item)])]
    .map((value) => Math.min(right(bounds), Math.max(bounds.x, value))))].sort((a, b) => a - b)
  const rects = []
  for (let i = 0; i < xs.length; i += 1) {
    for (let j = i + 1; j < xs.length; j += 1) {
      const x1 = xs[i]
      const x2 = xs[j]
      if (x2 - x1 < 1e-4) continue
      const blocking = obstacles.filter((item) => item.x < x2 - 1e-6 && right(item) > x1 + 1e-6)
        .map((item) => [Math.max(bounds.y, item.y), Math.min(bottom(bounds), bottom(item))])
        .filter(([top, low]) => low > top)
        .sort((a, b) => a[0] - b[0])
      let cursor = bounds.y
      const push = (top, low) => {
        if (low - top > 1e-4) rects.push({ x: x1, y: top, width: x2 - x1, height: low - top })
      }
      for (const [top, low] of blocking) {
        push(cursor, top)
        cursor = Math.max(cursor, low)
      }
      push(cursor, bottom(bounds))
    }
  }
  return rects.filter((rect, index) => !rects.some((other, otherIndex) => otherIndex !== index
    && other.x <= rect.x + 1e-6 && other.y <= rect.y + 1e-6
    && right(other) >= right(rect) - 1e-6 && bottom(other) >= bottom(rect) - 1e-6
    && area(other) > area(rect) + 1e-9))
}

function seededRandom(seed) {
  let state = seed
  return () => {
    state = (state * 1103515245 + 12345) % 2147483648
    return state / 2147483648
  }
}

test('freeRectangles: fast maximal filter returns exactly the reference rectangles, in order', () => {
  const random = seededRandom(7)
  for (let round = 0; round < 60; round += 1) {
    const bounds = { x: 0.05, y: 0.06, width: 0.9, height: 0.86 }
    const count = 1 + Math.floor(random() * 18)
    const obstacles = Array.from({ length: count }, () => {
      const width = 0.02 + random() * 0.4
      const height = 0.02 + random() * 0.4
      return { x: random() * (1 - width), y: random() * (1 - height), width, height }
    })
    assert.deepEqual(freeRectangles(bounds, obstacles), referenceFreeRectangles(bounds, obstacles))
  }
})

test('freeRectangles: memoized results are copies (callers may mutate them)', () => {
  const bounds = { x: 0, y: 0, width: 1, height: 1 }
  const obstacles = [{ x: 0.5, y: 0.2, width: 0.3, height: 0.3 }]
  const first = freeRectangles(bounds, obstacles)
  first[0].width = -1
  first.length = 0
  assert.deepEqual(freeRectangles(bounds, obstacles), referenceFreeRectangles(bounds, obstacles))
})

// ---- real decks (skipped when missing) ----
const outputRoot = new URL('../../../output/', import.meta.url)
const hasDeck = (id) => fs.existsSync(new URL(`${id}/report.json`, outputRoot))
  && fs.existsSync(new URL(`${id}/presentation.json`, outputRoot))
const loadDeck = (id) => ({
  report: JSON.parse(fs.readFileSync(new URL(`${id}/report.json`, outputRoot), 'utf8')),
  slides: JSON.parse(fs.readFileSync(new URL(`${id}/presentation.json`, outputRoot), 'utf8')).presentation.slides,
})
const smallDeck = ['5f31d1d84d52', 'f617017d34a7', 'ff3df98196bd', '51fb4e1edf14'].find(hasDeck)

test('vgroup detection is cached for the report\'s own slides only', { skip: !smallDeck && 'no deck in output/' }, () => {
  const { report } = loadDeck(smallDeck)
  const slide = report.slides.slides.find((item) => (item.content_elements || []).length > 3)
  const first = detectSlideVgroups(slide, { report })
  assert.equal(detectSlideVgroups(slide, { report }), first, 'same donor slide: cached result')
  const copy = JSON.parse(JSON.stringify(slide))
  const foreign = detectSlideVgroups(copy, { report })
  assert.notEqual(foreign, first, 'a built/edited copy is recomputed')
  assert.deepEqual(foreign.summary, first.summary, 'and gives the same answer')
  const withOptions = detectSlideVgroups(slide, { report, extra: true })
  assert.notEqual(withOptions, first, 'custom options bypass the cache')
  const edited = { ...slide, content_elements: slide.content_elements.slice(1) }
  report.slides.slides[report.slides.slides.indexOf(slide)] = edited
  assert.notEqual(detectSlideVgroups(edited, { report }), first)
})

test('metric catalog is built once per report and handed out as fresh arrays', { skip: !smallDeck && 'no deck in output/' }, () => {
  const { report } = loadDeck(smallDeck)
  const layouts = listDeckMetricLayouts(report)
  const components = listMetricComponents(report)
  const started = performance.now()
  for (let index = 0; index < 50; index += 1) {
    listDeckMetricLayouts(report)
    listMetricComponents(report)
  }
  assert.ok(performance.now() - started < 200, 'repeat calls are cache hits')
  const again = listMetricComponents(report)
  assert.notEqual(again, components)
  assert.deepEqual(again, components)
  again.length = 0
  assert.equal(listMetricComponents(report).length, components.length)
  assert.deepEqual(listDeckMetricLayouts(report), layouts)
})

// The deck from the slow UI run: 49 donor slides; every slide with KPI numbers
// used to rescan the whole deck ~150 times (about 3 minutes per slide).
const bigDeck = ['65e12715f240', '5153ceabd24c'].find(hasDeck)

test('real deck: slides with metrics assemble in seconds, not minutes', { skip: !bigDeck && 'slow-run deck not in output/' }, () => {
  const { report, slides } = loadDeck(bigDeck)
  const tokens = extractDesignTokens(report)
  const context = createCoverageContext(report)
  const metricSlide = slides.find((slide, index) => index > 0 && index < slides.length - 1
    && (slide.context?.metrics || slide.metrics || []).length)
  assert.ok(metricSlide, 'deck has a middle slide with metrics')
  const started = performance.now()
  const result = buildScenarioSlide(report, metricSlide, tokens, {
    selectionContext: context,
    seed: `speed|${metricSlide.index}`,
    position: slides.indexOf(metricSlide),
    totalSlides: slides.length,
  })
  const seconds = (performance.now() - started) / 1000
  assert.ok(seconds < 15, `metric slide took ${seconds.toFixed(1)}s`)
  assert.equal(result.previewVariants.filter((variant) => variant.catalogSlide).slice(0, 3).length, 3)
})
