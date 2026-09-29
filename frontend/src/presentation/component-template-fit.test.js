import test from 'node:test'
import assert from 'node:assert/strict'

import {
  auditPlacedContent,
  buildComponentTemplateRegistry,
  fittingTemplatesForComponent,
  isAssetBoardTemplate,
  measureTextInkBox,
  probeComponentOnTemplate,
  shiftComponentClearOfTitle,
  templateAssetBoardPenalty,
  templateObstacles,
} from './component-template-fit.js'

function emptyTemplate(id = 'tmpl_empty') {
  return {
    template_id: id,
    layout_name: 'Пустой',
    editable_slots: [],
    render: { layers: [] },
  }
}

function photoTemplate() {
  return {
    template_id: 'tmpl_photo',
    layout_name: 'С фото',
    editable_slots: [
      {
        role: 'title',
        geometry_norm: { x: 0.05, y: 0.08, width: 0.9, height: 0.1 },
      },
    ],
    render: {
      layers: [
        {
          layer_id: 'bleed',
          kind: 'image',
          geometry_norm: { x: 0, y: 0, width: 1, height: 1 },
        },
        {
          layer_id: 'side',
          kind: 'image',
          geometry_norm: { x: 0.5, y: 0.1, width: 0.45, height: 0.8 },
        },
      ],
    },
  }
}

function assetBoardTemplate(id = 'tmpl_assets') {
  return {
    template_id: id,
    layout_name: 'Assets',
    editable_slots: [],
    render: {
      layers: Array.from({ length: 14 }, (_, index) => ({
        layer_id: `asset_${index}`,
        kind: 'image',
        geometry_norm: {
          x: 0.06 + (index % 7) * 0.12,
          y: 0.08 + Math.floor(index / 7) * 0.18,
          width: 0.045,
          height: 0.055,
        },
      })),
    },
  }
}

function reportWith(templates) {
  return {
    layout: { content_margins: { left_norm: 0.04, right_norm: 0.04, top_norm: 0.04, bottom_norm: 0.04 } },
    slide_templates: { templates },
  }
}

test('full-bleed background is not an obstacle, a side photo is', () => {
  const obstacles = templateObstacles(photoTemplate())
  assert.equal(obstacles.some((item) => item.id === 'bleed'), false)
  assert.equal(obstacles.some((item) => item.id === 'side'), true)
  assert.equal(obstacles.some((item) => item.source === 'slot'), true)
})

test('a single copy that hits a template photo is rejected', () => {
  const report = reportWith([photoTemplate()])
  const probe = probeComponentOnTemplate({
    x: 0.04,
    y: 0.22,
    width: 0.6,
    height: 0.3,
    axis: 'row',
    cols: 1,
  }, photoTemplate(), report)
  assert.equal(probe.status, 'rejected')
  assert.equal(probe.max_count, 0)
  assert.equal(probe.fail_reason, 'obstacle')
  assert.equal(probe.fail_at_count, 1)
})

test('a narrow copy fits once and the next copy stops on the photo', () => {
  const report = reportWith([photoTemplate()])
  const probe = probeComponentOnTemplate({
    x: 0.04,
    y: 0.22,
    width: 0.3,
    height: 0.25,
    axis: 'row',
    cols: 1,
  }, photoTemplate(), report)
  assert.equal(probe.status, 'fit')
  assert.equal(probe.max_count, 1)
  assert.equal(probe.fail_reason, 'obstacle')
  assert.equal(probe.fail_at_count, 2)
})

test('column growth stops at the slide edge and keeps the last valid count', () => {
  const template = emptyTemplate()
  const probe = probeComponentOnTemplate({
    x: 0.04,
    y: 0.04,
    width: 0.4,
    height: 0.2,
    axis: 'column',
    cols: 1,
  }, template, reportWith([template]))
  assert.equal(probe.status, 'fit')
  assert.equal(probe.max_count, 4)
  assert.equal(probe.fail_reason, 'out_of_bounds')
  assert.equal(probe.fail_at_count, 5)
})

test('registry records every template for repeats, singletons and charts', () => {
  const empty = emptyTemplate()
  const photo = photoTemplate()
  const report = reportWith([empty, photo])
  const registry = buildComponentTemplateRegistry(report, [
    {
      id: 'vg_001',
      label: 'Карточки',
      kind: 'container',
      group: 'repeats',
      instances: [{
        layout: 'row',
        container_norm: { x: 0.1, y: 0.3, width: 0.6, height: 0.2 },
        repeat: { count: 3, item_count: 3 },
      }],
    },
    {
      id: 'sing_001',
      label: 'Спикер',
      kind: 'singleton',
      group: 'singletons',
      instances: [{
        container_norm: { x: 0.1, y: 0.3, width: 0.7, height: 0.4 },
      }],
    },
    {
      id: 'cht_001',
      label: 'Линия',
      kind: 'chart',
      group: 'charts',
      instances: [],
      raw: {
        baseline_preview: {
          geometry_norm: { x: 0.08, y: 0.28, width: 0.4, height: 0.35 },
        },
      },
    },
    {
      id: 'title_001',
      label: 'Заголовок',
      kind: 'slide_title',
      group: 'titles',
      instances: [],
    },
  ])

  assert.deepEqual(registry.components.map((item) => item.component_id), ['vg_001', 'sing_001', 'cht_001'])

  const cards = registry.components[0]
  assert.equal(cards.repeatable, true)
  assert.equal(cards.axis, 'row')
  assert.equal(cards.templates.length, 2)
  assert.equal(cards.unit_norm.x, 0.1)
  assert.equal(cards.unit_norm.y, 0.3)
  assert.ok(cards.unit_norm.width > 0.19 && cards.unit_norm.width < 0.21)
  const cardsOnEmpty = cards.templates.find((item) => item.template_id === 'tmpl_empty')
  const cardsOnPhoto = cards.templates.find((item) => item.template_id === 'tmpl_photo')
  assert.equal(cardsOnEmpty.status, 'fit')
  assert.ok(cardsOnEmpty.max_count >= 2)
  assert.equal(cardsOnPhoto.status, 'rejected')
  assert.equal(cardsOnPhoto.fail_reason, 'full_bleed_background')
  assert.equal(cardsOnPhoto.max_count, 0)

  const speaker = registry.components[1]
  assert.equal(speaker.repeatable, false)
  assert.equal(speaker.templates.find((item) => item.template_id === 'tmpl_photo').status, 'rejected')
  assert.equal(speaker.templates.find((item) => item.template_id === 'tmpl_empty').status, 'fit')

  const chart = registry.components[2]
  assert.equal(chart.templates.find((item) => item.template_id === 'tmpl_empty').status, 'fit')
  assert.equal(chart.templates.find((item) => item.template_id === 'tmpl_photo').status, 'rejected')
  assert.equal(chart.summary.accepted_count, 1)
})

test('asset board templates are detected conservatively from many small visual layers', () => {
  assert.equal(isAssetBoardTemplate(assetBoardTemplate()), true)
  assert.equal(isAssetBoardTemplate(photoTemplate()), false)
  assert.equal(isAssetBoardTemplate({
    ...assetBoardTemplate('tmpl_with_text'),
    editable_slots: [
      { role: 'title', geometry_norm: { x: 0.05, y: 0.05, width: 0.9, height: 0.1 } },
      { role: 'body', geometry_norm: { x: 0.05, y: 0.2, width: 0.9, height: 0.5 } },
    ],
  }), false)
})

test('asset board penalty grows with the number of asset slides on the template', () => {
  const normal = emptyTemplate('tmpl_normal')
  const asset = assetBoardTemplate('tmpl_assets')
  const report = {
    ...reportWith([normal, asset]),
    slides: {
      slides: [
        { ...assetBoardTemplate(), slide_number: 1, template_id: 'tmpl_assets' },
        { ...assetBoardTemplate(), slide_number: 2, template_id: 'tmpl_assets' },
        { slide_number: 3, template_id: 'tmpl_normal', render: { layers: [] } },
      ],
    },
  }

  assert.ok(templateAssetBoardPenalty(report, 'tmpl_assets') > templateAssetBoardPenalty(report, 'tmpl_normal'))
  assert.ok(templateAssetBoardPenalty(report, 'tmpl_assets') >= 600)
})


test('chart fitting templates are ordered by widest available chart box', () => {
  const narrow = {
    template_id: 'tmpl_narrow_chart',
    layout_name: 'Узкий график',
    editable_slots: [{ role: 'title', geometry_norm: { x: 0.05, y: 0.08, width: 0.9, height: 0.1 } }],
    render: { layers: [{ layer_id: 'decor', kind: 'image', geometry_norm: { x: 0.68, y: 0.22, width: 0.28, height: 0.7 } }] },
  }
  const wide = {
    template_id: 'tmpl_wide_chart',
    layout_name: 'Широкий график',
    editable_slots: [{ role: 'title', geometry_norm: { x: 0.05, y: 0.08, width: 0.9, height: 0.1 } }],
    render: { layers: [] },
  }
  const report = reportWith([narrow, wide])
  const registry = buildComponentTemplateRegistry(report, [{
    id: 'cht_wide_first',
    label: 'График',
    kind: 'chart',
    group: 'charts',
    instances: [],
    raw: { chart_type: 'area', baseline_preview: { geometry_norm: { x: 0.08, y: 0.28, width: 0.4, height: 0.35 } } },
  }])
  const chart = registry.components[0]
  assert.equal(chart.templates[0].template_id, 'tmpl_wide_chart')
  assert.ok(chart.templates[0].fit_width > chart.templates[1].fit_width)
  assert.deepEqual(
    fittingTemplatesForComponent(chart).map((item) => item.template_id),
    ['tmpl_wide_chart', 'tmpl_narrow_chart'],
  )
})

test('a full-bleed template stays suitable only when the component was found there', () => {
  const home = photoTemplate()
  const other = {
    ...photoTemplate(),
    template_id: 'tmpl_other_bleed',
    layout_name: 'Другой фон',
  }
  const report = reportWith([home, other, emptyTemplate()])
  const component = {
    id: 'vg_home',
    label: 'Карточки',
    kind: 'container',
    group: 'repeats',
    templates: ['tmpl_photo'],
    instances: [{
      layout: 'row',
      template_id: 'tmpl_photo',
      container_norm: { x: 0.1, y: 0.3, width: 0.3, height: 0.2 },
      repeat: { count: 1, item_count: 1 },
    }],
  }
  const registry = buildComponentTemplateRegistry(report, [component])
  const entry = registry.components[0]
  const byId = Object.fromEntries(entry.templates.map((item) => [item.template_id, item]))
  assert.equal(byId.tmpl_photo.status, 'fit')
  assert.equal(byId.tmpl_other_bleed.status, 'rejected')
  assert.equal(byId.tmpl_other_bleed.fail_reason, 'full_bleed_background')
  assert.equal(byId.tmpl_empty.status, 'fit')
  const extras = fittingTemplatesForComponent(entry, component.templates)
  assert.deepEqual(extras.map((item) => item.template_id), ['tmpl_empty'])
})

test('a contrasting fill panel is suitable only for a component found on that template', () => {
  const split = {
    template_id: 'tmpl_split',
    layout_name: 'Тёмная половина',
    editable_slots: [],
    render: {
      background_color: '#FFFFFF',
      layers: [{
        layer_id: 'panel',
        kind: 'fill',
        z_index: 2,
        geometry_norm: { x: 0.5, y: 0, width: 0.5, height: 1 },
        fill: { kind: 'solid', color: '#262626', alpha: 1 },
      }],
    },
  }
  const covered = {
    template_id: 'tmpl_covered',
    layout_name: 'Закрытая заливка',
    editable_slots: [],
    render: {
      background_color: '#FFFFFF',
      layers: [
        {
          layer_id: 'dark',
          kind: 'fill',
          z_index: 2,
          geometry_norm: { x: 0.5, y: 0, width: 0.5, height: 1 },
          fill: { kind: 'solid', color: '#262626', alpha: 1 },
        },
        {
          layer_id: 'cover',
          kind: 'fill',
          z_index: 4,
          geometry_norm: { x: 0, y: 0, width: 1, height: 1 },
          fill: { kind: 'solid', color: '#FFFFFF', alpha: 1 },
        },
      ],
    },
  }
  const partial = {
    template_id: 'tmpl_partial',
    layout_name: 'Частичное перекрытие',
    editable_slots: [],
    render: {
      background_color: '#FFFFFF',
      layers: [
        {
          layer_id: 'dark',
          kind: 'fill',
          z_index: 2,
          geometry_norm: { x: 0.5, y: 0, width: 0.5, height: 1 },
          fill: { kind: 'solid', color: '#262626', alpha: 1 },
        },
        {
          layer_id: 'chip',
          kind: 'fill',
          z_index: 5,
          geometry_norm: { x: 0.7, y: 0.2, width: 0.1, height: 0.15 },
          fill: { kind: 'solid', color: '#FFFFFF', alpha: 1 },
        },
      ],
    },
  }
  const masked = {
    template_id: 'tmpl_masked',
    layout_name: 'Закрытая панель',
    editable_slots: [],
    render: {
      background_color: '#FFFFFF',
      layers: [
        {
          layer_id: 'dark',
          kind: 'fill',
          z_index: 2,
          geometry_norm: { x: 0.5, y: 0, width: 0.5, height: 1 },
          fill: { kind: 'solid', color: '#262626', alpha: 1 },
        },
        {
          layer_id: 'mask',
          kind: 'fill',
          z_index: 5,
          geometry_norm: { x: 0.5, y: 0, width: 0.5, height: 1 },
          fill: { kind: 'solid', color: '#FFFFFF', alpha: 1 },
        },
      ],
    },
  }
  const pale = {
    template_id: 'tmpl_pale',
    layout_name: 'Бледный фон',
    editable_slots: [],
    render: {
      background_color: '#FFFFFF',
      layers: [{
        layer_id: 'wash',
        kind: 'fill',
        z_index: 1,
        geometry_norm: { x: 0, y: 0, width: 1, height: 1 },
        fill: { kind: 'solid', color: '#EBF3F9', alpha: 1 },
      }],
    },
  }
  const report = reportWith([split, covered, partial, masked, pale, emptyTemplate()])
  const outsider = {
    id: 'vg_out',
    label: 'Карточки',
    kind: 'container',
    group: 'repeats',
    templates: ['tmpl_empty'],
    instances: [{
      layout: 'row',
      template_id: 'tmpl_empty',
      container_norm: { x: 0.1, y: 0.3, width: 0.3, height: 0.2 },
      repeat: { count: 1, item_count: 1 },
    }],
  }
  const native = {
    ...outsider,
    id: 'vg_native',
    templates: ['tmpl_split'],
    instances: [{
      ...outsider.instances[0],
      template_id: 'tmpl_split',
    }],
  }
  const foreign = buildComponentTemplateRegistry(report, [outsider]).components[0]
  const home = buildComponentTemplateRegistry(report, [native]).components[0]
  const foreignById = Object.fromEntries(foreign.templates.map((item) => [item.template_id, item]))
  const homeById = Object.fromEntries(home.templates.map((item) => [item.template_id, item]))
  assert.equal(foreignById.tmpl_split.status, 'rejected')
  assert.equal(foreignById.tmpl_split.fail_reason, 'contrasting_fill')
  assert.equal(foreignById.tmpl_covered.status, 'fit')
  assert.equal(foreignById.tmpl_masked.status, 'fit')
  assert.equal(foreignById.tmpl_partial.status, 'rejected')
  assert.equal(foreignById.tmpl_partial.fail_reason, 'contrasting_fill')
  assert.equal(foreignById.tmpl_pale.status, 'fit')
  assert.equal(homeById.tmpl_split.status, 'fit')
  assert.deepEqual(
    fittingTemplatesForComponent(foreign, outsider.templates).map((item) => item.template_id).sort(),
    ['tmpl_covered', 'tmpl_masked', 'tmpl_pale'],
  )
})

function cardsOn(templateId) {
  return {
    id: 'vg_cards',
    label: 'Карточки',
    kind: 'container',
    group: 'repeats',
    templates: [templateId],
    instances: [{
      layout: 'row',
      template_id: templateId,
      container_norm: { x: 0.1, y: 0.3, width: 0.3, height: 0.2 },
      repeat: { count: 1, item_count: 1 },
    }],
  }
}

test('quote and code templates are not suitable shells for a foreign component', () => {
  const quote = {
    ...emptyTemplate('tmpl_quote'),
    layout_name: 'Цитата',
    detected_roles: ['quote'],
  }
  const code = {
    ...emptyTemplate('tmpl_code'),
    layout_name: 'Код',
    detected_roles: ['snippet'],
  }
  const report = reportWith([emptyTemplate(), quote, code])
  const entry = buildComponentTemplateRegistry(report, [cardsOn('tmpl_empty')]).components[0]
  const byId = Object.fromEntries(entry.templates.map((item) => [item.template_id, item]))
  assert.equal(byId.tmpl_empty.status, 'fit')
  assert.equal(byId.tmpl_quote.status, 'rejected')
  assert.equal(byId.tmpl_quote.fail_reason, 'quote_template')
  assert.equal(byId.tmpl_quote.max_count, 0)
  assert.equal(byId.tmpl_code.status, 'rejected')
  assert.equal(byId.tmpl_code.fail_reason, 'snippet_template')
  assert.deepEqual(
    fittingTemplatesForComponent(entry, ['tmpl_empty']).map((item) => item.template_id),
    [],
  )
})

test('a quote template stays the home shell of a component found on it', () => {
  const quote = {
    ...emptyTemplate('tmpl_quote'),
    layout_name: 'Цитата',
    detected_roles: ['quote'],
  }
  const report = reportWith([emptyTemplate(), quote])
  const entry = buildComponentTemplateRegistry(report, [cardsOn('tmpl_quote')]).components[0]
  const byId = Object.fromEntries(entry.templates.map((item) => [item.template_id, item]))
  assert.equal(byId.tmpl_quote.status, 'fit')
  assert.equal(byId.tmpl_empty.status, 'fit')
})

test('the only template in the deck stays suitable even when it is a quote template', () => {
  const quote = {
    ...emptyTemplate('tmpl_quote'),
    layout_name: 'Цитата',
    detected_roles: ['quote'],
  }
  const report = reportWith([quote])
  const entry = buildComponentTemplateRegistry(report, [cardsOn('tmpl_other')]).components[0]
  assert.equal(entry.templates[0].status, 'fit')
  assert.ok((entry.templates[0].max_count || 0) >= 1)
})

test('a footer logo counts as an obstacle', () => {
  const template = {
    template_id: 'tmpl_logo',
    layout_name: 'С логотипом',
    editable_slots: [],
    render: {
      layers: [{
        layer_id: 'logo',
        kind: 'image',
        geometry_norm: { x: 0.04, y: 0.9, width: 0.08, height: 0.04 },
      }],
    },
  }
  const obstacles = templateObstacles(template)
  assert.equal(obstacles.some((item) => item.id === 'logo'), true)
})

test('a component stays at its source bbox and is dropped when that bbox hits an obstacle', () => {
  const template = {
    template_id: 'tmpl_banner',
    layout_name: 'Баннер справа сверху',
    editable_slots: [],
    render: {
      layers: [{
        layer_id: 'banner',
        kind: 'image',
        geometry_norm: { x: 0.4, y: 0.04, width: 0.56, height: 0.35 },
      }],
    },
  }
  const report = reportWith([template])
  const beside = probeComponentOnTemplate({
    x: 0.04,
    y: 0.04,
    width: 0.25,
    height: 0.2,
    axis: 'row',
    cols: 1,
  }, template, report)
  const inside = probeComponentOnTemplate({
    x: 0.5,
    y: 0.1,
    width: 0.25,
    height: 0.2,
    axis: 'row',
    cols: 1,
  }, template, report)

  assert.equal(beside.status, 'fit')
  assert.equal(beside.max_count, 1)
  assert.equal(beside.anchor.x, 0.04)
  assert.equal(beside.anchor.y, 0.04)
  assert.equal(inside.status, 'rejected')
  assert.equal(inside.max_count, 0)
  assert.equal(inside.fail_reason, 'obstacle')
})

test('title hit-test follows the wrapped text instead of the catalog element box', () => {
  const slot = { x: 0.05, y: 0.06, width: 0.9, height: 0.04 }
  const typography = { size_pt: 32, alignment: 'l' }
  const ink = measureTextInkBox(
    slot,
    'Очень длинный заголовок слайда который занимает несколько строк и опускает контент ниже',
    typography,
    { width: 960, height: 540 },
  )
  assert.ok(ink.height > slot.height)

  const template = {
    template_id: 'tmpl_title',
    layout_name: 'Заголовок',
    editable_slots: [{
      role: 'title',
      geometry_norm: slot,
      typography,
    }],
    render: { layers: [] },
  }
  const report = reportWith([template])
  const longText = 'Очень длинный заголовок слайда который занимает несколько строк и опускает контент ниже'
  const overlapping = { x: 0.2, y: 0.08, width: 0.35, height: 0.1, axis: 'column', cols: 1 }
  const clear = { x: 0.08, y: 0.32, width: 0.4, height: 0.2, axis: 'column', cols: 1 }
  const shortOverlap = probeComponentOnTemplate(overlapping, template, report, { titleText: 'Кратко' })
  const longOverlap = probeComponentOnTemplate(overlapping, template, report, { titleText: longText })
  const shortClear = probeComponentOnTemplate(clear, template, report, { titleText: 'Кратко' })
  const longClear = probeComponentOnTemplate(clear, template, report, { titleText: longText })

  assert.equal(shortOverlap.status, 'fit')
  assert.ok(shortOverlap.anchor.y > 0.08)
  assert.equal(longOverlap.status, 'fit')
  assert.ok(longOverlap.anchor.y > shortOverlap.anchor.y)
  assert.equal(shortClear.status, 'fit')
  assert.equal(longClear.status, 'fit')
  assert.equal(shortClear.anchor.y, 0.32)
  assert.equal(longClear.anchor.y, 0.32)
  const longObstacle = templateObstacles(template, report, { titleText: longText })[0]
  assert.ok(longObstacle.height > slot.height)
})

test('component layout shifts clear of the title and keeps its size', () => {
  const frame = { x: 0.04, y: 0.04, width: 0.92, height: 0.92 }
  const slot = { x: 0.05, y: 0.06, width: 0.9, height: 0.2 }
  const ink = { x: 0.05, y: 0.06, width: 0.28, height: 0.07 }
  const overlapping = { x: 0.08, y: 0.1, width: 0.5, height: 0.45 }
  const moved = shiftComponentClearOfTitle(overlapping, { slot, ink }, frame)
  const titleBottom = slot.y + slot.height

  assert.equal(moved.fits, true)
  assert.equal(moved.shifted, true)
  assert.equal(moved.side, 'top')
  assert.equal(moved.box.width, overlapping.width)
  assert.equal(moved.box.height, overlapping.height)
  assert.ok(moved.box.y >= titleBottom + 0.03 - 0.001)

  const almostTouching = { x: 0.08, y: titleBottom + 0.01, width: 0.5, height: 0.4 }
  const padded = shiftComponentClearOfTitle(almostTouching, { slot, ink }, frame)
  assert.equal(padded.shifted, true)
  assert.equal(padded.box.height, almostTouching.height)
  assert.ok(padded.box.y >= titleBottom + 0.03 - 0.001)

  const clear = { x: 0.08, y: titleBottom + 0.08, width: 0.5, height: 0.3 }
  assert.equal(shiftComponentClearOfTitle(clear, { slot, ink }, frame).shifted, false)

  const giantSlot = { x: 0.05, y: 0.05, width: 0.9, height: 0.7 }
  const shortInk = { x: 0.05, y: 0.06, width: 0.9, height: 0.12 }
  const belowText = { x: 0.08, y: 0.3, width: 0.5, height: 0.4 }
  assert.equal(shiftComponentClearOfTitle(belowText, { slot: giantSlot, ink: shortInk }, frame).shifted, false)

  const footer = { x: 0.05, y: 0.78, width: 0.9, height: 0.08 }
  const tallComponent = { x: 0.08, y: 0.2, width: 0.5, height: 0.7 }
  const fromBottom = shiftComponentClearOfTitle(tallComponent, { slot: footer, ink: footer }, frame)
  assert.equal(fromBottom.fits, true)
  assert.equal(fromBottom.side, 'bottom')
  assert.equal(fromBottom.box.height, tallComponent.height)
  assert.ok(fromBottom.box.y + fromBottom.box.height <= footer.y - 0.03 + 0.001)

  const tooTall = { x: 0.08, y: 0.1, width: 0.5, height: 0.85 }
  const rejected = shiftComponentClearOfTitle(tooTall, { slot: footer, ink: footer }, frame)
  assert.equal(rejected.fits, false)
  assert.equal(rejected.box.height, tooTall.height)
})

test('fitting templates skip the shell where the component was found', () => {
  const fits = fittingTemplatesForComponent({
    axis: 'row',
    repeatable: true,
    templates: [
      { template_id: 'tmpl_photo', template_label: 'С фото', status: 'fit', max_count: 1 },
      { template_id: 'tmpl_empty', template_label: 'Пустой', status: 'fit', max_count: 4 },
      { template_id: 'tmpl_banner', template_label: 'Баннер', status: 'rejected', max_count: 0 },
    ],
  }, ['tmpl_photo'])

  assert.deepEqual(fits.map((item) => item.template_id), ['tmpl_empty'])
  assert.equal(fits[0].max_count, 4)
  assert.equal(fits[0].repeatable, true)
  assert.equal(fits[0].template_label, 'Пустой')
})

test('assembled content that covers a template photo is rejected', () => {
  const report = reportWith([photoTemplate()])
  const blocked = auditPlacedContent(report, {
    content_elements: [{
      element_id: 'card__repeat_1',
      geometry_norm: { x: 0.55, y: 0.35, width: 0.2, height: 0.2 },
    }],
  }, 'tmpl_photo')
  const clear = auditPlacedContent(report, {
    content_elements: [{
      element_id: 'card__repeat_1',
      geometry_norm: { x: 0.06, y: 0.35, width: 0.2, height: 0.2 },
    }],
  }, 'tmpl_photo')

  assert.equal(blocked.ok, false)
  assert.equal(blocked.reason, 'obstacle')
  assert.equal(clear.ok, true)
})
