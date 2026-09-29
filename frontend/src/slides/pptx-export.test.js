import assert from 'node:assert/strict'
import test from 'node:test'
import { resolveExportDimensions } from './pptx-export.js'

test('resolveExportDimensions keeps slide aspect ratio at export width', () => {
  const dims = resolveExportDimensions({ width: 960, height: 540 })
  assert.equal(dims.exportWidthPx, 1920)
  assert.equal(dims.exportHeightPx, 1080)
  assert.equal(dims.widthPt, 960)
  assert.equal(dims.heightPt, 540)
})

test('resolveExportDimensions supports non-16:9 decks', () => {
  const dims = resolveExportDimensions({ width: 720, height: 540 })
  assert.equal(dims.exportWidthPx, 1920)
  assert.equal(dims.exportHeightPx, 1440)
})
