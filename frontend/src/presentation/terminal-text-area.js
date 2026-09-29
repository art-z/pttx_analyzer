// Cover/ending text-area normalization.
//
// Template placeholders on covers and endings are often drawn much larger than
// the space that is actually free: a title slot that runs under the photo or
// decorative art on the right, off the slide, or into the subtitle. This module
//   1) collects the fixed obstacles of a terminal template (pictures and art
//      that are not a full backdrop, plates, logos, kept decoration);
//   2) finds the largest free rectangle next to each slot (inside the slide and
//      the per-layout safe area) and clips/moves the slot into it, keeping its
//      alignment edge and keeping the title above the subtitle with a gap;
//   3) lays text out in that region with word-wrapped, conservative glyph
//      widths (shrinking the font down to a legibility floor if needed);
//   4) simulates sample titles (short/medium/long) to know how long a title the
//      template can take, used for ranking against the real title.
// Results are cached per report + template + slide + slot geometry.
import { bodySafeAreaFor, safeAreaFor } from './slide-hit-test.js'
import { wrapText } from './text-measure.js'

export const TERMINAL_TITLE_SAMPLES = {
  short: 'Итоги года 2026',
  medium: 'Стратегия развития цифровых сервисов компании',
  long: 'Стратегия развития цифровых сервисов компании на 2026–2028 годы: цели, задачи и ресурсы',
}
export const TERMINAL_SUBTITLE_SAMPLE = 'Отчёт для руководства и ключевых партнёров'
export const TERMINAL_GLYPH_RATIO = 0.55
export const BACKDROP_AREA = 0.8
const GAP_PT = 8
const MIN_OBSTACLE_AREA = 0.0015
const CONTAINER_SHARE = 0.85
const DEFAULT_SIZE = { width: 960, height: 540 }
const LOGO_RE = /logo|wordmark|brand|логотип|бренд/i
const SYSTEM_PLACEHOLDERS = new Set(['sldNum', 'dt', 'ftr', 'hdr'])
const cache = new WeakMap()

const rightOf = (box) => box.x + box.width
const bottomOf = (box) => box.y + box.height
const areaOf = (box) => (box ? Math.max(0, box.width) * Math.max(0, box.height) : 0)

function finiteBox(value) {
  if (!value) return null
  const box = { x: Number(value.x), y: Number(value.y), width: Number(value.width), height: Number(value.height) }
  if (![box.x, box.y, box.width, box.height].every(Number.isFinite)) return null
  return box.width > 0 && box.height > 0 ? box : null
}

function intersect(left, right) {
  const x = Math.max(left.x, right.x)
  const y = Math.max(left.y, right.y)
  const width = Math.min(rightOf(left), rightOf(right)) - x
  const height = Math.min(bottomOf(left), bottomOf(right)) - y
  return width > 0 && height > 0 ? { x, y, width, height } : null
}

function inflate(box, dx, dy) {
  return { x: box.x - dx, y: box.y - dy, width: box.width + 2 * dx, height: box.height + 2 * dy }
}

function round4(box) {
  return box && {
    x: Number(box.x.toFixed(4)),
    y: Number(box.y.toFixed(4)),
    width: Number(box.width.toFixed(4)),
    height: Number(box.height.toFixed(4)),
  }
}

export function slideSizeOf(report, slide) {
  return slide?.render?.slide_size_pt || report?.typography?.visibility?.slide_size_pt || DEFAULT_SIZE
}

function isBackdrop(box) {
  return (box.width >= 0.92 && box.height >= 0.92) || areaOf(box) >= BACKDROP_AREA
}

// Fixed things a cover/ending text must not run over. Full backdrops (a
// full-bleed photo or colour) are surfaces, not obstacles; readability over
// them is the style/contrast check's job.
export function terminalObstacles(slide, { excludeIds = [] } = {}) {
  const excluded = new Set(excludeIds)
  const obstacles = []
  const add = (item, kind, source) => {
    const box = finiteBox(item.geometry_norm)
    if (!box || areaOf(box) < MIN_OBSTACLE_AREA || isBackdrop(box)) return
    obstacles.push({ box, kind, id: item.element_id || item.layer_id || item.asset || item.name || kind, source })
  }
  for (const layer of slide?.render?.layers || []) {
    if (layer.kind === 'image') add(layer, layer.decorative === true ? 'art' : 'picture', 'layer')
    else if (layer.kind === 'fill') add(layer, 'plate', 'layer')
    else if (layer.kind === 'text' && !SYSTEM_PLACEHOLDERS.has(layer.placeholder_type)
      && LOGO_RE.test(String(layer.name || '')) && areaOf(finiteBox(layer.geometry_norm)) < 0.08) add(layer, 'logo', 'layer')
  }
  for (const element of slide?.content_elements || []) {
    if (excluded.has(element.element_id) || element.kind === 'text') continue
    if (element.kind === 'image') add(element, 'picture', 'element')
    else if (['fill', 'line'].includes(element.kind)) add(element, 'plate', 'element')
  }
  return obstacles
}

// Maximal free rectangles inside `bounds` (sweep over obstacle edges).
// The same template slide is asked for its free space once per title length,
// per simulated sample title and per subtitle placement, with identical
// obstacles, so results are memoized by geometry (bounded cache).
const FREE_RECT_CACHE_LIMIT = 2000
const freeRectCache = new Map()

function geometryKey(bounds, obstacles) {
  const part = (box) => `${box.x},${box.y},${box.width},${box.height}`
  return `${part(bounds)}|${obstacles.map(part).join(';')}`
}

export function freeRectangles(bounds, obstacles) {
  const key = geometryKey(bounds, obstacles)
  const cached = freeRectCache.get(key)
  if (cached) return cached.map((rect) => ({ ...rect }))
  const rects = sweepFreeRectangles(bounds, obstacles)
  if (freeRectCache.size >= FREE_RECT_CACHE_LIMIT) freeRectCache.clear()
  freeRectCache.set(key, rects)
  return rects.map((rect) => ({ ...rect }))
}

function sweepFreeRectangles(bounds, obstacles) {
  const xs = [...new Set([bounds.x, rightOf(bounds), ...obstacles.flatMap((item) => [item.x, rightOf(item)])]
    .map((value) => Math.min(rightOf(bounds), Math.max(bounds.x, value))))].sort((a, b) => a - b)
  const rects = []
  for (let i = 0; i < xs.length; i += 1) {
    for (let j = i + 1; j < xs.length; j += 1) {
      const x1 = xs[i]
      const x2 = xs[j]
      if (x2 - x1 < 1e-4) continue
      const blocking = obstacles.filter((item) => item.x < x2 - 1e-6 && rightOf(item) > x1 + 1e-6)
        .map((item) => [Math.max(bounds.y, item.y), Math.min(bottomOf(bounds), bottomOf(item))])
        .filter(([top, bottom]) => bottom > top)
        .sort((a, b) => a[0] - b[0])
      let cursor = bounds.y
      const push = (top, bottom) => {
        if (bottom - top > 1e-4) rects.push({ x: x1, y: top, width: x2 - x1, height: bottom - top })
      }
      for (const [top, bottom] of blocking) {
        push(cursor, top)
        cursor = Math.max(cursor, bottom)
      }
      push(cursor, bottomOf(bounds))
    }
  }
  // Keep only maximal rectangles: a rectangle goes if a strictly larger one
  // contains it. Checking against the kept larger ones is enough
  // (containment is transitive); the original order is preserved.
  const areas = rects.map(areaOf)
  const order = rects.map((_, index) => index).sort((left, right) => areas[right] - areas[left])
  const kept = []
  const keep = new Array(rects.length).fill(false)
  for (const index of order) {
    const rect = rects[index]
    const covered = kept.some((otherIndex) => {
      const other = rects[otherIndex]
      return areas[otherIndex] > areas[index] + 1e-9
        && other.x <= rect.x + 1e-6 && other.y <= rect.y + 1e-6
        && rightOf(other) >= rightOf(rect) - 1e-6 && bottomOf(other) >= bottomOf(rect) - 1e-6
    })
    if (!covered) {
      keep[index] = true
      kept.push(index)
    }
  }
  return rects.filter((_, index) => keep[index])
}

function anchorPoint(slot, align, anchor) {
  const x = ['r', 'right'].includes(align) ? rightOf(slot) : ['ctr', 'center', 'c'].includes(align) ? slot.x + slot.width / 2 : slot.x
  const y = ['b', 'bottom'].includes(anchor) ? bottomOf(slot) : ['ctr', 'middle', 'center'].includes(anchor) ? slot.y + slot.height / 2 : slot.y
  return { x, y }
}

function distanceToRect(point, rect) {
  const dx = Math.max(rect.x - point.x, 0, point.x - rightOf(rect))
  const dy = Math.max(rect.y - point.y, 0, point.y - bottomOf(rect))
  return Math.hypot(dx, dy)
}

// Clip/move one slot into the best free rectangle next to its anchor.
export function normalizeSlotBox(slot, { obstacles = [], bounds, size = DEFAULT_SIZE, align = 'l', anchor = 't', minHeight = 0.04, below = null }) {
  const gapX = GAP_PT / size.width
  const gapY = GAP_PT / size.height
  const clipped = intersect(slot, bounds) || { ...bounds }
  // A plate or art panel that holds (almost) the whole slot is the text's own
  // container: write inside it, not around it. Photos never are.
  const container = obstacles.find((item) => ['plate', 'art'].includes(item.kind)
    && areaOf(intersect(item.box, slot)) >= CONTAINER_SHARE * areaOf(slot))
  const frame = container ? (intersect(inflate(container.box, -gapX, -gapY), bounds) || bounds) : bounds
  const blocking = obstacles.filter((item) => item !== container && !(container && areaOf(intersect(item.box, container.box)) >= 0.95 * areaOf(item.box) && item.kind === 'plate'))
    .map((item) => ({ ...inflate(item.box, gapX, gapY), obstacle: item }))
  const point = anchorPoint(clipped, align, anchor)
  const grow = { x: clipped.x, y: clipped.y - clipped.height, width: clipped.width, height: clipped.height * 3 }
  const free = freeRectangles(frame, blocking)
  const usable = (width) => free
    .filter((rect) => rect.width >= width - 1e-6 && rect.height >= minHeight - 1e-6)
    .filter((rect) => !below || rect.y >= below - 1e-6 || bottomOf(rect) >= below + minHeight)
    .map((rect) => (below && rect.y < below ? { ...rect, y: below, height: bottomOf(rect) - below } : rect))
    .filter((rect) => rect.height >= minHeight - 1e-6)
  // Prefer a region at least ~40% of the slot wide; accept a narrower column
  // (the text then wraps/shrinks) before giving up.
  let minWidth = Math.min(clipped.width, Math.max(0.18, 0.4 * clipped.width))
  let candidates = usable(minWidth)
  if (!candidates.length) {
    minWidth = Math.min(clipped.width, 0.12)
    candidates = usable(minWidth)
  }
  const scored = candidates.map((rect) => ({
    rect,
    score: areaOf(intersect(rect, clipped)) * 4 + areaOf(intersect(rect, grow)) - distanceToRect(point, rect) * 0.2,
  })).sort((left, right) => right.score - left.score)
  const region = scored[0]?.rect || null
  if (!region) {
    return { box: round4(clipped), region: null, changed: false, noRegion: true, reasons: ['no_free_region'], blockedBy: blocking.map((item) => item.obstacle.id) }
  }
  let box = intersect(clipped, region)
  if (!box || box.width < minWidth - 1e-6 || box.height < minHeight - 1e-6) {
    // Slot lies (almost) entirely on an obstacle: move it into the region,
    // keeping its alignment edge and height where possible.
    const width = Math.min(clipped.width, region.width)
    const x = ['r', 'right'].includes(align) ? rightOf(region) - width
      : ['ctr', 'center', 'c'].includes(align) ? region.x + (region.width - width) / 2 : region.x
    const height = Math.min(Math.max(clipped.height, minHeight), region.height)
    const y = Math.min(Math.max(clipped.y, region.y), bottomOf(region) - height)
    box = { x: Math.max(region.x, Math.min(x, clipped.x < region.x ? region.x : x)), y, width, height }
  }
  const reasons = []
  if (slot.x < -0.001 || slot.y < -0.001 || rightOf(slot) > 1.001 || bottomOf(slot) > 1.001) reasons.push('off_slide')
  if (areaOf(intersect(slot, bounds)) < areaOf(slot) - 1e-6) reasons.push('outside_safe_area')
  const hitIds = blocking.filter((item) => intersect(item, slot)).map((item) => item.obstacle.id)
  if (hitIds.length) reasons.push(...hitIds.map((id) => `obstacle:${id}`))
  const changed = Math.abs(box.x - slot.x) > 1e-4 || Math.abs(box.y - slot.y) > 1e-4
    || Math.abs(box.width - slot.width) > 1e-4 || Math.abs(box.height - slot.height) > 1e-4
  return { box: round4(box), region: round4(region), changed, reasons, container: container?.id || null }
}

// ---- text measuring (word wrap, conservative glyph width) ----

// Words are split on breakable spaces only: the typographer glues short words
// with no-break spaces, and the browser never wraps inside those.
const BREAKABLE_SPACE = /[ \t\u2002-\u200B]+/

export function longestUnbreakable(text) {
  return Math.max(0, ...String(text || '').split('\n')
    .flatMap((paragraph) => paragraph.split(BREAKABLE_SPACE)).map((word) => word.length))
}

export function wrapLineCount(text, widthPt, fontPt, ratio = TERMINAL_GLYPH_RATIO) {
  const maxChars = Math.max(1, Math.floor(widthPt / (fontPt * ratio)))
  let lines = 0
  for (const paragraph of String(text || '').split('\n')) {
    lines += 1
    let current = 0
    for (const word of paragraph.split(BREAKABLE_SPACE).filter(Boolean)) {
      let length = word.length
      if (current && current + 1 + length <= maxChars) {
        current += 1 + length
        continue
      }
      if (current) lines += 1
      while (length > maxChars) {
        lines += 1
        length -= maxChars
      }
      current = length
    }
  }
  return lines
}

function lineHeightFor(typography, font) {
  const base = Number(typography?.size_pt) || font
  const explicit = Number(typography?.line_height_pt)
  if (explicit > 0) return explicit * font / base
  const ratio = Number(typography?.line_height_ratio)
  return font * (ratio > 0 ? ratio : 1.15)
}

export function textHeightPt(text, widthPt, typography, font) {
  // Same wrap model as the hit-test (font advance tables, word breaks only).
  // A word wider than the box overflows sideways in the browser: not a fit.
  const wrap = wrapText(String(text || ''), widthPt, font, typography || {})
  if (wrap.overflowWord) return Infinity
  const lines = wrap.lineCount
  const lineHeight = lineHeightFor(typography, font)
  // Glyphs of tight line spacing (<1.0) still need their full em box.
  return lines * lineHeight + Math.max(0, font - lineHeight) * 0.6
}

// Legibility floor: half the design size, never below 24pt, and a huge
// display size (100pt+) may still come down to 36pt.
export function titleFontFloor(font) {
  return Math.min(font, Math.max(24, Math.min(font * 0.5, 36)))
}

export function subtitleFontFloor(font) {
  return Math.min(font, Math.max(10, font * 0.75))
}

// Wider box inside the free region, keeping the alignment edge; never wider
// than 60% of the slide (comfortable line length) unless the slot already was.
const MAX_WIDENED = 0.6

function widened(box, region, align, maxWidth = MAX_WIDENED) {
  if (!region || region.width <= box.width + 1e-4) return null
  const limit = Math.max(box.width, maxWidth)
  if (region.width > limit) {
    const x = ['r', 'right'].includes(align) ? Math.max(region.x, rightOf(box) - limit)
      : ['ctr', 'center', 'c'].includes(align) ? Math.max(region.x, box.x + box.width / 2 - limit / 2)
        : Math.max(region.x, Math.min(box.x, rightOf(region) - limit))
    region = { ...region, x, width: Math.min(limit, rightOf(region) - x) }
  }
  if (['r', 'right'].includes(align)) {
    const x = region.x
    return { ...box, x, width: rightOf(box) - x }
  }
  if (['ctr', 'center', 'c'].includes(align)) {
    const half = Math.min(box.x + box.width / 2 - region.x, rightOf(region) - (box.x + box.width / 2))
    return half * 2 > box.width + 1e-4 ? { ...box, x: box.x + box.width / 2 - half, width: half * 2 } : null
  }
  const width = rightOf(region) - box.x
  return width > box.width + 1e-4 ? { ...box, width } : null
}

// Fits one text: at the slot width first, then (if needed) widened inside
// the free region with its alignment edge kept.
function fitText(text, typography, box, region, size, options) {
  const first = fitTextAt(text, typography, box, region, size, options)
  if (first.fits) return first
  const wide = widened(box, region, String(typography?.alignment || 'l').toLowerCase())
  if (!wide) return first
  const second = fitTextAt(text, typography, wide, region, size, options)
  return second.fits || second.scale > first.scale ? { ...second, widened: true } : first
}

function fitTextAt(text, typography, box, region, size, { anchor = 't', floor, capBottom = null }) {
  const font0 = Number(typography?.size_pt) || 24
  const widthPt = box.width * size.width
  const top = region ? region.y : box.y
  const bottom = Math.min(region ? bottomOf(region) : bottomOf(box), capBottom ?? Infinity)
  const available = Math.max(0, bottom - top)
  let font = font0
  let heightPt = textHeightPt(text, widthPt, typography, font)
  while (heightPt / size.height > available + 1e-6 && font > floor + 1e-6) {
    font = Math.max(floor, font * 0.95)
    heightPt = textHeightPt(text, widthPt, typography, font)
  }
  const height = heightPt / size.height
  const fits = height <= available + 1e-6
  const need = Number.isFinite(height) ? Math.min(Math.max(height, 0), Math.max(available, 0)) : Math.max(available, 0)
  let y
  if (['b', 'bottom'].includes(anchor)) y = bottomOf(box) - Math.max(need, Math.min(box.height, available))
  else if (['ctr', 'middle', 'center'].includes(anchor)) y = box.y + box.height / 2 - need / 2
  else y = box.y
  const boxHeight = Math.max(need, Math.min(box.height, available))
  y = Math.min(Math.max(y, top), bottom - boxHeight)
  const placed = { x: box.x, y, width: box.width, height: boxHeight }
  const inkTop = ['b', 'bottom'].includes(anchor) ? bottomOf(placed) - need
    : ['ctr', 'middle', 'center'].includes(anchor) ? placed.y + (placed.height - need) / 2 : placed.y
  // The written box is the (conservative) ink area itself, so a title box
  // never reaches into the subtitle below it.
  const ink = { x: placed.x, y: inkTop, width: placed.width, height: need > 0 ? need : placed.height }
  return {
    font: Number(font.toFixed(2)),
    scale: font / font0,
    fits,
    box: round4(ink),
    ink: round4(ink),
  }
}

// Subtitle/description: widen before growing. The slot width is kept when
// the text fits at full size inside the slot height. Otherwise (a narrow
// column running down toward the margin, or a shrunk font) the title's
// column width is tried: taken when it is shorter at no smaller size. Only a
// text that still does not fit at full size goes wider, into the free region
// (up to MAX_WIDENED).
function fitSubtitleText(text, typography, box, region, size, options, { slotBottom, columnWidth = 0 }) {
  const align = String(typography?.alignment || 'l').toLowerCase()
  const tolerance = GAP_PT / size.height
  const full = (fit) => fit.fits && fit.scale >= 0.999
  const tall = (fit) => bottomOf(fit.box) > slotBottom + tolerance
  const better = (fit, than) => fit.fits && (!than.fits || fit.scale > than.scale + 1e-3
    || (Math.abs(fit.scale - than.scale) <= 1e-3 && fit.box.height < than.box.height - 1e-4))
  let best = fitTextAt(text, typography, box, region, size, options)
  if (full(best) && !tall(best)) return best
  if (columnWidth > box.width + 1e-4) {
    const column = widened(box, region, align, columnWidth)
    const fit = column ? fitTextAt(text, typography, column, region, size, options) : null
    if (fit && better(fit, best)) best = { ...fit, widened: true }
  }
  if (full(best)) return best
  const wide = widened(box, region, align)
  const fit = wide ? fitTextAt(text, typography, wide, region, size, options) : null
  return fit && better(fit, best) ? { ...fit, widened: true } : best
}

// Normalized title/subtitle areas of one terminal template slide (cached).
export function terminalTextAreas(report, slide, {
  titleBox,
  subtitleBox = null,
  titleStyle = {},
  subtitleStyle = {},
  excludeIds = [],
  cacheKey = null,
} = {}) {
  const title = finiteBox(titleBox)
  if (!title) return null
  const key = cacheKey && `${cacheKey}|${JSON.stringify(round4(title))}|${JSON.stringify(round4(finiteBox(subtitleBox)))}`
  let perReport = null
  if (key && report && typeof report === 'object') {
    perReport = cache.get(report) || new Map()
    cache.set(report, perReport)
    if (perReport.has(key)) return perReport.get(key)
  }
  const size = slideSizeOf(report, slide)
  const safe = safeAreaFor(report, slide)
  const inset = { x: 0.015, y: 0.015, width: 0.97, height: 0.97 }
  const bounds = intersect(safe, inset) || inset
  const obstacles = terminalObstacles(slide, { excludeIds })
  const subtitle = finiteBox(subtitleBox)
  // The subtitle/description stays inside the content margins + body slots
  // (plus its own slot): a full-height title slot elsewhere on the layout
  // must not let it run down to the slide edge.
  const bodySafe = bodySafeAreaFor(report, slide)
  const subtitleUnion = subtitle ? {
    x: Math.min(bodySafe.x, subtitle.x),
    y: Math.min(bodySafe.y, subtitle.y),
    width: Math.max(rightOf(bodySafe), rightOf(subtitle)) - Math.min(bodySafe.x, subtitle.x),
    height: Math.max(bottomOf(bodySafe), bottomOf(subtitle)) - Math.min(bodySafe.y, subtitle.y),
  } : null
  const subtitleBounds = (subtitleUnion && intersect(subtitleUnion, inset)) || bounds
  const titleFont = Number(titleStyle.typography?.size_pt) || 32
  const subtitleFont = Number(subtitleStyle.typography?.size_pt) || 16
  const titleArea = normalizeSlotBox(title, {
    obstacles,
    bounds,
    size,
    align: String(titleStyle.typography?.alignment || 'l').toLowerCase(),
    anchor: String(titleStyle.anchor || 't').toLowerCase(),
    minHeight: (titleFontFloor(titleFont) * 1.1) / size.height,
  })
  const result = {
    size,
    bounds: round4(bounds),
    obstacles: obstacles.map((item) => ({ id: item.id, kind: item.kind, box: round4(item.box) })),
    title: { slot: round4(title), ...titleArea, anchor: String(titleStyle.anchor || 't').toLowerCase(), typography: titleStyle.typography || {} },
    subtitle: subtitle ? {
      slot: round4(subtitle),
      anchor: String(subtitleStyle.anchor || 't').toLowerCase(),
      align: String(subtitleStyle.typography?.alignment || 'l').toLowerCase(),
      typography: subtitleStyle.typography || {},
      below: subtitle.y + subtitle.height / 2 >= title.y + title.height / 2,
    } : null,
    obstaclesForSubtitle: obstacles,
    boundsBox: bounds,
    subtitleBoundsBox: subtitleBounds,
  }
  result.capacity = simulateTerminalCapacity(result, { titleFont, subtitleFont })
  if (perReport) perReport.set(key, result)
  return result
}

// Lays out a real (or sample) title + subtitle in the normalized areas.
export function layoutTerminalText(areas, { title = '', subtitle = '' } = {}) {
  if (!areas?.title) return null
  const { size } = areas
  const gapY = GAP_PT / size.height
  const titleTypography = areas.title.typography || {}
  const titleFont = Number(titleTypography.size_pt) || 32
  const titleRegion = areas.title.region || areas.title.box
  const sub = areas.subtitle
  // The title may not run into the subtitle slot below it (unless the
  // template slot already did).
  const capBottom = sub?.below && subtitle
    ? Math.max(bottomOf(areas.title.box), sub.slot.y - gapY)
    : null
  const titleFit = fitText(title, titleTypography, areas.title.box, titleRegion, size, {
    anchor: areas.title.anchor,
    floor: titleFontFloor(titleFont),
    capBottom,
  })
  let subtitleFit = null
  if (sub && subtitle) {
    const subtitleTypography = sub.typography || {}
    const subtitleFont = Number(subtitleTypography.size_pt) || 16
    const inkObstacle = { box: titleFit.ink, kind: 'title', id: 'title' }
    const below = sub.below ? bottomOf(titleFit.ink) + gapY : null
    const area = normalizeSlotBox(sub.slot, {
      obstacles: [...areas.obstaclesForSubtitle, inkObstacle],
      bounds: areas.subtitleBoundsBox || areas.boundsBox,
      size,
      align: sub.align,
      anchor: sub.anchor,
      minHeight: (subtitleFontFloor(subtitleFont) * 1.2) / size.height,
      below,
    })
    const start = below != null && area.box.y < below ? { ...area.box, y: below } : area.box
    // Title column: the placed title box when the subtitle sits under it.
    const titleBox = titleFit.box
    const column = sub.below && Math.min(rightOf(titleBox), rightOf(start)) - Math.max(titleBox.x, start.x) > 0
      ? titleBox.width : 0
    subtitleFit = {
      ...fitSubtitleText(subtitle, subtitleTypography, start, area.region || area.box, size, {
        anchor: 't',
        floor: subtitleFontFloor(subtitleFont),
      }, { slotBottom: Math.max(bottomOf(sub.slot), bottomOf(start)), columnWidth: column }),
      reasons: area.reasons,
      region: area.region,
      noRegion: Boolean(area.noRegion),
    }
  }
  // No free place at all for a slot means the text would sit on an obstacle.
  return {
    title: titleFit,
    subtitle: subtitleFit,
    fits: titleFit.fits && !areas.title.noRegion && (!subtitleFit || (subtitleFit.fits && !subtitleFit.noRegion)),
  }
}

// Sample titles tell how long a title this template can take legibly.
export function simulateTerminalCapacity(areas, { withSubtitle = true } = {}) {
  const results = {}
  let fitsUpTo = null
  for (const [name, sample] of Object.entries(TERMINAL_TITLE_SAMPLES)) {
    const layout = layoutTerminalText(areas, { title: sample, subtitle: withSubtitle && areas.subtitle ? TERMINAL_SUBTITLE_SAMPLE : '' })
    results[name] = { fits: Boolean(layout?.fits), scale: Number((layout?.title.scale ?? 0).toFixed(2)) }
    if (layout?.fits) fitsUpTo = name
  }
  const maxChars = fitsUpTo ? TERMINAL_TITLE_SAMPLES[fitsUpTo].length : 0
  return { ...results, fitsUpTo, maxChars, label: fitsUpTo === 'long' ? 'any' : fitsUpTo ? `${fitsUpTo}_titles_only` : 'none' }
}

function writeGeometry(element, box, size) {
  element.geometry_norm = { ...(element.geometry_norm || {}), ...box }
  element.geometry_pt = {
    ...(element.geometry_pt || {}),
    x_pt: box.x * size.width,
    y_pt: box.y * size.height,
    width_pt: box.width * size.width,
    height_pt: box.height * size.height,
  }
}

function writeFont(element, font) {
  const current = Number(element.typography?.size_pt)
  if (!(current > 0) || Math.abs(current - font) < 0.05) return
  const typography = { ...element.typography, size_pt: font }
  if (Number(typography.line_height_pt) > 0) typography.line_height_pt = Number((typography.line_height_pt * font / current).toFixed(2))
  element.typography = typography
}

// Build time: move the real title/subtitle into the normalized areas.
export function applyTerminalTextAreas(report, slide, {
  titleIds = [],
  bodyIds = [],
  title = '',
  subtitle = '',
  cacheKey = null,
} = {}) {
  const elements = slide?.content_elements || []
  const titleElements = elements.filter((element) => titleIds.includes(element.element_id))
  const bodyElements = elements.filter((element) => bodyIds.includes(element.element_id))
  if (titleElements.length !== 1 || bodyElements.length > 1) return { slide, applied: false }
  const [titleElement] = titleElements
  const bodyElement = bodyElements[0] || null
  if (titleElement.text_group_id || bodyElement?.text_group_id) return { slide, applied: false }
  const areas = terminalTextAreas(report, slide, {
    titleBox: titleElement.geometry_norm,
    subtitleBox: bodyElement?.geometry_norm || null,
    titleStyle: { typography: titleElement.typography, anchor: titleElement.vertical_anchor },
    subtitleStyle: { typography: bodyElement?.typography, anchor: bodyElement?.vertical_anchor },
    excludeIds: [...titleIds, ...bodyIds],
    cacheKey,
  })
  if (!areas) return { slide, applied: false }
  const layout = layoutTerminalText(areas, { title: title || titleElement.text, subtitle: bodyElement ? (subtitle || bodyElement.text) : '' })
  const next = { ...slide, content_elements: elements.map((element) => ({ ...element })) }
  const size = areas.size
  const titleNext = next.content_elements.find((element) => element.element_id === titleElement.element_id)
  writeGeometry(titleNext, layout.title.box, size)
  writeFont(titleNext, layout.title.font)
  // Boxes are sized with conservative word-wrap metrics; later passes must not
  // tighten them back to an optimistic estimate.
  titleNext.text_area_normalized = true
  // The written box is the ink area itself (measured without padding), so
  // the renderer must not pad it again.
  if (titleNext.body_insets_pt) titleNext.body_insets_pt = { ...titleNext.body_insets_pt, left: 0, right: 0, top: 0, bottom: 0 }
  titleNext.text_area_scale = Number(layout.title.scale.toFixed(3))
  if (bodyElement && layout.subtitle) {
    const bodyNext = next.content_elements.find((element) => element.element_id === bodyElement.element_id)
    writeGeometry(bodyNext, layout.subtitle.box, size)
    writeFont(bodyNext, layout.subtitle.font)
    bodyNext.text_area_normalized = true
    if (bodyNext.body_insets_pt) bodyNext.body_insets_pt = { ...bodyNext.body_insets_pt, left: 0, right: 0, top: 0, bottom: 0 }
  }
  return {
    slide: next,
    applied: true,
    fits: layout.fits,
    capacity: areas.capacity,
    titleArea: { slot: areas.title.slot, box: layout.title.box, region: areas.title.region, reasons: areas.title.reasons, font: layout.title.font },
    subtitleArea: layout.subtitle ? { box: layout.subtitle.box, font: layout.subtitle.font, reasons: layout.subtitle.reasons } : null,
  }
}
