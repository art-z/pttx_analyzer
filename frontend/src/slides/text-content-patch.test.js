import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  applyTextContentToElements,
  isolateSlideTextContent,
  patchSlideTextContent,
  splitContentParagraphs,
} from './text-content-patch.js'
import { findSlideDescriptionElements } from './slide-description-detect.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const spatialReportPath = path.resolve(__dirname, '../../../output/b13e9370de41/report.json')

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

test('splitContentParagraphs treats blank lines and bullet prefixes', () => {
  assert.deepEqual(splitContentParagraphs('Один абзац'), ['Один абзац'])
  assert.deepEqual(splitContentParagraphs('• первый\n• второй'), ['первый', 'второй'])
  assert.deepEqual(splitContentParagraphs('первый\n\nвторой'), ['первый', 'второй'])
})

test('applyTextContentToElements maps one paragraph to one list slot on slide 24', () => {
  if (!fs.existsSync(spatialReportPath)) return

  const report = JSON.parse(fs.readFileSync(spatialReportPath, 'utf8'))
  const slide = clone(report.slides.slides.find((item) => item.slide_number === 24))
  const detected = findSlideDescriptionElements(slide, report)
  const text = 'Один абзац без списка.'

  const patched = applyTextContentToElements(slide, detected.elementIds, text)
  const elements = patched.content_elements.filter((element) => detected.elementIds.includes(element.element_id))

  assert.equal(elements.length, 1)
  assert.equal(elements[0].text, text)
})

test('applyTextContentToElements maps multiple paragraphs to list slots', () => {
  if (!fs.existsSync(spatialReportPath)) return

  const report = JSON.parse(fs.readFileSync(spatialReportPath, 'utf8'))
  const slide = clone(report.slides.slides.find((item) => item.slide_number === 24))
  const detected = findSlideDescriptionElements(slide, report)
  const text = 'Первый пункт\nВторой пункт'

  const patched = applyTextContentToElements(slide, detected.elementIds, text)
  const elements = patched.content_elements.filter((element) => detected.elementIds.includes(element.element_id))

  assert.deepEqual(elements.map((element) => element.text), ['Первый пункт', 'Второй пункт'])
})

test('isolateSlideTextContent clears template text outside component slots', () => {
  if (!fs.existsSync(spatialReportPath)) return

  const report = JSON.parse(fs.readFileSync(spatialReportPath, 'utf8'))
  const slide = clone(report.slides.slides.find((item) => item.slide_number === 24))
  const detected = findSlideDescriptionElements(slide, report)
  const keepIds = detected.elementIds.slice(0, 1)

  const isolated = isolateSlideTextContent(slide, { keepElementIds: keepIds })
  const kept = isolated.content_elements.filter((element) => keepIds.includes(element.element_id))
  const cleared = isolated.content_elements.filter((element) => (
    element.kind === 'text' && !keepIds.includes(element.element_id)
  ))

  assert.ok(kept.every((element) => element.text))
  assert.ok(cleared.every((element) => !element.text))
})

test('patchSlideTextContent isolates and applies content together', () => {
  if (!fs.existsSync(spatialReportPath)) return

  const report = JSON.parse(fs.readFileSync(spatialReportPath, 'utf8'))
  const slide = clone(report.slides.slides.find((item) => item.slide_number === 24))
  const detected = findSlideDescriptionElements(slide, report)
  const text = 'Только один абзац.'

  const patched = patchSlideTextContent(slide, {
    elementIds: detected.elementIds,
    text,
    isolate: true,
    keepElementIds: detected.elementIds,
  })

  const descriptionElements = patched.content_elements.filter((element) => (
    detected.elementIds.includes(element.element_id)
  ))
  const otherTextElements = patched.content_elements.filter((element) => (
    element.kind === 'text' && !detected.elementIds.includes(element.element_id)
  ))

  assert.equal(descriptionElements.filter((element) => element.text).length, 1)
  assert.equal(descriptionElements.find((element) => element.text)?.text, text)
  assert.ok(otherTextElements.every((element) => !element.text))
})
