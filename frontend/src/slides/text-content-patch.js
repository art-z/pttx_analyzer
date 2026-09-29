import { isCodeTextElement, typographRussianText } from './text-typographer.js'

const LEADING_BULLET_RE = /^[•\-\*\u2022\u2013\u2014]\s*/

export function stripLeadingBullet(text) {
  return String(text || '').replace(LEADING_BULLET_RE, '').trim()
}

export function splitContentParagraphs(text) {
  const raw = String(text || '').trim()
  if (!raw) return []

  if (/\n\n/.test(raw)) {
    return raw
      .split(/\n\n+/)
      .map((line) => stripLeadingBullet(line))
      .filter(Boolean)
  }

  const lines = raw.split(/\n/).map((line) => line.trim()).filter(Boolean)
  if (lines.length <= 1) return [stripLeadingBullet(raw)]

  return lines.map((line) => stripLeadingBullet(line))
}

export function clearTextElementContent(element) {
  const cleared = {
    ...element,
    text: '',
    text_sample: '',
  }

  if (element.text_paragraphs?.length) {
    cleared.text_paragraphs = element.text_paragraphs.map((paragraph) => ({
      ...paragraph,
      text: '',
    }))
  }

  if (element.text_runs?.length) {
    cleared.text_runs = element.text_runs.map((run) => ({
      ...run,
      text: run?.break ? run.text : '',
    }))
  }

  return cleared
}

export function isolateSlideTextContent(slide, { keepElementIds = [] } = {}) {
  const keep = new Set(keepElementIds.filter(Boolean))
  return {
    ...slide,
    content_elements: (slide.content_elements || []).map((element) => {
      if (element.kind !== 'text') return element
      if (keep.has(element.element_id)) return element
      return clearTextElementContent(element)
    }),
  }
}

export function isolateSlideMetricPreview(slide, { keepElementIds = [] } = {}) {
  const keep = new Set(keepElementIds.filter(Boolean))
  return {
    ...slide,
    content_elements: (slide.content_elements || []).filter((element) => keep.has(element.element_id)),
  }
}

function parseLineIndex(elementId) {
  const match = String(elementId || '').match(/_line_(\d+)(?:_|$)/)
  return match ? Number(match[1]) : null
}

function sortTextElements(elements) {
  return [...elements].sort((left, right) => {
    const leftY = left.geometry_norm?.y ?? 0
    const rightY = right.geometry_norm?.y ?? 0
    if (Math.abs(leftY - rightY) > 0.002) return leftY - rightY

    const leftX = left.geometry_norm?.x ?? 0
    const rightX = right.geometry_norm?.x ?? 0
    if (Math.abs(leftX - rightX) > 0.002) return leftX - rightX

    const leftLine = parseLineIndex(left.element_id)
    const rightLine = parseLineIndex(right.element_id)
    if (leftLine != null && rightLine != null) return leftLine - rightLine

    return String(left.element_id).localeCompare(String(right.element_id))
  })
}

function isListSlotElement(element) {
  return Boolean(element?.bullet && element.bullet.kind !== 'none')
}

function pickPrimaryBlockElement(elements) {
  const withParagraphs = elements.find((element) => element.text_paragraphs?.length > 1)
  if (withParagraphs) return withParagraphs

  return [...elements].sort((left, right) => (
    (right.geometry_norm?.width || 0) - (left.geometry_norm?.width || 0)
  ))[0] || elements[0]
}

function cloneParagraphStyle(templateParagraphs, index) {
  const source = templateParagraphs?.[index] ?? templateParagraphs?.[0] ?? {}
  return {
    ...source,
    text: '',
    paragraph_spacing_pt: { ...(source.paragraph_spacing_pt || {}) },
  }
}

function applyBlockContent(element, paragraphs) {
  if (!paragraphs.length) return clearTextElementContent(element)

  const templateParagraphs = element.text_paragraphs?.length
    ? element.text_paragraphs
    : [{ text: element.text || '', paragraph_spacing_pt: element.paragraph_spacing_pt || {} }]

  if (paragraphs.length === 1 && templateParagraphs.length <= 1) {
    const text = paragraphs[0]
    return {
      ...element,
      text,
      text_sample: text,
      text_runs: [],
      text_paragraphs: element.text_paragraphs?.length
        ? [{ ...element.text_paragraphs[0], text }]
        : element.text_paragraphs,
    }
  }

  const textParagraphs = paragraphs.map((text, index) => ({
    ...cloneParagraphStyle(templateParagraphs, index),
    text,
  }))
  const combinedText = paragraphs.join('\n')

  return {
    ...element,
    text: combinedText,
    text_sample: combinedText,
    text_paragraphs: textParagraphs,
    text_runs: [],
  }
}

export function replaceTextElementContent(element, text) {
  const value = String(text || '')
  return applyBlockContent(element, splitContentParagraphs(
    isCodeTextElement(element) ? value : typographRussianText(value),
  ))
}

function applyListSlotContent(element, text) {
  const cleaned = stripLeadingBullet(text)
  if (!cleaned) return clearTextElementContent(element)
  return { ...element, text: cleaned, text_sample: cleaned, text_runs: [] }
}

export function applyTextContentToElements(slide, elementIds, text) {
  const rawText = String(text || '').trim()
  const idSet = new Set(elementIds || [])
  const targets = sortTextElements(
    (slide.content_elements || []).filter((element) => (
      idSet.has(element.element_id) && element.kind === 'text'
    )),
  )

  if (!targets.length) return slide

  const trimmed = targets.every(isCodeTextElement) ? rawText : typographRussianText(rawText)

  const updates = new Map()
  const removeIds = new Set()

  if (!trimmed) {
    for (const element of targets) {
      updates.set(element.element_id, clearTextElementContent(element))
    }
    return {
      ...slide,
      content_elements: (slide.content_elements || []).map((element) => (
        updates.has(element.element_id) ? updates.get(element.element_id) : element
      )),
    }
  }

  const paragraphs = splitContentParagraphs(trimmed)
  const listSlots = targets.filter(isListSlotElement)
  const allListSlots = listSlots.length > 0 && listSlots.length === targets.length

  if (allListSlots) {
    targets.forEach((element, index) => {
      if (index < paragraphs.length) {
        updates.set(element.element_id, applyListSlotContent(element, paragraphs[index]))
      } else {
        removeIds.add(element.element_id)
      }
    })
  } else if (paragraphs.length === 1) {
    const primary = pickPrimaryBlockElement(targets)
    for (const element of targets) {
      if (element.element_id === primary.element_id) {
        updates.set(element.element_id, applyBlockContent(element, paragraphs))
      } else {
        updates.set(element.element_id, clearTextElementContent(element))
      }
    }
  } else if (targets.length === 1) {
    updates.set(targets[0].element_id, applyBlockContent(targets[0], paragraphs))
  } else {
    targets.forEach((element, index) => {
      if (index < paragraphs.length) {
        updates.set(element.element_id, applyBlockContent(element, [paragraphs[index]]))
      } else {
        updates.set(element.element_id, clearTextElementContent(element))
      }
    })
  }

  return {
    ...slide,
    content_elements: (slide.content_elements || [])
      .filter((element) => !removeIds.has(element.element_id))
      .map((element) => (
        updates.has(element.element_id) ? updates.get(element.element_id) : element
      )),
  }
}

export function patchSlideTextContent(slide, {
  elementIds = [],
  text = '',
  isolate = false,
  keepElementIds = null,
} = {}) {
  let next = slide
  const keepIds = keepElementIds || elementIds

  if (isolate && keepIds.length) {
    next = isolateSlideTextContent(next, { keepElementIds: keepIds })
  }

  if (!elementIds.length) return next
  return applyTextContentToElements(next, elementIds, text)
}
