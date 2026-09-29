import {
  componentIntro,
  componentKindLabel,
  componentSourceLabel,
  componentVariabilityNote,
  filterComponentsByGroup,
  layoutLabel,
  listAllComponents,
  listComponentGroups,
  getVgroupComponentSummary,
  resolveComponentPreviewContext,
  resolveComponentTemplateId,
} from './catalog.js'
import {
  buildComponentInputJson,
  componentInputJsonCaption,
  componentInputJsonTitle,
  formatComponentInputJson,
} from './input-json.js'
import {
  CONTEXT_BLOCK_INTENTS,
  repeatSemanticsLegend,
  roleLabel,
} from './component-semantics.js'
import {
  buildContainerCapacityForInstance,
  defaultContainerModel,
  isIterableRepeatComponent,
  resolveRepeatPlaygroundAnchor,
  resizeContainerModel,
  sortInstancesForRepeatPreview,
} from './container-catalog.js'
import { payloadKeyForComponent } from './model-data.js'
import { defaultPaginatorModel } from './pagination-catalog.js'
import {
  buildTitleTextFromWords,
  defaultSlideTitleModel,
} from './slide-title-catalog.js'
import {
  buildDescriptionTextFromWords,
  defaultSlideDescriptionModel,
} from './slide-description-catalog.js'
import { defaultSlideImageModel } from './image-catalog.js'
import {
  defaultTableModel,
  resizeTableModelData,
} from './table-catalog.js'
import {
  defaultMetricModel,
  resizeMetricModel,
} from './metric-catalog.js'
import { METRIC_PATTERNS } from '../slides/metric-detect.js'
import { mountComponentPreview, mountSlidePreview } from './render.js'
import { buildComponentOnTemplatePreview } from './fit-template-preview.js'
import {
  PLACEMENT_AXIS_LABELS,
  getComponentTemplateRegistry,
  isRegistryComponent,
  lookupTemplateFit,
  placementFailLabel,
  placementFitLabel,
} from '../presentation/component-template-fit.js'

export function captureComponentDetailScroll(root, state) {
  if (!root || !state) return
  const detail = root.querySelector('.component-detail-panel')
  if (!detail) return
  state.componentDetailScroll = {
    top: detail.scrollTop,
    componentId: state.selectedComponent,
    groupFilter: state.componentGroupFilter || 'all',
    tab: state.tab || 'components',
  }
}

function restoreComponentDetailScroll(detail, state) {
  const saved = state?.componentDetailScroll
  if (!detail || !saved) return
  if (saved.componentId !== state.selectedComponent) return
  if (saved.groupFilter !== (state.componentGroupFilter || 'all')) return
  if (saved.tab !== (state.tab || 'components')) return
  const applyScroll = () => {
    detail.scrollTop = saved.top
  }
  applyScroll()
  requestAnimationFrame(applyScroll)
}

export function clearComponentDetailScroll(state) {
  if (state) state.componentDetailScroll = null
}

const SLOT_ROLE_LABELS = {
  title: 'Заголовок',
  subtitle: 'Подзаголовок',
  heading: 'Заголовок',
  body: 'Текст',
  description: 'Описание',
  text: 'Текст',
  content: 'Контент',
  list: 'Список',
  caption: 'Подпись',
  label: 'Метка',
  icon: 'Иконка',
  image: 'Изображение',
  background_image: 'Фон',
}

const ITERABILITY_METHOD_LABELS = {
  repeat_grid: 'repeat grid',
  repeat_series: 'repeat series',
  cross_slide: 'cross-slide',
  deck_repeat: 'deck repeat',
  cross_slide_progression: 'cross-slide progression',
  pagination_pattern: 'pagination pattern',
  none: 'нет',
}

function renderPlacementRegistry(detail, report, component, components, helpers) {
  if (!isRegistryComponent(component)) return
  const { node, append, dataTable } = helpers
  const entry = lookupTemplateFit(getComponentTemplateRegistry(report, components), component.id)
  if (!entry) return

  const block = append(
    node('section', 'content-block component-profile-panel'),
    node('h4', '', 'Реестр размещения'),
  )
  const axis = PLACEMENT_AXIS_LABELS[entry.axis] || 'как есть'
  const summary = entry.summary || {}
  block.append(node(
    'p',
    'component-variability-note',
    summary.accepted_count
      ? `Встаёт в ${summary.accepted_count} из ${summary.template_count} шаблонов, максимум ${summary.max_count} · ${axis}. Одна копия на картинке шаблона отбрасывает шаблон сразу.`
      : `Ни в один из ${summary.template_count} шаблонов не встаёт: одиночная копия не проходит хит-тест.`,
  ))
  if (!entry.templates?.length) {
    block.append(node('p', 'heatmap-note', 'В отчёте нет шаблонов.'))
    detail.append(block)
    return
  }
  block.append(dataTable(
    ['Шаблон', 'Копий', 'Почему дальше нельзя'],
    entry.templates.map((item) => [
      item.template_label,
      placementFitLabel(item),
      placementFailLabel(item),
    ]),
  ))
  detail.append(block)
}

function fitPreviewCount(state, component, fit) {
  const stored = state.componentFitCounts?.[component.id]?.[fit.template_id]
  const fallback = state.componentModelData?.item_count || fit.max_count
  const count = Number.isFinite(Number(stored)) ? Number(stored) : Number(fallback)
  return Math.max(1, Math.min(fit.max_count, Number.isFinite(count) ? count : 1))
}

function repeatModelForFit(component, instance, baseModel, count) {
  if (!isIterableRepeatComponent(component) || !baseModel) return baseModel
  const resized = resizeContainerModel(baseModel, count, component, instance)
  return {
    ...resized,
    item_count: count,
    items: (resized.items || []).slice(0, count),
  }
}

function renderFittingTemplatePreviews(parent, report, jobId, component, state, previewContext, renderPanel, helpers) {
  const fits = component.fitting_templates || []
  if (!isRegistryComponent(component)) return
  const { node, append } = helpers
  const block = append(
    node('section', 'content-block component-fit-previews'),
    node('h4', '', 'Подходящие шаблоны'),
  )
  if (!fits.length) {
    block.append(node('p', 'heatmap-note', 'Других шаблонов, куда компонент встаёт своим bbox, нет.'))
    parent.append(block)
    return
  }
  block.append(node(
    'p',
    'heatmap-note',
    'Вёрстка сдвигается целиком и сохраняет пропорции. Если экземпляр не входит в bbox рядом с заголовком, шаблон не подходит.',
  ))

  const repeatable = isIterableRepeatComponent(component)
  let shown = 0
  for (const fit of fits) {
    const card = node('article', 'component-fit-preview')
    const count = repeatable ? fitPreviewCount(state, component, fit) : 1
    card.append(node(
      'h5',
      'component-fit-preview-title',
      repeatable
        ? `${fit.template_label} · до ${fit.max_count}`
        : fit.template_label,
    ))
    if (repeatable && fit.max_count > 1) {
      const label = node('label', 'component-playground-label', `Количество · ${count}`)
      const input = node('input', 'component-playground-range')
      input.type = 'range'
      input.min = '1'
      input.max = String(fit.max_count)
      input.value = String(count)
      input.addEventListener('input', () => {
        const next = Number(input.value)
        state.componentFitCounts = state.componentFitCounts || {}
        state.componentFitCounts[component.id] = state.componentFitCounts[component.id] || {}
        state.componentFitCounts[component.id][fit.template_id] = next
        label.textContent = `Количество · ${next}`
        renderPanel()
      })
      card.append(label, input)
    }
    const shell = node('div', 'component-preview-shell')
    card.append(shell)
    const modelData = repeatable
      ? repeatModelForFit(component, previewContext.instance, state.componentModelData, count)
      : (state.componentModelData || null)
    const preview = buildComponentOnTemplatePreview(report, component, fit.template_id, {
      sourceTemplateId: previewContext.templateId,
      instanceIndex: previewContext.instanceIndex,
      modelData,
    })
    if (!preview || preview.fits === false) continue
    shown += 1
    if (preview?.hitTest?.shifted) {
      const sideLabel = {
        top: 'вниз',
        bottom: 'вверх',
        left: 'вправо',
        right: 'влево',
      }[preview.hitTest.side] || 'от заголовка'
      card.append(node('p', 'heatmap-note', `Hit-test: компонент сдвинут ${sideLabel}, пропорции те же.`))
    } else if (preview?.hitTest?.titleInk) {
      card.append(node('p', 'heatmap-note', 'Hit-test: текст заголовка и bbox компонента не пересекаются.'))
    }
    mountSlidePreview(shell, report, jobId, preview?.slide || null, preview?.bboxNorm || null, preview?.hitTest || null)
    block.append(card)
  }
  if (!shown) {
    block.append(node('p', 'heatmap-note', 'Других шаблонов, куда компонент встаёт своим bbox, нет.'))
  }
  parent.append(block)
}

function componentUsesPlaygroundModel(component) {
  return component.kind === 'paginator'
    || component.kind === 'slide_title'
    || component.kind === 'slide_description'
    || component.kind === 'slide_image'
    || component.kind === 'table'
    || component.kind === 'metric'
    || isIterableRepeatComponent(component)
}

const HIDDEN_COMPONENT_GROUPS = ['containers']

function previewInstanceKey(instance) {
  if (!instance) return ''
  if (instance.layout_key) return instance.layout_key
  return [
    instance.slide_number,
    instance.vgroup_id,
    instance.group_index,
    instance.element_ids?.join(','),
    instance.template_id,
  ].filter((value) => value != null && value !== '').join('|')
}

function shouldRefreshPlaygroundModel(state, component, instance) {
  if (!state.componentModelData) return true
  if (state.componentModelData.component_id !== component.id) return true
  const nextKey = previewInstanceKey(instance)
  return Boolean(nextKey) && state.componentModelData.preview_instance_key !== nextKey
}

function ensurePaginatorModel(component, state, instance = null) {
  if (component.kind !== 'paginator') return null
  const sample = instance || component.instances?.[0]
  if (shouldRefreshPlaygroundModel(state, component, sample)) {
    state.componentModelData = {
      ...defaultPaginatorModel(component, sample),
      preview_instance_key: previewInstanceKey(sample),
    }
  }
  return state.componentModelData
}

function ensureSlideTitleModel(component, state, instance = null) {
  if (component.kind !== 'slide_title') return null
  const sample = instance || component.instances?.[0]
  if (shouldRefreshPlaygroundModel(state, component, sample)) {
    state.componentModelData = {
      ...defaultSlideTitleModel(component, sample),
      preview_instance_key: previewInstanceKey(sample),
    }
  }
  return state.componentModelData
}

function ensureSlideDescriptionModel(component, state, instance = null) {
  if (component.kind !== 'slide_description') return null
  const sample = instance || component.instances?.[0]
  if (shouldRefreshPlaygroundModel(state, component, sample)) {
    state.componentModelData = {
      ...defaultSlideDescriptionModel(component, sample),
      preview_instance_key: previewInstanceKey(sample),
    }
  }
  return state.componentModelData
}

function ensureSlideImageModel(component, state, instance = null) {
  if (component.kind !== 'slide_image') return null
  const sample = instance || component.instances?.[0]
  if (shouldRefreshPlaygroundModel(state, component, sample)) {
    state.componentModelData = {
      ...defaultSlideImageModel(component, sample),
      preview_instance_key: previewInstanceKey(sample),
    }
  }
  return state.componentModelData
}

function ensureTableModel(component, state, instance = null, report = null) {
  if (component.kind !== 'table') return null
  const sample = instance || component.instances?.[0]
  if (shouldRefreshPlaygroundModel(state, component, sample)) {
    state.componentModelData = {
      ...defaultTableModel(component, sample, report),
      preview_instance_key: previewInstanceKey(sample),
    }
  }
  return state.componentModelData
}

function ensureContainerModel(component, state, instance = null) {
  if (!isIterableRepeatComponent(component)) return null
  const fallback = sortInstancesForRepeatPreview(component.instances || [])[0] || null
  const sample = instance || fallback
  if (shouldRefreshPlaygroundModel(state, component, sample)) {
    state.componentModelData = {
      ...defaultContainerModel(component, sample),
      preview_instance_key: previewInstanceKey(sample),
    }
  }
  return state.componentModelData
}

function ensureMetricModel(component, state, instance = null) {
  if (component.kind !== 'metric') return null
  const sample = instance || component.instances?.[0] || null
  if (shouldRefreshPlaygroundModel(state, component, sample)) {
    state.componentModelData = {
      ...defaultMetricModel(component, sample),
      preview_instance_key: previewInstanceKey(sample),
    }
  }
  return state.componentModelData
}

function resetComponentModelData(component, instance = null, report = null) {
  if (component.kind === 'paginator') {
    return { ...defaultPaginatorModel(component, instance), preview_instance_key: previewInstanceKey(instance) }
  }
  if (component.kind === 'slide_title') {
    return { ...defaultSlideTitleModel(component, instance), preview_instance_key: previewInstanceKey(instance) }
  }
  if (component.kind === 'slide_description') {
    return { ...defaultSlideDescriptionModel(component, instance), preview_instance_key: previewInstanceKey(instance) }
  }
  if (component.kind === 'slide_image') {
    return { ...defaultSlideImageModel(component, instance), preview_instance_key: previewInstanceKey(instance) }
  }
  if (component.kind === 'table') {
    return { ...defaultTableModel(component, instance, report), preview_instance_key: previewInstanceKey(instance) }
  }
  if (isIterableRepeatComponent(component)) {
    const fallback = sortInstancesForRepeatPreview(component.instances || [])[0] || null
    const sample = instance || fallback
    return { ...defaultContainerModel(component, sample), preview_instance_key: previewInstanceKey(sample) }
  }
  if (component.kind === 'metric') {
    return { ...defaultMetricModel(component, instance), preview_instance_key: previewInstanceKey(instance) }
  }
  return null
}

function renderPaginatorPlayground(detail, component, state, renderPanel, helpers, previewInstance = null) {
  const { node, append, metric } = helpers
  if (component.kind !== 'paginator' || component.paginationType !== 'dot_pagination') return

  const model = ensurePaginatorModel(component, state, previewInstance)
  const capacity = component.capacity || {}
  const minPages = capacity.dot_count_min || 2
  const maxPages = capacity.dot_count_max || 20
  const block = append(node('section', 'content-block component-paginator-playground'), node('h4', '', 'Paginator playground'))

  block.append(append(node('div', 'mini-metrics'),
    metric(model.page_count, 'pages'),
    metric(model.active_index + 1, 'active'),
    metric(maxPages, 'max dots'),
  ))

  const placementBar = node('div', 'component-template-bar')
  placementBar.append(node('span', 'component-template-label', 'Размещение'))
  ;(component.placements || []).forEach((placement) => {
    const button = node(
      'button',
      `component-template-btn ${placement.id === model.placement_id ? 'active' : ''}`,
      placement.label,
    )
    button.type = 'button'
    button.title = placement.id
    button.addEventListener('click', () => {
      model.placement_id = placement.id
      state.componentModelData = { ...model }
      state.componentViewMode = 'preview'
      renderPanel()
    })
    placementBar.append(button)
  })
  block.append(placementBar)

  const pageCountLabel = node('label', 'component-playground-label', `Количество pages · ${model.page_count}`)
  const pageCountInput = node('input', 'component-playground-range')
  pageCountInput.type = 'range'
  pageCountInput.min = String(minPages)
  pageCountInput.max = String(maxPages)
  pageCountInput.value = String(model.page_count)
  pageCountInput.addEventListener('input', () => {
    model.page_count = Number(pageCountInput.value)
    model.active_index = Math.min(model.active_index, model.page_count - 1)
    pageCountLabel.textContent = `Количество pages · ${model.page_count}`
    activeBar.querySelectorAll('button').forEach((button, index) => {
      button.hidden = index >= model.page_count
      button.classList.toggle('active', index === model.active_index)
    })
  })
  pageCountInput.addEventListener('change', () => {
    state.componentModelData = { ...model }
    state.componentViewMode = 'preview'
    renderPanel()
  })
  block.append(pageCountLabel, pageCountInput)

  const activeBar = node('div', 'component-view-bar')
  for (let index = 0; index < maxPages; index += 1) {
    const button = node(
      'button',
      `component-view-btn ${index === model.active_index ? 'active' : ''}`,
      String(index + 1),
    )
    button.type = 'button'
    button.hidden = index >= model.page_count
    button.addEventListener('click', () => {
      model.active_index = index
      state.componentModelData = { ...model }
      state.componentViewMode = 'preview'
      renderPanel()
    })
    activeBar.append(button)
  }
  block.append(node('p', 'slot-section-label', 'Active page'), activeBar)

  const applyBtn = node('button', 'component-view-btn', 'Применить в preview')
  applyBtn.type = 'button'
  applyBtn.addEventListener('click', () => {
    state.componentModelData = { ...model }
    state.componentViewMode = 'preview'
    renderPanel()
  })
  block.append(applyBtn)
  detail.append(block)
}

function renderContainerPlayground(detail, component, state, renderPanel, helpers, previewInstance = null) {
  const { node, append, metric } = helpers
  if (!isIterableRepeatComponent(component)) return

  const model = ensureContainerModel(component, state, previewInstance)
  const capacity = buildContainerCapacityForInstance(component, previewInstance)
    || component.capacity
    || model.capacity
    || {}
  const minItems = capacity.item_count_min || 1
  const maxItems = capacity.item_count_max || model.item_count || minItems
  const block = append(node('section', 'content-block component-container-playground'), node('h4', '', 'Repeat playground'))

  block.append(append(node('div', 'mini-metrics'),
    metric(model.item_count, 'items'),
    metric(capacity.item_count_known || '—', 'known'),
    metric(maxItems, 'max'),
    metric(layoutLabel(component.layout), 'layout'),
  ))

  const itemCountLabel = node('label', 'component-playground-label', `Количество · ${model.item_count}`)
  const itemCountInput = node('input', 'component-playground-range')
  itemCountInput.type = 'range'
  itemCountInput.min = String(minItems)
  itemCountInput.max = String(maxItems)
  itemCountInput.value = String(model.item_count)
  itemCountInput.addEventListener('input', () => {
    const next = resizeContainerModel(model, Number(itemCountInput.value), component, previewInstance)
    model.item_count = next.item_count
    model.items = next.items
    itemCountLabel.textContent = `Количество · ${model.item_count}`
    state.componentModelData = { ...model }
    if (state.componentViewMode === 'preview') renderPanel()
  })
  itemCountInput.addEventListener('change', () => {
    state.componentModelData = { ...model }
    state.componentViewMode = 'preview'
    renderPanel()
  })
  block.append(itemCountLabel, itemCountInput)

  const applyBtn = node('button', 'component-view-btn', 'Применить в preview')
  applyBtn.type = 'button'
  applyBtn.addEventListener('click', () => {
    state.componentModelData = { ...model }
    state.componentViewMode = 'preview'
    renderPanel()
  })
  block.append(applyBtn)
  detail.append(block)
}

function renderTablePlayground(detail, component, state, report, renderPanel, helpers, previewInstance = null) {
  const { node, append, metric } = helpers
  if (component.kind !== 'table') return

  const model = ensureTableModel(component, state, previewInstance, report)
  const capacity = component.capacity || {}
  const structure = component.raw?.structure || {}
  const minRows = capacity.row_count_min || 2
  const maxRows = capacity.row_count_max || model.row_count || minRows
  const minCols = capacity.col_count_min || 1
  const maxCols = capacity.col_count_max || model.col_count || minCols
  const block = append(node('section', 'content-block component-table-playground'), node('h4', '', 'Table playground'))

  block.append(append(node('div', 'mini-metrics'),
    metric(model.row_count, 'rows'),
    metric(model.col_count, 'cols'),
    metric(`${capacity.row_count_known || '—'}×${capacity.col_count_known || '—'}`, 'known'),
  ))

  const syncModelSize = (rowCount, colCount) => {
    const next = resizeTableModelData(model, rowCount, colCount, structure)
    model.row_count = next.row_count
    model.col_count = next.col_count
    model.columns = next.columns
    model.rows = next.rows
    rowCountLabel.textContent = `Строк · ${model.row_count}`
    colCountLabel.textContent = `Колонок · ${model.col_count}`
  }

  const rowCountLabel = node('label', 'component-playground-label', `Строк · ${model.row_count}`)
  const rowCountInput = node('input', 'component-playground-range')
  rowCountInput.type = 'range'
  rowCountInput.min = String(minRows)
  rowCountInput.max = String(maxRows)
  rowCountInput.value = String(model.row_count)
  rowCountInput.addEventListener('input', () => {
    syncModelSize(Number(rowCountInput.value), model.col_count)
  })
  rowCountInput.addEventListener('change', () => {
    state.componentModelData = { ...model }
    state.componentViewMode = 'preview'
    renderPanel()
  })

  const colCountLabel = node('label', 'component-playground-label', `Колонок · ${model.col_count}`)
  const colCountInput = node('input', 'component-playground-range')
  colCountInput.type = 'range'
  colCountInput.min = String(minCols)
  colCountInput.max = String(maxCols)
  colCountInput.value = String(model.col_count)
  colCountInput.addEventListener('input', () => {
    syncModelSize(model.row_count, Number(colCountInput.value))
  })
  colCountInput.addEventListener('change', () => {
    state.componentModelData = { ...model }
    state.componentViewMode = 'preview'
    renderPanel()
  })

  block.append(rowCountLabel, rowCountInput, colCountLabel, colCountInput)

  const applyBtn = node('button', 'component-view-btn', 'Применить в preview')
  applyBtn.type = 'button'
  applyBtn.addEventListener('click', () => {
    syncModelSize(model.row_count, model.col_count)
    state.componentModelData = { ...model }
    state.componentViewMode = 'preview'
    renderPanel()
  })
  block.append(applyBtn)
  detail.append(block)
}

function renderSlideTitlePlayground(detail, component, state, renderPanel, helpers, previewInstance = null) {
  const { node, append, metric } = helpers
  if (component.kind !== 'slide_title') return

  const model = ensureSlideTitleModel(component, state, previewInstance)
  const capacity = component.capacity || {}
  const phrase = component.defaultPhrase || component.raw?.default_phrase || ''
  const minWords = capacity.word_count_min || 1
  const maxWords = capacity.word_count_max || model.word_count || minWords
  const block = append(node('section', 'content-block component-slide-title-playground'), node('h4', '', 'Slide title playground'))

  block.append(append(node('div', 'mini-metrics'),
    metric(model.word_count, 'words'),
    metric(model.text?.length || 0, 'chars'),
    metric(maxWords, 'max words'),
  ))

  const placementBar = node('div', 'component-template-bar')
  placementBar.append(node('span', 'component-template-label', 'Размещение'))
  ;(component.placements || []).forEach((placement) => {
    const button = node(
      'button',
      `component-template-btn ${placement.id === model.placement_id ? 'active' : ''}`,
      placement.label,
    )
    button.type = 'button'
    button.title = placement.id
    button.addEventListener('click', () => {
      model.placement_id = placement.id
      state.componentModelData = { ...model }
      state.componentViewMode = 'preview'
      renderPanel()
    })
    placementBar.append(button)
  })
  block.append(placementBar)

  const wordCountLabel = node('label', 'component-playground-label', `Количество слов · ${model.word_count}`)
  const wordCountInput = node('input', 'component-playground-range')
  wordCountInput.type = 'range'
  wordCountInput.min = String(minWords)
  wordCountInput.max = String(maxWords)
  wordCountInput.value = String(model.word_count)
  const textPreview = node('p', 'component-playground-text-preview', model.text || '')
  wordCountInput.addEventListener('input', () => {
    model.word_count = Number(wordCountInput.value)
    model.text = buildTitleTextFromWords(phrase, model.word_count)
    wordCountLabel.textContent = `Количество слов · ${model.word_count}`
    textPreview.textContent = model.text
    state.componentModelData = { ...model }
    if (state.componentViewMode === 'preview') renderPanel()
  })
  wordCountInput.addEventListener('change', () => {
    state.componentModelData = { ...model }
    state.componentViewMode = 'preview'
    renderPanel()
  })
  block.append(wordCountLabel, wordCountInput, textPreview)

  const applyBtn = node('button', 'component-view-btn', 'Применить в preview')
  applyBtn.type = 'button'
  applyBtn.addEventListener('click', () => {
    model.text = buildTitleTextFromWords(phrase, model.word_count)
    state.componentModelData = { ...model }
    state.componentViewMode = 'preview'
    renderPanel()
  })
  block.append(applyBtn)
  detail.append(block)
}

function renderSlideDescriptionPlayground(detail, component, state, renderPanel, helpers, previewInstance = null) {
  const { node, append, metric } = helpers
  if (component.kind !== 'slide_description') return

  const model = ensureSlideDescriptionModel(component, state, previewInstance)
  const capacity = component.capacity || {}
  const phrase = component.defaultPhrase || component.raw?.default_phrase || ''
  const minWords = capacity.word_count_min || 8
  const maxWords = capacity.word_count_max || model.word_count || minWords
  const block = append(node('section', 'content-block component-slide-description-playground'), node('h4', '', 'Slide description playground'))

  block.append(append(node('div', 'mini-metrics'),
    metric(model.word_count, 'words'),
    metric(model.text?.length || 0, 'chars'),
    metric(capacity.line_count_typical || '—', 'lines typical'),
    metric(maxWords, 'max words'),
  ))

  const placementBar = node('div', 'component-template-bar')
  placementBar.append(node('span', 'component-template-label', 'Размещение'))
  ;(component.placements || []).forEach((placement) => {
    const button = node(
      'button',
      `component-template-btn ${placement.id === model.placement_id ? 'active' : ''}`,
      placement.label,
    )
    button.type = 'button'
    button.title = placement.id
    button.addEventListener('click', () => {
      model.placement_id = placement.id
      state.componentModelData = { ...model }
      state.componentViewMode = 'preview'
      renderPanel()
    })
    placementBar.append(button)
  })
  block.append(placementBar)

  const wordCountLabel = node('label', 'component-playground-label', `Количество слов · ${model.word_count}`)
  const wordCountInput = node('input', 'component-playground-range')
  wordCountInput.type = 'range'
  wordCountInput.min = String(minWords)
  wordCountInput.max = String(maxWords)
  wordCountInput.value = String(model.word_count)
  const textPreview = node('p', 'component-playground-text-preview', model.text || '')
  wordCountInput.addEventListener('input', () => {
    model.word_count = Number(wordCountInput.value)
    model.text = buildDescriptionTextFromWords(phrase, model.word_count)
    wordCountLabel.textContent = `Количество слов · ${model.word_count}`
    textPreview.textContent = model.text
    state.componentModelData = { ...model }
    if (state.componentViewMode === 'preview') renderPanel()
  })
  wordCountInput.addEventListener('change', () => {
    state.componentModelData = { ...model }
    state.componentViewMode = 'preview'
    renderPanel()
  })
  block.append(wordCountLabel, wordCountInput, textPreview)

  const applyBtn = node('button', 'component-view-btn', 'Применить в preview')
  applyBtn.type = 'button'
  applyBtn.addEventListener('click', () => {
    model.text = buildDescriptionTextFromWords(phrase, model.word_count)
    state.componentModelData = { ...model }
    state.componentViewMode = 'preview'
    renderPanel()
  })
  block.append(applyBtn)
  detail.append(block)
}

function renderMetricPlayground(detail, component, state, renderPanel, helpers, previewInstance = null) {
  const { node, append, metric } = helpers
  if (component.kind !== 'metric') return

  const sample = previewInstance || component.instances?.[0] || null
  const model = ensureMetricModel(component, state, sample)
  const minItems = 1
  const maxItems = sample?.capacity_expandable || sample?.item_capacity || 1
  const block = append(node('section', 'content-block component-metric-playground'), node('h4', '', 'KPI playground'))

  block.append(append(node('div', 'mini-metrics'),
    metric(model.metrics?.length || 1, 'metrics'),
    metric(sample?.capacity_visible || sample?.item_capacity || 1, 'visible'),
    metric(maxItems, 'max'),
  ))

  const itemCountLabel = node('label', 'component-playground-label', `Количество KPI · ${model.metrics?.length || 1}`)
  const itemCountInput = node('input', 'component-playground-range')
  itemCountInput.type = 'range'
  itemCountInput.min = String(minItems)
  itemCountInput.max = String(maxItems)
  itemCountInput.value = String(model.metrics?.length || 1)
  itemCountInput.addEventListener('input', () => {
    const next = resizeMetricModel(model, Number(itemCountInput.value), component, sample)
    model.metrics = next.metrics
    itemCountLabel.textContent = `Количество KPI · ${model.metrics.length}`
    state.componentModelData = { ...model }
    if (state.componentViewMode === 'preview') renderPanel()
  })
  itemCountInput.addEventListener('change', () => {
    state.componentModelData = { ...model }
    state.componentViewMode = 'preview'
    renderPanel()
  })
  block.append(itemCountLabel, itemCountInput)

  if (maxItems > (sample?.capacity_visible || 1)) {
    const expandedLabel = node('label', 'component-playground-label', 'Размножить до расширенной ёмкости')
    const expandedInput = node('input', 'component-playground-checkbox')
    expandedInput.type = 'checkbox'
    expandedInput.checked = Boolean(model.expanded)
    expandedInput.addEventListener('change', () => {
      model.expanded = expandedInput.checked
      state.componentModelData = { ...model }
      state.componentViewMode = 'preview'
      renderPanel()
    })
    block.append(expandedLabel, expandedInput)
  }

  const applyBtn = node('button', 'component-view-btn', 'Применить в preview')
  applyBtn.type = 'button'
  applyBtn.addEventListener('click', () => {
    state.componentModelData = { ...model }
    state.componentViewMode = 'preview'
    renderPanel()
  })
  block.append(applyBtn)
  detail.append(block)
}

function renderRepeatSemanticsPanel(detail, component, helpers) {
  const { node, append, dataTable } = helpers
  if (!isIterableRepeatComponent(component)) return

  const legend = repeatSemanticsLegend(component)
  const { semantics, pattern, exampleItem, mappingNote } = legend
  const block = append(node('section', 'content-block component-repeat-semantics-panel'), node('h4', '', 'Семантика данных'))

  block.append(node(
    'p',
    'component-repeat-semantics-note',
    'JSON для повтора использует единый контракт items[].fields: heading + body. Внутренние роли шаблона связываются с ним автоматически.',
  ))

  block.append(dataTable(
    ['Семантика', 'Значение'],
    [
      ['Pattern', `${semantics.patternLabel} (${semantics.pattern})`],
      ['Roles', semantics.roles.map((role) => roleLabel(role)).join(', ') || '—'],
      ['Context blocks', semantics.contextBlocks.join(', ') || '—'],
      ['Intents', semantics.intents.join(', ') || '—'],
      ['Items known / max', `${semantics.itemCountKnown ?? '—'} / ${semantics.itemCountMax ?? '—'}`],
      ['Signature', semantics.signature || component.variantSignature || '—'],
    ],
  ))

  if (semantics.fieldSchema?.length) {
    block.append(node('h5', '', 'Поля одной карточки'))
    block.append(dataTable(
      ['Role', 'Смысл', 'Required'],
      semantics.fieldSchema.map((field) => [
        field.role,
        field.label,
        field.required ? 'да' : 'нет',
      ]),
    ))
  }

  if (semantics.contextBlocks.length) {
    block.append(node('h5', '', 'Intent → context → component'))
    block.append(dataTable(
      ['Context block', 'Intents', 'Пример данных модели'],
      semantics.contextBlocks.map((contextBlock) => {
        let sample = { ...exampleItem.fields }
        if (contextBlock === 'persons') {
          sample = { heading: 'Анна Иванова', body: 'Head of Marketing' }
        } else if (contextBlock === 'metrics') {
          sample = { value: '40', unit: '%', description: 'сокращение времени' }
        } else if (contextBlock === 'lists') {
          sample = { heading: 'Анализ шаблона', body: 'извлечение типографики и цветов' }
        }
        return [
          contextBlock,
          (CONTEXT_BLOCK_INTENTS[contextBlock] || []).join(', '),
          JSON.stringify(sample),
        ]
      }),
    ))
  }

  block.append(node('h5', '', 'Пример items[] для API'))
  block.append(node('pre', 'component-repeat-semantics-example', JSON.stringify({
    component_id: component.id,
    item_count: 1,
    items: [exampleItem],
  }, null, 2)))

  block.append(node('p', 'component-repeat-semantics-footnote', mappingNote.join(' · ')))
  detail.append(block)
}

export function renderComponentsPanel(panel, { state, report, jobId, renderPanel, helpers } = {}) {
  const {
    node,
    append,
    sectionTitle,
    empty,
    metric,
    number,
    pct,
    fmt,
    dataTable,
    renderComponentCanvasPanel,
    componentSlotCard,
  } = helpers

  append(
    panel,
    sectionTitle(
      'Компоненты',
      'Graphic-компоненты (таблицы, графики, диаграммы), paginator, заголовки, повторы и прочие контейнеры. Preview — полный слайд, где компонент найден. Под ним — другие шаблоны, куда он встаёт своим bbox.',
    ),
  )

  const allComponents = listAllComponents(report)
    .filter((item) => !HIDDEN_COMPONENT_GROUPS.includes(item.group))
  if (!allComponents.length) {
    panel.append(empty('Компоненты не найдены. Нужны повторяющиеся блоки в Visual groups или baseline-определения DS для таблиц/графиков.'))
    return
  }

  const activeGroup = HIDDEN_COMPONENT_GROUPS.includes(state.componentGroupFilter)
    ? 'all'
    : (state.componentGroupFilter || 'all')
  if (state.componentGroupFilter !== activeGroup) state.componentGroupFilter = activeGroup
  const isRepeatsFilter = activeGroup === 'repeats'
  const isMetricsFilter = activeGroup === 'metrics'
  const pool = isRepeatsFilter
    ? allComponents.filter((item) => item.group === 'repeats')
    : isMetricsFilter
      ? allComponents.filter((item) => item.group === 'metrics')
      : allComponents.filter((item) => item.group !== 'repeats' && item.group !== 'metrics')
  if (!pool.length) {
    panel.append(empty(isRepeatsFilter
      ? 'Повторяющиеся компоненты не найдены. Нужны vgroups с repeat series/grid и текстовыми слотами для подстановки data.'
      : isMetricsFilter
        ? 'KPI-раскладки не найдены. Нужны слайды с hero KPI, flex row или split pseudo-table.'
        : 'Компоненты не найдены.'))
    return
  }

  const groups = listComponentGroups(report, allComponents, { excludeGroups: HIDDEN_COMPONENT_GROUPS })
  const components = filterComponentsByGroup(pool, (isRepeatsFilter || isMetricsFilter) ? 'all' : activeGroup)
  if (!components.length) {
    panel.append(empty('В выбранной группе компонентов пока ничего нет.'))
    return
  }

  const vgroupSummary = getVgroupComponentSummary(report)
  const paginatorCount = allComponents.filter((item) => item.kind === 'paginator').length
  const titleCount = allComponents.filter((item) => item.kind === 'slide_title').length
  const descriptionCount = allComponents.filter((item) => item.kind === 'slide_description').length
  const imageCount = allComponents.filter((item) => item.kind === 'slide_image').length
  const singletonCount = allComponents.filter((item) => item.kind === 'singleton').length
  const tableCount = allComponents.filter((item) => item.kind === 'table').length
  const repeatCount = allComponents.filter((item) => item.group === 'repeats').length
  const metricCount = allComponents.filter((item) => item.group === 'metrics').length
  const graphicSummary = report.graphic_components?.summary || {}

  panel.append(append(node('div', 'mini-metrics'),
    metric(isRepeatsFilter || isMetricsFilter ? components.length : pool.length, 'типов'),
    metric(
      isRepeatsFilter
        ? components.reduce((sum, item) => sum + (item.capacity?.item_count_known || item.frequency?.instance_count || 0), 0)
        : isMetricsFilter
          ? components.reduce((sum, item) => sum + (item.frequency?.instance_count || 0), 0)
          : (vgroupSummary.instance_count || 0)
            + (graphicSummary.table_instance_count || 0)
            + (graphicSummary.chart_instance_count || 0)
            + (graphicSummary.diagram_instance_count || 0),
      'экземпляров',
    ),
    ...(isRepeatsFilter
      ? [metric(repeatCount, 'repeat types')]
      : isMetricsFilter
        ? [metric(metricCount, 'KPI types')]
        : [
        metric(repeatCount, 'repeats'),
        metric(metricCount, 'metrics'),
        metric(paginatorCount, 'paginators'),
        metric(titleCount, 'titles'),
        metric(descriptionCount, 'text'),
        metric(imageCount, 'images'),
        metric(singletonCount, 'singletons'),
        metric(tableCount, 'tables'),
        metric(
          (graphicSummary.chart_component_count || 0)
            + (graphicSummary.diagram_component_count || 0),
          'graphic',
        ),
      ]),
  ))

  const groupBar = node('div', 'component-selector')
  groups.forEach((group) => {
    const button = node(
      'button',
      `component-filter ${group.id === activeGroup ? 'active' : ''}`,
      `${group.label} · ${group.count}`,
    )
    button.type = 'button'
    button.addEventListener('click', () => {
      clearComponentDetailScroll(state)
      state.componentGroupFilter = group.id
      state.selectedComponent = null
      state.componentTemplateId = null
      state.componentInstanceIndex = 0
      renderPanel()
    })
    groupBar.append(button)
  })
  panel.append(groupBar)

  const selectedId = state.selectedComponent || components[0].id
  const component = components.find((item) => item.id === selectedId) || components[0]
  state.selectedComponent = component.id
  if (state.componentInstanceIndex == null) state.componentInstanceIndex = 0
  if (state.componentViewMode == null) state.componentViewMode = 'preview'
  state.componentTemplateId = resolveComponentTemplateId(component, state.componentTemplateId)

  const previewContext = resolveComponentPreviewContext(report, component, {
    templateId: state.componentTemplateId,
    instanceIndex: state.componentInstanceIndex,
  })
  state.componentTemplateId = previewContext.templateId
  state.componentInstanceIndex = previewContext.instanceIndex
  if (component.kind === 'paginator') ensurePaginatorModel(component, state, previewContext.instance)
  else if (component.kind === 'slide_title') ensureSlideTitleModel(component, state, previewContext.instance)
  else if (component.kind === 'slide_description') ensureSlideDescriptionModel(component, state, previewContext.instance)
  else if (component.kind === 'slide_image') ensureSlideImageModel(component, state, previewContext.instance)
  else if (component.kind === 'table') ensureTableModel(component, state, previewContext.instance, report)
  else if (component.kind === 'metric') ensureMetricModel(component, state, previewContext.instance)
  const inputJson = buildComponentInputJson(report, component, previewContext)

  const layout = node('div', 'component-gallery-layout')

  const list = node('div', 'component-list')
  list.append(node('h4', '', 'Каталог'))
  list.append(node('p', 'component-list-note', 'Клик — preview на канвасе. Вариант = signature / схема слотов.'))

  const listScroll = node('div', 'component-list-scroll')
  components.forEach((item) => {
    const card = node('button', `component-list-card ${item.id === component.id ? 'active' : ''}`)
    card.type = 'button'
    card.append(
      append(node('div', 'component-list-card-head'),
        node('strong', '', item.label),
        node('span', `component-kind-badge component-kind-badge--${item.kind}`, componentKindLabel(item.kind)),
        ...(item.isBaseline ? [node('span', 'component-baseline-badge', 'baseline')] : []),
      ),
      node('small', '', `${item.id} · ${componentSourceLabel(item.source)} · ${item.frequency?.instance_count || 0} экз.`),
      node('span', 'component-list-card-meta', componentIntro(item, report)),
    )
    card.addEventListener('click', () => {
      if (state.selectedComponent !== item.id) clearComponentDetailScroll(state)
      state.selectedComponent = item.id
      state.componentInstanceIndex = 0
      state.componentTemplateId = null
      state.componentViewMode = 'preview'
      state.componentModelData = null
      renderPanel()
    })
    listScroll.append(card)
  })
  list.append(listScroll)
  layout.append(list)

  const detail = node('div', 'component-detail-panel')
  detail.append(append(node('div', 'component-detail-title'),
    node('h4', '', `${component.label}`),
    node('p', '', componentIntro(component, report)),
    node('p', 'component-variability-note', componentVariabilityNote(component)),
  ))

  renderPlacementRegistry(detail, report, component, allComponents, { node, append, dataTable })

  const viewBar = node('div', 'component-view-bar')
  const instanceBar = node('div', 'component-instance-bar')

  if (previewContext.templates.length > 1) {
    const templateBar = node('div', 'component-template-bar')
    templateBar.append(node('span', 'component-template-label', 'Шаблон'))
    previewContext.templates.forEach((template) => {
      const button = node(
        'button',
        `component-template-btn ${template.templateId === previewContext.templateId ? 'active' : ''}`,
        `${template.label} · ${template.count}`,
      )
      button.type = 'button'
      button.title = template.templateId
      button.addEventListener('click', () => {
        state.componentTemplateId = template.templateId
        state.componentInstanceIndex = 0
        state.componentViewMode = 'preview'
        state.componentModelData = resetComponentModelData(
          component,
          resolveComponentPreviewContext(report, component, {
            templateId: template.templateId,
            instanceIndex: 0,
          }).instance,
          report,
        )
        renderPanel()
      })
      templateBar.append(button)
    })
    detail.append(templateBar)
  } else if (previewContext.templates.length === 1) {
    detail.append(node(
      'p',
      'component-template-note',
      `Шаблон: ${previewContext.templates[0].label} (${previewContext.templates[0].templateId})`,
    ))
  }

  const previewBtn = node('button', `component-view-btn ${state.componentViewMode === 'preview' ? 'active' : ''}`, 'Preview')
  previewBtn.type = 'button'
  previewBtn.addEventListener('click', () => { state.componentViewMode = 'preview'; renderPanel() })
  viewBar.append(previewBtn)

  const jsonBtn = node('button', `component-view-btn ${state.componentViewMode === 'json' ? 'active' : ''}`, 'Данные')
  jsonBtn.type = 'button'
  jsonBtn.addEventListener('click', () => { state.componentViewMode = 'json'; renderPanel() })
  viewBar.append(jsonBtn)

  if (component.source === 'spatial' || component.source === 'vgroups') {
    const schemaBtn = node('button', `component-view-btn ${state.componentViewMode === 'schema' ? 'active' : ''}`, 'Схема слотов')
    schemaBtn.type = 'button'
    schemaBtn.addEventListener('click', () => { state.componentViewMode = 'schema'; renderPanel() })
    viewBar.append(schemaBtn)
  }

  previewContext.instances.slice(0, 8).forEach((instance, index) => {
    const label = component.kind === 'metric'
      ? `Сл. ${instance.slide_number}`
      : (component.source === 'spatial' || component.source === 'vgroups')
        ? `Сл. ${instance.slide_number} #${instance.group_index}`
        : `Сл. ${instance.slide_number}`
    const button = node(
      'button',
      `component-view-btn ${state.componentViewMode === 'preview' && previewContext.instanceIndex === index ? 'active' : ''}`,
      label,
    )
    button.type = 'button'
    button.addEventListener('click', () => {
      state.componentViewMode = 'preview'
      state.componentInstanceIndex = index
      if (component.kind === 'paginator' || component.kind === 'slide_title' || component.kind === 'slide_description' || component.kind === 'slide_image' || component.kind === 'table' || component.kind === 'metric' || isIterableRepeatComponent(component)) {
        state.componentModelData = resetComponentModelData(component, instance, report)
      }
      renderPanel()
    })
    instanceBar.append(button)
  })
  detail.append(viewBar)

  const previewWorkspace = node('div', 'component-preview-workspace')
  const controlsColumn = node('div', 'component-preview-controls')
  const previewColumn = node('div', 'component-preview-canvas-col')

  if (previewContext.instances.length > 1 && component.kind !== 'metric') {
    controlsColumn.append(append(
      node('div', 'component-instance-bar-wrap'),
      node('span', 'component-template-label', 'Экземпляр'),
      instanceBar,
    ))
  }

  renderPaginatorPlayground(controlsColumn, component, state, renderPanel, helpers, previewContext.instance)
  renderSlideTitlePlayground(controlsColumn, component, state, renderPanel, helpers, previewContext.instance)
  renderSlideDescriptionPlayground(controlsColumn, component, state, renderPanel, helpers, previewContext.instance)
  renderTablePlayground(controlsColumn, component, state, report, renderPanel, helpers, previewContext.instance)
  renderContainerPlayground(controlsColumn, component, state, renderPanel, helpers, previewContext.instance)
  renderMetricPlayground(controlsColumn, component, state, renderPanel, helpers, previewContext.instance)

  if (state.componentViewMode === 'schema' && (component.source === 'spatial' || component.source === 'vgroups')) {
    detail.append(renderComponentCanvasPanel(component.raw))
  } else if (state.componentViewMode === 'json') {
    const jsonBlock = append(node('section', 'content-block component-input-json-panel'), node('h4', '', componentInputJsonTitle()))
    jsonBlock.append(node('p', 'component-input-json-caption', componentInputJsonCaption(component)))
    jsonBlock.append(node('pre', 'component-input-json-dump', formatComponentInputJson(inputJson)))
    detail.append(jsonBlock)
  } else {
    const previewBlock = append(node('section', 'content-block component-preview-panel'), node('h4', '', 'Preview'))
    const mount = node('div', 'component-preview-shell')
    previewBlock.append(mount)
    mountComponentPreview(mount, report, jobId, component, {
      templateId: previewContext.templateId,
      instanceIndex: previewContext.instanceIndex,
      editable: !componentUsesPlaygroundModel(component),
      modelData: componentUsesPlaygroundModel(component) ? state.componentModelData : (state.componentModelData || null),
    })
    previewBlock.append(node('p', 'heatmap-note', 'Тексты можно править прямо в preview. Изображения — замена в следующих итерациях.'))
    previewColumn.append(previewBlock)
    renderFittingTemplatePreviews(
      previewColumn,
      report,
      jobId,
      component,
      state,
      previewContext,
      renderPanel,
      helpers,
    )

    if (controlsColumn.childNodes.length) {
      previewWorkspace.append(controlsColumn, previewColumn)
      detail.append(previewWorkspace)
    } else {
      detail.append(previewColumn)
    }
  }

  renderRepeatSemanticsPanel(detail, component, helpers)

  if (state.componentViewMode !== 'json') {
    const jsonBlock = append(node('section', 'content-block component-input-json-panel'), node('h4', '', componentInputJsonTitle()))
    jsonBlock.append(node('p', 'component-input-json-caption', componentInputJsonCaption(component)))
    jsonBlock.append(node('pre', 'component-input-json-dump', formatComponentInputJson(inputJson)))
    const applyBtn = node('button', 'component-view-btn', 'Preview с этими данными')
    applyBtn.type = 'button'
    applyBtn.addEventListener('click', () => {
      const payloadKey = payloadKeyForComponent(component)
      state.componentModelData = inputJson[payloadKey]?.[0] || null
      state.componentViewMode = 'preview'
      renderPanel()
    })
    jsonBlock.append(applyBtn)
    detail.append(jsonBlock)
  }

  if (component.source === 'spatial' || component.source === 'vgroups') {
    const profileBlock = append(node('section', 'content-block component-profile-panel'), node('h4', '', 'Профиль компонента'))

    if (component.source === 'vgroups') {
      const bounds = component.containerBounds || component.raw?.container_bounds || {}
      const maxBox = component.containerMax || bounds.max || {}
      const typicalBox = component.container || bounds.typical || {}
      profileBlock.append(dataTable(
        ['Метрика', 'Typical', 'Max', 'Min'],
        [
          [
            'Контейнер (pt)',
            `${Math.round(typicalBox.width_pt || 0)}×${Math.round(typicalBox.height_pt || 0)}`,
            `${Math.round(maxBox.width_pt || 0)}×${Math.round(maxBox.height_pt || 0)}`,
            `${Math.round(bounds.min?.width_pt || 0)}×${Math.round(bounds.min?.height_pt || 0)}`,
          ],
          [
            'Контейнер (norm)',
            `${Math.round((typicalBox.width_norm || 0) * 100)}×${Math.round((typicalBox.height_norm || 0) * 100)}%`,
            `${Math.round((maxBox.width_norm || 0) * 100)}×${Math.round((maxBox.height_norm || 0) * 100)}%`,
            `${Math.round((bounds.min?.width_norm || 0) * 100)}×${Math.round((bounds.min?.height_norm || 0) * 100)}%`,
          ],
          [
            'Элементов в контейнере',
            typicalBox.element_count ?? '—',
            maxBox.element_count ?? '—',
            bounds.min?.element_count ?? '—',
          ],
        ],
      ))

      const iter = component.iterability || component.raw?.iterability
      if (iter) {
        profileBlock.append(dataTable(
          ['Проверка итерируемости', 'Значение'],
          [
            ['Статус', iter.is_iterable ? 'iterable' : 'fixed'],
            ['Метод', ITERABILITY_METHOD_LABELS[iter.method] || iter.method || '—'],
            ['Confidence', `${Math.round((iter.confidence || 0) * 100)}%`],
            ['Экземпляров', iter.instance_count || 0],
            ['Слайдов', iter.slide_count || 0],
            ['Max repeat', iter.max_repeat_count ?? '—'],
            ['Same-slide repeat', iter.checks?.same_slide_repeat ? 'да' : 'нет'],
            ['Grid cell', iter.checks?.repeat_grid_cell ? 'да' : 'нет'],
            ['Too deep', iter.checks?.too_deep ? 'да' : 'нет'],
            ['Narrow strip', iter.checks?.narrow_strip ? 'да' : 'нет'],
            ['Peripheral branch', iter.checks?.peripheral_branch ? 'да' : 'нет'],
            ['Flex axis', iter.checks?.invalid_flex_axis ? 'нет' : 'да'],
            ['Page grid fragment', iter.checks?.page_grid_fragment ? 'да' : 'нет'],
            ['Nested inner repeat', iter.checks?.nested_inner_repeat ? 'да' : 'нет'],
            ['Row segment fragment', iter.checks?.row_segment_fragment ? 'да' : 'нет'],
            ['Column section fragment', iter.checks?.column_section_fragment ? 'да' : 'нет'],
            ['Inconsistent slot geometry', iter.checks?.inconsistent_slot_geometry ? 'да' : 'нет'],
            ['Split axis mismatch', iter.checks?.split_axis_mismatch ? 'да' : 'нет'],
            ['Deck repeat', iter.checks?.deck_repeat ? 'да' : 'нет'],
            ['Cross-slide', iter.checks?.cross_slide ? 'да' : 'нет'],
            ['Repeat series', iter.checks?.repeat_series ? 'да' : 'нет'],
            ['Repeat grid', iter.checks?.repeat_grid ? 'да' : 'нет'],
            ['Layout split', iter.checks?.layout_split ? 'да' : 'нет'],
          ],
        ))
      }

      const layoutSplits = component.raw?.layout_splits || []
      if (layoutSplits.length) {
        profileBlock.append(dataTable(
          ['Слайд', 'Grid-группы', 'Экземпляров', 'Зона (pt)', 'itemSig'],
          layoutSplits.map((split) => [
            split.slide_number,
            split.vgroup_ids?.join(', ') || '—',
            split.item_count,
            split.container?.width_pt
              ? `${Math.round(split.container.width_pt)}×${Math.round(split.container.height_pt)}`
              : '—',
            split.item_sig || '—',
          ]),
        ))
        profileBlock.append(node(
          'p',
          'heatmap-note',
          'Несколько repeat-grid на одном слайде с одним itemSig — это один компонент, разбитый версткой. Playground считает суммарное число items.',
        ))
      }
    }

    detail.append(profileBlock)

    const slotsBlock = append(node('section', 'content-block component-slots-panel'), node('h4', '', 'Слоты'))
    const required = component.slots?.required || []
    const optional = component.slots?.optional || []
    if (required.length) {
      slotsBlock.append(node('p', 'slot-section-label', 'Required — ≥75% экземпляров'))
      slotsBlock.append(append(node('div', 'slot-grid'), ...required.map((slot) => componentSlotCard(slot, 'required', component.raw))))
    }
    if (optional.length) {
      slotsBlock.append(node('p', 'slot-section-label', 'Optional — вариативные'))
      slotsBlock.append(append(node('div', 'slot-grid'), ...optional.map((slot) => componentSlotCard(slot, 'optional', component.raw))))
    }
    detail.append(slotsBlock)
  }

  if (component.kind === 'paginator') {
    const profileBlock = append(node('section', 'content-block component-profile-panel'), node('h4', '', 'Профиль пагинатора'))
    const capacity = component.capacity || {}
    const behavior = component.behavior || {}
    const style = component.styleTokens || {}

    profileBlock.append(dataTable(
      ['Метрика', 'Значение'],
      [
        ['Тип', component.paginationType || '—'],
        ['Confidence', `${Math.round((component.confidence || 0) * 100)}%`],
        ['Dots typical', capacity.dot_count_typical ?? '—'],
        ['Dots observed max', capacity.dot_count_observed_max ?? capacity.dot_count_typical ?? '—'],
        ['Dots absolute max', capacity.dot_count_max ?? '—'],
        ['Spacing', capacity.spacing_pt ? `${capacity.spacing_pt} pt` : '—'],
        ['Y typical', capacity.y_norm_typical ? `${Math.round(capacity.y_norm_typical * 100)}%` : '—'],
        ['Active via', behavior.active_reason || '—'],
        ['Progression', behavior.progression || '—'],
        ['Active fill', style.active_fill || '—'],
        ['Inactive fill', style.inactive_fill || '—'],
      ],
    ))

    if (component.placements?.length) {
      profileBlock.append(dataTable(
        ['Placement', 'Source', 'Space', 'X', 'Y', 'Spacing', 'Экз.'],
        component.placements.map((placement) => [
          placement.label,
          placement.source,
          placement.coordinate_space || placement.anchor_mode || '—',
          placement.x_norm != null ? `${Math.round(placement.x_norm * 100)}%` : '—',
          placement.y_norm != null ? `${Math.round(placement.y_norm * 100)}%` : '—',
          placement.spacing_pt ? `${Math.round(placement.spacing_pt)} pt` : '—',
          placement.instance_count || 0,
        ]),
      ))
    }

    detail.append(profileBlock)
  }

  if (component.kind === 'slide_title') {
    const profileBlock = append(node('section', 'content-block component-profile-panel'), node('h4', '', 'Профиль заголовка'))
    const capacity = component.capacity || {}
    const typography = component.typography || {}

    profileBlock.append(dataTable(
      ['Метрика', 'Значение'],
      [
        ['Words typical', capacity.word_count_typical ?? '—'],
        ['Words observed max', capacity.word_count_observed_max ?? '—'],
        ['Words absolute max', capacity.word_count_max ?? '—'],
        ['Chars observed max', capacity.char_count_max ?? '—'],
        ['Lines typical', capacity.line_count_typical ?? '—'],
        ['Lines max', capacity.line_count_max ?? '—'],
        ['Typography', typography.dominant_size_pt
          ? `${typography.dominant_family || '—'} · ${typography.dominant_size_pt} pt`
          : '—'],
        ['Detection', (component.behavior?.detection_methods || []).join(', ') || '—'],
      ],
    ))

    if (component.placements?.length) {
      profileBlock.append(dataTable(
        ['Placement', 'Source', 'Space', 'X', 'Y', 'Size', 'Экз.'],
        component.placements.map((placement) => [
          placement.label,
          placement.source,
          placement.coordinate_space || placement.anchor_mode || '—',
          placement.x_norm != null ? `${Math.round(placement.x_norm * 100)}%` : '—',
          placement.y_norm != null ? `${Math.round(placement.y_norm * 100)}%` : '—',
          placement.width_norm != null
            ? `${Math.round(placement.width_norm * 100)}×${Math.round((placement.height_norm || 0) * 100)}%`
            : '—',
          placement.instance_count || 0,
        ]),
      ))
    }

    detail.append(profileBlock)
  }

  if (component.kind === 'slide_image') {
    const profileBlock = append(node('section', 'content-block component-profile-panel'), node('h4', '', 'Профиль изображения'))
    const capacity = component.capacity || {}

    profileBlock.append(dataTable(
      ['Метрика', 'Значение'],
      [
        ['Layout', component.layoutPattern || '—'],
        ['Background', component.isBackground ? 'да' : 'нет'],
        ['Description', component.hasDescription ? 'да' : 'нет'],
        ['Area typical', capacity.image_area_typical ? `${Math.round(capacity.image_area_typical * 100)}%` : '—'],
        ['Width typical', capacity.image_width_typical ? `${Math.round(capacity.image_width_typical * 100)}%` : '—'],
        ['Height typical', capacity.image_height_typical ? `${Math.round(capacity.image_height_typical * 100)}%` : '—'],
        ['Detection', (component.behavior?.detection_methods || []).join(', ') || '—'],
      ],
    ))

    if (component.placements?.length) {
      profileBlock.append(dataTable(
        ['Placement', 'Source', 'Space', 'X', 'Y', 'Size', 'Экз.'],
        component.placements.map((placement) => [
          placement.label,
          placement.source,
          placement.coordinate_space || placement.anchor_mode || '—',
          placement.x_norm != null ? `${Math.round(placement.x_norm * 100)}%` : '—',
          placement.y_norm != null ? `${Math.round(placement.y_norm * 100)}%` : '—',
          placement.width_norm != null
            ? `${Math.round(placement.width_norm * 100)}×${Math.round((placement.height_norm || 0) * 100)}%`
            : '—',
          placement.instance_count || 0,
        ]),
      ))
    }

    detail.append(profileBlock)
  }

  if (component.kind === 'slide_description') {
    const profileBlock = append(node('section', 'content-block component-profile-panel'), node('h4', '', 'Профиль описания'))
    const capacity = component.capacity || {}
    const typography = component.typography || {}

    profileBlock.append(dataTable(
      ['Метрика', 'Значение'],
      [
        ['Words typical', capacity.word_count_typical ?? '—'],
        ['Words observed max', capacity.word_count_observed_max ?? '—'],
        ['Words absolute max', capacity.word_count_max ?? '—'],
        ['Chars observed max', capacity.char_count_max ?? '—'],
        ['Lines typical', capacity.line_count_typical ?? '—'],
        ['Lines max', capacity.line_count_max ?? '—'],
        ['Typography', typography.dominant_size_pt
          ? `${typography.dominant_family || '—'} · ${typography.dominant_size_pt} pt`
          : '—'],
        ['Detection', (component.behavior?.detection_methods || []).join(', ') || '—'],
      ],
    ))

    if (component.placements?.length) {
      profileBlock.append(dataTable(
        ['Placement', 'Source', 'Space', 'X', 'Y', 'Size', 'Экз.'],
        component.placements.map((placement) => [
          placement.label,
          placement.source,
          placement.coordinate_space || placement.anchor_mode || '—',
          placement.x_norm != null ? `${Math.round(placement.x_norm * 100)}%` : '—',
          placement.y_norm != null ? `${Math.round(placement.y_norm * 100)}%` : '—',
          placement.width_norm != null
            ? `${Math.round(placement.width_norm * 100)}×${Math.round((placement.height_norm || 0) * 100)}%`
            : '—',
          placement.instance_count || 0,
        ]),
      ))
    }

    detail.append(profileBlock)
  }

  if (component.kind === 'table') {
    const profileBlock = append(node('section', 'content-block component-profile-panel'), node('h4', '', 'Профиль таблицы'))
    const capacity = component.capacity || {}
    const style = component.styleTokens || {}

    profileBlock.append(dataTable(
      ['Метрика', 'Значение'],
      [
        ['Source', component.tableSource || component.raw?.table_source || '—'],
        ['Rows known', capacity.row_count_known ?? '—'],
        ['Cols known', capacity.col_count_known ?? '—'],
        ['Rows range', `${capacity.row_count_min ?? '—'}…${capacity.row_count_max ?? '—'}`],
        ['Cols range', `${capacity.col_count_min ?? '—'}…${capacity.col_count_max ?? '—'}`],
        ['Header row', capacity.header_row ?? '—'],
        ['Style id', component.raw?.table_style_id || '—'],
        ['Header cell', style.header_cell?.typography?.size_pt ? `${style.header_cell.typography.size_pt} pt` : '—'],
        ['Body cell', style.body_cell?.typography?.size_pt ? `${style.body_cell.typography.size_pt} pt` : '—'],
      ],
    ))

    detail.append(profileBlock)
  }

  const textFields = component.textFields || component.raw?.text_fields || []
  if (textFields.length) {
    const textBlock = append(node('section', 'content-block component-text-fields-panel'), node('h4', '', `Текстовые поля · ${textFields.length}`))
    textBlock.append(dataTable(
      ['Field', 'Role', 'Required', 'Presence', 'Typography', 'Sample'],
      textFields.map((field) => [
        field.field_id,
        SLOT_ROLE_LABELS[field.role] || field.role,
        field.required ? 'да' : 'нет',
        pct(field.presence_ratio || 0),
        field.typography?.dominant_size_pt
          ? `${field.typography.dominant_family || '—'} · ${field.typography.dominant_size_pt} pt`
          : '—',
        field.sample_text || '—',
      ]),
    ))
    detail.append(textBlock)
  }

  const variants = component.variants?.length
    ? component.variants
    : (component.raw?.variants || [])
  if (variants.length) {
    const variantsBlock = append(node('section', 'content-block'), node('h4', '', `Variants · ${variants.length}`))
    variantsBlock.append(dataTable(
      ['ID', 'Layout', 'Эл.', 'Экз.', 'Слайды', 'Размер (norm)'],
      variants.map((variant) => [
        variant.variant_id,
        layoutLabel(variant.layout),
        variant.element_count ?? variant.slot_count ?? '—',
        variant.instance_count,
        (variant.slide_numbers || []).join(', '),
        variant.container
          ? `${Math.round((variant.container.width_norm || 0) * 100)}×${Math.round((variant.container.height_norm || 0) * 100)}%`
          : '—',
      ]),
    ))
    detail.append(variantsBlock)
  }

  const instances = component.instances || []
  if (instances.length && component.kind !== 'metric') {
    const instanceBlock = append(node('section', 'content-block'), node('h4', '', `Экземпляры · ${number(instances.length)}`))
    if (component.source === 'spatial' || component.source === 'vgroups') {
      instanceBlock.append(dataTable(
        ['Слайд', 'Layout', '#', 'Размер', 'Слотов', 'Состав'],
        instances.slice(0, 20).map((item) => [
          item.slide_number,
          layoutLabel(item.layout),
          item.group_index,
          `${Math.round(item.container?.width_pt || 0)}×${Math.round(item.container?.height_pt || 0)}`,
          item.slot_count,
          (item.slots || []).map((slot) => SLOT_ROLE_LABELS[slot.role] || slot.role).join(' + '),
        ]),
      ))
    } else if (component.kind === 'paginator') {
      instanceBlock.append(dataTable(
        ['Слайд', 'Dots', 'Active', 'Reason', 'Spacing', 'Elements'],
        instances.slice(0, 20).map((item) => [
          item.slide_number,
          item.dot_count,
          item.active_index,
          item.active_reason || '—',
          item.spacing_uniformity ?? '—',
          (item.element_ids || []).length,
        ]),
      ))
    } else if (component.kind === 'slide_title') {
      instanceBlock.append(dataTable(
        ['Слайд', 'Words', 'Chars', 'Lines', 'Method', 'Placement', 'Elements'],
        instances.slice(0, 20).map((item) => [
          item.slide_number,
          item.word_count,
          item.char_count,
          item.line_count,
          item.detection_method || '—',
          item.placement_id || '—',
          (item.element_ids || []).length,
        ]),
      ))
    } else if (component.kind === 'slide_description') {
      instanceBlock.append(dataTable(
        ['Слайд', 'Words', 'Chars', 'Lines', 'Method', 'Placement', 'Elements'],
        instances.slice(0, 20).map((item) => [
          item.slide_number,
          item.word_count,
          item.char_count,
          item.line_count,
          item.detection_method || '—',
          item.placement_id || '—',
          (item.element_ids || []).length,
        ]),
      ))
    } else if (component.kind === 'slide_image') {
      instanceBlock.append(dataTable(
        ['Слайд', 'Asset', 'Pattern', 'Desc', 'Area', 'Placement', 'Image'],
        instances.slice(0, 20).map((item) => [
          item.slide_number,
          item.asset || '—',
          item.layout_pattern || '—',
          item.has_description ? 'да' : 'нет',
          item.image_area_norm ? `${Math.round(item.image_area_norm * 100)}%` : '—',
          item.placement_id || '—',
          item.element_id || '—',
        ]),
      ))
    } else {
      instanceBlock.append(dataTable(
        ['Слайд', 'Template', 'Element', 'Размер'],
        instances.slice(0, 20).map((item) => [
          item.slide_number,
          item.template_id || '—',
          item.element_id || item.name || '—',
          item.geometry_pt
            ? `${Math.round(item.geometry_pt.width_pt)}×${Math.round(item.geometry_pt.height_pt)}`
            : '—',
        ]),
      ))
    }
    detail.append(instanceBlock)
  }

  layout.append(detail)
  panel.append(layout)
  restoreComponentDetailScroll(detail, state)
}
