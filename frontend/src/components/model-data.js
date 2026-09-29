import { findSlide, listAllComponents } from './catalog.js'
import { defaultPaginatorModel } from './pagination-catalog.js'
import { buildTitleTextFromWords, defaultSlideTitleModel } from './slide-title-catalog.js'
import { defaultSlideDescriptionModel, buildDescriptionTextFromWords } from './slide-description-catalog.js'
import {
  containerModelToDataPayload,
  defaultContainerModel,
  isIterableRepeatComponent,
  resizeContainerModel,
} from './container-catalog.js'
import {
  buildTableCapacity,
  defaultTableModel,
  resizeTableModelData,
  resizeTableStructureMeta,
} from './table-catalog.js'
import { defaultMetricModel } from './metric-catalog.js'
import { defaultSlideImageModel } from './image-catalog.js'
import { typographRussianText } from '../slides/text-typographer.js'

export { isIterableRepeatComponent } from './container-catalog.js'

export const ITERABLE_PAYLOAD_KEYS = ['tables', 'charts', 'diagrams', 'containers', 'paginators', 'slide_titles', 'slide_descriptions', 'slide_images', 'metrics']

export const PAYLOAD_KEY_BY_KIND = {
  container: 'containers',
  paginator: 'paginators',
  slide_title: 'slide_titles',
  slide_description: 'slide_descriptions',
  slide_image: 'slide_images',
  table: 'tables',
  chart: 'charts',
  diagram: 'diagrams',
  metric: 'metrics',
}

function findGraphicElement(report, instance) {
  if (!instance?.slide_number || !instance?.element_id) return null
  const slide = findSlide(report, instance.slide_number)
  if (!slide) return null
  return (slide.content_elements || []).find((element) => element.element_id === instance.element_id) || null
}

export function slugifyId(value, fallback) {
  const slug = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
  return slug || fallback
}

function inferValueType(values) {
  const samples = (values || [])
    .map((value) => String(value ?? '').trim())
    .filter(Boolean)
  if (!samples.length) return 'text'
  const numeric = samples.every((value) => /^-?\d+(?:[.,]\d+)?%?$/.test(value.replace(/\s/g, '')))
  return numeric ? 'number' : 'text'
}

function uniqueColumnIds(labels) {
  const used = new Set()
  return labels.map((label, index) => {
    let id = slugifyId(label, `col_${index}`)
    let suffix = 2
    while (used.has(id)) {
      id = `${slugifyId(label, `col_${index}`)}_${suffix}`
      suffix += 1
    }
    used.add(id)
    return id
  })
}

function cloneValue(value) {
  if (typeof structuredClone === 'function') return structuredClone(value)
  return JSON.parse(JSON.stringify(value))
}

export function payloadKeyForComponent(component) {
  if (component.kind === 'metric' || component.source === 'metric') {
    return PAYLOAD_KEY_BY_KIND.metric
  }
  if (component.kind === 'paginator' || component.source === 'pagination') {
    return PAYLOAD_KEY_BY_KIND.paginator
  }
  if (component.kind === 'slide_title' || component.source === 'slide_title') {
    return PAYLOAD_KEY_BY_KIND.slide_title
  }
  if (component.kind === 'slide_description' || component.source === 'slide_description') {
    return PAYLOAD_KEY_BY_KIND.slide_description
  }
  if (component.kind === 'slide_image' || component.source === 'slide_image') {
    return PAYLOAD_KEY_BY_KIND.slide_image
  }
  if (component.source === 'spatial' || component.source === 'vgroups' || component.kind === 'container') {
    return PAYLOAD_KEY_BY_KIND.container
  }
  return PAYLOAD_KEY_BY_KIND[component.kind] || 'components'
}

export function normalizeModelPayload(payload) {
  const source = payload && typeof payload === 'object' ? payload : {}
  const normalized = {}
  for (const key of ITERABLE_PAYLOAD_KEYS) {
    if (Array.isArray(source[key])) normalized[key] = source[key]
  }
  return normalized
}

export function tableMatrixToDataPayload(rows, structure = {}, { componentId = null } = {}) {
  const matrix = Array.isArray(rows) ? rows : []
  if (!matrix.length) {
    return {
      component_id: componentId,
      title: null,
      text: null,
      columns: [],
      rows: [],
    }
  }

  const headerRowIndex = Number.isInteger(structure.header_row) ? structure.header_row : 0
  const headerCells = matrix[headerRowIndex] || matrix[0] || []
  const columnIds = uniqueColumnIds(headerCells.map((label, index) => label || `Column ${index + 1}`))
  const dataMatrix = matrix.slice(headerRowIndex + 1)

  const columns = headerCells.map((label, index) => ({
    id: columnIds[index],
    label: String(label ?? `Column ${index + 1}`),
    type: inferValueType(dataMatrix.map((row) => row?.[index])),
  }))

  const dataRows = dataMatrix.map((row) => {
    const record = {}
    columns.forEach((column, index) => {
      record[column.id] = row?.[index] ?? ''
    })
    return record
  })

  return {
    component_id: componentId,
    title: null,
    text: null,
    columns,
    rows: dataRows,
  }
}

export function tableDataToMatrix(data, structure = {}) {
  const columns = data?.columns || []
  const records = data?.rows || []
  if (!columns.length) return []

  const headerRowIndex = Number.isInteger(structure.header_row) ? structure.header_row : 0
  const headerRow = columns.map((column) => column.label ?? '')
  const bodyRows = records.map((record) => columns.map((column) => record?.[column.id] ?? ''))

  if (headerRowIndex === 0) return [headerRow, ...bodyRows]
  return bodyRows
}

export function applyTableDataToElement(element, data, { rowCount = null, colCount = null } = {}) {
  const next = cloneValue(element || {})
  const structure = next.table?.structure || {}
  const matrix = tableDataToMatrix(data, structure)
  const colCountResolved = colCount || matrix[0]?.length || columnsLength(data?.columns)
  const rowCountResolved = rowCount || matrix.length

  next.preview = matrix
  next.rows = rowCountResolved
  next.cols = colCountResolved
  next.table = {
    ...(next.table || {}),
    data_preview: { rows: matrix },
    structure: {
      ...(next.table?.structure || {}),
      header_row: Number.isInteger(structure.header_row) ? structure.header_row : 0,
    },
  }
  return resizeTableStructureMeta(next, rowCountResolved, colCountResolved, matrix)
}

function columnsLength(columns) {
  return Array.isArray(columns) ? columns.length : 0
}

export function chartElementToDataPayload(element, raw = {}, { componentId = null } = {}) {
  const chart = element?.chart || {}
  const categories = chart.categories_preview || raw.categories_preview || element?.categories_preview || []
  const seriesSource = chart.series || raw.series_preview || element?.series_preview || []
  const usedSeriesIds = new Set()

  const series = seriesSource.map((item, index) => {
    let id = slugifyId(item.name || item.label, `series_${index}`)
    let suffix = 2
    while (usedSeriesIds.has(id)) {
      id = `${slugifyId(item.name || item.label, `series_${index}`)}_${suffix}`
      suffix += 1
    }
    usedSeriesIds.add(id)
    const values = item.values_preview || item.values || []
    return {
      id,
      label: item.name || item.label || `Series ${index + 1}`,
      type: inferValueType(values),
      values,
    }
  })

  return {
    component_id: componentId,
    title: null,
    text: null,
    chart_type: chart.type || element?.chart_type || raw.chart_type || 'bar',
    categories,
    series,
  }
}

export function applyChartDataToElement(element, data) {
  const next = cloneValue(element || {})
  const series = (data?.series || []).map((item) => ({
    name: item.label || item.id,
    label: item.label || item.id,
    values_preview: item.values || [],
    values: item.values || [],
  }))

  next.chart_type = data?.chart_type || next.chart_type || next.chart?.type || 'bar'
  next.categories_preview = data?.categories || []
  next.series_preview = series
  next.chart = {
    ...(next.chart || {}),
    type: next.chart_type,
    categories_preview: data?.categories || [],
    series,
  }
  return next
}

export function diagramElementToDataPayload(element, raw = {}, { componentId = null } = {}) {
  const diagram = element?.diagram || {}
  const texts = diagram.preview_texts || raw.preview_texts || element?.preview_texts || []

  return {
    component_id: componentId,
    title: null,
    text: null,
    diagram_type: diagram.diagram_type || element?.diagram_type || raw.diagram_type || 'flow',
    nodes: texts.map((label, index) => ({
      id: slugifyId(label, `step_${index + 1}`),
      label: String(label ?? `Step ${index + 1}`),
    })),
  }
}

export function applyDiagramDataToElement(element, data) {
  const next = cloneValue(element || {})
  const labels = (data?.nodes || []).map((node) => String(node?.label ?? ''))

  next.diagram_type = data?.diagram_type || next.diagram_type || next.diagram?.diagram_type || 'flow'
  next.preview_texts = labels
  next.diagram = {
    ...(next.diagram || {}),
    diagram_type: next.diagram_type,
    preview_texts: labels,
  }
  return next
}

function slotValue(slot) {
  if (slot.text != null && String(slot.text).trim() !== '') return slot.text
  if (slot.preview_text != null && String(slot.preview_text).trim() !== '') return slot.preview_text
  if (slot.asset || slot.filename) return slot.asset || slot.filename
  return null
}

export function slideTitleToDataPayload(component, instance = null) {
  const defaults = defaultSlideTitleModel(component, instance)
  return {
    component_id: component.id,
    word_count: defaults.word_count,
    text: defaults.text,
    placement_id: defaults.placement_id,
    capacity: {
      min: component.capacity?.word_count_min || 1,
      max: component.capacity?.word_count_max || defaults.word_count,
    },
  }
}

export function slideDescriptionToDataPayload(component, instance = null, overrideText = null) {
  const defaults = defaultSlideDescriptionModel(component, instance, overrideText)
  return {
    component_id: component.id,
    word_count: defaults.word_count,
    text: defaults.text,
    placement_id: defaults.placement_id,
    capacity: {
      min: component.capacity?.word_count_min || 8,
      max: component.capacity?.word_count_max || defaults.word_count,
    },
  }
}

export function slideImageToDataPayload(component, instance = null) {
  const defaults = defaultSlideImageModel(component, instance)
  return {
    component_id: component.id,
    asset: defaults.asset,
    fill_mode: defaults.fill_mode,
    placement_id: defaults.placement_id,
  }
}

export function paginatorToDataPayload(component, instance = null) {
  const defaults = defaultPaginatorModel(component)
  const sample = instance || component.instances?.[0] || {}
  return {
    component_id: component.id,
    pagination_type: component.paginationType || component.raw?.pagination_type,
    page_count: sample.dot_count || defaults.page_count,
    active_index: sample.active_index ?? defaults.active_index,
    placement_id: component.defaultPlacementId || defaults.placement_id,
    capacity: {
      min: component.capacity?.dot_count_min || 2,
      max: component.capacity?.dot_count_max || 20,
    },
  }
}

export function containerInstanceToDataPayload(component, instance) {
  if (isIterableRepeatComponent(component)) {
    return containerModelToDataPayload(component, instance)
  }

  const raw = component.raw || {}
  const slots = instance?.slots || []
  const fields = {}

  for (const slot of slots) {
    const role = slot.role || slot.slot_id || 'field'
    fields[role] = slotValue(slot)
  }

  return {
    component_id: component.id,
    name: raw.name || component.name || null,
    title: fields.title || fields.heading || null,
    text: fields.description || fields.body || fields.text || fields.subtitle || null,
    fields,
  }
}

export function applyContainerDataToInstance(instance, data) {
  const next = cloneValue(instance || {})
  const fields = { ...(data?.fields || {}) }

  if (data?.title != null) fields.title = data.title
  if (data?.text != null) {
    fields.description = fields.description ?? data.text
    fields.body = fields.body ?? data.text
    fields.text = fields.text ?? data.text
  }

  next.slots = (next.slots || []).map((slot) => {
    const role = slot.role || slot.slot_id || 'field'
    if (fields[role] == null) return slot
    const isTextSlot = slot.kind === 'text' || ['title', 'description', 'list', 'body', 'subtitle', 'content', 'heading'].includes(role)
    if (isTextSlot) return { ...slot, text: typographRussianText(fields[role]) }
    if (slot.kind === 'image' || slot.kind === 'icon') return { ...slot, asset: fields[role], filename: fields[role] }
    return { ...slot, value: fields[role] }
  })

  return next
}

export function buildBaselineGraphicElement(report, component) {
  const slideSizePt = report?.typography?.visibility?.slide_size_pt || { width: 960, height: 540 }
  const widthPt = slideSizePt.width * 0.62
  const heightPt = slideSizePt.height * (component.kind === 'table' ? 0.42 : 0.48)
  const xPt = (slideSizePt.width - widthPt) / 2
  const yPt = (slideSizePt.height - heightPt) / 2
  const geometryPt = { x_pt: xPt, y_pt: yPt, width_pt: widthPt, height_pt: heightPt }
  const geometryNorm = {
    x: xPt / slideSizePt.width,
    y: yPt / slideSizePt.height,
    width: widthPt / slideSizePt.width,
    height: heightPt / slideSizePt.height,
  }
  const raw = component.raw || {}

  const base = {
    kind: component.kind,
    element_id: `${component.id}_baseline`,
    is_baseline: Boolean(raw.is_baseline ?? true),
    geometry_pt: geometryPt,
    geometry_norm: geometryNorm,
    z_index: 2,
  }

  if (component.kind === 'table') {
    return {
      ...base,
      rows: raw.default_size?.rows || 3,
      cols: raw.default_size?.cols || 3,
      table: {
        source: raw.table_source || 'native',
        structure: raw.structure || {},
        style_tokens: raw.style_tokens || {},
        column_widths_pt: raw.column_widths_pt || [],
        row_heights_pt: raw.row_heights_pt || [],
        data_preview: raw.data_preview || {},
        cell_text: raw.data_preview?.rows || [],
      },
      preview: raw.data_preview?.rows || [],
    }
  }

  if (component.kind === 'chart') {
    const rawStyle = raw.style_tokens || {}
    const circularLayout = rawStyle.circular_layout || {}
    return {
      ...base,
      chart_type: raw.chart_type || 'bar',
      subtype: raw.subtype || {},
      center_metric_preview: raw.center_metric_preview || circularLayout.center_metric?.preview || null,
      baseline_preview: raw.baseline_preview || null,
      chart: {
        type: raw.chart_type || 'bar',
        subtype: raw.subtype || {},
        series: raw.series_preview || [],
        categories_preview: raw.categories_preview || [],
        style_tokens: rawStyle,
        center_metric_preview: raw.center_metric_preview || circularLayout.center_metric?.preview || null,
      },
      series_preview: raw.series_preview || [],
      categories_preview: raw.categories_preview || [],
      style_tokens: rawStyle,
    }
  }

  if (component.kind === 'diagram') {
    const rawStyle = raw.style_tokens || {}
    return {
      ...base,
      diagram_type: raw.diagram_type || 'flow',
      deck_style_source: raw.deck_style_source || null,
      style_tokens: rawStyle,
      diagram: {
        diagram_type: raw.diagram_type || 'flow',
        layout_id: raw.layout_id || raw.diagram_type || 'flow',
        preview_texts: raw.preview_texts || [],
        style_tokens: rawStyle,
      },
      preview_texts: raw.preview_texts || [],
    }
  }

  return base
}

export function resolveComponentBaseElement(report, component, instance = null) {
  if (component.source === 'spatial' || component.source === 'vgroups') return null
  if (instance) {
    const element = findGraphicElement(report, instance)
    if (element) return cloneValue(element)
  }
  return buildBaselineGraphicElement(report, component)
}

export function componentToDataPayload(report, component, instance = null) {
  if (component.kind === 'paginator' || component.source === 'pagination') {
    return paginatorToDataPayload(component, instance)
  }
  if (component.kind === 'slide_title' || component.source === 'slide_title') {
    return slideTitleToDataPayload(component, instance)
  }
  if (component.kind === 'slide_description' || component.source === 'slide_description') {
    return slideDescriptionToDataPayload(component, instance)
  }
  if (component.kind === 'slide_image' || component.source === 'slide_image') {
    return slideImageToDataPayload(component, instance)
  }
  if (component.kind === 'metric' || component.source === 'metric') {
    const sample = instance || component.instances?.[0] || null
    return {
      component_id: component.id,
      pattern: component.pattern,
      metrics: (sample?.layout ? defaultMetricModel(component, sample).metrics : []),
      expanded: false,
    }
  }
  if (component.source === 'spatial' || component.source === 'vgroups') {
    if (!instance) {
      return {
        component_id: component.id,
        name: component.name || null,
        title: null,
        text: null,
        fields: {},
      }
    }
    return containerInstanceToDataPayload(component, instance)
  }

  const raw = component.raw || {}
  const element = resolveComponentBaseElement(report, component, instance)

  if (component.kind === 'table') {
    const rows = element?.preview || element?.table?.data_preview?.rows || raw.data_preview?.rows || []
    const structure = element?.table?.structure || raw.structure || {}
    const payload = tableMatrixToDataPayload(rows, structure, { componentId: component.id })
    const capacity = component.capacity || buildTableCapacity(component)
    return {
      ...payload,
      row_count: rows.length || capacity.row_count_typical,
      col_count: rows[0]?.length || capacity.col_count_typical,
    }
  }
  if (component.kind === 'chart') return chartElementToDataPayload(element, raw, { componentId: component.id })
  if (component.kind === 'diagram') return diagramElementToDataPayload(element, raw, { componentId: component.id })

  return { component_id: component.id, title: null, text: null, fields: {} }
}

export function buildComponentDataPayload(report, component, instance = null) {
  const payloadKey = payloadKeyForComponent(component)
  return {
    [payloadKey]: [componentToDataPayload(report, component, instance)],
  }
}

export function applyModelDataToComponent(component, dataItem, { report, instance = null, baseElement = null } = {}) {
  if (!component || !dataItem) {
    return { ok: false, reason: 'missing_component_or_data' }
  }

  if (component.kind === 'paginator' || component.source === 'pagination') {
    return {
      ok: true,
      kind: 'paginator',
      component_id: component.id,
      modelData: dataItem,
      meta: {
        page_count: dataItem.page_count,
        active_index: dataItem.active_index,
        placement_id: dataItem.placement_id,
      },
    }
  }

  if (component.kind === 'slide_title' || component.source === 'slide_title') {
    const phrase = component.defaultPhrase || component.default_phrase || component.raw?.default_phrase
    const wordCount = Number(dataItem.word_count) || defaultSlideTitleModel(component, instance).word_count
    const text = dataItem.text || buildTitleTextFromWords(phrase, wordCount)
    const modelData = {
      component_id: component.id,
      word_count: wordCount,
      text,
      placement_id: dataItem.placement_id ?? defaultSlideTitleModel(component, instance).placement_id,
    }
    return {
      ok: true,
      kind: 'slide_title',
      component_id: component.id,
      modelData,
      meta: {
        word_count: wordCount,
        text,
        placement_id: modelData.placement_id,
      },
    }
  }

  if (component.kind === 'slide_description' || component.source === 'slide_description') {
    const phrase = component.defaultPhrase || component.default_phrase || component.raw?.default_phrase
    const wordCount = Number(dataItem.word_count) || defaultSlideDescriptionModel(component, instance).word_count
    const text = dataItem.text || buildDescriptionTextFromWords(phrase, wordCount)
    const modelData = {
      component_id: component.id,
      word_count: wordCount,
      text,
      placement_id: dataItem.placement_id ?? defaultSlideDescriptionModel(component, instance).placement_id,
    }
    return {
      ok: true,
      kind: 'slide_description',
      component_id: component.id,
      modelData,
      meta: {
        word_count: wordCount,
        text,
        placement_id: modelData.placement_id,
      },
    }
  }

  if (component.kind === 'slide_image' || component.source === 'slide_image') {
    const defaults = defaultSlideImageModel(component, instance)
    const modelData = {
      component_id: component.id,
      asset: dataItem.asset ?? defaults.asset,
      fill_mode: dataItem.fill_mode ?? defaults.fill_mode,
      placement_id: dataItem.placement_id ?? defaults.placement_id,
    }
    return {
      ok: true,
      kind: 'slide_image',
      component_id: component.id,
      modelData,
      meta: {
        asset: modelData.asset,
        fill_mode: modelData.fill_mode,
        placement_id: modelData.placement_id,
      },
    }
  }

  if (component.source === 'spatial' || component.source === 'vgroups') {
    const sourceInstance = instance || component.instances?.[0] || { slots: [] }
    if (isIterableRepeatComponent(component) && dataItem?.item_count) {
      return {
        ok: true,
        kind: 'container',
        component_id: component.id,
        modelData: resizeContainerModel(dataItem, dataItem.item_count, component, sourceInstance),
        meta: {
          item_count: dataItem.item_count,
          layout: dataItem.layout || component.layout,
        },
      }
    }
    return {
      ok: true,
      kind: 'container',
      component_id: component.id,
      instance: applyContainerDataToInstance(sourceInstance, dataItem),
      meta: {
        title: dataItem.title ?? null,
        text: dataItem.text ?? null,
      },
    }
  }

  const element = baseElement || resolveComponentBaseElement(report, component, instance)
  if (!element) {
    return { ok: false, reason: 'missing_base_element', component_id: component.id }
  }

  if (component.kind === 'table') {
    const structure = component.raw?.structure || {}
    const capacity = component.capacity || buildTableCapacity(component)
    const rowCount = Number(dataItem.row_count) || capacity.row_count_typical
    const colCount = Number(dataItem.col_count) || capacity.col_count_typical
    const normalizedData = resizeTableModelData(
      { ...dataItem, component_id: component.id },
      rowCount,
      colCount,
      structure,
    )
    return {
      ok: true,
      kind: 'table',
      component_id: component.id,
      element: applyTableDataToElement(element, normalizedData, { rowCount, colCount }),
      modelData: normalizedData,
      meta: {
        row_count: rowCount,
        col_count: colCount,
        title: normalizedData.title ?? null,
        text: normalizedData.text ?? null,
      },
    }
  }

  if (component.kind === 'chart') {
    return {
      ok: true,
      kind: 'chart',
      component_id: component.id,
      element: applyChartDataToElement(element, dataItem),
      meta: { title: dataItem.title ?? null, text: dataItem.text ?? null },
    }
  }

  if (component.kind === 'diagram') {
    return {
      ok: true,
      kind: 'diagram',
      component_id: component.id,
      element: applyDiagramDataToElement(element, dataItem),
      meta: { title: dataItem.title ?? null, text: dataItem.text ?? null },
    }
  }

  return { ok: false, reason: 'unsupported_kind', component_id: component.id, kind: component.kind }
}

export function applyModelData(modelPayload, { report, components = null } = {}) {
  const payload = normalizeModelPayload(modelPayload)
  const catalog = components || listAllComponents(report)
  const byId = new Map(catalog.map((component) => [component.id, component]))
  const applied = []
  const skipped = []

  for (const key of ITERABLE_PAYLOAD_KEYS) {
    for (const item of payload[key] || []) {
      const componentId = item?.component_id
      const component = byId.get(componentId)
      if (!component) {
        skipped.push({ key, component_id: componentId, reason: 'unknown_component' })
        continue
      }

      const expectedKey = payloadKeyForComponent(component)
      if (expectedKey !== key) {
        skipped.push({
          key,
          component_id: componentId,
          reason: 'payload_key_mismatch',
          expected_key: expectedKey,
        })
        continue
      }

      const result = applyModelDataToComponent(component, item, { report })
      if (!result.ok) {
        skipped.push({ key, component_id: componentId, reason: result.reason })
        continue
      }

      applied.push({ key, ...result })
    }
  }

  return { applied, skipped, payload }
}

export function applyModelDataToSlide(slide, modelPayload, { report, components = null } = {}) {
  const { applied, skipped } = applyModelData(modelPayload, { report, components })
  const nextSlide = cloneValue(slide || {})
  const elements = [...(nextSlide.content_elements || [])]

  for (const item of applied) {
    if (item.kind === 'container') continue
    const instance = (components || listAllComponents(report))
      .find((component) => component.id === item.component_id)
      ?.instances?.[0]
    const elementId = instance?.element_id
    const index = elements.findIndex((element) => element.element_id === elementId)
    if (index >= 0) elements[index] = item.element
    else if (item.element) elements.push(item.element)
  }

  nextSlide.content_elements = elements
  return { slide: nextSlide, applied, skipped }
}
