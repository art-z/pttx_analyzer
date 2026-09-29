import assert from 'node:assert/strict'
import test from 'node:test'
import { formatDuration, formatTokenLine, listFlyableAssets } from './lite-session.js'

test('formatDuration keeps minutes, seconds and tenths', () => {
  assert.equal(formatDuration(0), '0:00.0')
  assert.equal(formatDuration(6400), '0:06.4')
  assert.equal(formatDuration(75400), '1:15.4')
})

test('listFlyableAssets keeps raster and svg files', () => {
  const assets = listFlyableAssets({
    assets: {
      media_files: [
        { filename: 'icon.png', extension: '.png' },
        { filename: 'clip.emf', extension: '.emf' },
        { filename: 'logo.svg', extension: '.SVG' },
        { filename: '', extension: '.png' },
      ],
    },
  })
  assert.deepEqual(assets.map((asset) => asset.filename), ['icon.png', 'logo.svg'])
})

test('formatTokenLine summarizes model usage', () => {
  assert.equal(formatTokenLine(null), '')
  assert.equal(formatTokenLine({ request_count: 0 }), '')
  const line = formatTokenLine({
    request_count: 1,
    total_tokens: 1200,
    input_tokens: 800,
    output_tokens: 400,
  }).replace(/\s/g, ' ')
  assert.equal(line, '1 200 токенов · вход 800 · выход 400')
})
