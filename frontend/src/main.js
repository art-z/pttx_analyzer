import './style.css'
import { renderConstructor, teardownConstructorMode } from './constructor/render.js'
import { renderTemplates } from './templates/render.js'
import { renderSlides } from './slides/render.js'
import { captureComponentDetailScroll, renderComponentsPanel } from './components/panel.js'
import { countAllComponents } from './components/catalog.js'
import { extractDesignTokens } from './constructor/tokens.js'
import { buildScenarioSlide } from './presentation/build-slide.js'
import { createCoverageContext, recordDisplayedVariants } from './presentation/component-coverage.js'
import { collectLayoutFeedback } from './presentation/layout-feedback.js'
import { mountScenarioSlidePreviewVariants } from './presentation/render-scenario-slide.js'
import { exportGeneratedPresentation } from './presentation/export-generated-presentation.js'
import { renderVgroups } from './vgroups/render.js'
import { detectDeckVgroups } from './slides/vgroup-detect.js'

const $ = (selector) => document.querySelector(selector)
let presentationPreviewDisposers = []
let presentationObserver = null
let presentationHydrators = []
const state = { file: null, brief: '', generatePresentation: false, report: null, presentation: null, presentationError: null, llmUsage: null, jobId: null, presentationSelections: {}, presentationBuildResults: [], preflightBuildResults: null, presentationExporting: false, presentationExportFormat: null, resultsView: 'analysis', tab: 'typography', mediaFilter: 'all', spatialComponent: 'slide_title', selectedComponent: null, componentGroupFilter: 'all', componentTemplateId: null, componentViewMode: 'preview', componentInstanceIndex: 0, componentModelData: null, constructor: null, selectedSlideNumber: null, selectedVgroupSlideNumber: null, activeVgroupId: null, vgroupsShowBounds: true, vgroupsCompareFlat: true, slidesView: 'gallery', slidesRenderMode: 'design-system', selectedPatternId: null, patternLayoutFilter: 'all', loading: false }
const tabs = [
  { id: 'typography', label: 'Font / text styles', count: (r) => r.typography.text_slots?.summary.template_slots ?? r.typography.styles.length },
  { id: 'components', label: 'Components', count: (r) => countAllComponents(r) },
  { id: 'slides', label: 'Slides', count: (r) => r.slides?.summary?.slide_count ?? 0 },
  { id: 'vgroups', label: 'VGroups', count: (r) => detectDeckVgroups(r?.slides, r).summary.totalGroups },
  { id: 'templates', label: 'Templates', count: (r) => r.slide_templates?.summary?.template_count ?? 0 },
  { id: 'constructor', label: 'Constructor', count: (r) => r.typography.components?.summary?.component_count ?? 0 },
  { id: 'spatial', label: 'Layout / zones', count: (r) => r.typography.spatial?.components?.length ?? 0 },
  { id: 'media', label: 'Media files', count: (r) => r.assets.media_files.length },
  { id: 'colors', label: 'Colors', count: (r) => r.colors.resolved_palette.length }
]
const contexts = { text: 'Текст', fill: 'Заливка', stroke: 'Контур', background: 'Фон', effect: 'Эффекты', other: 'Другое' }
const number = (value) => new Intl.NumberFormat('ru-RU').format(value || 0)
const bytes = (value) => value < 1024 ? `${value} Б` : value < 1024 ** 2 ? `${(value / 1024).toFixed(1)} КБ` : `${(value / 1024 ** 2).toFixed(1)} МБ`
const node = (tag, className = '', value = '') => {
  const element = document.createElement(tag)
  if (className) element.className = className
  if (value !== null && value !== undefined) element.textContent = String(value)
  return element
}
const append = (parent, ...children) => { parent.append(...children); return parent }
const sectionTitle = (title, note) => append(node('div', 'section-title'), append(node('div'), node('h3', '', title), node('p', '', note)))
const empty = (text) => node('div', 'section-empty', text)
const fmt = (value, fallback = '—') => value === null || value === undefined || value === '' ? fallback : String(value)

function updateActionButtonLabel() {
  const label = state.generatePresentation ? 'Создать презентацию' : 'Анализировать шаблон'
  $('#create-button').innerHTML = `${label} <span aria-hidden="true">↗</span>`
}

function updateUploadCopy() {
  if (!state.file) return
  $('#upload-title').textContent = state.generatePresentation
    ? 'Шаблон готов к созданию презентации'
    : 'Шаблон готов к анализу'
}

function updateGeneratePresentationUI() {
  const enabled = state.generatePresentation
  $('#brief-input').disabled = !enabled
  $('#brief-field').classList.toggle('brief-field--disabled', !enabled)
  updateActionButtonLabel()
  updateUploadCopy()
}

function updateCreateButtonState() {
  const ready = Boolean(state.file && (!state.generatePresentation || state.brief.trim()))
  $('#create-button').disabled = !ready || state.loading
}

function setFile(file) {
  if (!file) return
  if (!file.name.toLowerCase().endsWith('.pptx')) {
    state.file = null
    $('#selected-file').textContent = 'Файл не выбран'
    updateCreateButtonState()
    showError('Выберите файл в формате .pptx')
    return
  }
  state.file = file
  $('#selected-file').textContent = `${file.name} · ${bytes(file.size)}`
  updateUploadCopy()
  $('#upload-hint').textContent = 'Можно выбрать другой файл'
  $('#error').hidden = true
  updateCreateButtonState()
}

function showError(message) {
  $('#error').textContent = message
  $('#error').hidden = false
}

async function loadDefaultBrief() {
  try {
    const response = await fetch('/prompts/default-brief')
    const data = await response.json()
    if (!response.ok) throw new Error(data.detail || 'Не удалось загрузить бриф')
    state.brief = String(data.brief || '')
    $('#brief-input').value = state.brief
    updateCreateButtonState()
  } catch (error) {
    showError(error.message || 'Не удалось загрузить бриф по умолчанию')
  }
}

async function createPresentation() {
  if (!state.file || state.loading) return
  if (state.generatePresentation && !state.brief.trim()) return
  state.loading = true
  updateCreateButtonState()
  $('#create-button').textContent = state.generatePresentation ? 'Создаём презентацию…' : 'Анализируем шаблон…'
  $('#error').hidden = true
  try {
    state.preflightBuildResults = null
    const body = new FormData()
    body.append('file', state.file)
    body.append('generate_presentation', state.generatePresentation ? 'true' : 'false')
    body.append('brief', state.generatePresentation ? state.brief.trim() : '')
    const response = await fetch('/create-presentation', { method: 'POST', body })
    const data = await response.json()
    if (!response.ok) {
      throw new Error(data.detail || (state.generatePresentation
        ? 'Не удалось создать презентацию'
        : 'Не удалось проанализировать шаблон'))
    }
    if (data.presentation?.presentation?.slides?.length) {
      const build = await preflightPresentation(data.report, data.presentation)
      data.presentation.layout_issues_after_review = collectLayoutFeedback(
        data.presentation.presentation.slides, build, data.report,
      )
      state.preflightBuildResults = build
    }
    state.report = data.report
    state.presentation = data.presentation
    state.presentationError = data.presentation_error
    state.llmUsage = data.llm_usage || null
    state.jobId = data.job_id
    state.presentationSelections = {}
    state.presentationBuildResults = []
    state.resultsView = (data.presentation || data.presentation_error) ? 'generation' : 'analysis'
    state.tab = 'typography'
    state.mediaFilter = 'all'
    state.constructor = null
    state.selectedSlideNumber = null
    render()
    $('#results').scrollIntoView({ behavior: 'smooth', block: 'start' })
  } catch (error) {
    showError(error.message || (state.generatePresentation
      ? 'Не удалось создать презентацию'
      : 'Не удалось проанализировать шаблон'))
  } finally {
    state.loading = false
    updateCreateButtonState()
    updateActionButtonLabel()
  }
}

async function preflightPresentation(report, presentation, totalSlides = null) {
  const slides = presentation?.presentation?.slides || []
  const tokens = extractDesignTokens(report)
  const selectionContext = createCoverageContext(report)
  const built = []
  for (let index = 0; index < slides.length; index += 1) {
    const slide = slides[index]
    try {
      const result = buildScenarioSlide(report, slide, tokens, {
        selectionContext,
        seed: `${presentation.presentation.title || 'presentation'}|${slide.index ?? index + 1}|${slide.intent || ''}`,
        position: index,
        totalSlides: totalSlides || slides.length,
      })
      built.push(result)
      recordDisplayedVariants(selectionContext, result.previewVariants?.slice(0, 3))
    } catch {
      built.push({ previewVariants: [] })
    }
    if (index % 2 === 1) await new Promise((resolve) => requestAnimationFrame(resolve))
  }
  return built
}

function renderLLMUsage() {
  const usageNode = $('#llm-usage')
  const usage = state.llmUsage
  if (!usage || !usage.request_count) {
    usageNode.hidden = true
    usageNode.replaceChildren()
    return
  }

  usageNode.hidden = false
  usageNode.replaceChildren(
    append(node('div', 'llm-usage-head'),
      node('span', 'section-kicker', 'РАСХОД ТОКЕНОВ'),
      node('p', '', 'Сумма по всем запросам к модели для этой презентации')),
    append(node('div', 'llm-usage-metrics'),
      metric(usage.request_count, 'запросов'),
      metric(usage.input_tokens, 'вход'),
      metric(usage.output_tokens, 'выход'),
      metric(usage.total_tokens, 'всего')),
  )
}

function disposePresentationView() {
  presentationObserver?.disconnect()
  presentationObserver = null
  presentationPreviewDisposers.forEach((dispose) => dispose())
  presentationPreviewDisposers = []
  presentationHydrators = []
  state.presentationBuildResults = []
  $('#presentation-slides').replaceChildren()
}

function updatePresentationExportButton(slideCount = null) {
  const count = slideCount ?? state.presentation?.presentation?.slides?.length ?? 0
  const actions = $('.presentation-export-actions')
  actions.hidden = !count
  for (const button of actions.querySelectorAll('[data-export-format]')) {
    button.disabled = state.presentationExporting || !count
    const format = button.dataset.exportFormat.toUpperCase()
    button.textContent = state.presentationExportFormat === button.dataset.exportFormat
      ? `Собираем ${format}…` : `Скачать ${format}`
  }
}

function renderPresentation() {
  const section = $('#presentation-section')
  const errorNode = $('#presentation-error')
  const slidesNode = $('#presentation-slides')
  disposePresentationView()
  section.hidden = false
  errorNode.hidden = true

  if (state.presentationError) {
    updatePresentationExportButton(0)
    $('#presentation-title').textContent = 'Сценарий не получен'
    $('#presentation-meta').textContent = 'Анализ шаблона выполнен, но модель не вернула сценарий'
    errorNode.textContent = state.presentationError
    errorNode.hidden = false
    return
  }

  const payload = state.presentation?.presentation
  if (!payload) {
    updatePresentationExportButton(0)
    section.hidden = true
    return
  }

  const unresolved = state.presentation?.layout_issues_after_review || []
  if (unresolved.length) {
    errorNode.textContent = `После повторной проверки остались замечания к компоновке: ${unresolved.map((item) => item.slide).join(', ')}. Выберите наиболее удачный вариант каждого слайда.`
    errorNode.hidden = false
  }

  $('#presentation-title').textContent = payload.title || 'Презентация'
  const meta = [payload.goal, payload.audience].filter(Boolean)
  $('#presentation-meta').textContent = meta.join(' · ')

  const slides = Array.isArray(payload.slides) ? payload.slides : []
  const baseTokens = state.report ? extractDesignTokens(state.report) : null
  const selectionContext = state.report ? createCoverageContext(state.report) : null

  updatePresentationExportButton(slides.length)

  if ('IntersectionObserver' in window) {
    presentationObserver = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return
        presentationObserver?.unobserve(entry.target)
        const position = Number(entry.target.dataset.slidePosition)
        presentationHydrators[position]?.(true)
      })
    }, { rootMargin: '500px 0px' })
  }

  slides.forEach((slide, slidePosition) => {
    const card = node('article', 'presentation-slide-card')
    card.dataset.slidePosition = String(slidePosition)
    const head = append(node('div', 'presentation-slide-head'),
      node('strong', '', `Слайд ${String(slide.index ?? '').padStart(2, '0')}`),
      node('span', '', String(slide.intent || 'slide').toUpperCase()))
    card.append(head)

    const buildMount = node('div', 'presentation-slide-lazy', 'Собираем слайд…')
    card.append(buildMount)
    let buildResult = null
    let buildFailed = false
    let previewMounted = false
    const hydrate = (mountPreview = true) => {
      if (buildFailed) return null
      if (!baseTokens || !state.report) {
        buildMount.replaceChildren()
        return null
      }
      const selectionId = String(slide.index ?? slidePosition + 1)
      if (!buildResult) {
        try {
          buildResult = state.preflightBuildResults?.[slidePosition] || buildScenarioSlide(state.report, slide, baseTokens, {
            selectionContext,
            seed: `${payload.title || 'presentation'}|${selectionId}|${slide.intent || ''}`,
            position: slidePosition,
            totalSlides: slides.length,
          })
        } catch (error) {
          buildFailed = true
          buildMount.classList.add('hydrated')
          buildMount.replaceChildren(node(
            'p',
            'presentation-slide-analysis-error',
            error instanceof RangeError
              ? 'Поиск шаблона превысил допустимую глубину'
              : `Не удалось подобрать шаблон: ${error?.message || 'неизвестная ошибка'}`,
          ))
          return null
        }
        state.presentationBuildResults[slidePosition] = buildResult
        buildMount.classList.add('hydrated')
        const selectedKey = state.presentationSelections[selectionId]
          || buildResult.previewVariants?.[0]?.key
          || null
        if (selectedKey) state.presentationSelections[selectionId] = selectedKey
        const selectedVariant = buildResult.previewVariants?.find((item) => item.key === selectedKey)
          || buildResult.previewVariants?.[0]
        recordDisplayedVariants(selectionContext, buildResult.previewVariants?.slice(0, 3))

        buildMount.replaceChildren()
        const renderLabel = buildResult.match.templateName || '—'
        const matchMeta = append(node('div', 'presentation-slide-match'),
          node('span', '', renderLabel))
        if (buildResult.filled.length) {
          matchMeta.append(node('span', '', ` · ${buildResult.filled.join(' → ')}`))
        }
        buildMount.append(matchMeta)

        if (buildResult.gaps.length) {
          const gaps = node('ul', 'presentation-slide-gaps')
          buildResult.gaps.forEach((gap) => gaps.append(node('li', '', gap)))
          buildMount.append(gaps)
        }
      }

      if (mountPreview && !previewMounted) {
        previewMounted = true
        const selectedKey = state.presentationSelections[selectionId] || buildResult.previewVariants?.[0]?.key
        const previewMount = node('div', 'presentation-slide-preview-mount')
        buildMount.insertBefore(previewMount, buildMount.querySelector('.presentation-slide-gaps'))
        presentationPreviewDisposers.push(mountScenarioSlidePreviewVariants(previewMount, buildResult, state.jobId, {
          selectedKey,
          onSelect: (variant) => {
            state.presentationSelections[selectionId] = variant.key
          },
        }))
      }
      return buildResult
    }
    presentationHydrators[slidePosition] = hydrate

    const jsonToggle = node('button', 'presentation-slide-json-toggle', 'JSON')
    jsonToggle.type = 'button'
    const jsonBlock = node('pre', 'presentation-slide-json')
    jsonBlock.hidden = true
    jsonBlock.textContent = JSON.stringify(slide, null, 2)
    jsonToggle.addEventListener('click', () => {
      jsonBlock.hidden = !jsonBlock.hidden
      jsonToggle.textContent = jsonBlock.hidden ? 'JSON' : 'Скрыть JSON'
      jsonToggle.classList.toggle('active', !jsonBlock.hidden)
    })
    card.append(append(node('div', 'presentation-slide-json-actions'), jsonToggle), jsonBlock)
    slidesNode.append(card)
    if (presentationObserver) presentationObserver.observe(card)
    else hydrate(true)
  })
}

async function hydratePresentationForExport() {
  for (let index = 0; index < presentationHydrators.length; index += 1) {
    presentationHydrators[index]?.(false)
    if (index % 2 === 1) await new Promise((resolve) => requestAnimationFrame(resolve))
  }
}

async function handleGeneratedPresentationExport(format = 'pptx') {
  if (state.presentationExporting) return
  state.presentationExporting = true
  state.presentationExportFormat = format
  updatePresentationExportButton()
  try {
    await hydratePresentationForExport()
    const rawSlides = state.presentation?.presentation?.slides || []
    const selectedSlides = rawSlides.map((rawSlide, index) => {
      const buildResult = state.presentationBuildResults[index]
      if (!buildResult) return null
      const selectionId = String(rawSlide.index ?? index + 1)
      const selectedKey = state.presentationSelections[selectionId]
      const variant = buildResult.previewVariants?.find((item) => item.key === selectedKey)
        || buildResult.previewVariants?.[0]
      return variant?.catalogSlide || buildResult.catalogSlide
    }).filter(Boolean)
    await exportGeneratedPresentation(state, selectedSlides, format)
  } catch (error) {
    showError(error.message || 'Не удалось экспортировать презентацию')
  } finally {
    state.presentationExporting = false
    state.presentationExportFormat = null
    updatePresentationExportButton()
  }
}

function hasGenerationResult() {
  return Boolean(state.presentation?.presentation || state.presentationError)
}

function renderResultsViewTabs() {
  const tabsNode = $('#results-view-tabs')
  tabsNode.hidden = !hasGenerationResult()
  tabsNode.querySelectorAll('[data-results-view]').forEach((button) => {
    const active = button.dataset.resultsView === state.resultsView
    button.classList.toggle('active', active)
    button.setAttribute('aria-selected', String(active))
  })
}

function render() {
  const report = state.report
  $('#results').hidden = false
  $('#empty-state').hidden = true
  renderResultsViewTabs()
  const showGeneration = state.resultsView === 'generation' && hasGenerationResult()
  $('#analysis-section').hidden = showGeneration
  $('#presentation-section').hidden = !showGeneration
  if (showGeneration) {
    $('#panel').replaceChildren()
    teardownConstructorMode()
    renderLLMUsage()
    renderPresentation()
    return
  }

  disposePresentationView()
  $('#presentation-section').hidden = true
  $('#llm-usage').hidden = true
  $('#result-title').textContent = state.file.name
  $('#download-report').href = `/jobs/${encodeURIComponent(state.jobId)}/report.json`
  const stats = [
    [report.stats.assets.media_files, 'медиафайлов'],
    [report.stats.typography.font_families, 'семейств шрифтов'],
    [report.stats.typography.template_slots, 'слотов шаблона'],
    [report.colors.resolved_palette.length, 'цветов в палитре']
  ]
  $('#stats').replaceChildren(...stats.map(([value, label], index) => append(node('div', 'stat'), node('span', 'stat-index', `0${index + 1}`), node('strong', '', number(value)), node('span', 'stat-label', label))))
  renderTabs()
  renderPanel()
}

function renderTabs() {
  $('#tabs').replaceChildren(...tabs.map((tab) => {
    const button = append(node('button', `tab ${state.tab === tab.id ? 'active' : ''}`), node('span', '', tab.label), node('small', '', number(tab.count(state.report))))
    button.type = 'button'
    button.role = 'tab'
    button.id = `tab-${tab.id}`
    button.setAttribute('aria-selected', String(state.tab === tab.id))
    button.setAttribute('aria-controls', 'panel')
    button.addEventListener('click', () => { state.tab = tab.id; renderTabs(); renderPanel() })
    return button
  }))
}

function renderPanel() {
  const panel = $('#panel')
  if (state.tab === 'components') captureComponentDetailScroll(panel, state)
  panel.setAttribute('aria-labelledby', `tab-${state.tab}`)
  panel.replaceChildren()
  if (state.tab !== 'constructor') teardownConstructorMode()
  if (state.tab === 'media') renderMedia(panel)
  if (state.tab === 'typography') renderTypography(panel)
  if (state.tab === 'components') renderComponents(panel)
  if (state.tab === 'templates') renderTemplates(panel, state)
  if (state.tab === 'slides') renderSlides(panel, state)
  if (state.tab === 'vgroups') renderVgroups(panel, state)
  if (state.tab === 'constructor') renderConstructor(panel, state, { onChange: renderPanel })
  if (state.tab === 'spatial') renderSpatial(panel)
  if (state.tab === 'colors') renderColors(panel)
}

function renderMedia(panel) {
  const { assets, stats } = state.report
  append(panel, sectionTitle('Медиафайлы', 'Изображения и другие вложения из презентации'))
  const metrics = append(node('div', 'mini-metrics'),
    metric(stats.assets.unique_exact_assets, 'уникальных файлов'),
    metric(stats.assets.background_candidates || 0, 'вероятных фонов'),
    metric(stats.assets.icon_files || 0, 'вероятных иконок'),
    metric(stats.assets.total_asset_occurrences, 'использований'))
  panel.append(metrics)
  if (!assets.media_files.length) return panel.append(empty('Медиафайлы не найдены'))

  const byName = new Map(assets.media_files.map((asset) => [asset.filename, asset]))
  if (assets.background_candidates?.length) {
    const section = append(node('section', 'media-feature'),
      node('h4', '', `Вероятные фоны и подложки · ${number(assets.background_candidates.length)}`),
      node('p', '', 'Изображения, которые служат фоновой заливкой или занимают большую часть слайда.'))
    const grid = node('div', 'media-grid feature-grid')
    assets.background_candidates.slice(0, 6).forEach((candidate) => {
      const asset = byName.get(candidate.filename)
      if (asset) grid.append(mediaCard(asset))
    })
    section.append(grid)
    panel.append(section)
  }

  if (assets.icon_groups?.length) {
    const section = append(node('section', 'media-feature'),
      node('h4', '', `Серии вероятных иконок · ${number(assets.icon_groups.length)}`),
      node('p', '', 'Группы файлов с одинаковым форматом и размером, без фоновых изображений.'))
    const groups = node('div', 'icon-groups')
    assets.icon_groups.slice(0, 6).forEach((group) => {
      const card = node('article', 'icon-group-card')
      const previews = node('div', 'icon-group-previews')
      group.files.slice(0, 4).forEach((filename) => {
        const image = node('img')
        image.src = `/jobs/${encodeURIComponent(state.jobId)}/assets/${encodeURIComponent(filename)}`
        image.alt = filename
        image.loading = 'lazy'
        previews.append(image)
      })
      append(card, previews, node('strong', '', `${number(group.file_count)} файлов`),
        node('small', '', `${group.width} × ${group.height} px · ${group.extension}`))
      groups.append(card)
    })
    section.append(groups)
    panel.append(section)
  }

  const filters = [
    ['all', 'Все', assets.media_files.length],
    ['background', 'Фоны', assets.background_candidates?.length || 0],
    ['icons', 'Иконки', stats.assets.icon_files || 0],
  ]
  const filterBar = append(node('div', 'media-filter-bar'), node('h4', '', 'Все медиафайлы'))
  const buttons = node('div', 'media-filters')
  filters.forEach(([id, label, count]) => {
    const button = node('button', `media-filter ${state.mediaFilter === id ? 'active' : ''}`, `${label} · ${number(count)}`)
    button.type = 'button'
    button.addEventListener('click', () => { state.mediaFilter = id; renderPanel() })
    buttons.append(button)
  })
  filterBar.append(buttons)
  panel.append(filterBar)

  const visible = assets.media_files.filter((asset) => state.mediaFilter === 'all'
    || (state.mediaFilter === 'background' && asset.background_likelihood >= 0.7)
    || (state.mediaFilter === 'icons' && asset.icon_group_id))
  if (!visible.length) return panel.append(empty('В этой группе файлов нет'))
  const grid = node('div', 'media-grid')
  visible.forEach((asset) => grid.append(mediaCard(asset)))
  panel.append(grid)
}

function mediaCard(asset) {
    const card = node('article', 'media-card')
    const preview = node('div', 'media-preview')
    if (['.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg'].includes(asset.extension)) {
      const image = node('img')
      image.src = `/jobs/${encodeURIComponent(state.jobId)}/assets/${encodeURIComponent(asset.filename)}`
      image.alt = asset.filename
      image.loading = 'lazy'
      image.addEventListener('error', () => image.replaceWith(node('span', 'media-fallback', asset.extension || 'FILE')))
      preview.append(image)
    } else preview.append(node('span', 'media-fallback', asset.extension || 'FILE'))
    const meta = append(node('div', 'media-meta'), node('strong', '', asset.filename), node('small', '', `${bytes(asset.bytes)}${asset.width ? ` · ${asset.width} × ${asset.height}` : ''}`))
    if (asset.background_likelihood >= 0.7) meta.append(node('span', 'media-tag background-tag', asset.background_reason || 'Вероятный фон'))
    else if (asset.icon_group_id) meta.append(node('span', 'media-tag icon-tag', 'Вероятная иконка'))
    const location = asset.slide_numbers?.length
      ? `Слайды ${asset.slide_numbers.join(', ')}`
      : asset.sources?.some((source) => /slideLayouts|slideMasters/.test(source.part)) ? 'В шаблоне' : 'Нет ссылок на слайды'
    const footer = append(node('div', 'media-footer'), node('span', '', `${number(asset.occurrences)} исп.`), node('span', '', location))
    append(card, preview, meta, footer)
    return card
}

function metric(value, label) { return append(node('div', 'mini-metric'), node('strong', '', number(value)), node('span', '', label)) }

function dataTable(headings, rows) {
  const wrapper = node('div', 'table-wrap')
  const table = node('table')
  const thead = append(node('thead'), append(node('tr'), ...headings.map((label) => node('th', '', label))))
  const tbody = node('tbody')
  rows.forEach((row) => tbody.append(append(node('tr'), ...row.map((value) => node('td', '', value)))))
  return append(wrapper, append(table, thead, tbody))
}

function renderFinalScales(typography) {
  const scales = typography.type_scales || []
  const usageByFamily = new Map((typography.scale_usage?.scale_roles || []).map((item) => [item.family, item]))
  const block = node('section', 'final-scales')
  append(block, node('h3', '', 'Итоговая шкала шрифтов'),
    node('p', 'final-scales-note', 'Зелёная заливка: размер найден в тексте и слотах. Зелёный контур: размер есть в тексте и продолжает шкалу выше подтверждённого максимума. Body и заголовок слайда выводятся из геометрии и паттернов использования на слайдах.'))
  if (!scales.length) return append(block, empty('Данных для шкалы шрифтов нет'))

  scales.forEach((scale, familyIndex) => {
    const card = node('article', 'font-scale')
    const levels = scale.levels || scale.steps || []
    const usage = usageByFamily.get(scale.family)
    const usageLevels = new Map((usage?.levels || []).map((level) => [level.scale_level, level]))
    const legacyBody = levels.find((level) => level.role === 'body')
    const bodyLevel = usage?.inferred_body_level ?? legacyBody?.scale_level
    const bodyConfidence = usage?.inferred_body_confidence ?? 0
    const bodyStep = bodyConfidence >= 0.2 ? (usageLevels.get(bodyLevel) || legacyBody) : null
    const headingLeft = append(node('div'), node('small', '', `ШРИФТ ${String(familyIndex + 1).padStart(2, '0')}`), node('h4', '', scale.family === 'Наследуется' ? 'Не определён (наследуемый)' : scale.family))
    if (levels.length) {
      const range = append(node('div', 'scale-range'),
        node('small', '', `${levels.length} уровней · ${levels[levels.length - 1].size_pt}–${levels[0].size_pt} pt`))
      const track = node('div', 'scale-range-track')
      levels.slice().reverse().forEach((level) => {
        const chip = node('span', `scale-range-chip ${level.scale_level === bodyLevel || level.role === 'body' ? 'is-body' : ''}`, `${level.size_pt}`)
        chip.title = `${level.size_pt} pt`
        track.append(chip)
      })
      range.append(track)
      headingLeft.append(range)
    }
    const heading = append(node('div', `font-scale-heading ${bodyStep ? 'body-strong' : ''}`),
      headingLeft,
      bodyStep
        ? append(node('div', 'body-marker'), node('strong', '', `Body · ${bodyStep.size_pt} pt`),
          node('small', '', usage
            ? `уверенность ${Math.round(bodyConfidence * 100)}% · ${bodyStep.role_hint || 'по объёму текста и геометрии'}`
            : scale.body_basis === 'weighted' ? 'по взвешенной частоте' : 'по числу уровней слотов'))
        : node('div', 'body-marker', node('small', '', 'Роли по геометрии пока не определены')))
    card.append(heading)
    const list = node('div', 'font-scale-list')
    for (const step of levels) {
      const role = usageLevels.get(step.scale_level)
      const isBody = role?.scale_level === bodyLevel
      const row = node('div', `font-scale-step ${isBody ? 'is-body' : ''} ${step.size_confidence === 'high' ? 'is-strong' : ''} ${step.size_confidence === 'extended' ? 'is-extended' : ''}`)
      const stepOffset = role?.step_from_body ?? step.step
      const label = stepOffset == null
        ? (step.scale_level == null ? '—' : `L${step.scale_level}`)
        : stepOffset === 0 ? 'BODY' : stepOffset > 0 ? `+${stepOffset}` : String(stepOffset).replace('-', '−')
      const meta = append(node('div', 'font-scale-meta'), node('span', 'scale-step-label', label),
        node('strong', '', `${step.size_pt} pt`))
      if (step.size_confidence === 'high') meta.append(node('span', 'scale-confidence', 'текст + слоты'))
      if (step.size_confidence === 'extended') {
        const badge = node('span', 'scale-confidence inferred', 'продолжение шкалы')
        badge.title = `Подтверждено текстом; шаг от ${step.extension_from_pt} pt: ${step.extension_ratio}×`
        meta.append(badge)
      }
      if (role) {
        if (role.role_hint === 'body' || (role.body_probability || 0) >= 0.25) {
          meta.append(node('span', 'scale-confidence role-body', `body ${Math.round((role.body_probability || 0) * 100)}%`))
        }
        if (role.role_hint === 'slide_title' || (role.slide_title_probability || 0) >= 0.25) {
          meta.append(node('span', 'scale-confidence role-title', `title ${Math.round(role.slide_title_probability * 100)}%`))
        }
      }
      const preview = node('div', 'font-scale-preview')
      const sample = node('span', '', 'Аа Текст задаёт ритм')
      if (scale.family !== 'Наследуется') sample.style.fontFamily = `"${scale.family.replace(/["\\]/g, '\\$&')}", sans-serif`
      sample.style.fontSize = `${step.size_pt}pt`
      sample.style.lineHeight = step.line_height_applicable === false
        ? 'normal'
        : (step.line_height_pt == null ? 'normal' : `${step.line_height_pt}pt`)
      preview.append(sample)
      const pptxLnSpc = step.pptx_line_spacing_ratio
      const height = step.line_height_applicable === false
        ? (pptxLnSpc == null
          ? 'Строка: normal (метрики шрифта)'
          : `lnSpc в файле ${Math.round(pptxLnSpc * 1000) / 10}% · рендер: normal`)
        : (step.line_height_pt == null
          ? 'Строка не задана'
          : `Строка ${step.line_height_source === 'size' ? '≈' : ''}${step.line_height_ratio}× · ${step.line_height_pt} pt`)
      const usageText = step.text_occurrences
        ? `${number(step.text_occurrences)} в тексте · ${number(step.slot_occurrences)} уровней слотов`
        : `${number(step.slot_occurrences)} уровней слотов`
      const roleText = role
        ? `${number(role.block_count)} блоков · ${number(role.slide_count)} слайдов · ${role.metrics?.multiline_ratio != null ? `${Math.round(role.metrics.multiline_ratio * 100)}% многострочных` : '—'}`
        : usageText
      const detail = append(node('div', 'font-scale-detail'), node('strong', step.height_confidence === 'high' ? 'height-confirmed' : '', height), node('small', '', roleText))
      const originals = step.original_sizes_pt || [step.size_pt]
      if (originals.length > 1 || originals[0] !== step.size_pt) {
        detail.append(node('small', 'normalized-sizes', `из ${originals.map((size) => `${size} pt`).join(' · ')}`))
      }
      append(row, meta, preview, detail)
      list.append(row)
    }
    card.append(list)
    block.append(card)
  })
  block.append(node('p', 'heatmap-note', 'Примеры показаны в натуральном размере. Для отсутствующего на устройстве шрифта браузер использует замену. Высота строки указана множителем размера шрифта и в pt.'))
  return block
}

function renderTypeScale(typography, mode = 'slots') {
  const slotStyles = typography.text_slots?.slot_styles || []
  const usingSlots = mode === 'slots' && slotStyles.length > 0
  const block = append(node('section', 'content-block type-scale'), node('h4', '', usingSlots ? 'Исходные размеры слотов' : 'Исходные размеры текстовых фрагментов'))
  const counts = new Map()
  const breakdown = new Map()
  const sizes = new Set()
  for (const style of usingSlots ? slotStyles : typography.styles) {
    if (style.size_pt == null) continue
    const family = style.family || 'Наследуется'
    const size = Number(style.size_pt)
    sizes.add(size)
    if (!counts.has(family)) counts.set(family, new Map())
    const familyCounts = counts.get(family)
    familyCounts.set(size, (familyCounts.get(size) || 0) + style.occurrences)
    if (usingSlots) breakdown.set(`${family}\u0000${size}`, style)
  }
  if (!sizes.size) return append(block, empty('Размеры текста для шкалы не найдены'))

  const sortedSizes = [...sizes].sort((a, b) => a - b)
  const families = [...counts.entries()].sort((a, b) => {
    const total = (entries) => [...entries.values()].reduce((sum, count) => sum + count, 0)
    return total(b[1]) - total(a[1])
  })
  const max = Math.max(...families.flatMap(([, entries]) => [...entries.values()]))
  const legend = append(node('div', 'heatmap-legend'), node('span', '', 'Реже'))
  for (const level of [0.15, 0.3, 0.5, 0.72, 1]) {
    const swatch = node('span', 'heatmap-legend-cell')
    swatch.style.backgroundColor = `rgba(30, 161, 106, ${level})`
    legend.append(swatch)
  }
  legend.append(node('span', '', 'Чаще'))
  block.append(legend)

  const scroll = node('div', 'heatmap-scroll')
  const grid = node('div', 'heatmap-grid')
  grid.style.minWidth = `${190 + sortedSizes.length * (usingSlots ? 76 : 50)}px`
  grid.style.gridTemplateColumns = `minmax(150px, 190px) repeat(${sortedSizes.length}, minmax(${usingSlots ? 74 : 48}px, 1fr))`
  grid.append(node('div', 'heatmap-corner', 'Шрифт / pt'))
  sortedSizes.forEach((size) => grid.append(node('div', 'heatmap-axis', size)))
  for (const [family, familyCounts] of families) {
    grid.append(node('div', 'heatmap-family', family))
    for (const size of sortedSizes) {
      const count = familyCounts.get(size) || 0
      const source = breakdown.get(`${family}\u0000${size}`)
      const cell = node('div', `heatmap-cell ${usingSlots ? 'with-height' : ''} ${count ? 'filled' : ''}`)
      if (count && usingSlots) {
        const height = source?.line_height_pt
        append(cell,
          node('strong', 'heatmap-height', height == null ? '—' : `${source.line_height_source === 'size' ? '≈' : ''}${height} pt`),
          node('small', 'heatmap-uses', `× ${number(count)}`))
      } else cell.textContent = count ? number(count) : '·'
      if (count) {
        const intensity = 0.14 + 0.86 * Math.sqrt(count / max)
        cell.style.backgroundColor = `rgba(30, 161, 106, ${intensity})`
        if (intensity > 0.58) cell.classList.add('strong')
      }
        cell.title = usingSlots && source
        ? `${family} · ${size} pt · высота строки: ${source.line_height_pt == null ? (source.pptx_line_spacing_ratio != null ? `normal · lnSpc ${Math.round(source.pptx_line_spacing_ratio * 1000) / 10}%` : 'normal (метрики шрифта)') : `${source.line_height_pt} pt${source.line_height_source === 'size' ? ' (по другим шрифтам этого размера)' : ''}`} · варианты: ${source.line_height_variants?.map((item) => `${item.height_pt} pt ×${item.occurrences}`).join(', ') || 'нет'} · ${number(count)} уровней слотов (шаблон: ${number(source.template_occurrences)}, слайды: ${number(source.slide_occurrences)})`
        : `${family} · ${size} pt · ${number(count)} применений`
      grid.append(cell)
    }
  }
  block.append(append(scroll, grid))
  block.append(node('p', 'heatmap-note', usingSlots
    ? 'В ячейке — наиболее частая высота строки в pt; × показывает число уровней слотов. Знак ≈ означает оценку по другим шрифтам того же размера. Пустое значение означает, что межстрочный интервал не задан.'
    : 'Показаны размеры, явно заданные в текстовых фрагментах. Число — количество применений.'))
  return block
}

function renderTemplateSlots(typography) {
  const slots = typography.text_slots
  if (!slots) return null
  const block = append(node('section', 'content-block slot-section'), node('h4', '', `Текстовые слоты шаблона · ${number(slots.summary.template_slots)}`))
  block.append(node('p', 'slot-intro', `${number(slots.summary.empty_template_slots)} пустых слотов сохранено в анализе. Параметры наследуются от master к layout.`))
  if (!slots.templates.length) return append(block, empty('Текстовые слоты шаблона не найдены'))

  const list = node('div', 'slot-list')
  for (const slot of slots.templates) {
    const first = slot.levels.find((level) => level.size_pt != null) || slot.levels[0] || {}
    const detail = node('details', 'slot-card')
    const summary = node('summary', 'slot-summary')
    const identity = append(node('span', 'slot-identity'),
      node('strong', '', slot.placeholder_type || slot.name || 'Текстовая зона'),
      node('small', '', `${slot.source_type === 'layout' ? 'Layout' : 'Master'} ${slot.source.match(/\d+(?=\.xml$)/)?.[0] || ''} · ${slot.name || 'без названия'}`))
    append(summary, identity,
      node('span', `slot-status ${slot.empty ? 'is-empty' : ''}`, slot.empty ? 'Пустой' : 'С текстом'),
      node('span', 'slot-font', `${fmt(first.family, 'Шрифт наследуется')} · ${first.size_pt == null ? '—' : `${first.size_pt} pt`}${first.line_height_pt == null ? '' : ` · строка ${first.line_height_pt} pt`}`),
      node('span', 'slot-chevron', '⌄'))
    detail.append(summary)
    const body = node('div', 'slot-details')
    const geometry = slot.geometry
    body.append(node('p', '', geometry
      ? `Положение: ${geometry.x_pt} × ${geometry.y_pt} pt · Размер: ${geometry.width_pt} × ${geometry.height_pt} pt · Слайдов: ${slot.slide_numbers.length}`
      : `Геометрия не задана · Слайдов: ${slot.slide_numbers.length}`))
    if (slot.inherited_from) body.append(node('p', '', `Наследует: ${slot.inherited_from}`))
    if (slot.body && Object.keys(slot.body).length) {
      const insets = ['left_inset_pt', 'right_inset_pt', 'top_inset_pt', 'bottom_inset_pt']
        .map((key) => slot.body[key] == null ? '—' : slot.body[key]).join(' / ')
      body.append(node('p', '', `Вертикальное выравнивание: ${fmt(slot.body.vertical_anchor)} · Отступы Л/П/В/Н: ${insets} pt`))
    }
    if (slot.levels.length) body.append(dataTable(
      ['Уровень', 'Шрифт', 'Размер', 'Высота строки', 'Начертание', 'Выравнивание', 'Интервал', 'Before', 'After'],
      slot.levels.map((level) => [level.level, fmt(level.family), level.size_pt == null ? '—' : `${level.size_pt} pt`,
        level.line_height_pt == null ? '—' : `${level.line_height_pt} pt`,
        [level.bold && 'Жирный', level.italic && 'Курсив'].filter(Boolean).join(', ') || 'Обычный',
        fmt(level.alignment), level.line_spacing == null ? '—' : `${level.line_spacing} ${level.line_spacing_unit}`,
        level.space_before_pt == null ? '—' : `${level.space_before_pt} pt`,
        level.space_after_pt == null ? '—' : `${level.space_after_pt} pt`])
    ))
    detail.append(body)
    list.append(detail)
  }
  block.append(list)
  return block
}

function renderTypography(panel) {
  const typography = state.report.typography
  append(panel, sectionTitle('Типографика', 'Текстовые слоты шаблона, шрифты и параметры текста'))
  panel.append(renderFinalScales(typography))
  panel.append(renderTypeScale(typography))
  if (typography.styles.length) panel.append(renderTypeScale(typography, 'runs'))
  const slots = renderTemplateSlots(typography)
  if (slots) panel.append(slots)
  const columns = node('div', 'type-columns')
  const families = append(node('section', 'content-block'), node('h4', '', 'Семейства шрифтов'))
  families.append(typography.families.length ? dataTable(['Шрифт', 'Применений'], typography.families.map((x) => [x.family, number(x.occurrences)])) : empty('Явные шрифты не найдены'))
  const sizes = append(node('section', 'content-block'), node('h4', '', 'Размеры текста'))
  sizes.append(typography.sizes.length ? dataTable(['Размер', 'Применений'], typography.sizes.map((x) => [`${x.size_pt} pt`, number(x.occurrences)])) : empty('Явные размеры не найдены'))
  append(columns, families, sizes)
  panel.append(columns)
  const styles = append(node('section', 'content-block'), node('h4', '', `Стили текста · ${number(typography.styles.length)}`))
  styles.append(typography.styles.length ? dataTable(['Шрифт', 'Размер', 'Начертание', 'Интервал', 'Применений'], typography.styles.map((x) => [fmt(x.family, 'Наследуется'), x.size_pt == null ? '—' : `${x.size_pt} pt`, [x.bold && 'Жирный', x.italic && 'Курсив', x.underline && x.underline !== 'none' && 'Подчёркнутый'].filter(Boolean).join(', ') || 'Обычный', x.letter_spacing_pt == null ? '—' : `${x.letter_spacing_pt} pt`, number(x.occurrences)])) : empty('Стили текста не найдены'))
  panel.append(styles)
  if (typography.line_spacings.length) {
    const lines = append(node('section', 'content-block'), node('h4', '', 'Межстрочный интервал'))
    lines.append(dataTable(['Тип', 'Значение', 'Применений'], typography.line_spacings.map((x) => [x.type, `${x.value} ${x.unit}`, number(x.occurrences)])))
    panel.append(lines)
  }
}

function pct(value) {
  return value == null ? '—' : `${Math.round(value * 100)}%`
}

function spatialRange(label, stats, unit = 'pt') {
  if (!stats) return null
  return [label, `${stats.min}–${stats.max} ${unit}`, `мед. ${stats.median} ${unit}`]
}

const SPATIAL_CANVAS_WIDTH = 560
const SPATIAL_COLORS = {
  slide_title: [42, 119, 167],
  text_regions: [26, 154, 98],
  image_regions: [210, 125, 45],
  safe_space: [130, 145, 158],
  repeated_groups: [108, 72, 172],
}

const SPATIAL_LAYOUT_LABELS = { row: 'Строка', column: 'Колонка', grid: 'Сетка' }

function spatialRgb(componentId) {
  return SPATIAL_COLORS[componentId] || SPATIAL_COLORS.slide_title
}

function spatialRgba(componentId, alpha) {
  const [r, g, b] = spatialRgb(componentId)
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}

function spatialNormRect(instance, slideSize) {
  const widthPt = slideSize?.width || 720
  const heightPt = slideSize?.height || 405
  return {
    x: instance.x_norm ?? instance.x_pt / widthPt,
    y: instance.y_norm ?? instance.y_pt / heightPt,
    w: instance.width_norm ?? instance.width_pt / widthPt,
    h: instance.height_norm ?? instance.height_pt / heightPt,
  }
}

function spatialCanvasMetrics(slideSize) {
  const widthPt = slideSize?.width || 720
  const heightPt = slideSize?.height || 405
  const displayWidth = SPATIAL_CANVAS_WIDTH
  const displayHeight = Math.round(displayWidth * heightPt / widthPt)
  return { widthPt, heightPt, displayWidth, displayHeight }
}

function spatialFillAlpha(instanceCount) {
  return Math.min(0.12, Math.max(0.045, 1.8 / Math.max(instanceCount, 1)))
}

function spatialOverlapAlpha(layers, baseAlpha) {
  return 1 - (1 - baseAlpha) ** layers
}

function drawSafeSpaceHeatmap(ctx, component, displayWidth, displayHeight) {
  const heatmap = component.heatmap
  const cols = heatmap.cols
  const rows = heatmap.rows
  const cellW = displayWidth / cols
  const cellH = displayHeight / rows
  const cells = []
  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      const free = heatmap.free_ratios[row][col]
      if (free < 0.04) continue
      const intensity = 0.05 + 0.9 * free
      ctx.fillStyle = spatialRgba('safe_space', intensity)
      ctx.fillRect(col * cellW, row * cellH, cellW + 0.5, cellH + 0.5)
      cells.push({ row, col, free, x: col * cellW, y: row * cellH, w: cellW, h: cellH })
    }
  }
  return {
    fillAlpha: 0.1,
    colorId: 'safe_space',
    hitInstances(x, y) {
      return cells
        .filter((cell) => x >= cell.x && x <= cell.x + cell.w && y >= cell.y && y <= cell.y + cell.h)
        .map((cell) => ({
          text_sample: `Свободно ${Math.round(cell.free * 100)}% слайдов`,
          free_ratio: cell.free,
        }))
    },
  }
}

function drawSpatialCanvas(canvas, component, slideSize) {
  const instances = component.instances || []
  const rules = component.spatial_rules || {}
  const fillAlpha = spatialFillAlpha(instances.length)
  const colorId = component.id
  const [strokeR, strokeG, strokeB] = spatialRgb(colorId)
  const { displayWidth, displayHeight } = spatialCanvasMetrics(slideSize)
  const dpr = window.devicePixelRatio || 1

  canvas.width = Math.round(displayWidth * dpr)
  canvas.height = Math.round(displayHeight * dpr)
  canvas.style.width = `${displayWidth}px`
  canvas.style.height = `${displayHeight}px`

  const ctx = canvas.getContext('2d')
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, displayWidth, displayHeight)

  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, displayWidth, displayHeight)
  ctx.strokeStyle = '#b8c8d4'
  ctx.lineWidth = 1
  ctx.strokeRect(0.5, 0.5, displayWidth - 1, displayHeight - 1)

  if (colorId === 'safe_space' && component.heatmap?.mode === 'free_ratio') {
    return drawSafeSpaceHeatmap(ctx, component, displayWidth, displayHeight)
  }

  if (!instances.length) {
    ctx.fillStyle = '#9ba7b0'
    ctx.font = '13px Arial, sans-serif'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText('Нет данных для heatmap', displayWidth / 2, displayHeight / 2)
    return { hitInstances: () => [] }
  }

  for (const instance of instances) {
    const rect = spatialNormRect(instance, slideSize)
    ctx.fillStyle = spatialRgba(colorId, fillAlpha)
    ctx.fillRect(
      rect.x * displayWidth,
      rect.y * displayHeight,
      rect.w * displayWidth,
      rect.h * displayHeight,
    )
  }

  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const instance of instances) {
    const rect = spatialNormRect(instance, slideSize)
    minX = Math.min(minX, rect.x)
    minY = Math.min(minY, rect.y)
    maxX = Math.max(maxX, rect.x + rect.w)
    maxY = Math.max(maxY, rect.y + rect.h)
  }
  if (Number.isFinite(minX) && colorId !== 'safe_space') {
    ctx.save()
    ctx.strokeStyle = spatialRgba(colorId, 0.38)
    ctx.lineWidth = 1.5
    ctx.setLineDash([6, 4])
    ctx.strokeRect(minX * displayWidth, minY * displayHeight, (maxX - minX) * displayWidth, (maxY - minY) * displayHeight)
    ctx.restore()
  }

  if (rules.x_norm?.median != null && rules.width_norm?.median != null && colorId !== 'safe_space') {
    ctx.strokeStyle = `rgb(${strokeR}, ${strokeG}, ${strokeB})`
    ctx.lineWidth = 2.5
    ctx.setLineDash([])
    ctx.strokeRect(
      rules.x_norm.median * displayWidth,
      rules.y_norm.median * displayHeight,
      rules.width_norm.median * displayWidth,
      rules.height_norm.median * displayHeight,
    )
  }

  return {
    fillAlpha,
    colorId,
    hitInstances(x, y) {
      const nx = x / displayWidth
      const ny = y / displayHeight
      return instances.filter((instance) => {
        const rect = spatialNormRect(instance, slideSize)
        return nx >= rect.x && nx <= rect.x + rect.w && ny >= rect.y && ny <= rect.y + rect.h
      })
    },
  }
}

function renderSpatialCanvasPanel(component, slideSize) {
  const block = append(node('section', 'content-block spatial-canvas-panel'), node('h4', '', 'Heatmap зон'))
  const instances = component.instances || []
  const hasSafeHeatmap = component.id === 'safe_space' && component.heatmap?.mode === 'free_ratio'
  if (!instances.length && !hasSafeHeatmap) return append(block, empty('Недостаточно данных для heatmap'))

  const { widthPt, heightPt, displayWidth, displayHeight } = spatialCanvasMetrics(slideSize)
  block.append(node('p', 'spatial-canvas-note', `${widthPt} × ${heightPt} pt · соотношение ${(widthPt / heightPt).toFixed(2)}:1`))

  const legend = append(node('div', 'heatmap-legend spatial-canvas-legend'))
  if (hasSafeHeatmap) {
    legend.append(node('span', '', 'Занято'))
    for (const level of [0.15, 0.35, 0.55, 0.75, 0.95]) {
      const swatch = node('span', 'heatmap-legend-cell')
      swatch.style.backgroundColor = spatialRgba('safe_space', 0.05 + 0.9 * level)
      swatch.title = `Свободно ${Math.round(level * 100)}% слайдов`
      legend.append(swatch)
    }
    legend.append(node('span', '', 'Свободно'))
  } else {
    const fillAlpha = spatialFillAlpha(instances.length)
    const overlapSteps = [1, 2, 4, 8, Math.min(16, instances.length)]
    legend.append(node('span', '', '1 поле'))
    for (const layers of overlapSteps) {
      const swatch = node('span', 'heatmap-legend-cell')
      swatch.style.backgroundColor = spatialRgba(component.id, spatialOverlapAlpha(layers, fillAlpha))
      swatch.title = `${layers}× перекрытие`
      legend.append(swatch)
    }
    legend.append(node('span', '', `${overlapSteps[overlapSteps.length - 1]}×`))
  }
  block.append(legend)

  const frame = node('div', 'spatial-canvas-frame')
  const canvas = node('canvas', 'spatial-canvas')
  canvas.setAttribute('role', 'img')
  canvas.setAttribute('aria-label', `Heatmap расположения ${component.label}`)
  const tooltip = node('div', 'spatial-canvas-tooltip')
  tooltip.hidden = true
  frame.append(canvas, tooltip)
  block.append(frame)

  const api = drawSpatialCanvas(canvas, component, slideSize)
  canvas.addEventListener('mousemove', (event) => {
    const bounds = canvas.getBoundingClientRect()
    const x = event.clientX - bounds.left
    const y = event.clientY - bounds.top
    const hits = api.hitInstances(x, y)
    if (!hits.length) {
      tooltip.hidden = true
      return
    }
    tooltip.hidden = false
    tooltip.style.left = `${Math.min(x + 12, displayWidth - 180)}px`
    tooltip.style.top = `${Math.max(y - 8, 8)}px`
    const sample = hits[0]
    if (component.id === 'safe_space') {
      tooltip.textContent = sample.text_sample || `Свободно ${Math.round((sample.free_ratio || 0) * 100)}% слайдов`
    } else if (component.id === 'image_regions') {
      tooltip.textContent = hits.length === 1
        ? `Слайд ${sample.slide_number} · ${sample.filename || '—'} · ${sample.width_pt}×${sample.height_pt} pt`
        : `Перекрытие ×${number(hits.length)} · ${[...new Set(hits.map((item) => item.filename).filter(Boolean))].slice(0, 3).join(', ')}`
    } else if (component.id === 'repeated_groups') {
      tooltip.textContent = hits.length === 1
        ? `${sample.group_id || '—'} · ${SPATIAL_LAYOUT_LABELS[sample.group_layout] || sample.group_layout || '—'} · слайд ${sample.slide_number}`
        : `Перекрытие ×${number(hits.length)} · ${[...new Set(hits.map((item) => item.group_id).filter(Boolean))].slice(0, 3).join(', ')}`
    } else {
      tooltip.textContent = hits.length === 1
        ? `Слайд ${sample.slide_number} · ${sample.width_pt}×${sample.height_pt} pt · ${sample.text_sample || '—'}`
        : `Перекрытие ×${number(hits.length)} · слайды ${[...new Set(hits.map((item) => item.slide_number).filter(Boolean))].slice(0, 4).join(', ')}`
    }
  })
  canvas.addEventListener('mouseleave', () => { tooltip.hidden = true })

  const notes = {
    slide_title: 'Каждый заголовок — полупрозрачный прямоугольник. Пунктир — общий охват, сплошной — медианная зона.',
    text_regions: 'Зоны основного текста: body-слоты, параграфы и описания. Насыщенность — частота совпадения полей.',
    image_regions: 'Размещение изображений на слайдах (без фонов). Насыщенность — типичные позиции и размеры.',
    safe_space: 'Инверсия занятости контентом (текст, иконки). Светлее — чаще свободная зона. Фоны и крупные изображения не учитываются.',
    repeated_groups: 'Повторяющиеся карточки и блоки одинакового размера, выстроенные в строки, колонки или сетки.',
  }
  block.append(node('p', 'heatmap-note', notes[component.id] || notes.slide_title))
  return block
}

function renderSpatialRules(component) {
  const rules = component.spatial_rules || {}
  const lines = component.line_counts || {}
  const freq = component.frequency || {}
  const typo = component.typography || {}
  const block = append(node('section', 'content-block spatial-rules-panel'), node('h4', '', 'Пространственные правила'))

  const rows = []
  if (rules.x_norm) rows.push(spatialRange('X (доля ширины)', rules.x_norm, ''))
  if (rules.y_norm) rows.push(spatialRange('Y (доля высоты)', rules.y_norm, ''))
  if (rules.width_norm) rows.push(spatialRange('Ширина (доля)', rules.width_norm, ''))
  if (rules.height_norm) rows.push(spatialRange('Высота (доля)', rules.height_norm, ''))
  if (rules.x_pt) rows.push(spatialRange('X', rules.x_pt))
  if (rules.y_pt) rows.push(spatialRange('Y', rules.y_pt))
  if (rules.width_pt) rows.push(spatialRange('Ширина', rules.width_pt))
  if (rules.height_pt) rows.push(spatialRange('Высота', rules.height_pt))

  if (rows.length) block.append(dataTable(['Параметр', 'Диапазон', 'Медиана'], rows))

  const metrics = component.id === 'repeated_groups'
    ? append(node('div', 'mini-metrics'),
      metric(component.extra?.pattern_count || component.groups?.length || 0, 'паттернов'),
      metric(freq.instance_count || 0, 'элементов'),
      metric(freq.slide_count || 0, 'слайдов'))
    : append(node('div', 'mini-metrics'),
      metric(freq.instance_count || 0, 'найдено'),
      metric(freq.slide_count || 0, 'слайдов'),
      metric(lines.median ?? '—', 'строк (мед.)'))
  block.append(metrics)

  if (component.id === 'repeated_groups' && component.groups?.length) {
    block.append(dataTable(
      ['Паттерн', 'Layout', 'Размер', 'Сетка', 'Интервал', 'Слайды', 'Раз'],
      component.groups.slice(0, 12).map((group) => [
        group.group_id,
        SPATIAL_LAYOUT_LABELS[group.layout] || group.layout,
        `${group.item_width_pt}×${group.item_height_pt} pt`,
        `${group.rows}×${group.cols}`,
        group.spacing_pt == null ? '—' : `${group.spacing_pt} pt`,
        group.slide_numbers.slice(0, 3).join(', ') + (group.slide_numbers.length > 3 ? '…' : ''),
        number(group.occurrences),
      ])
    ))
  }

  const meta = []
  const media = component.media || {}
  if (component.id === 'image_regions' && media.dominant_width_pt) {
    meta.push(`Типичный размер: ${media.dominant_width_pt}×${media.dominant_height_pt} pt`)
  }
  if (component.id === 'safe_space') {
    if (component.extra?.median_free_ratio != null) meta.push(`Медиана свободного: ${pct(component.extra.median_free_ratio)}`)
    if (component.extra?.avg_free_ratio != null) meta.push(`Среднее свободное: ${pct(component.extra.avg_free_ratio)}`)
    if (component.detection?.excludes?.length) meta.push(`Исключено: ${component.detection.excludes.join(', ')}`)
  }
  if (component.id === 'repeated_groups' && component.detection?.layout_counts) {
    meta.push(Object.entries(component.detection.layout_counts)
      .map(([key, value]) => `${SPATIAL_LAYOUT_LABELS[key] || key}: ${value}`)
      .join(' · '))
  }
  if (typo.dominant_family) meta.push(`Шрифт: ${typo.dominant_family}${typo.dominant_size_pt ? ` · ${typo.dominant_size_pt} pt` : ''}`)
  if (typo.slot_dominant_family && typo.slot_dominant_family !== typo.dominant_family) {
    meta.push(`Слот шаблона: ${typo.slot_dominant_family}${typo.slot_dominant_size_pt ? ` · ${typo.slot_dominant_size_pt} pt` : ''}`)
  }
  if (freq.presence_ratio != null && component.id !== 'safe_space') meta.push(`Присутствие: ${pct(freq.presence_ratio)} слайдов`)
  if (lines.min != null && component.id !== 'safe_space' && component.id !== 'image_regions') meta.push(`Строк: ${lines.min}–${lines.max}, мед. ${lines.median}`)
  if (component.detection?.instance_methods) {
    const methods = Object.entries(component.detection.instance_methods)
      .map(([key, value]) => `${key}: ${value}`)
      .join(' · ')
    meta.push(`Детекция: ${methods}`)
  }
  if (meta.length) block.append(node('p', 'spatial-meta', meta.join(' · ')))
  return block
}

function renderSpatialInstances(component) {
  const instances = component.instances || []
  const block = append(node('section', 'content-block'), node('h4', '', `Примеры · ${number(instances.length)}`))
  if (!instances.length) return append(block, empty('Экземпляры не найдены'))

  const tables = {
    slide_title: {
      headings: ['Слайд', 'X × Y', 'Размер', 'Строк', 'Текст', 'Метод'],
      rows: (item) => [item.slide_number, `${item.x_pt} × ${item.y_pt}`, `${item.width_pt} × ${item.height_pt}`, item.line_count ?? '—', item.text_sample ?? '—', item.detection_method ?? '—'],
    },
    text_regions: {
      headings: ['Слайд', 'X × Y', 'Размер', 'Строк', 'Текст', 'Метод'],
      rows: (item) => [item.slide_number || '—', `${item.x_pt} × ${item.y_pt}`, `${item.width_pt} × ${item.height_pt}`, item.line_count ?? '—', item.text_sample ?? '—', item.detection_method ?? '—'],
    },
    image_regions: {
      headings: ['Слайд', 'Файл', 'X × Y', 'Размер pt', 'Px', 'Coverage'],
      rows: (item) => [item.slide_number, item.filename ?? '—', `${item.x_pt} × ${item.y_pt}`, `${item.width_pt} × ${item.height_pt}`, item.pixel_width ? `${item.pixel_width}×${item.pixel_height}` : '—', item.coverage ?? '—'],
    },
    safe_space: {
      headings: ['Зона', 'X × Y', 'Размер', 'Свободно', 'Ячеек', 'Метод'],
      rows: (item) => [item.shape_id ?? '—', `${item.x_pt} × ${item.y_pt}`, `${item.width_pt} × ${item.height_pt}`, item.free_ratio != null ? pct(item.free_ratio) : '—', item.cell_count ?? '—', item.detection_method ?? '—'],
    },
    repeated_groups: {
      headings: ['Слайд', 'Паттерн', 'Layout', '#', 'Размер', 'Тип'],
      rows: (item) => [item.slide_number, item.group_id ?? '—', SPATIAL_LAYOUT_LABELS[item.group_layout] || item.group_layout || '—', item.group_index ?? '—', `${item.width_pt}×${item.height_pt}`, item.element_kind ?? '—'],
    },
  }
  const table = tables[component.id] || tables.slide_title
  block.append(dataTable(table.headings, instances.slice(0, 40).map(table.rows)))
  if (instances.length > 40) block.append(node('p', 'heatmap-note', `Показаны первые 40 из ${number(instances.length)}.`))
  return block
}

const SLOT_ROLE_LABELS = {
  title: 'Заголовок',
  description: 'Описание',
  list: 'Список',
  icon: 'Иконка',
  image: 'Изображение',
  background_image: 'Фон',
}

const COMPONENT_CANVAS_WIDTH = 320
const SLOT_COLORS = {
  title: [31, 134, 93],
  description: [42, 119, 167],
  list: [210, 125, 45],
  icon: [108, 72, 172],
  image: [210, 125, 45],
  background_image: [130, 145, 158],
}
const CONTAINER_COLOR = [90, 62, 140]

function slotRgb(role) {
  return SLOT_COLORS[role] || CONTAINER_COLOR
}

function slotRgba(role, alpha) {
  const [r, g, b] = slotRgb(role)
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}

function componentCanvasMetrics(container) {
  const widthPt = container?.width_pt || 220
  const heightPt = container?.height_pt || 180
  const displayWidth = COMPONENT_CANVAS_WIDTH
  const displayHeight = Math.round(displayWidth * heightPt / widthPt)
  return { widthPt, heightPt, displayWidth, displayHeight }
}

function slotRect(slot, displayWidth, displayHeight) {
  const cx = slot.position?.cx_norm ?? slot.cx_norm ?? 0.5
  const cy = slot.position?.cy_norm ?? slot.cy_norm ?? 0.5
  const w = slot.position?.width_norm ?? slot.width_norm ?? 0.5
  const h = slot.position?.height_norm ?? slot.height_norm ?? 0.12
  const px = (cx - w / 2) * displayWidth
  const py = (cy - h / 2) * displayHeight
  return { x: px, y: py, w: w * displayWidth, h: h * displayHeight, cx, cy }
}

function schemaSlots(component) {
  return [...(component.slots?.required || []), ...(component.slots?.optional || [])]
}

function slotsRoughlyMatch(first, second) {
  if (first.kind !== second.kind) return false
  const textRoles = new Set(['title', 'description', 'list'])
  if (first.role !== second.role && !(textRoles.has(first.role) && textRoles.has(second.role))) return false
  const dx = Math.abs((first.cx_norm ?? first.position?.cx_norm ?? 0) - (second.position?.cx_norm ?? second.cx_norm ?? 0))
  const dy = Math.abs((first.cy_norm ?? first.position?.cy_norm ?? 0) - (second.position?.cy_norm ?? second.cy_norm ?? 0))
  return dx <= 0.12 && dy <= 0.12
}

function collectSlotVariations(component, schemaSlot) {
  const matches = []
  for (const instance of component.instances || []) {
    for (const slot of instance.slots || []) {
      if (slotsRoughlyMatch(slot, schemaSlot)) matches.push(slot)
    }
  }
  if (!matches.length) return null
  const cxs = matches.map((item) => item.cx_norm)
  const cys = matches.map((item) => item.cy_norm)
  const ws = matches.map((item) => item.width_norm)
  const hs = matches.map((item) => item.height_norm)
  return {
    count: matches.length,
    total: component.instances?.length || 0,
    cx_min: Math.min(...cxs), cx_max: Math.max(...cxs),
    cy_min: Math.min(...cys), cy_max: Math.max(...cys),
    w_min: Math.min(...ws), w_max: Math.max(...ws),
    h_min: Math.min(...hs), h_max: Math.max(...hs),
    matches,
  }
}

function drawComponentCanvas(canvas, component, viewMode) {
  const container = component.container || {}
  const { displayWidth, displayHeight } = componentCanvasMetrics(container)
  const dpr = window.devicePixelRatio || 1
  canvas.width = Math.round(displayWidth * dpr)
  canvas.height = Math.round(displayHeight * dpr)
  canvas.style.width = `${displayWidth}px`
  canvas.style.height = `${displayHeight}px`

  const ctx = canvas.getContext('2d')
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, displayWidth, displayHeight)

  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, displayWidth, displayHeight)

  const [cr, cg, cb] = CONTAINER_COLOR
  ctx.strokeStyle = `rgb(${cr}, ${cg}, ${cb})`
  ctx.lineWidth = 2
  ctx.strokeRect(1, 1, displayWidth - 2, displayHeight - 2)
  ctx.fillStyle = slotRgba('background_image', 0.04)
  ctx.fillRect(1, 1, displayWidth - 2, displayHeight - 2)

  const required = component.slots?.required || []
  const optional = component.slots?.optional || []
  const allSchema = schemaSlots(component)
  const hitTargets = []

  if (viewMode === 'schema') {
    for (const schemaSlot of allSchema) {
      const variation = collectSlotVariations(component, schemaSlot)
      if (variation && (variation.cx_max - variation.cx_min > 0.015 || variation.cy_max - variation.cy_min > 0.015)) {
        const spread = {
          cx_norm: (variation.cx_min + variation.cx_max) / 2,
          cy_norm: (variation.cy_min + variation.cy_max) / 2,
          width_norm: Math.max(variation.w_max, (variation.cx_max - variation.cx_min) + variation.w_min),
          height_norm: Math.max(variation.h_max, (variation.cy_max - variation.cy_min) + variation.h_min),
        }
        const rect = slotRect({ position: spread }, displayWidth, displayHeight)
        ctx.fillStyle = slotRgba(schemaSlot.role, 0.08)
        ctx.fillRect(rect.x, rect.y, rect.w, rect.h)
        ctx.strokeStyle = slotRgba(schemaSlot.role, 0.22)
        ctx.lineWidth = 1
        ctx.setLineDash([3, 3])
        ctx.strokeRect(rect.x, rect.y, rect.w, rect.h)
        ctx.setLineDash([])
      }
      for (const match of variation?.matches || []) {
        const ghost = slotRect(match, displayWidth, displayHeight)
        ctx.fillStyle = slotRgba(schemaSlot.role, 0.06)
        ctx.fillRect(ghost.x, ghost.y, ghost.w, ghost.h)
      }
    }

    for (const schemaSlot of optional) {
      const rect = slotRect(schemaSlot, displayWidth, displayHeight)
      const alpha = 0.12 + 0.55 * (schemaSlot.presence_ratio || 0)
      ctx.fillStyle = slotRgba(schemaSlot.role, alpha)
      ctx.fillRect(rect.x, rect.y, rect.w, rect.h)
      ctx.strokeStyle = slotRgba(schemaSlot.role, 0.75)
      ctx.lineWidth = 1.5
      ctx.setLineDash([5, 4])
      ctx.strokeRect(rect.x, rect.y, rect.w, rect.h)
      ctx.setLineDash([])
      hitTargets.push({ rect, slot: schemaSlot, tier: 'optional' })
    }

    for (const schemaSlot of required) {
      const rect = slotRect(schemaSlot, displayWidth, displayHeight)
      ctx.fillStyle = slotRgba(schemaSlot.role, 0.55)
      ctx.fillRect(rect.x, rect.y, rect.w, rect.h)
      ctx.strokeStyle = slotRgba(schemaSlot.role, 1)
      ctx.lineWidth = 2
      ctx.setLineDash([])
      ctx.strokeRect(rect.x, rect.y, rect.w, rect.h)
      hitTargets.push({ rect, slot: schemaSlot, tier: 'required' })
    }
  } else {
    const instance = component.instances?.[viewMode]
    if (!instance) return { hitTargets: () => [] }

    for (const schemaSlot of optional) {
      const rect = slotRect(schemaSlot, displayWidth, displayHeight)
      ctx.fillStyle = 'rgba(200, 205, 210, 0.25)'
      ctx.fillRect(rect.x, rect.y, rect.w, rect.h)
      ctx.strokeStyle = 'rgba(160, 170, 180, 0.55)'
      ctx.lineWidth = 1
      ctx.setLineDash([4, 4])
      ctx.strokeRect(rect.x, rect.y, rect.w, rect.h)
      ctx.setLineDash([])
    }

    for (const schemaSlot of required) {
      const present = (instance.slots || []).some((slot) => slotsRoughlyMatch(slot, schemaSlot))
      if (!present) {
        const rect = slotRect(schemaSlot, displayWidth, displayHeight)
        ctx.fillStyle = 'rgba(220, 80, 70, 0.12)'
        ctx.fillRect(rect.x, rect.y, rect.w, rect.h)
        ctx.strokeStyle = 'rgba(200, 70, 60, 0.65)'
        ctx.lineWidth = 1.5
        ctx.setLineDash([3, 3])
        ctx.strokeRect(rect.x, rect.y, rect.w, rect.h)
        ctx.setLineDash([])
      }
    }

    for (const slot of instance.slots || []) {
      const rect = slotRect(slot, displayWidth, displayHeight)
      const schemaMatch = allSchema.find((item) => slotsRoughlyMatch(slot, item))
      const tier = schemaMatch && required.some((item) => item.slot_id === schemaMatch.slot_id) ? 'required' : 'optional'
      const alpha = tier === 'required' ? 0.62 : 0.48
      ctx.fillStyle = slotRgba(slot.role, alpha)
      ctx.fillRect(rect.x, rect.y, rect.w, rect.h)
      ctx.strokeStyle = slotRgba(slot.role, 1)
      ctx.lineWidth = tier === 'required' ? 2 : 1.5
      ctx.setLineDash(tier === 'required' ? [] : [4, 3])
      ctx.strokeRect(rect.x, rect.y, rect.w, rect.h)
      ctx.setLineDash([])
      hitTargets.push({ rect, slot, tier, schemaMatch })
    }
  }

  ctx.font = '600 10px Arial, sans-serif'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  for (const target of hitTargets) {
    const label = SLOT_ROLE_LABELS[target.slot.role] || target.slot.role
    const short = label.length > 12 ? `${label.slice(0, 11)}…` : label
    const cx = target.rect.x + target.rect.w / 2
    const cy = target.rect.y + target.rect.h / 2
    if (target.rect.w > 36 && target.rect.h > 14) {
      ctx.fillStyle = target.tier === 'required' ? '#fff' : 'rgba(40, 50, 58, 0.85)'
      ctx.fillText(short, cx, cy)
    }
  }

  return {
    hitTargets(x, y) {
      return hitTargets.filter((target) => (
        x >= target.rect.x && x <= target.rect.x + target.rect.w
        && y >= target.rect.y && y <= target.rect.y + target.rect.h
      ))
    },
  }
}

function renderComponentCanvasPanel(component) {
  const block = append(node('section', 'content-block component-canvas-panel'), node('h4', '', 'Схема компонента'))
  const container = component.container || {}
  const { widthPt, heightPt, displayWidth, displayHeight } = componentCanvasMetrics(container)
  block.append(node('p', 'component-canvas-note', `${Math.round(widthPt)} × ${Math.round(heightPt)} pt · ${component.name}`))

  const legend = append(node('div', 'heatmap-legend component-canvas-legend'))
  legend.append(node('span', '', 'Required'))
  const reqSwatch = node('span', 'heatmap-legend-cell')
  reqSwatch.style.backgroundColor = slotRgba('title', 0.55)
  reqSwatch.title = 'Обязательный слот'
  legend.append(reqSwatch)
  legend.append(node('span', '', 'Optional'))
  for (const level of [0.25, 0.5, 0.75]) {
    const swatch = node('span', 'heatmap-legend-cell')
    swatch.style.backgroundColor = slotRgba('icon', 0.12 + 0.55 * level)
    swatch.title = `Optional · ${Math.round(level * 100)}% экз.`
    legend.append(swatch)
  }
  legend.append(node('span', '', 'Разброс'))
  const spreadSwatch = node('span', 'heatmap-legend-cell component-spread-swatch')
  spreadSwatch.title = 'Разброс позиций между экземплярами'
  legend.append(spreadSwatch)
  block.append(legend)

  const viewBar = node('div', 'component-view-bar')
  const schemaBtn = node('button', `component-view-btn ${state.componentViewMode === 'schema' ? 'active' : ''}`, 'Схема + вариативность')
  schemaBtn.type = 'button'
  schemaBtn.addEventListener('click', () => { state.componentViewMode = 'schema'; renderPanel() })
  viewBar.append(schemaBtn)
  ;(component.instances || []).slice(0, 8).forEach((instance, index) => {
    const button = node(
      'button',
      `component-view-btn ${state.componentViewMode === index ? 'active' : ''}`,
      `Слайд ${instance.slide_number} #${instance.group_index}`,
    )
    button.type = 'button'
    button.addEventListener('click', () => { state.componentViewMode = index; renderPanel() })
    viewBar.append(button)
  })
  block.append(viewBar)

  const frame = node('div', 'component-canvas-frame')
  const canvas = node('canvas', 'component-canvas')
  canvas.setAttribute('role', 'img')
  canvas.setAttribute('aria-label', `Схема компонента ${component.name}`)
  const tooltip = node('div', 'component-canvas-tooltip')
  tooltip.hidden = true
  frame.append(canvas, tooltip)
  block.append(frame)

  const viewMode = state.componentViewMode === 'schema' ? 'schema' : state.componentViewMode
  const api = drawComponentCanvas(canvas, component, viewMode)

  canvas.addEventListener('mousemove', (event) => {
    const bounds = canvas.getBoundingClientRect()
    const x = event.clientX - bounds.left
    const y = event.clientY - bounds.top
    const hits = api.hitTargets(x, y)
    if (!hits.length) {
      tooltip.hidden = true
      return
    }
    tooltip.hidden = false
    tooltip.style.left = `${Math.min(x + 12, displayWidth - 190)}px`
    tooltip.style.top = `${Math.max(y - 8, 8)}px`
    const target = hits[hits.length - 1]
    const slot = target.slot
    const role = SLOT_ROLE_LABELS[slot.role] || slot.role
    const presence = slot.presence_ratio != null ? ` · ${pct(slot.presence_ratio)} экз.` : ''
    const variation = collectSlotVariations(component, target.schemaMatch || slot)
    const spread = variation && (variation.cx_max - variation.cx_min > 0.01 || variation.cy_max - variation.cy_min > 0.01)
      ? ` · разброс ±${Math.round(Math.max(variation.cx_max - variation.cx_min, variation.cy_max - variation.cy_min) * 50)}%`
      : ''
    tooltip.textContent = `${role} · ${target.tier || 'instance'}${presence}${spread}`
  })
  canvas.addEventListener('mouseleave', () => { tooltip.hidden = true })

  const required = component.slots?.required || []
  const optional = component.slots?.optional || []
  const note = state.componentViewMode === 'schema'
    ? `Сплошные блоки — required (${required.length}). Пунктир и прозрачность — optional (${optional.length}), насыщенность = доля экземпляров. Светлые зоны — разброс позиций.`
    : `Экземпляр на слайде ${component.instances[state.componentViewMode]?.slide_number}. Серый пунктир — optional-слоты, которых нет в этом варианте.`
  block.append(node('p', 'heatmap-note', note))
  return block
}

function renderComponents(panel) {
  renderComponentsPanel(panel, {
    state,
    report: state.report,
    jobId: state.jobId,
    renderPanel,
    helpers: {
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
    },
  })
}

function componentSlotCard(slot, tier, component) {
  const card = node('article', `component-slot-card ${tier}`)
  const pos = slot.position || {}
  const typo = slot.typography || {}
  const variation = collectSlotVariations(component, slot)
  const spreadX = variation ? Math.round((variation.cx_max - variation.cx_min) * 100) : 0
  const spreadY = variation ? Math.round((variation.cy_max - variation.cy_min) * 100) : 0
  const swatch = node('span', 'component-slot-swatch')
  swatch.style.backgroundColor = slotRgba(slot.role, tier === 'required' ? 0.65 : 0.18 + 0.45 * (slot.presence_ratio || 0))
  append(card,
    append(node('div', 'component-slot-head'),
      swatch,
      node('strong', '', SLOT_ROLE_LABELS[slot.role] || slot.role),
      node('span', `component-slot-tier ${tier}`, tier === 'required' ? 'required' : 'optional')),
    node('p', '', `${slot.kind} · ${pct(slot.presence_ratio)} экз.`),
    node('small', '', `поз. ${Math.round((pos.cx_norm || 0) * 100)}%, ${Math.round((pos.cy_norm || 0) * 100)}% · ${Math.round((pos.width_norm || 0) * 100)}×${Math.round((pos.height_norm || 0) * 100)}%`),
  )
  if (spreadX > 1 || spreadY > 1) {
    card.append(node('small', 'component-slot-spread', `разброс позиции: ±${Math.max(spreadX, spreadY)}%`))
  }
  if (typo.dominant_size_pt) card.append(node('small', 'component-slot-typo', `${typo.dominant_family || '—'} · ${typo.dominant_size_pt} pt · level ${fmt(typo.dominant_scale_level)}`))
  return card
}

const PAGINATION_TYPE_LABELS = {
  dot_pagination: 'Точки',
  numeric: 'Числа',
  progress_bar: 'Progress bar',
}

function renderPaginationCanvas(canvas, instance, dotCount) {
  const width = 280
  const height = 36
  const dpr = window.devicePixelRatio || 1
  canvas.width = Math.round(width * dpr)
  canvas.height = Math.round(height * dpr)
  canvas.style.width = `${width}px`
  canvas.style.height = `${height}px`
  const ctx = canvas.getContext('2d')
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, width, height)
  const count = dotCount || instance?.dot_count || 5
  const active = instance?.active_index ?? 0
  const gap = Math.min(28, (width - 40) / Math.max(count - 1, 1))
  const radius = 5
  const startX = (width - gap * (count - 1)) / 2
  const cy = height / 2
  for (let index = 0; index < count; index += 1) {
    const isActive = index === active
    ctx.beginPath()
    ctx.arc(startX + gap * index, cy, isActive ? radius + 1.5 : radius, 0, Math.PI * 2)
    if (isActive) {
      ctx.fillStyle = '#5a3f8c'
      ctx.fill()
    } else {
      ctx.strokeStyle = '#b8afc8'
      ctx.lineWidth = 1.5
      ctx.stroke()
    }
  }
}

function renderPaginationPanel() {
  const data = state.report.typography.pagination
  const patterns = data?.patterns || []
  const block = append(node('section', 'content-block pagination-panel'),
    node('h4', '', `Пагинация · ${number(patterns.length)}`),
    node('p', 'pagination-intro', 'Отдельная логика: не просто ряд кружков, а active state, прогрессия по слайдам и числовые форматы.'))
  if (!patterns.length) {
    block.append(empty('Паттерны пагинации не найдены. Нужны точки/числа в нижней зоне с признаками active state или последовательности.'))
    return block
  }

  const summary = data.summary || {}
  block.append(append(node('div', 'mini-metrics'),
    metric(summary.pattern_count || patterns.length, 'паттернов'),
    metric(summary.slide_count || 0, 'слайдов'),
    metric(Object.keys(summary.types || {}).length, 'типов')))

  patterns.forEach((pattern) => {
    const card = node('article', 'pagination-card')
    const typeLabel = PAGINATION_TYPE_LABELS[pattern.type] || pattern.type
    append(card, node('strong', '', `${typeLabel} · ${pattern.pattern_id}`))
    card.append(node('p', '', `confidence ${Math.round((pattern.confidence || 0) * 100)}% · ${pattern.slide_count || pattern.slide_numbers?.length || 0} слайдов`))

    if (pattern.type === 'dot_pagination') {
      card.append(node('p', '', `${pattern.dot_count} индикаторов · интервал ${pattern.spacing_pt} pt · y ${Math.round((pattern.y_norm || 0) * 100)}%`))
      const logic = pattern.logic || {}
      const active = logic.active_state || {}
      card.append(node('p', 'pagination-logic', `Active: ${active.dominant_reason || '—'} · progression ${active.progression || '—'} · detected ${active.detected_on_slides || 0}/${pattern.dot_count}`))
      const sample = pattern.instances?.[0]
      if (sample) {
        const canvas = node('canvas', 'pagination-canvas')
        renderPaginationCanvas(canvas, sample, pattern.dot_count)
        card.append(canvas)
      }
    } else if (pattern.type === 'numeric') {
      card.append(node('p', '', `Всего страниц: ${pattern.total_pages} · seen ${(pattern.current_pages_seen || []).join(', ')}`))
    } else if (pattern.type === 'progress_bar') {
      card.append(node('p', '', 'Горизонтальный track в нижней зоне слайда'))
    }

    const rows = (pattern.instances || []).slice(0, 12).map((item) => {
      if (pattern.type === 'numeric') return [item.slide_number, `${item.current_page}/${item.total_pages}`, item.text]
      if (pattern.type === 'dot_pagination') return [item.slide_number, item.active_index ?? '—', item.active_reason ?? '—', item.spacing_uniformity ?? '—']
      return [item.slide_number, item.track_width_pt ?? '—', item.y_norm ?? '—']
    })
    const headings = pattern.type === 'numeric'
      ? ['Слайд', 'Страница', 'Текст']
      : pattern.type === 'dot_pagination'
        ? ['Слайд', 'Active #', 'Причина', 'Spacing']
        : ['Слайд', 'Track pt', 'Y norm']
    card.append(dataTable(headings, rows))
    block.append(card)
  })
  return block
}

function renderSpatial(panel) {
  const spatial = state.report.typography.spatial
  append(panel, sectionTitle('Пространство', 'Heatmap, пагинация и устойчивые правила расположения элементов на слайде'))
  panel.append(renderPaginationPanel())

  const components = spatial?.components || []
  if (!components.length) return panel.append(empty('Пространственные компоненты не найдены. Загрузите презентацию для анализа.'))

  const selector = node('div', 'spatial-selector')
  components.forEach((component) => {
    const button = node('button', `spatial-filter ${state.spatialComponent === component.id ? 'active' : ''}`, component.label)
    button.type = 'button'
    button.addEventListener('click', () => { state.spatialComponent = component.id; renderPanel() })
    selector.append(button)
  })
  panel.append(selector)

  const component = components.find((item) => item.id === state.spatialComponent) || components[0]
  state.spatialComponent = component.id

  const layout = node('div', 'spatial-layout')
  layout.append(renderSpatialRules(component))
  layout.append(renderSpatialCanvasPanel(component, spatial.slide_size_pt))
  panel.append(layout)
  panel.append(renderSpatialInstances(component))
}

function colorCard(color, subtitle) {
  const item = node('div', 'color-card')
  const swatch = node('span', 'swatch')
  if (/^#[0-9a-fA-F]{6}$/.test(color.color)) swatch.style.backgroundColor = color.color
  if (Number(color.alpha ?? 1) === 0) swatch.classList.add('transparent')
  else swatch.style.opacity = String(Math.max(0, Math.min(1, Number(color.alpha ?? 1))))
  return append(item, swatch, append(node('div', 'color-copy'), node('strong', '', color.color), node('small', '', subtitle)))
}

function renderColors(panel) {
  const colors = state.report.colors
  append(panel, sectionTitle('Цвета', 'Палитра и назначение цветов в презентации'))
  const palette = append(node('section', 'content-block'), node('h4', '', `Общая палитра · ${number(colors.resolved_palette.length)}`))
  if (colors.resolved_palette.length) {
    const grid = node('div', 'color-grid')
    colors.resolved_palette.forEach((color) => grid.append(colorCard(color, `α ${color.alpha} · ${number(color.occurrences)} исп.`)))
    palette.append(grid)
  } else palette.append(empty('Цвета не найдены'))
  panel.append(palette)
  for (const [key, label] of Object.entries(contexts)) {
    const entries = colors.context_palettes?.[key] || []
    if (!entries.length) continue
    const group = append(node('section', 'content-block'), node('h4', '', `${label} · ${number(entries.length)}`))
    const grid = node('div', 'color-grid')
    entries.forEach((color) => grid.append(colorCard(color, `${number(color.occurrences)} исп.`)))
    group.append(grid)
    panel.append(group)
  }
  if (colors.transparent?.length) {
    const group = append(node('section', 'content-block'), node('h4', '', 'Прозрачные цвета'))
    const grid = node('div', 'color-grid')
    colors.transparent.forEach((color) => grid.append(colorCard({ color: color.source_color, alpha: 0 }, `${number(color.occurrences)} исп.`)))
    group.append(grid)
    panel.append(group)
  }
}

$('#dropzone').addEventListener('click', () => $('#file-input').click())
$('#dropzone').addEventListener('keydown', (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); $('#file-input').click() } })
$('#file-input').addEventListener('change', (event) => setFile(event.target.files[0]))
$('#brief-input').addEventListener('input', (event) => { state.brief = event.target.value; updateCreateButtonState() })
$('#generate-presentation').addEventListener('change', (event) => {
  state.generatePresentation = event.target.checked
  updateGeneratePresentationUI()
  updateCreateButtonState()
})
$('#create-button').addEventListener('click', createPresentation)
document.querySelectorAll('[data-export-format]').forEach((button) => {
  button.addEventListener('click', () => handleGeneratedPresentationExport(button.dataset.exportFormat))
})
document.querySelectorAll('[data-results-view]').forEach((button) => {
  button.addEventListener('click', () => {
    const view = button.dataset.resultsView
    if (!['generation', 'analysis'].includes(view) || view === state.resultsView) return
    state.resultsView = view
    render()
  })
})
for (const eventName of ['dragenter', 'dragover']) $('#dropzone').addEventListener(eventName, (event) => { event.preventDefault(); $('#dropzone').classList.add('dragging') })
for (const eventName of ['dragleave', 'drop']) $('#dropzone').addEventListener(eventName, (event) => { event.preventDefault(); $('#dropzone').classList.remove('dragging') })
$('#dropzone').addEventListener('drop', (event) => setFile(event.dataTransfer.files[0]))
updateGeneratePresentationUI()
loadDefaultBrief()
