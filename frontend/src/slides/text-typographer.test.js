import test from 'node:test'
import assert from 'node:assert/strict'

import { typographRussianText, typographSlideSpec, typographSlideText } from './text-typographer.js'
import { patchSlideTextContent } from './text-content-patch.js'

test('short Russian words stay with the following word without crossing a line break', () => {
  const source = 'Данные и метрики в отчёте\nно не в коде'
  const expected = 'Данные и\u00a0метрики в\u00a0отчёте\nно\u00a0не\u00a0в\u00a0коде'
  assert.equal(typographRussianText(source), expected)
  assert.equal(typographRussianText(expected), expected)
  assert.equal(typographRussianText('Он сказал, что всё готово или почти готово'),
    'Он сказал, что\u00a0всё готово или\u00a0почти готово')
  assert.equal(typographRussianText('Flow and design'), 'Flow and design')
})

test('slide specification typographs prose but leaves code snippets intact', () => {
  const spec = typographSlideSpec({
    title: 'Продукт и команда',
    text: 'Работа в одном стиле',
    cards: [{ heading: 'Сроки и качество', body: 'Сборка за неделю' }],
    quotes: [{ heading: '', body: 'Мы сократили работу в три раза.' }],
    snippets: [{ code: 'const a = "и тест";' }],
    tables: [{ headers: ['Работа в команде'], rows: [['В срок']] }],
  })

  assert.equal(spec.title, 'Продукт и\u00a0команда')
  assert.equal(spec.cards[0].body, 'Сборка за\u00a0неделю')
  assert.equal(spec.quotes[0].body, 'Мы сократили работу в\u00a0три раза.')
  assert.equal(spec.tables[0].headers[0], 'Работа в\u00a0команде')
  assert.equal(spec.snippets[0].code, 'const a = "и тест";')
})

test('direct text insertion and final slide typography use nonbreaking spaces', () => {
  const slide = { content_elements: [{
    element_id: 'body', kind: 'text', text: 'Исходный текст',
    text_runs: [{ text: 'Исходный текст' }],
    text_paragraphs: [{ text: 'Исходный текст' }],
  }] }
  const patched = patchSlideTextContent(slide, { elementIds: ['body'], text: 'И в этом смысл' })
  assert.equal(patched.content_elements[0].text, 'И\u00a0в\u00a0этом смысл')
  assert.equal(patched.content_elements[0].text_paragraphs[0].text, 'И\u00a0в\u00a0этом смысл')
  assert.deepEqual(patched.content_elements[0].text_runs, [])

  const finalized = typographSlideText({ content_elements: [{
    element_id: 'body', kind: 'text', text: 'Работа и результат',
    text_paragraphs: [{ text: 'Работа и результат' }],
  }] })
  assert.equal(finalized.content_elements[0].text, 'Работа и\u00a0результат')
  assert.equal(finalized.content_elements[0].text_paragraphs[0].text, 'Работа и\u00a0результат')

  const code = patchSlideTextContent({ content_elements: [{
    element_id: 'code', kind: 'text', narrative_role: 'snippet', text: '',
  }] }, { elementIds: ['code'], text: 'const value = "и тест"' })
  assert.equal(code.content_elements[0].text, 'const value = "и тест"')
})
