// Text width and word-wrap estimate shared by the hit-test and the text
// fitters. It wraps the way the slide renderer does after this change
// (`word-break: normal; overflow-wrap: normal; hyphens: manual`): lines break
// only at spaces and after a hyphen/dash, never inside a word; no-break spaces
// (U+00A0, U+202F) and the non-breaking hyphen (U+2011) glue.
//
// Widths come from per-character advance tables generated from the actual
// font files (text-metrics-data.js). The assembly runs in a web worker where
// the template fonts are not loaded, so canvas measureText there would measure
// the fallback font; the tables are deterministic in node and the browser.
// Fonts that the app does not serve may still be installed on the viewer's
// machine, so for those the wider of the family table and Arial is used.
import { TEXT_METRIC_CHARS, TEXT_METRIC_FONTS } from './text-metrics-data.js'

const CHAR_INDEX = new Map([...TEXT_METRIC_CHARS].map((char, index) => [char, index]))
const BREAK_SPACE = /[ \t\u1680\u2000-\u200A\u200B\u205F\u3000]/
const BREAK_AFTER = new Set(['-', '\u2010', '\u2012', '\u2013', '\u2014'])
const WIDTH_SAFETY = 1.01
export const ORPHAN_MAX_CHARS = 2

const parsedTables = new Map()
function fontTable(key) {
  if (!parsedTables.has(key)) {
    const font = TEXT_METRIC_FONTS[key]
    parsedTables.set(key, font ? { fallback: font.fallback, widths: font.widths.split(',').map(Number) } : null)
  }
  return parsedTables.get(key)
}

const WEIGHTS = ['extralight', 'light', 'medium', 'semibold', 'demibold', 'extrabold', 'black', 'bold']

function weightOf(family, bold) {
  const compact = family.replace(/[\s_-]+/g, '')
  const named = WEIGHTS.find((weight) => compact.includes(weight))
  if (named) return named
  return bold ? 'bold' : 'regular'
}

// Table keys for a typography: [family table, (Arial when the family is not served)].
export function fontTableKeys(typography = {}) {
  const family = String(typography?.family || '').toLowerCase()
  const weight = weightOf(family, Boolean(typography?.bold))
  const pick = (base, map) => {
    const suffix = map[weight] ?? map.regular
    return suffix ? `${base}-${suffix}` : base
  }
  const arial = ['bold', 'semibold', 'demibold', 'extrabold', 'black'].includes(weight) ? 'arial-bold' : 'arial'
  if (/\bplay\b|vk\s*sans/.test(family)) {
    // Served by the app (fonts/font-aliases.json: Play -> VK Sans Display).
    return [pick('vk-sans-display', { regular: '', medium: 'medium', semibold: 'demibold', demibold: 'demibold', bold: 'bold', extrabold: 'bold', black: 'bold', light: '', extralight: '' })]
  }
  if (/consolas|mono|courier/.test(family)) return [weight === 'regular' ? 'consolas' : 'consolas-bold']
  if (/montserrat|raleway|gilroy|gotham|proxima/.test(family)) {
    // Montserrat files are in app/fonts; geometric families without files
    // (Raleway, Gilroy…) are approximated by Montserrat of the same weight.
    return [pick('montserrat', { regular: '', extralight: 'extralight', light: 'light', medium: 'medium', semibold: 'semibold', demibold: 'semibold', bold: 'bold', extrabold: 'extrabold', black: 'black' }), arial]
  }
  return [arial]
}

const mergedTables = new Map()
function tableFor(typography) {
  const keys = fontTableKeys(typography)
  const id = keys.join('+')
  if (!mergedTables.has(id)) {
    const tables = keys.map(fontTable).filter(Boolean)
    const widths = TEXT_METRIC_CHARS.length
    const merged = { id, fallback: Math.max(...tables.map((table) => table.fallback)), widths: new Array(widths) }
    for (let index = 0; index < widths; index += 1) {
      merged.widths[index] = Math.max(...tables.map((table) => (table.widths[index] >= 0 ? table.widths[index] : table.fallback)))
    }
    mergedTables.set(id, merged)
  }
  return mergedTables.get(id)
}

function charWidth(table, char) {
  const index = CHAR_INDEX.get(char)
  if (index != null) return table.widths[index]
  const code = char.codePointAt(0)
  if (code >= 0x2e80) return 1000
  if (code >= 0x0300 && code <= 0x036f) return 0
  return table.fallback
}

export function measureTextWidthPt(text, fontPt, typography = {}) {
  const table = tableFor(typography)
  let units = 0
  for (const char of String(text || '')) units += charWidth(table, char)
  return units / 1000 * fontPt * WIDTH_SAFETY
}

// Unbreakable pieces of a paragraph: [{ text, width, space }] where `space`
// is the width of the breakable whitespace before the piece (0 = glued to the
// previous piece after a hyphen/dash).
function pieces(paragraph, fontPt, typography, offset = 0) {
  const table = tableFor(typography)
  const scale = fontPt / 1000 * WIDTH_SAFETY
  const spaceWidth = charWidth(table, ' ') * scale
  const out = []
  let current = ''
  let width = 0
  let pendingSpace = 0
  let spaceStart = -1
  let spaceEnd = -1
  let position = offset
  const flush = (nextSpace) => {
    if (current) out.push({ text: current, width, space: pendingSpace, spaceStart: pendingSpace ? spaceStart : -1, spaceEnd })
    current = ''
    width = 0
    pendingSpace = nextSpace
  }
  const chars = [...paragraph]
  chars.forEach((char, index) => {
    const at = position
    position += char.length
    if (BREAK_SPACE.test(char)) {
      if (current) {
        flush(spaceWidth)
        spaceStart = at
      } else {
        pendingSpace = out.length ? spaceWidth : 0
        if (spaceStart < 0 || spaceEnd !== at) spaceStart = at
      }
      spaceEnd = at + char.length
      return
    }
    current += char
    width += charWidth(table, char) * scale
    const next = chars[index + 1]
    if (BREAK_AFTER.has(char) && current.length > 1 && next && !BREAK_SPACE.test(next)) flush(0)
  })
  flush(0)
  return out
}

const WRAP_CACHE_LIMIT = 20000
const wrapCache = new Map()

// Greedy line breaking like the browser. Returns the lines plus the checks the
// hit-test needs: a piece wider than the box (it would overflow sideways — the
// renderer no longer breaks inside words) and orphan lines of 1–2 characters.
export function wrapText(text, widthPt, fontPt, typography = {}) {
  const source = String(text ?? '')
  const key = `${tableFor(typography).id}|${Number(fontPt).toFixed(2)}|${Number(widthPt).toFixed(1)}|${source}`
  const cached = wrapCache.get(key)
  if (cached) return cached
  const lines = []
  let longestPiecePt = 0
  let longestPiece = ''
  let overflowWord = false
  const orphans = []
  let paragraphOffset = 0
  for (const paragraph of source.split('\n')) {
    const parts = pieces(paragraph, fontPt, typography, paragraphOffset)
    paragraphOffset += paragraph.length + 1
    const start = lines.length
    let line = null
    for (const part of parts) {
      if (part.width > longestPiecePt) {
        longestPiecePt = part.width
        longestPiece = part.text
      }
      if (part.width > widthPt + 0.5) overflowWord = true
      if (line && line.width + part.space + part.width <= widthPt + 0.5) {
        line.text += (part.space ? ' ' : '') + part.text
        line.width += part.space + part.width
        line.pieces.push(part.text)
      } else {
        if (line) lines.push(line)
        line = { text: part.text, width: part.width, pieces: [part.text], breakStart: part.spaceStart, breakEnd: part.spaceEnd }
      }
    }
    lines.push(line || { text: '', width: 0, pieces: [] })
    const paragraphLines = lines.slice(start)
    if (paragraphLines.length > 1) {
      paragraphLines.forEach((item, index) => {
        const visible = item.text.replace(/[\s\u00a0\u202f]/g, '')
        if (visible.length > 0 && visible.length <= ORPHAN_MAX_CHARS) orphans.push({ line: start + index, text: item.text })
      })
    }
  }
  const result = {
    lines: lines.map((item) => ({ text: item.text, widthPt: item.width, breakStart: item.breakStart ?? -1, breakEnd: item.breakEnd ?? -1 })),
    lineCount: lines.length,
    widestPt: Math.max(0, ...lines.map((item) => Math.min(item.width, Math.max(widthPt, item.width)))),
    longestPiecePt,
    longestPiece,
    overflowWord,
    orphans,
  }
  if (wrapCache.size >= WRAP_CACHE_LIMIT) wrapCache.clear()
  wrapCache.set(key, result)
  return result
}

// Body insets as the renderer applies them (mirrors shouldApplyBodyInsetsPt in
// slides/slide-metrics.js: all insets are dropped when lIns=0 and rIns>0).
export function bodyInsetsPt(element) {
  const insets = element?.body_insets_pt || {}
  const left = Number(insets.left) || 0
  const right = Number(insets.right) || 0
  const top = Number(insets.top) || 0
  const bottom = Number(insets.bottom) || 0
  if (!(left || right || top || bottom) || (left === 0 && right > 0)) return { left: 0, right: 0, top: 0, bottom: 0 }
  return { left, right, top, bottom }
}

// Horizontal text area of an element box: box width minus body insets.
export function textAreaWidthPt(element, boxWidthPt) {
  const insets = bodyInsetsPt(element)
  const inner = boxWidthPt - insets.left - insets.right
  return Math.max(1, inner)
}

// Glue an orphan line to the word before it with a no-break space (the
// renderer then carries that word over together with the orphan). Returns the
// new text, or null when gluing is impossible or would overflow sideways.
// With allowOverflow the glued word may be wider than the box: the hit-test
// then widens the box or shrinks the font (a word too wide is still an error).
export function glueOrphans(text, widthPt, fontPt, typography = {}, { allowOverflow = false } = {}) {
  let current = String(text ?? '')
  let changed = false
  for (let pass = 0; pass < 4; pass += 1) {
    const wrap = wrapText(current, widthPt, fontPt, typography)
    const orphan = wrap.orphans[0]
    if (!orphan) return changed ? current : null
    const line = wrap.lines[orphan.line]
    // A first line that is an orphan glues forward: to the break after it.
    const target = line.breakStart >= 0 ? line : wrap.lines[orphan.line + 1]
    if (!target || target.breakStart < 0) return null
    const next = `${current.slice(0, target.breakStart)}\u00a0${current.slice(target.breakEnd)}`
    if (!allowOverflow && wrapText(next, widthPt, fontPt, typography).overflowWord) return null
    current = next
    changed = true
  }
  return changed && !wrapText(current, widthPt, fontPt, typography).orphans.length ? current : null
}
