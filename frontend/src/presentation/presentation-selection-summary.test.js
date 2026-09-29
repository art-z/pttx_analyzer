import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { buildScenarioSlide } from './build-slide.js'
import { summarizePresentationSelection } from './presentation-selection-summary.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const spatialReportPath = path.resolve(__dirname, '../../../output/b13e9370de41/report.json')

test('summarizePresentationSelection returns template, selected and up to 3 alternatives', () => {
  if (!fs.existsSync(spatialReportPath)) return

  const report = JSON.parse(fs.readFileSync(spatialReportPath, 'utf8'))
  const buildResult = buildScenarioSlide(report, {
    index: 5,
    intent: 'team',
    title: 'Команда',
    text: 'Ключевые участники',
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
  })

  const summary = summarizePresentationSelection(buildResult)
  assert.ok(summary.template)
  assert.ok(summary.selected)
  assert.ok(summary.alternatives.length >= 1)
  assert.ok(summary.alternatives.length <= 3)
})
