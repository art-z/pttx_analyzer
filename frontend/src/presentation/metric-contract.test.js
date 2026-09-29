import test from 'node:test'
import assert from 'node:assert/strict'

import {
  adaptMetricsForLayout,
  formatMetricDisplay,
  normalizeMetricItem,
  normalizeMetricItems,
  parseMetricDisplay,
} from './metric-contract.js'
import { normalizeSlideSpec } from './slide-spec.js'

test('metric contract parses legacy value+unit display and keeps description', () => {
  const { metric, issue } = normalizeMetricItem({ title: '40%', text: 'рост выручки' })

  assert.equal(issue, null)
  assert.deepEqual(
    { value: metric.value, unit: metric.unit, description: metric.description },
    { value: '40', unit: '%', description: 'рост выручки' },
  )
  assert.equal(metric.title, '40%')
  assert.equal(metric.text, 'рост выручки')
})

test('metric contract accepts explicit value, unit and description', () => {
  const { metric } = normalizeMetricItem({ value: '10', unit: 'млн', description: 'пользователей' })
  assert.equal(metric.title, '10 млн')
  assert.equal(formatMetricDisplay(metric), '10 млн')
})

test('metric contract accepts an empty unit but still requires description', () => {
  const normalized = normalizeMetricItems([
    { title: '40', text: 'рост' },
    { title: '40%', text: '' },
    { title: '40%', text: 'рост' },
  ])

  assert.equal(normalized.metrics.length, 2)
  assert.equal(normalized.metrics[0].value, '40')
  assert.equal(normalized.metrics[0].unit, '')
  assert.equal(normalized.metrics[0].title, '40')
  assert.equal(normalized.issues.length, 1)
  assert.deepEqual(normalized.issues[0].missing_or_invalid, ['description'])
})

test('slide normalization applies the strict metric contract to both input shapes', () => {
  const nested = normalizeSlideSpec({
    intent: 'metrics',
    context: { metrics: [{ value: '3', unit: '×', description: 'быстрее' }] },
  })
  const flat = normalizeSlideSpec({
    intent: 'metrics',
    metrics: [{ title: '7', text: 'без единицы' }, { title: '72%', text: 'готово' }],
  })

  assert.equal(nested.metrics[0].title, '3×')
  assert.equal(flat.metrics.length, 2)
  assert.equal(flat.metrics[0].title, '7')
  assert.equal(flat.metrics[0].unit, '')
  assert.equal(flat.metrics[1].title, '72%')
  assert.equal(flat.metric_issues.length, 0)
})

test('adaptMetricsForLayout folds units when layout has unit_mode none', () => {
  const adapted = adaptMetricsForLayout([
    { value: '3', unit: '×', description: 'быстрее подготовка' },
  ], { unit_mode: 'none' })

  assert.equal(adapted.length, 1)
  assert.equal(adapted[0].unit, '')
  assert.equal(adapted[0].title, '3×')
  assert.equal(adapted[0].description, 'быстрее подготовка')
})

test('display parser supports prefix currency units', () => {
  assert.deepEqual(parseMetricDisplay('$12'), {
    value: '12',
    unit: '$',
    unit_position: 'prefix',
  })
})
