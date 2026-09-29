import test from 'node:test'
import assert from 'node:assert/strict'

import { normalizeSlideSpec } from './slide-spec.js'

test('paragraphs feed narrative text without becoming a numbered list', () => {
  const spec = normalizeSlideSpec({
    title: 'Как работает Flow',
    text: 'Краткая аннотация',
    context: {
      paragraphs: [
        { text: 'Сначала система анализирует структуру исходного шаблона.' },
        'Затем данные распределяются по подходящим компонентам.',
      ],
      lists: [],
    },
  })

  assert.equal(spec.paragraphs.length, 2)
  assert.match(spec.text, /анализирует структуру/)
  assert.match(spec.text, /данные распределяются/)
  assert.equal(spec.lists.length, 0)
  assert.equal(spec.summary_text, 'Краткая аннотация')
})

test('legacy text lists migrate to cards while paragraphs remain narrative', () => {
  const spec = normalizeSlideSpec({
    context: {
      paragraphs: [{ text: 'Связное объяснение.' }],
      lists: [{ title: 'Пункт', text: 'Деталь' }],
    },
  })

  assert.equal(spec.lists.length, 0)
  assert.equal(spec.cards.length, 1)
  assert.equal(spec.cards[0].heading, 'Пункт')
  assert.equal(spec.cards[0].body, 'Деталь')
  assert.equal(spec.cards[0].title, undefined)
  assert.equal(spec.cards[0].text, undefined)
  assert.equal(spec.text, 'Связное объяснение.')
})

test('quote body does not require an author heading; authors remain persons', () => {
  const spec = normalizeSlideSpec({
    context: {
      persons: [{ heading: 'Анна', body: 'Руководитель проекта' }],
      quotes: [{ body: 'Мы закончили за неделю.' }],
    },
  })

  assert.deepEqual(
    { heading: spec.persons[0].heading, body: spec.persons[0].body },
    { heading: 'Анна', body: 'Руководитель проекта' },
  )
  assert.deepEqual(
    { heading: spec.quotes[0].heading, body: spec.quotes[0].body },
    { heading: '', body: 'Мы закончили за неделю.' },
  )
})

test('legacy text list headings migrate to cards without renumbering', () => {
  const spec = normalizeSlideSpec({
    context: {
      lists: [
        { heading: 'Преимущества', body: 'Быстрая подготовка' },
        { heading: 'Преимущества', body: 'Сохранение фирменного стиля' },
        { heading: 'Преимущества', body: 'Меньше ручной работы' },
      ],
    },
  })

  assert.equal(spec.lists.length, 0)
  assert.deepEqual(spec.cards.map((item) => item.heading), [
    'Преимущества', 'Преимущества', 'Преимущества',
  ])
})

test('legacy lists split into cards, numbered lists, timelines and icon lists', () => {
  const spec = normalizeSlideSpec({
    context: {
      lists: [
        { heading: 'Скорость', body: 'Быстрая подготовка' },
        { heading: '1', body: 'Первый шаг' },
        { heading: '2026', body: 'Запуск продукта' },
        { heading: '', body: 'Тезис под иконкой' },
      ],
    },
  })

  assert.deepEqual(spec.cards.map((item) => item.heading), ['Скорость'])
  assert.deepEqual(spec.lists.map((item) => item.heading), ['1'])
  assert.deepEqual(spec.timelines.map((item) => item.heading), ['2026'])
  assert.deepEqual(spec.icon_lists.map((item) => item.body), ['Тезис под иконкой'])
})

test('short numeric list headings are promoted to metric data', () => {
  const spec = normalizeSlideSpec({
    context: {
      metrics: [],
      lists: [
        { heading: '40%', body: 'сокращение времени' },
        { heading: '3×', body: 'быстрее подготовка' },
        { heading: 'Обычный пункт', body: 'не является метрикой' },
      ],
    },
  })

  assert.deepEqual(
    spec.metrics.map((item) => ({
      value: item.value,
      unit: item.unit,
      description: item.description,
    })),
    [
      { value: '40', unit: '%', description: 'сокращение времени' },
      { value: '3', unit: '×', description: 'быстрее подготовка' },
    ],
  )
})

test('long numeric headings remain regular list content', () => {
  const spec = normalizeSlideSpec({
    context: {
      lists: [{
        heading: 'Результаты программы за 2026 год',
        body: 'Подробное описание',
      }],
    },
  })

  assert.equal(spec.metrics.length, 0)
})
