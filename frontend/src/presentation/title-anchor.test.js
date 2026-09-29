// Round 10: titles measured by their effective text rect (anchor growth,
// insets, wrap="none"), not the nominal frame.
import test from 'node:test'
import assert from 'node:assert/strict'
import { estimateTextInkHeightPt } from './separate-vertical-text.js'
import { detectLayoutIssues, measureTextInk, resolveSlideLayout } from './slide-hit-test.js'
import { textInkBand } from './title-gap.js'
import { effectiveTextRect, horizontalTextSpan, inheritVerticalAnchors, resolveVerticalAnchor } from './text-rect.js'
import { resolveTextWhiteSpace, verticalAnchorToJustifyContent } from '../slides/flex-layout.js'

const W = 960
const H = 540
const SIZE = { width: W, height: H }
const INSETS = { left: 7.2, right: 7.2, top: 3.6, bottom: 3.6 }
const LONG = 'Архитектура Flow: от загрузки шаблона до генерации презентаций'
const report = {
  layout: { content_margins: { left_norm: 0.05, right_norm: 0.05, top_norm: 0.05, bottom_norm: 0.05 } },
}

function title(anchor, geometry, value = LONG, extra = {}) {
  return {
    element_id: 'slide1_slide_text_100',
    kind: 'text',
    placeholder_type: 'title',
    text: value,
    ...(anchor ? { vertical_anchor: anchor } : {}),
    body_insets_pt: INSETS,
    geometry_norm: geometry,
    typography: { size_pt: 40, family: 'Arial', alignment: 'l', color: '#000000' },
    ...extra,
  }
}

function slideWith(elements, layers = []) {
  return {
    slide_number: 1,
    render: {
      slide_size_pt: SIZE,
      layers: [{ kind: 'fill', geometry_norm: { x: 0, y: 0, width: 1, height: 1 }, fill: { color: '#FFFFFF' } }, ...layers],
    },
    content_elements: elements,
  }
}

const codes = (issues) => issues.map((issue) => issue.code)
const box = { x: 0.05, y: 0.3, width: 0.5, height: 0.1 }

test('effective rect: top grows down, bottom grows up, middle both ways (insets included)', () => {
  const lines = estimateTextInkHeightPt(title('t', box), box.width * W)
  assert.ok(lines > box.height * H, 'the long title needs more than its frame')
  const top = effectiveTextRect(title('t', box), box, SIZE)
  const bottom = effectiveTextRect(title('b', box), box, SIZE)
  const middle = effectiveTextRect(title('ctr', box), box, SIZE)
  const frameTop = box.y * H
  const frameBottom = (box.y + box.height) * H
  assert.ok(Math.abs(top.y * H - (frameTop + 3.6)) < 0.01, 'top: first line under the top inset')
  assert.ok((top.y + top.height) * H > frameBottom, 'top: overflows downwards only')
  assert.ok(Math.abs((bottom.y + bottom.height) * H - (frameBottom - 3.6)) < 0.01, 'bottom: last line on the bottom inset')
  assert.ok(bottom.y * H < frameTop - 20, 'bottom: grows UP past the frame top')
  const upOverflow = frameTop - middle.y * H
  const downOverflow = (middle.y + middle.height) * H - frameBottom
  assert.ok(upOverflow > 5 && Math.abs(upOverflow - downOverflow) < 0.01, 'middle: grows both ways equally')
  for (const rect of [top, bottom, middle]) {
    assert.ok(Math.abs(rect.overflowPt - (lines - (box.height * H - 7.2))) < 0.01, 'overflow counts the vertical insets')
  }
  const ink = measureTextInk(title('b', box), box, SIZE)
  assert.ok(Math.abs(ink.y - bottom.y) < 1e-9 && ink.padTop > 0, 'hit-test ink is the effective rect')
  const band = textInkBand(title('b', box), SIZE)
  assert.ok(Math.abs(band.top - bottom.y) < 1e-9, 'title gap uses the effective rect too')
})

test('a single line that fits the frame but not frame minus insets overflows (renderer pads the box)', () => {
  const one = title('b', { x: 0.05, y: 0.3, width: 0.8, height: 46 / H }, 'Итоги')
  const ink = measureTextInk(one, one.geometry_norm, SIZE)
  assert.ok(ink.overflowPt > 5, `overflow ${ink.overflowPt}`)
  const noInsets = { ...one, body_insets_pt: { left: 0, right: 7.2, top: 3.6, bottom: 3.6 } }
  assert.ok(measureTextInk(noInsets, one.geometry_norm, SIZE).overflowPt <= 0.01, 'lIns=0 & rIns>0: the renderer drops insets')
})

test('hit-test catches a bottom-anchored title growing above the safe area; top/middle anchors differ', () => {
  const frame = { x: 0.05, y: 0.07, width: 0.5, height: 0.1 }
  const bottom = detectLayoutIssues(report, slideWith([title('b', frame)]), { titleIds: ['slide1_slide_text_100'] })
  const issue = bottom.issues.find((item) => item.code === 'title_outside_safe_area')
  assert.ok(issue, `issues ${codes(bottom.issues)}`)
  assert.equal(issue.anchor, 'b')
  const top = detectLayoutIssues(report, slideWith([title('t', frame)]), { titleIds: ['slide1_slide_text_100'] })
  assert.ok(!codes(top.issues).includes('title_outside_safe_area'), 'top anchor grows down, inside the safe area')
  const middle = detectLayoutIssues(report, slideWith([title('ctr', frame)]), { titleIds: ['slide1_slide_text_100'] })
  assert.ok(codes(middle.issues).includes('title_outside_safe_area'), 'middle anchor grows up as well')
})

test('bottom-anchored title does not grow up over layout art: reshaped downward into free space', () => {
  const art = { kind: 'image', decorative: true, layer_id: 'layout_pic_1', geometry_norm: { x: 0.05, y: 0.0, width: 0.3, height: 0.1 } }
  const frame = { x: 0.05, y: 0.12, width: 0.5, height: 0.1 }
  const { slide, validation } = resolveSlideLayout(report, slideWith([title('b', frame)], [art]), { titleIds: ['slide1_slide_text_100'] })
  assert.equal(validation.valid, true, JSON.stringify(validation.errors))
  const element = slide.content_elements[0]
  const ink = measureTextInk(element, element.geometry_norm, SIZE)
  assert.ok(ink.y * H >= 0.1 * H + 2, `ink top ${ink.y * H} must stay below the art (54pt)`)
  assert.ok(ink.overflowPt <= 2, 'the text fits its (reshaped) frame')
  assert.ok(element.geometry_norm.y + element.geometry_norm.height > frame.y + frame.height, 'frame grew downwards')
  assert.ok(!('__frame0_norm' in element), 'internal markers are removed')
})

test('bottom-anchored title with free space above grows up only to the safe area top, then down', () => {
  const frame = { x: 0.05, y: 0.12, width: 0.5, height: 0.1 }
  const { slide, validation } = resolveSlideLayout(report, slideWith([title('b', frame)]), { titleIds: ['slide1_slide_text_100'] })
  assert.equal(validation.valid, true, JSON.stringify(validation.errors))
  const element = slide.content_elements[0]
  const ink = measureTextInk(element, element.geometry_norm, SIZE)
  assert.ok(ink.y >= 0.05 - 1e-6, `ink top ${ink.y} inside the safe area`)
  assert.ok(Math.abs(element.geometry_norm.y - 0.05) < 0.002, 'grew up (its anchor side) as far as the safe area allows')
  assert.ok(ink.overflowPt <= 2 && element.typography.size_pt === 40, 'the rest of the height is taken below, no shrink needed')
})

test('a title that cannot fit between layout art and template text is rejected with a reason', () => {
  const art = { kind: 'image', decorative: true, layer_id: 'layout_pic_1', geometry_norm: { x: 0.05, y: 0.0, width: 0.6, height: 0.1 } }
  const footer = { kind: 'text', layer_id: 'layout_text_1', text: 'Footer', geometry_norm: { x: 0.05, y: 0.24, width: 0.6, height: 0.05 } }
  const frame = { x: 0.05, y: 0.12, width: 0.3, height: 0.1 }
  const text = `${LONG} ${LONG}`
  const body = {
    element_id: 'body', kind: 'text', synthetic: true, vertical_anchor: 't',
    text: 'Первый пункт списка с пояснением. Второй пункт списка с пояснением. Третий пункт списка.',
    geometry_norm: { x: 0.05, y: 0.3, width: 0.9, height: 0.6 },
    typography: { size_pt: 20, family: 'Arial', alignment: 'l', color: '#000000' },
  }
  const { slide, validation } = resolveSlideLayout(report, slideWith([body, title('b', frame, text)], [art, footer]), { titleIds: ['slide1_slide_text_100'] })
  assert.ok(slide.content_elements[1].geometry_norm.y < 0.3, 'the title is not shoved below the content')
  assert.equal(validation.valid, false)
  assert.ok(/text_overflow|title_outside_safe_area|title_over_layer/.test(validation.reject_reason), validation.reject_reason)
})

test('inherited anchor: typography or the donor placeholder decide, and the renderer gets it', () => {
  assert.equal(resolveVerticalAnchor({ typography: { vertical_anchor: 'bottom' } }), 'b')
  assert.equal(resolveVerticalAnchor({ vertical_anchor: 'middle' }), 'ctr')
  assert.equal(resolveVerticalAnchor({}), 't')
  const donorReport = {
    ...report,
    slides: { slides: [{ slide_number: 1, content_elements: [{ element_id: 'slide1_slide_text_100', kind: 'text', placeholder_type: 'title', vertical_anchor: 'b' }] }] },
  }
  const frame = { x: 0.05, y: 0.07, width: 0.5, height: 0.1 }
  const inherited = slideWith([title(null, frame)])
  inheritVerticalAnchors(donorReport, inherited)
  assert.equal(inherited.content_elements[0].vertical_anchor, 'b')
  const byPlaceholder = slideWith([{ ...title(null, frame), element_id: 'synthetic_title' }])
  inheritVerticalAnchors(donorReport, byPlaceholder)
  assert.equal(byPlaceholder.content_elements[0].vertical_anchor, 'b', 'same placeholder type on the donor')
  const { slide } = resolveSlideLayout(donorReport, slideWith([title(null, frame)]), { titleIds: ['slide1_slide_text_100'] })
  const element = slide.content_elements[0]
  assert.equal(element.vertical_anchor, 'b', 'written back so the renderer anchors the same way')
  assert.ok(measureTextInk(element, element.geometry_norm, SIZE).y >= 0.05 - 1e-6, 'and fitted inside the safe area')
  assert.equal(verticalAnchorToJustifyContent('bottom'), 'flex-end')
  assert.equal(verticalAnchorToJustifyContent('middle'), 'center')
})

test('wrap="none" does not wrap and grows sideways by alignment', () => {
  const frame = { x: 0.3, y: 0.3, width: 0.2, height: 0.1 }
  const line = (align) => title('t', frame, 'Очень длинная строка без переноса', { wrap: 'none', typography: { size_pt: 24, family: 'Arial', alignment: align } })
  const height = estimateTextInkHeightPt(line('l'), frame.width * W)
  assert.ok(Math.abs(height - 24 * 1.15) < 0.01, 'one line: wrap none never wraps')
  const left = horizontalTextSpan(line('l'), frame, SIZE)
  const right = horizontalTextSpan(line('r'), frame, SIZE)
  const centre = horizontalTextSpan(line('ctr'), frame, SIZE)
  assert.ok(left.words.noWrapOverflow && !left.words.wordTooWide)
  assert.ok(Math.abs(left.x - frame.x) < 1e-9 && left.x + left.width > frame.x + frame.width, 'left: grows right')
  assert.ok(Math.abs(right.x + right.width - (frame.x + frame.width)) < 1e-9 && right.x < frame.x, 'right: grows left')
  assert.ok(centre.x < frame.x && centre.x + centre.width > frame.x + frame.width, 'centre: grows both ways')
  assert.ok(Math.abs((frame.x - centre.x) - (centre.x + centre.width - frame.x - frame.width)) < 1e-9)
  assert.equal(resolveTextWhiteSpace('a b', 'none'), 'pre')
  assert.equal(resolveTextWhiteSpace('a b'), 'normal')
})

test('wrap="none" title is widened by alignment into free space (or shrunk), then fits', () => {
  const frame = { x: 0.4, y: 0.3, width: 0.2, height: 0.1 }
  const element = title('t', frame, 'Очень длинная строка без переноса', { wrap: 'none', typography: { size_pt: 24, family: 'Arial', alignment: 'r' } })
  const { slide, validation } = resolveSlideLayout(report, slideWith([element]), { titleIds: ['slide1_slide_text_100'] })
  assert.equal(validation.valid, true, JSON.stringify(validation.errors))
  const out = slide.content_elements[0]
  const span = horizontalTextSpan(out, out.geometry_norm, SIZE)
  assert.ok(!span.words.noWrapOverflow, 'the line fits its frame now')
  assert.ok(Math.abs(out.geometry_norm.x + out.geometry_norm.width - (frame.x + frame.width)) < 0.002, 'right edge kept (right-aligned)')
})
