import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { listAllComponents } from './catalog.js'
import { splitInstanceIntoItems } from './container-catalog.js'
import {
  buildContainerModelFromContext,
  inferComponentSemantics,
  mapContextItemToFields,
  matchRepeatComponents,
  resolveSlideAssemblyPlan,
} from './component-semantics.js'
import { normalizeSlideSpec } from '../presentation/slide-spec.js'
import * as semanticsModule from './component-semantics.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const spatialReportPath = path.resolve(__dirname, '../../../output/b13e9370de41/report.json')

test('item fields export semantic roles only', () => {
  const items = splitInstanceIntoItems({
    repeat: { count: 1 },
    element_ids: ['a', 'b', 'c'],
    slots: [
      { slot_id: 'slot_image_01', kind: 'image', role: 'image', text: null },
      { slot_id: 'slot_text_02', kind: 'text', role: 'heading', text: 'Имя Фамилия' },
      { slot_id: 'slot_text_03', kind: 'text', role: 'body', text: 'Должность' },
    ],
  })

  assert.deepEqual(items[0].fields, {
    heading: 'Имя Фамилия',
    body: 'Должность',
  })
  assert.equal(items[0].fields.slot_text_02, undefined)
})

test('mapContextItemToFields maps LLM persons to heading/body', () => {
  assert.deepEqual(mapContextItemToFields('persons', {
    name: 'Анна Иванова',
    bio: 'Head of Marketing',
  }), {
    heading: 'Анна Иванова',
    body: 'Head of Marketing',
  })
})

test('quote fields contain the quotation without a fabricated author', () => {
  assert.deepEqual(mapContextItemToFields('quotes', {
    body: 'Мы запустили проект за неделю.',
  }), {
    body: 'Мы запустили проект за неделю.',
  })
})

test('mapContextItemToFields always emits canonical fields for legacy component roles', () => {
  assert.deepEqual(mapContextItemToFields('lists', {
    heading: 'Анализ шаблона',
    body: 'Извлечение типографики',
  }, ['title', 'description']), {
    heading: 'Анализ шаблона',
    body: 'Извлечение типографики',
  })
})

test('mapContextItemToFields keeps metrics numeric display separate from description', () => {
  assert.deepEqual(mapContextItemToFields('metrics', {
    value: '40',
    unit: '%',
    title: '40%',
    description: 'сокращение времени',
  }), {
    heading: '40%',
    body: 'сокращение времени',
  })
})

test('inferComponentSemantics detects card pattern', () => {
  const component = {
    layout: 'grid',
    slots: {
      required: [
        { kind: 'image', role: 'image' },
        { kind: 'text', role: 'heading' },
        { kind: 'text', role: 'body' },
      ],
      optional: [],
    },
    capacity: { item_count_known: 8, item_count_max: 9 },
  }

  const semantics = inferComponentSemantics(component)
  assert.equal(semantics.pattern, 'card')
  assert.deepEqual(semantics.contextBlocks, ['cards', 'persons', 'quotes'])
  assert.ok(semantics.intents.includes('team'))
})

test('inferComponentSemantics classifies repeat headings by their values', () => {
  const componentWithHeadings = (headings, { image = false, heading = true } = {}) => ({
    slots: {
      required: [
        ...(image ? [{ kind: 'image', role: 'image' }] : []),
        ...(heading ? [{ kind: 'text', role: 'heading' }] : []),
        { kind: 'text', role: 'body' },
      ],
      optional: [],
    },
    instances: headings.map((value, index) => ({
      slots: [
        ...(image ? [{ kind: 'image', role: 'image' }] : []),
        ...(heading ? [{ kind: 'text', role: 'heading', text: value }] : []),
        { kind: 'text', role: 'body', text: `Описание ${index + 1}` },
      ],
    })),
  })

  assert.equal(inferComponentSemantics(componentWithHeadings(['1', '2', '3'])).pattern, 'numbered_list')
  assert.equal(inferComponentSemantics(componentWithHeadings(['2010', '2018', '2026'])).pattern, 'timeline')
  assert.equal(inferComponentSemantics(componentWithHeadings(['Q1', 'Q2', 'Q3'])).pattern, 'timeline')
  assert.equal(inferComponentSemantics(componentWithHeadings(['Скорость', 'Стиль'])).pattern, 'card')
  assert.equal(inferComponentSemantics(componentWithHeadings(['', ''], { image: true, heading: false })).pattern, 'icon_list')
})

test('legacy text slot is exported as canonical body field', () => {
  const items = splitInstanceIntoItems({
    repeat: { count: 1 },
    element_ids: ['a'],
    slots: [{ slot_id: 'slot_text_01', kind: 'text', role: 'text', text: 'Тезис' }],
  })

  assert.deepEqual(items[0].fields, { body: 'Тезис' })
})

test('matchRepeatComponents prefers team grid for persons context', () => {
  if (!fs.existsSync(spatialReportPath)) return

  const report = JSON.parse(fs.readFileSync(spatialReportPath, 'utf8'))
  const spec = normalizeSlideSpec({
    intent: 'team',
    purpose: 'Показать команду',
    title: 'Команда',
    text: 'Ключевые люди проекта',
    context: {
      metrics: [],
      lists: [],
      tables: [],
      charts: [],
      diagrams: [],
      persons: [
        { name: 'Анна Иванова', bio: 'PM' },
        { name: 'Иван Петров', bio: 'Design' },
        { name: 'Мария Сидорова', bio: 'Dev' },
      ],
      quotes: [],
      snippets: [],
      images: [],
    },
  })

  const matches = matchRepeatComponents(report, spec)
  assert.ok(matches.length >= 1)
  const top = matches[0]
  assert.ok(top.score >= 40)
  assert.ok(top.semantics.contextBlocks.includes('persons'))
})

test('resolveSlideAssemblyPlan builds container payload from LLM slide', () => {
  if (!fs.existsSync(spatialReportPath)) return

  const report = JSON.parse(fs.readFileSync(spatialReportPath, 'utf8'))
  const rawSlide = {
    intent: 'team',
    purpose: 'Команда',
    title: 'Команда проекта',
    text: 'Кто делает продукт',
    context: {
      persons: [
        { name: 'Анна', bio: 'PM' },
        { name: 'Иван', bio: 'Design' },
      ],
      metrics: [],
      lists: [],
      tables: [],
      charts: [],
      diagrams: [],
      quotes: [],
      snippets: [],
      images: [],
    },
  }

  const plan = resolveSlideAssemblyPlan(report, normalizeSlideSpec(rawSlide))
  assert.ok(plan.repeatComponent)
  assert.equal(plan.primaryContextBlock, 'persons')
  assert.ok(plan.containerPayload?.items?.length >= 2)
  assert.equal(plan.containerPayload.items[0].fields.heading, 'Анна')
  assert.equal(plan.containerPayload.items[0].fields.body, 'PM')
  assert.equal(plan.containerPayload.items[0].fields.slot_text_02, undefined)
})

test('real GRID_TEXT repeat component exposes card semantics on spatial deck', () => {
  if (!fs.existsSync(spatialReportPath)) return

  const report = JSON.parse(fs.readFileSync(spatialReportPath, 'utf8'))
  const component = listAllComponents(report).find((item) => (
    item.group === 'repeats'
    && item.raw?.signature === 'y[i,y[t20,t14]]'
  ))
  assert.ok(component, 'expected y[i,y[t20,t14]] repeat component')
  assert.equal(component.semantics.pattern, 'card')
  assert.ok(component.semantics.roles.includes('heading'))
  assert.ok(component.semantics.roles.includes('body'))
  assert.ok(component.semantics.roles.includes('image'))
})

test('intent adds only a small bonus to repeat component scoring', () => {
  const component = {
    semantics: { intents: ['team'], contextBlocks: ['persons'], pattern: 'card', itemCountKnown: 3 },
  }
  const counts = { persons: 3 }
  const withIntent = semanticsModule.scoreRepeatComponent(component, { intent: 'team' }, counts).score
  const withoutIntent = semanticsModule.scoreRepeatComponent(component, { intent: 'content' }, counts).score
  assert.ok(withIntent - withoutIntent <= 2 * semanticsModule.INTENT_RANK_BONUS)
  assert.ok(withIntent > withoutIntent)
})
