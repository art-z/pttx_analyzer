import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { listPaginationComponents, defaultPaginatorModel } from './pagination-catalog.js'
import { buildPaginatorPreviewView } from './pagination-render.js'
import { listAllComponents } from './catalog.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const sampleReportPath = path.resolve(__dirname, '../../../output/b80e2f13b5ec/report.json')

test('listPaginationComponents normalizes dot paginator with capacity and placements', () => {
  if (!fs.existsSync(sampleReportPath)) return

  const report = JSON.parse(fs.readFileSync(sampleReportPath, 'utf8'))
  const items = listPaginationComponents(report)
  assert.ok(items.length >= 1)

  const paginator = items.find((item) => item.pagination_type === 'dot_pagination')
  assert.ok(paginator)
  assert.ok(paginator.capacity.dot_count_max >= paginator.capacity.dot_count_typical)
  assert.ok(paginator.placements.some((item) => item.source === 'absolute'))
  assert.ok(paginator.instances[0].placement?.coordinate_space === 'slide_absolute')
  assert.ok(paginator.instances[0].element_ids.length >= 3)
  assert.ok(paginator.style_tokens.active_fill)
})

test('paginator appears in Components catalog and preview rebuilds dots', () => {
  if (!fs.existsSync(sampleReportPath)) return

  const report = JSON.parse(fs.readFileSync(sampleReportPath, 'utf8'))
  const component = listAllComponents(report).find((item) => item.kind === 'paginator')
  assert.ok(component)

  const model = {
    ...defaultPaginatorModel(component),
    page_count: 7,
    active_index: 3,
    placement_id: component.instances[0].placement_id,
  }
  const view = buildPaginatorPreviewView(report, component, { modelData: model })
  assert.ok(view.slide)
  assert.ok(view.bboxPt?.width_pt > 0)

  const dots = view.slide.content_elements.filter((element) => String(element.element_id).includes('_dot_'))
  assert.equal(dots.length, 7)
  assert.equal(dots[3].fill.color, component.styleTokens.active_fill)
  assert.equal(dots[0].fill.color, component.styleTokens.inactive_fill)
  assert.ok(Math.abs(dots[0].geometry_norm.x - 0.054) < 0.01)
})
