import { buildContainerCapacity, isIterableRepeatComponent, sortInstancesForRepeatPreview } from './container-catalog.js'
import { inferComponentSemantics } from './component-semantics.js'
import { detectComponentsFromVgroups } from './from-vgroups.js'
import { listMetricComponents } from './metric-catalog.js'
import { listPaginationComponents } from './pagination-catalog.js'
import { listSlideImageComponents } from './image-catalog.js'
import { listSlideDescriptionComponents } from './slide-description-catalog.js'
import { listSlideTitleComponents } from './slide-title-catalog.js'
import { listSingletonComponents } from './singleton-catalog.js'
import { buildTableCapacity, listGraphicTables } from './table-catalog.js'
import {
  fittingTemplatesForComponent,
  getComponentTemplateRegistry,
  isRegistryComponent,
  lookupTemplateFit,
  templateAssetBoardPenalty,
} from '../presentation/component-template-fit.js'

const SPATIAL_LAYOUT_LABELS = {
  row: 'ряд',
  column: 'колонка',
  grid: 'сетка',
  single: 'одиночный',
}

const KIND_LABELS = {
  container: 'Контейнер',
  paginator: 'Пагинатор',
  slide_title: 'Заголовок',
  slide_description: 'Описание',
  slide_image: 'Изображение',
  singleton: 'Одиночный',
  metric: 'KPI',
  table: 'Таблица',
  chart: 'График',
  diagram: 'Диаграмма',
  quote: 'Цитата',
  snippet: 'Пример кода',
}

export const COMPONENT_GROUPS = [
  { id: 'all', label: 'Все' },
  { id: 'repeats', label: 'Повторы' },
  { id: 'metrics', label: 'Метрики' },
  { id: 'paginators', label: 'Пагинаторы' },
  { id: 'titles', label: 'Заголовки' },
  { id: 'text', label: 'Текст' },
  { id: 'images', label: 'Изображения' },
  { id: 'singletons', label: 'Одиночные' },
  { id: 'tables', label: 'Таблицы' },
  { id: 'charts', label: 'Графики' },
  { id: 'diagrams', label: 'Диаграммы' },
  { id: 'quotes', label: 'Цитаты' },
  { id: 'snippets', label: 'Код' },
]

const SOURCE_LABELS = {
  spatial: 'Spatial',
  vgroups: 'VGroups',
  pagination: 'Pagination',
  slide_title: 'Slide title',
  slide_description: 'Slide description',
  slide_image: 'Slide image',
  singleton: 'Singleton',
  metric: 'Metric layout',
  graphic: 'Graphic',
  narrative: 'Narrative',
}

let vgroupComponentCache = null
let vgroupComponentCacheReport = null
const allComponentsCache = new WeakMap()
const allComponentsWithoutMetricsCache = new WeakMap()

function getVgroupCatalog(report) {
  if (vgroupComponentCache && vgroupComponentCacheReport === report) {
    return vgroupComponentCache
  }
  vgroupComponentCache = detectComponentsFromVgroups(report)
  vgroupComponentCacheReport = report
  return vgroupComponentCache
}

export function primeVgroupComponents(report, catalog = null) {
  vgroupComponentCache = catalog
  vgroupComponentCacheReport = report
  if (report) {
    allComponentsCache.delete(report)
    allComponentsWithoutMetricsCache.delete(report)
  }
  return catalog
}

function slideByNumber(report, slideNumber) {
  return (report?.slides?.slides || []).find((slide) => slide.slide_number === slideNumber) || null
}

function templateLabel(report, templateId) {
  if (!templateId) return null
  const template = (report?.slide_templates?.templates || []).find((item) => item.template_id === templateId)
  return template?.layout_name || templateId
}

function normalizeSingletonComponent(component) {
  return {
    id: component.component_id,
    source: 'singleton',
    kind: 'singleton',
    group: 'singletons',
    pattern: component.pattern,
    isBaseline: false,
    name: component.name || component.component_id,
    label: component.label || component.name || component.component_id,
    variantSignature: component.pattern || component.component_id,
    description: 'Одиночный блок: фиксированное место на слайде, не размножается (спикер, список, текст).',
    frequency: component.frequency || {},
    templates: [...new Set((component.instances || []).map((item) => item.template_id).filter(Boolean))],
    layout: component.instances?.[0]?.layout || null,
    layoutCounts: {},
    container: component.container || {},
    containerBounds: component.container_bounds || null,
    capacity: component.capacity || {},
    behavior: component.behavior || {},
    textFields: component.text_fields || [],
    variants: [],
    slots: { required: [], optional: [] },
    instances: component.instances || [],
    raw: component,
  }
}

function normalizeSlideImageComponent(component) {
  return {
    id: component.component_id,
    source: 'slide_image',
    kind: 'slide_image',
    group: 'images',
    isBaseline: false,
    name: component.name || component.component_id,
    label: component.label || component.name || component.component_id,
    variantSignature: component.group_key || component.layout_pattern || component.component_id,
    layoutPattern: component.layout_pattern || null,
    hasDescription: Boolean(component.has_description),
    isBackground: Boolean(component.is_background),
    description: 'Hero-изображение на слайде: заголовок + крупная image-область; опционально описание. Фоновые full-bleed изображения тоже включаются.',
    frequency: component.frequency || {},
    templates: [...new Set((component.instances || []).map((item) => item.template_id).filter(Boolean))],
    layout: component.layout_pattern || null,
    layoutCounts: {},
    container: component.container || {},
    containerBounds: component.container_bounds || null,
    capacity: component.capacity || {},
    placements: component.placements || [],
    defaultPlacementId: component.default_placement_id || null,
    behavior: component.behavior || {},
    imageFields: component.image_fields || [],
    variants: component.placements || [],
    slots: { required: [{ kind: 'image', role: 'image' }], optional: [] },
    instances: component.instances || [],
    raw: component,
  }
}

function normalizeSlideDescriptionComponent(component) {
  return {
    id: component.component_id,
    source: 'slide_description',
    kind: 'slide_description',
    group: 'text',
    isBaseline: false,
    name: component.name || component.component_id,
    label: component.label || component.name || component.component_id,
    variantSignature: component.component_id,
    description: 'Описание/абзац под заголовком: длинный текст, списки и пояснения рядом с title, не repeat.',
    frequency: component.frequency || {},
    templates: [...new Set((component.instances || []).map((item) => item.template_id).filter(Boolean))],
    layout: null,
    layoutCounts: {},
    container: component.container || {},
    containerBounds: component.container_bounds || null,
    capacity: component.capacity || {},
    typography: component.typography || {},
    defaultPhrase: component.default_phrase || null,
    placements: component.placements || [],
    defaultPlacementId: component.default_placement_id || null,
    behavior: component.behavior || {},
    synthetic: Boolean(component.synthetic),
    textFields: component.text_fields || [],
    variants: component.placements || [],
    slots: { required: [], optional: [] },
    instances: component.instances || [],
    raw: component,
  }
}

function normalizeSlideTitleComponent(component) {
  return {
    id: component.component_id,
    source: 'slide_title',
    kind: 'slide_title',
    group: 'titles',
    isBaseline: false,
    name: component.name || component.component_id,
    label: component.label || component.name || component.component_id,
    variantSignature: component.component_id,
    description: 'Заголовок слайда: absolute placement из content_elements, ёмкость текста и playground.',
    frequency: component.frequency || {},
    templates: [...new Set((component.instances || []).map((item) => item.template_id).filter(Boolean))],
    layout: null,
    layoutCounts: {},
    container: component.container || {},
    containerBounds: component.container_bounds || null,
    capacity: component.capacity || {},
    typography: component.typography || {},
    defaultPhrase: component.default_phrase || null,
    placements: component.placements || [],
    defaultPlacementId: component.default_placement_id || null,
    behavior: component.behavior || {},
    textFields: component.text_fields || [],
    variants: component.placements || [],
    slots: { required: [], optional: [] },
    instances: component.instances || [],
    raw: component,
  }
}

function preferNonAssetTemplates(report, component) {
  if (!['slide_title', 'slide_description'].includes(component?.kind)) return component
  const templates = (component.templates || []).filter(Boolean)
  if (!templates.length) return component
  const normalTemplates = templates.filter((templateId) => templateAssetBoardPenalty(report, templateId) <= 0)
  if (normalTemplates.length === templates.length) return component
  if (!normalTemplates.length) return null

  const allowed = new Set(normalTemplates)
  const instances = (component.instances || []).filter((instance) => (
    !instance.template_id || allowed.has(instance.template_id)
  ))
  if (!instances.length) return null
  const placements = (component.placements || []).filter((placement) => (
    !placement.template_id || allowed.has(placement.template_id)
  ))
  const defaultPlacementId = placements.some((item) => item.id === component.defaultPlacementId)
    ? component.defaultPlacementId
    : placements[0]?.id || component.defaultPlacementId
  return {
    ...component,
    templates: normalTemplates,
    instances,
    placements,
    defaultPlacementId,
    assetTemplateSuppression: {
      removed_templates: templates.filter((templateId) => !allowed.has(templateId)),
      reason: 'asset_board_template',
    },
  }
}

function normalizePaginationComponent(component) {
  return {
    id: component.component_id,
    source: 'pagination',
    kind: 'paginator',
    group: 'paginators',
    isBaseline: false,
    name: component.name || component.component_id,
    label: component.label || component.name || component.component_id,
    variantSignature: component.component_id,
    paginationType: component.pagination_type,
    description: 'Пагинатор: active state, варианты размещения, max dots/pages и playground.',
    frequency: component.frequency || {},
    templates: [...new Set((component.instances || []).map((item) => item.template_id).filter(Boolean))],
    layout: component.behavior?.progression || null,
    layoutCounts: {},
    container: component.container || {},
    containerBounds: component.container_bounds || null,
    containerMax: component.container_bounds?.max || {},
    capacity: component.capacity || {},
    behavior: component.behavior || {},
    styleTokens: component.style_tokens || {},
    placements: component.placements || [],
    defaultPlacementId: component.default_placement_id || null,
    iterability: component.iterability || null,
    textFields: component.text_fields || [],
    variants: component.variants || [],
    slots: { required: [], optional: [] },
    instances: component.instances || [],
    confidence: component.confidence || 0,
    raw: component,
  }
}

function normalizeSpatialComponent(component, { source = 'spatial' } = {}) {
  const capacity = buildContainerCapacity({ ...component, id: component.component_id, instances: component.instances || [] })
  const normalized = {
    id: component.component_id,
    source,
    kind: 'container',
    isBaseline: false,
    name: component.name || component.label || component.component_id,
    label: component.label || component.name || component.component_id,
    variantSignature: component.variant_signature || component.signature || component.component_id,
    description: source === 'vgroups'
      ? 'Повторяющийся блок из Visual groups: XY-cut, repeat/grid и structural signature.'
      : 'Повторяющийся контейнер: одинаковая геометрия и набор слотов (required ≥75%, optional ≥25%).',
    frequency: component.frequency || {},
    templates: [],
    layout: component.layout,
    layoutCounts: component.layout_counts || {},
    container: component.container || {},
    containerBounds: component.container_bounds || null,
    containerMax: component.container_max || component.container_bounds?.max || {},
    capacity,
    iterability: component.iterability || null,
    textFields: component.text_fields || [],
    variants: component.variants || [],
    slots: component.slots || { required: [], optional: [] },
    instances: component.instances || [],
    raw: component,
  }
  normalized.group = componentGroupId(normalized)
  normalized.semantics = inferComponentSemantics(normalized)
  return normalized
}

function graphicComponentLabel(component, kind) {
  if (component.is_baseline) {
    const detail = component.chart_type
      || component.diagram_type
      || component.table_source
      || kind
    return `${KIND_LABELS[kind] || kind} · baseline · ${detail}`
  }
  if (kind === 'table' && component.table_source === 'inferred_grid') {
    return `${KIND_LABELS[kind] || kind} · псевдотаблица · ${component.component_id}`
  }
  return `${KIND_LABELS[kind] || kind} · ${component.component_id}`
}

function normalizeMetricCatalogComponent(component) {
  const placement = component.placement || component.instances?.[0] || null
  return {
    id: component.component_id,
    source: 'metric',
    kind: 'metric',
    group: 'metrics',
    pattern: component.pattern,
    name: component.name || component.pattern,
    label: component.label,
    variantSignature: placement?.layout_key || component.pattern,
    description: 'KPI-раскладка из vgroup flex: preview собирает карточки через flex row/column в рамке компонента.',
    frequency: component.frequency || {},
    templates: placement?.template_id ? [placement.template_id] : [],
    layout: component.layout || null,
    layoutCounts: {},
    container: component.container || placement?.container || {},
    container_norm: component.container_norm || placement?.container_norm || null,
    capacity: component.capacity || {},
    slots: { required: [], optional: [] },
    behavior: component.behavior || {},
    placement,
    instances: placement ? [placement] : [],
    raw: component,
  }
}

function componentGroupId(component) {
  if (component.kind === 'metric' || component.source === 'metric') return 'metrics'
  if (component.kind === 'paginator') return 'paginators'
  if (component.kind === 'slide_title') return 'titles'
  if (component.kind === 'slide_description') return 'text'
  if (component.kind === 'slide_image') return 'images'
  if (component.kind === 'singleton') return 'singletons'
  if (isIterableRepeatComponent(component)) return 'repeats'
  if (component.source === 'spatial' || component.source === 'vgroups' || component.kind === 'container') return 'containers'
  if (component.kind === 'table') return 'tables'
  if (component.kind === 'chart') return 'charts'
  if (component.kind === 'diagram') return 'diagrams'
  if (component.kind === 'quote') return 'quotes'
  if (component.kind === 'snippet') return 'snippets'
  return 'containers'
}

function normalizeNarrativeComponent(component, kind) {
  const style = component.style_tokens || {}
  return {
    id: component.component_id,
    source: 'narrative',
    kind,
    group: kind === 'quote' ? 'quotes' : 'snippets',
    isBaseline: Boolean(component.is_baseline),
    name: component.label || kind,
    label: component.is_baseline
      ? `${KIND_LABELS[kind] || kind} · baseline`
      : `${KIND_LABELS[kind] || kind} · ${component.component_id}`,
    variantSignature: component.variant_signature || component.component_id,
    description: kind === 'quote'
      ? 'Цитата: декоративные кавычки шаблона или кавычки в длинном тексте. Шаблон слайда помечен как шаблон цитаты.'
      : 'Пример кода: длинный текст, похожий на код, с несколькими цветами подсветки. Шаблон слайда помечен как шаблон сниппета.',
    frequency: component.frequency || {},
    templates: component.frequency?.template_ids || [],
    layout: null,
    layoutCounts: {},
    container: component.instances?.[0]?.container || {},
    container_norm: component.instances?.[0]?.container_norm || null,
    capacity: {},
    slots: { required: [], optional: [] },
    instances: component.instances || [],
    styleTokens: style,
    textFields: component.text_fields || [],
    raw: component,
  }
}

function normalizeGraphicComponent(component, kind, report) {
  const capacity = kind === 'table' ? buildTableCapacity({ raw: component }) : null
  const previewSlide = slideByNumber(report, component.baseline_preview?.slide_number)
  const templates = [...new Set([
    ...(component.frequency?.template_ids || []),
    ...(previewSlide?.template_id ? [previewSlide.template_id] : []),
  ])]
  return {
    id: component.component_id,
    source: 'graphic',
    kind,
    group: kind === 'table' ? 'tables' : kind === 'chart' ? 'charts' : 'diagrams',
    isBaseline: Boolean(component.is_baseline),
    chartType: component.chart_type || null,
    diagramType: component.diagram_type || null,
    tableSource: component.table_source || null,
    name: component.chart_type || component.diagram_type || kind,
    label: graphicComponentLabel(component, kind),
    variantSignature: component.variant_signature || component.component_id,
    description: kind === 'table'
      ? 'Таблица: стиль и структура из OOXML, playground меняет rows/cols и data.'
      : 'Graphic frame: стиль и структура из OOXML, контент — preview/data.',
    frequency: component.frequency || {},
    templates,
    layout: null,
    layoutCounts: {},
    container: {
      rows: capacity?.row_count_typical || component.default_size?.rows,
      cols: capacity?.col_count_typical || component.default_size?.cols,
    },
    capacity,
    slots: { required: [], optional: [] },
    instances: component.instances || [],
    styleTokens: component.style_tokens || {},
    dsBinding: component.ds_binding || null,
    raw: component,
  }
}

export function getVgroupComponentSummary(report) {
  return getVgroupCatalog(report)?.summary || {}
}

export function countRepeatComponents(report) {
  return listAllComponents(report).filter((item) => item.group === 'repeats').length
}

export function countAllComponents(report) {
  const items = listAllComponents(report)
  return items.filter((item) => item.group !== 'repeats').length
}

export { decomposeDeck, decomposeSlide, decomposeSlideByNumber } from '../slides/slide-decomposition.js'

export function listAllComponents(report, options = {}) {
  const skipMetrics = Boolean(options.skipMetrics)
  const resultCache = skipMetrics ? allComponentsWithoutMetricsCache : allComponentsCache
  if (report && resultCache.has(report)) return resultCache.get(report)
  const items = []
  const vgroupCatalog = getVgroupCatalog(report)
  for (const component of vgroupCatalog?.components || []) {
    const normalized = normalizeSpatialComponent(component, { source: 'vgroups' })
    normalized.instances = (component.instances || []).map((instance) => ({
      ...instance,
      template_id: slideByNumber(report, instance.slide_number)?.template_id || null,
    }))
    normalized.templates = [...new Set(normalized.instances.map((item) => item.template_id).filter(Boolean))]
    items.push(normalized)
  }

  for (const component of listPaginationComponents(report)) {
    items.push(normalizePaginationComponent(component))
  }

  for (const component of listSlideTitleComponents(report)) {
    items.push(normalizeSlideTitleComponent(component))
  }

  for (const component of listSlideDescriptionComponents(report)) {
    items.push(normalizeSlideDescriptionComponent(component))
  }

  for (const component of listSlideImageComponents(report)) {
    items.push(normalizeSlideImageComponent(component))
  }

  for (const component of listSingletonComponents(report)) {
    if (component.pattern === 'metric_card') continue
    items.push(normalizeSingletonComponent(component))
  }

  if (!skipMetrics) {
    for (const component of listMetricComponents(report)) {
      items.push(normalizeMetricCatalogComponent(component))
    }
  }

  const graphic = report?.graphic_components || {}
  for (const component of listGraphicTables(report)) {
    items.push(normalizeGraphicComponent(component, 'table', report))
  }
  for (const component of graphic.charts || []) {
    items.push(normalizeGraphicComponent(component, 'chart', report))
  }
  for (const component of graphic.diagrams || []) {
    items.push(normalizeGraphicComponent(component, 'diagram', report))
  }

  const narrative = report?.narrative_components || {}
  for (const component of narrative.quotes || []) {
    items.push(normalizeNarrativeComponent(component, 'quote'))
  }
  for (const component of narrative.snippets || []) {
    items.push(normalizeNarrativeComponent(component, 'snippet'))
  }

  const cleanedItems = items
    .map((component) => preferNonAssetTemplates(report, component))
    .filter(Boolean)

  const result = cleanedItems.sort((left, right) => (
    Number(Boolean(right.isBaseline)) - Number(Boolean(left.isBaseline))
    || (right.frequency?.instance_count || 0) - (left.frequency?.instance_count || 0)
    || left.label.localeCompare(right.label, 'ru')
  ))
  attachFittingTemplates(report, result)
  if (report) resultCache.set(report, result)
  return result
}

function attachFittingTemplates(report, components) {
  const registry = report ? getComponentTemplateRegistry(report, components) : null
  for (const component of components) {
    if (!isRegistryComponent(component)) {
      component.fitting_templates = []
      continue
    }
    const entry = lookupTemplateFit(registry, component.id)
    component.fitting_templates = fittingTemplatesForComponent(entry, component.templates)
  }
}

export function filterComponentsByGroup(components, groupId = 'all', options = {}) {
  const excludeGroups = options.excludeGroups || []
  let items = components || []
  if (excludeGroups.length) {
    items = items.filter((item) => !excludeGroups.includes(item.group))
  }
  if (!groupId || groupId === 'all') return items
  return items.filter((item) => item.group === groupId)
}

export function listComponentGroups(report, components = null, options = {}) {
  const excludeGroups = options.excludeGroups || []
  const items = (components || listAllComponents(report))
    .filter((item) => !excludeGroups.includes(item.group))
  const groupDefs = excludeGroups.length
    ? COMPONENT_GROUPS.filter((group) => !excludeGroups.includes(group.id))
    : COMPONENT_GROUPS
  const counts = new Map(groupDefs.map((group) => [group.id, 0]))
  counts.set('all', items.length)
  items.forEach((item) => {
    counts.set(item.group, (counts.get(item.group) || 0) + 1)
  })
  return groupDefs.map((group) => ({
    ...group,
    count: counts.get(group.id) || 0,
  }))
}

export function findComponent(report, componentId) {
  return listAllComponents(report).find((item) => item.id === componentId) || null
}

export function getInstanceBBox(instance) {
  if (instance?.container?.width_pt && instance.container.height_pt) {
    return {
      x_pt: instance.container.x_pt || 0,
      y_pt: instance.container.y_pt || 0,
      width_pt: instance.container.width_pt,
      height_pt: instance.container.height_pt,
    }
  }
  if (instance?.geometry_pt?.width_pt) {
    return {
      x_pt: instance.geometry_pt.x_pt || 0,
      y_pt: instance.geometry_pt.y_pt || 0,
      width_pt: instance.geometry_pt.width_pt,
      height_pt: instance.geometry_pt.height_pt,
    }
  }
  return null
}

function median(values) {
  const sorted = values.filter((value) => Number.isFinite(value)).sort((left, right) => left - right)
  if (!sorted.length) return null
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

export function filterInstancesByTemplate(instances, templateId) {
  if (!templateId) return instances || []
  return (instances || []).filter((item) => item.template_id === templateId)
}

export function listComponentTemplates(report, component) {
  const counts = new Map()
  for (const instance of component.instances || []) {
    const templateId = instance.template_id || slideByNumber(report, instance.slide_number)?.template_id
    if (!templateId) continue
    counts.set(templateId, (counts.get(templateId) || 0) + 1)
  }
  return [...counts.entries()]
    .map(([templateId, count]) => ({
      templateId,
      label: templateLabel(report, templateId) || templateId,
      count,
    }))
    .sort((left, right) => right.count - left.count || left.label.localeCompare(right.label, 'ru'))
}

export function resolveComponentTemplateId(component, templateId) {
  const templates = (component.templates || []).filter(Boolean)
  if (templateId && templates.includes(templateId)) return templateId
  return templates[0] || null
}

export function getTypicalBBox(instances, slideSizePt) {
  const boxes = (instances || []).map((instance) => getInstanceBBox(instance)).filter(Boolean)
  if (!boxes.length) return null
  const widthPt = slideSizePt?.width || 960
  const heightPt = slideSizePt?.height || 540
  const bboxPt = {
    x_pt: median(boxes.map((item) => item.x_pt)) ?? 0,
    y_pt: median(boxes.map((item) => item.y_pt)) ?? 0,
    width_pt: median(boxes.map((item) => item.width_pt)) ?? widthPt,
    height_pt: median(boxes.map((item) => item.height_pt)) ?? heightPt,
  }
  return {
    bboxPt,
    bboxNorm: {
      x: bboxPt.x_pt / widthPt,
      y: bboxPt.y_pt / heightPt,
      width: bboxPt.width_pt / widthPt,
      height: bboxPt.height_pt / heightPt,
    },
  }
}

export function resolveComponentPreviewContext(report, component, { templateId = null, instanceIndex = 0 } = {}) {
  const templates = listComponentTemplates(report, component)
  const resolvedTemplateId = resolveComponentTemplateId(component, templateId)
  let instances = filterInstancesByTemplate(component.instances || [], resolvedTemplateId)
  if (isIterableRepeatComponent(component)) {
    instances = sortInstancesForRepeatPreview(instances)
  }
  const safeIndex = Math.max(0, Math.min(Number.isFinite(instanceIndex) ? instanceIndex : 0, Math.max(instances.length - 1, 0)))
  const instance = instances[safeIndex] || null
  return {
    templates,
    templateId: resolvedTemplateId,
    instances,
    instanceIndex: safeIndex,
    instance,
  }
}

export function findSlide(report, slideNumber) {
  return slideByNumber(report, slideNumber)
}

export function componentKindLabel(kind) {
  return KIND_LABELS[kind] || kind
}

export function componentSourceLabel(source) {
  return SOURCE_LABELS[source] || source
}

export function layoutLabel(layout) {
  return SPATIAL_LAYOUT_LABELS[layout] || layout || '—'
}

export function componentIntro(component, report) {
  const freq = component.frequency || {}
  const templates = (component.templates || [])
    .map((id) => templateLabel(report, id) || id)
    .slice(0, 3)
    .join(', ')
  const size = component.kind === 'metric'
    ? `${component.capacity?.item_count_typical || '—'} KPI · max ${component.capacity?.item_count_max || '—'}`
    : component.kind === 'slide_title' || component.kind === 'slide_description'
    ? `${component.capacity?.word_count_typical || '—'} words · max ${component.capacity?.word_count_max || '—'} · ${Math.round(component.typography?.dominant_size_pt || 0)} pt`
    : component.kind === 'slide_image'
    ? `${Math.round((component.capacity?.image_width_typical || 0) * 100)}×${Math.round((component.capacity?.image_height_typical || 0) * 100)}% · ${component.layoutPattern || 'hero'}`
    : component.kind === 'paginator'
    ? `${component.capacity?.dot_count_typical || '—'} dots · observed max ${component.capacity?.dot_count_observed_max || '—'} · abs max ${component.capacity?.dot_count_max || '—'}`
    : (component.source === 'spatial' || component.source === 'vgroups')
      ? `${Math.round(component.container?.width_pt || 0)}×${Math.round(component.container?.height_pt || 0)} pt`
    : component.kind === 'table'
      ? `${component.capacity?.row_count_typical || component.container?.rows || '—'}×${component.capacity?.col_count_typical || component.container?.cols || '—'} · max ${component.capacity?.row_count_max || '—'}×${component.capacity?.col_count_max || '—'}`
      : component.kind
  const maxPart = component.source === 'vgroups' && component.containerMax?.width_pt
    ? ` · max ${Math.round(component.containerMax.width_pt)}×${Math.round(component.containerMax.height_pt || 0)} pt · ≤${component.containerMax.element_count || '—'} el`
    : ''
  const iterablePart = component.source === 'vgroups' && component.iterability
    ? ` · ${component.iterability.is_iterable ? 'iterable' : 'fixed'} (${component.iterability.method})`
    : ''
  const layoutPart = component.layout ? ` · layout ${layoutLabel(component.layout)}` : ''
  const templatePart = templates ? ` · шаблоны: ${templates}` : ''
  const baselinePart = component.isBaseline ? ' · baseline DS' : ''
  const shellPreview = component.raw?.baseline_preview
  const shellPart = shellPreview?.layout_name
    ? ` · shell: ${shellPreview.layout_name} (${shellPreview.match_strategy})`
    : ''
  return `${componentKindLabel(component.kind)} · ${size}${maxPart}${iterablePart}${layoutPart} · ${freq.instance_count || 0} экз. на ${freq.slide_count || freq.slide_numbers?.length || 0} слайдах${baselinePart}${shellPart}${templatePart}`
}

export function componentVariabilityNote(component) {
  if (component.kind === 'metric' || component.source === 'metric') {
    const rowTile = component.behavior?.row_tile_capacity
    const tilePart = rowTile > 1 ? ` · до ${rowTile} KPI в ряд по ширине слайда` : ''
    return `KPI-раскладка «${component.label}» · flex ${layoutLabel(component.layout)} · playground меняет metrics[] · preview = flex-сборка в рамке${tilePart}.`
  }
  if (component.source === 'graphic') {
    if (component.kind === 'table') {
      return `Таблица: signature «${component.variantSignature}» · known ${component.capacity?.row_count_known || '—'}×${component.capacity?.col_count_known || '—'} · playground меняет rows/cols и data.`
    }
    return `Вариант определяется signature «${component.variantSignature}»: тип, подтип и palette/style tokens из PPTX.`
  }
  if (component.kind === 'slide_title') {
    return `Заголовок: absolute placement из content_elements · typical ${component.capacity?.word_count_typical || '—'} words · max ${component.capacity?.word_count_max || '—'} · playground наполняет дефолтной фразой.`
  }
  if (component.kind === 'slide_description') {
    if (component.synthetic || component.raw?.synthetic) {
      return `Описание · synthetic · bbox из vertical repeat · typography из design system · playground наполняет дефолтным текстом.`
    }
    return `Описание: абзац/список под заголовком · typical ${component.capacity?.word_count_typical || '—'} words · max ${component.capacity?.word_count_max || '—'} · playground наполняет дефолтным текстом.`
  }
  if (component.kind === 'slide_image') {
    const descPart = component.hasDescription ? ' · с описанием' : ''
    return `Hero-изображение: ${component.layoutPattern || 'title + image'}${descPart} · preview = заголовок + image area · asset из content_elements.`
  }
  if (component.kind === 'paginator') {
    const placements = component.placements?.length || 0
    const variants = component.variants?.length || 0
    const active = component.behavior?.active_reason || '—'
    return `Пагинатор: координаты = absolute из content_elements (+ vgroup row как metadata) · active via ${active} · ${variants} реальных placements · synthetic presets только для playground.`
  }
  if (isIterableRepeatComponent(component)) {
    const textFieldCount = component.textFields?.length || 0
    const textPart = textFieldCount ? ` · ${textFieldCount} text fields` : ''
    return `Контейнер: signature «${component.variantSignature}» · known ${component.capacity?.item_count_known || '—'} items · max ${component.capacity?.item_count_max || '—'}${textPart} · playground меняет количество повторов и text data.`
  }
  const required = component.slots?.required?.length || 0
  const optional = component.slots?.optional?.length || 0
  const variantCount = component.variants?.length || component.raw?.variants?.length || 0
  const textFieldCount = component.textFields?.length || 0
  const variantPart = variantCount ? ` · ${variantCount} variants` : ''
  const textPart = textFieldCount ? ` · ${textFieldCount} text fields` : ''
  const iterPart = component.iterability?.is_iterable
    ? ` · iterable (${Math.round((component.iterability.confidence || 0) * 100)}%)`
    : component.source === 'vgroups'
      ? ' · not iterable'
      : ''
  const methodPart = component.source === 'vgroups'
    ? ` · signature «${component.variantSignature}»`
    : component.raw?.source === 'visual_atom'
      ? ' · visual atom match'
      : ''
  return `Вариант = схема слотов (${required} required, ${optional} optional) + layout «${layoutLabel(component.layout)}»${variantPart}${textPart}${iterPart}${methodPart}. Optional-слоты и разброс позиций — вариативность между экземплярами.`
}
