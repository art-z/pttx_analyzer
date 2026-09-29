import test from 'node:test'
import assert from 'node:assert/strict'

import { estimateTextInkHeightPt, separateVerticalText } from './separate-vertical-text.js'

test('repeat card text and plaque move as one unit when clearing a title', () => {
  const heading = text('slide-title', 0.2, { role: 'title', width: 0.4, height: 0.15,
    size_pt: 32, text: 'Длинный заголовок карточного слайда занимает несколько строк' })
  const cardText = text('card-text__repeat_1', 0.27, { text: 'Подпись карточки' })
  const plaque = {
    element_id: 'card-fill__repeat_1', kind: 'fill',
    geometry_norm: { x: 0.08, y: 0.25, width: 0.46, height: 0.14 },
    geometry_pt: { x_pt: 76.8, y_pt: 135, width_pt: 441.6, height_pt: 75.6 },
  }
  const slide = { render: { slide_size_pt: { width: 960, height: 540 } },
    content_elements: [heading, cardText, plaque] }
  separateVerticalText(slide)
  const textShift = cardText.geometry_norm.y - 0.27
  const fillShift = plaque.geometry_norm.y - 0.25
  assert.ok(textShift > 0)
  assert.ok(Math.abs(textShift - fillShift) < 0.00001)
})

function inkTop(element) {
  const box = element.geometry_norm
  const ink = estimateTextInkHeightPt(element, box.width * 960) / 540
  if (element.vertical_anchor === 'b') return box.y + box.height - ink
  if (element.vertical_anchor === 'ctr') return box.y + (box.height - ink) / 2
  return box.y
}

function text(id, y, extra = {}) {
  return {
    element_id: id,
    kind: 'text',
    text: extra.text || 'Короткий текст',
    role: extra.role || 'body',
    vertical_anchor: extra.vertical_anchor,
    geometry_norm: {
      x: extra.x ?? 0.1,
      y,
      width: extra.width ?? 0.4,
      height: extra.height ?? 0.08,
    },
    geometry_pt: {
      x_pt: (extra.x ?? 0.1) * 960,
      y_pt: y * 540,
      width_pt: (extra.width ?? 0.4) * 960,
      height_pt: (extra.height ?? 0.08) * 540,
    },
    typography: { size_pt: extra.size_pt || 18 },
    text_group_id: extra.text_group_id,
    text_group_geometry_norm: extra.group,
    text_group_geometry_pt: extra.group
      ? {
        x_pt: extra.group.x * 960,
        y_pt: extra.group.y * 540,
        width_pt: extra.group.width * 960,
        height_pt: extra.group.height * 540,
      }
      : undefined,
    text_group_spacing_pt: extra.spacing,
  }
}

test('a bottom-anchored title that grows off the top is lowered before the body moves', () => {
  const slide = {
    render: { slide_size_pt: { width: 960, height: 540 } },
    content_elements: [
      text('heading', 0.02, {
        role: 'title',
        vertical_anchor: 'b',
        size_pt: 32,
        width: 0.72,
        height: 0.08,
        text: 'Длинный заголовок, который занимает много строк и растёт снизу вверх',
      }),
      text('body', 0.12, {
        size_pt: 16,
        width: 0.72,
        text: 'Текст под заголовком',
      }),
    ],
  }
  const report = { layout: { content_margins: { top_norm: 0.04 } } }

  assert.ok(inkTop(slide.content_elements[0]) < 0)
  separateVerticalText(slide, report)

  const heading = slide.content_elements[0]
  const body = slide.content_elements[1]
  const headingInk = inkTop(heading)
  const headingInkBottom = headingInk + (
    estimateTextInkHeightPt(heading, heading.geometry_norm.width * 960) / 540
  )

  assert.ok(headingInk + 0.002 >= 0.04)
  assert.ok(body.geometry_norm.y + 0.002 >= headingInkBottom)
  assert.ok(heading.geometry_pt.y_pt >= heading.geometry_norm.y * 540 - 0.2)
})

test('a lone title that sticks out the top is lowered to the safe edge', () => {
  const slide = {
    render: { slide_size_pt: { width: 960, height: 540 } },
    content_elements: [
      text('heading', 0.02, {
        role: 'title',
        vertical_anchor: 'b',
        size_pt: 32,
        width: 0.72,
        height: 0.08,
        text: 'Длинный заголовок, который занимает много строк и растёт снизу вверх',
      }),
    ],
  }

  assert.ok(inkTop(slide.content_elements[0]) < 0)
  separateVerticalText(slide, { layout: { content_margins: { top_norm: 0.04 } } })

  assert.ok(inkTop(slide.content_elements[0]) + 0.002 >= 0.04)
})

test('lower text moves below the heading ink and stays on the slide', () => {
  const slide = {
    render: { slide_size_pt: { width: 960, height: 540 } },
    content_elements: [
      text('heading', 0.1, {
        role: 'title',
        size_pt: 28,
        width: 0.35,
        text: 'Длинный заголовок слайда, который занимает две строки',
      }),
      text('body', 0.12, {
        size_pt: 16,
        text: 'Абзац под заголовком',
      }),
    ],
  }

  separateVerticalText(slide)
  const heading = slide.content_elements[0]
  const body = slide.content_elements[1]
  const headingInk = heading.geometry_norm.y + (
    estimateTextInkHeightPt(heading, heading.geometry_norm.width * 960) / 540
  )

  assert.ok(body.geometry_norm.y + 0.001 >= headingInk)
  assert.ok(body.geometry_norm.y + body.geometry_norm.height <= 1)
  assert.ok(body.geometry_pt.y_pt >= body.geometry_norm.y * 540 - 0.1)
  assert.equal(heading.geometry_norm.y, 0.1)
})

test('side by side text stays in place', () => {
  const slide = {
    content_elements: [
      text('left', 0.2, { x: 0.08, width: 0.3, text: 'Левая колонка' }),
      text('right', 0.2, { x: 0.62, width: 0.3, text: 'Правая колонка' }),
    ],
  }

  separateVerticalText(slide)

  assert.equal(slide.content_elements[0].geometry_norm.y, 0.2)
  assert.equal(slide.content_elements[1].geometry_norm.y, 0.2)
})

test('text already at the bottom is not pushed off the slide', () => {
  const slide = {
    content_elements: [
      text('heading', 0.7, {
        size_pt: 32,
        width: 0.3,
        height: 0.12,
        text: 'Очень длинный заголовок, который не помещается в одну строку и занимает несколько',
      }),
      text('body', 0.9, { height: 0.08, text: 'Нижний абзац' }),
    ],
  }

  separateVerticalText(slide)
  const body = slide.content_elements[1]

  assert.ok(body.geometry_norm.y + body.geometry_norm.height <= 1)
})

test('a text group moves together', () => {
  const group = { x: 0.1, y: 0.16, width: 0.5, height: 0.16 }
  const slide = {
    content_elements: [
      text('title', 0.08, {
        role: 'title',
        size_pt: 28,
        width: 0.4,
        height: 0.08,
        text: 'Длинный заголовок слайда, который занимает две строки',
      }),
      text('card-heading', 0.16, {
        text_group_id: 'card',
        group,
        spacing: { flex_stack_direction: 'column', line_gap_pt: 4 },
        text: 'Карточка',
      }),
      text('card-body', 0.24, {
        text_group_id: 'card',
        group,
        spacing: { flex_stack_direction: 'column', line_gap_pt: 4 },
        text: 'Описание карточки',
      }),
    ],
  }

  separateVerticalText(slide)
  const heading = slide.content_elements[1]
  const body = slide.content_elements[2]

  assert.ok(heading.text_group_geometry_norm.y > group.y)
  assert.ok(Math.abs((heading.geometry_norm.y - body.geometry_norm.y) - (0.16 - 0.24)) < 0.0001)
  assert.equal(
    heading.text_group_geometry_pt.y_pt,
    heading.text_group_geometry_norm.y * 540,
  )
})

test('a tight text group grows so both lines fit', () => {
  const group = { x: 0.1, y: 0.3, width: 0.4, height: 0.05 }
  const slide = {
    render: { slide_size_pt: { width: 960, height: 540 } },
    content_elements: [
      text('value', 0.3, {
        text_group_id: 'metric',
        group,
        spacing: { flex_stack_direction: 'column', line_gap_pt: 4 },
        size_pt: 28,
        height: 0.04,
        text: '128',
      }),
      text('caption', 0.32, {
        text_group_id: 'metric',
        group,
        spacing: { flex_stack_direction: 'column', line_gap_pt: 4 },
        size_pt: 14,
        height: 0.03,
        text: 'заявок в неделю',
      }),
    ],
  }

  separateVerticalText(slide)
  const box = slide.content_elements[0].text_group_geometry_norm
  const valueInk = estimateTextInkHeightPt(slide.content_elements[0], 0.4 * 960) / 540
  const captionInk = estimateTextInkHeightPt(slide.content_elements[1], 0.4 * 960) / 540

  assert.ok(box.height + 0.001 >= valueInk + captionInk)
  assert.ok(box.y + box.height <= 1)
  assert.equal(slide.content_elements[1].text_group_geometry_norm.height, box.height)
})

test('text that covers a photo moves below it', () => {
  const slide = {
    render: { slide_size_pt: { width: 960, height: 540 } },
    content_elements: [
      text('body', 0.4, {
        x: 0.1,
        width: 0.6,
        height: 0.08,
        text: 'Описание поверх фото',
      }),
      {
        element_id: 'photo',
        kind: 'image',
        geometry_norm: { x: 0.45, y: 0.42, width: 0.4, height: 0.2 },
      },
    ],
  }

  separateVerticalText(slide)
  const body = slide.content_elements[0]

  assert.ok(body.geometry_norm.y + 0.001 >= 0.62)
  assert.equal(slide.content_elements[1].geometry_norm.y, 0.42)
})

test('synthetic text that cannot clear a photo is dropped', () => {
  const slide = {
    render: { slide_size_pt: { width: 960, height: 540 } },
    content_elements: [
      {
        ...text('body', 0.7, {
          x: 0.1,
          width: 0.7,
          height: 0.12,
          text: 'Некуда поставить',
        }),
        synthetic: true,
      },
      {
        element_id: 'photo',
        kind: 'image',
        geometry_norm: { x: 0.2, y: 0.72, width: 0.6, height: 0.26 },
      },
    ],
  }

  separateVerticalText(slide)

  assert.equal(slide.content_elements.some((element) => element.element_id === 'body'), false)
  assert.equal(slide.content_elements[0].element_id, 'photo')
})
