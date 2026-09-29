import { mountCatalogSlide } from '../templates/slide-render.js'
import { patternDisplayLabel } from '../constructor/templates.js'
import { createSlideRenderContext } from './resolve-element-style.js'
import { mountDesignSystemSlide } from './design-system-render.js'
import { exportSlidesToPptx } from './pptx-export.js'

function mountSlidePreview(container, slide, jobId, renderContext, mode) {
  if (mode === 'faithful') {
    mountCatalogSlide(container, slide, jobId)
    return
  }
  mountDesignSystemSlide(container, slide, jobId, renderContext)
}

const KIND_LABELS = {
  text: 'Текст',
  image: 'Изображение',
  fill: 'Фигура',
  table: 'Таблица',
  chart: 'График',
  diagram: 'Диаграмма',
  graphic: 'Графика',
}

const SCOPE_LABELS = {
  layout: 'Layout',
  deck: 'Deck',
}

function formatSummary(summary) {
  return Object.entries(summary || {})
    .map(([kind, count]) => `${KIND_LABELS[kind] || kind}: ${count}`)
    .join(' · ')
}

function terminalLabels(slide) {
  const candidate = slide?.terminal_candidate || {}
  const labels = []
  if (candidate.preferred_initial) labels.push('Выбран для начала')
  else if ((slide?.terminal_roles || []).includes('initial')) labels.push('Кандидат на начало')
  if (candidate.preferred_final) labels.push('Выбран для финала')
  else if ((slide?.terminal_roles || []).includes('final')) labels.push('Кандидат на финал')
  return labels
}

function renderTerminalBadges(parent, slide) {
  const labels = terminalLabels(slide)
  if (!labels.length) return
  const badges = document.createElement('div')
  badges.className = 'terminal-slide-badges'
  for (const label of labels) {
    const badge = document.createElement('span')
    badge.className = `terminal-slide-badge ${label.startsWith('Выбран') ? 'is-preferred' : ''}`
    badge.textContent = label
    badges.append(badge)
  }
  parent.append(badges)
}

function formatSlotSummary(pattern) {
  const required = pattern.slots?.required?.length || 0
  const optional = pattern.slots?.optional?.length || 0
  const kinds = Object.entries(pattern.element_kinds || {})
    .map(([kind, count]) => `${KIND_LABELS[kind] || kind}×${count}`)
    .join(', ')
  return `${required} req · ${optional} opt${kinds ? ` · ${kinds}` : ''}`
}

function renderSlideCard(slide, jobId, renderContext, renderMode, onSelect, selected) {
  const card = document.createElement('button')
  card.type = 'button'
  card.className = `catalog-card ${selected ? 'active' : ''}`
  card.dataset.slideNumber = String(slide.slide_number)

  const preview = document.createElement('div')
  preview.className = 'catalog-card-preview'
  mountSlidePreview(preview, slide, jobId, renderContext, renderMode)
  card.append(preview)

  const meta = document.createElement('div')
  meta.className = 'catalog-card-meta'
  meta.append(Object.assign(document.createElement('strong'), {
    textContent: `#${slide.slide_number}`,
  }))
  renderTerminalBadges(meta, slide)
  meta.append(Object.assign(document.createElement('small'), {
    textContent: slide.layout_name || slide.layout_file || 'Layout',
  }))
  meta.append(Object.assign(document.createElement('span'), {
    className: 'catalog-card-tags',
    textContent: formatSummary(slide.element_summary),
  }))
  if (slide.pattern_ids?.length) {
    meta.append(Object.assign(document.createElement('span'), {
      className: 'catalog-card-patterns',
      textContent: slide.pattern_ids.join(', '),
    }))
  }
  card.append(meta)

  card.addEventListener('click', () => onSelect(slide.slide_number))
  return card
}

function renderSlideDetail(panel, slide, jobId, renderContext, renderMode, patternsById) {
  panel.replaceChildren()
  if (!slide) {
    panel.append(Object.assign(document.createElement('p'), {
      className: 'catalog-detail-empty',
      textContent: 'Выберите слайд в галерее.',
    }))
    return
  }

  const title = document.createElement('div')
  title.className = 'catalog-detail-title'
  title.append(Object.assign(document.createElement('h4'), {
    textContent: `Слайд ${slide.slide_number}`,
  }))
  title.append(Object.assign(document.createElement('p'), {
    textContent: `${slide.layout_name || slide.layout_file || '—'}${slide.template_id ? ` · ${slide.template_id}` : ''}`,
  }))
  renderTerminalBadges(title, slide)
  panel.append(title)

  const mount = document.createElement('div')
  mount.className = 'catalog-detail-mount'
  mountSlidePreview(mount, slide, jobId, renderContext, renderMode)
  panel.append(mount)

  if (slide.pattern_ids?.length) {
    panel.append(Object.assign(document.createElement('h5'), { textContent: 'Паттерны на слайде' }))
    const patternList = document.createElement('div')
    patternList.className = 'catalog-pattern-chip-list'
    slide.pattern_ids.forEach((patternId) => {
      const pattern = patternsById.get(patternId)
      const chip = document.createElement('span')
      chip.className = 'catalog-pattern-chip'
      chip.textContent = pattern ? `${patternId} · ${patternDisplayLabel(pattern)}` : patternId
      patternList.append(chip)
    })
    panel.append(patternList)
  }

  const list = document.createElement('div')
  list.className = 'catalog-element-list'
  for (const element of slide.content_elements || []) {
    const item = document.createElement('div')
    item.className = 'catalog-element-item'
    const label = KIND_LABELS[element.kind] || element.kind
    const detail = element.kind === 'text'
      ? (element.text_sample || element.text || '').slice(0, 80)
      : element.kind === 'table'
        ? `${element.rows || 0}×${element.cols || 0}`
        : element.asset || element.name || ''
    item.textContent = `${label}${detail ? ` · ${detail}` : ''}`
    list.append(item)
  }
  panel.append(Object.assign(document.createElement('h5'), { textContent: 'Элементы на слайде' }))
  panel.append(list)
}

function renderPatternCard(pattern, selected, onSelect) {
  const card = document.createElement('button')
  card.type = 'button'
  card.className = `pattern-card ${selected ? 'active' : ''}`

  const head = document.createElement('div')
  head.className = 'pattern-card-head'
  head.append(Object.assign(document.createElement('strong'), {
    textContent: patternDisplayLabel(pattern),
  }))
  head.append(Object.assign(document.createElement('span'), {
    className: `pattern-scope pattern-scope--${pattern.scope || 'layout'}`,
    textContent: SCOPE_LABELS[pattern.scope] || pattern.scope || 'layout',
  }))
  card.append(head)

  card.append(Object.assign(document.createElement('small'), {
    textContent: `${pattern.pattern_id} · ${pattern.frequency?.instance_count || 0}× · ${pattern.frequency?.slide_count || 0} слайдов`,
  }))
  card.append(Object.assign(document.createElement('span'), {
    className: 'pattern-card-meta',
    textContent: pattern.layout_name || pattern.layout_source || '—',
  }))
  card.append(Object.assign(document.createElement('span'), {
    className: 'pattern-card-slots',
    textContent: formatSlotSummary(pattern),
  }))

  card.addEventListener('click', () => onSelect(pattern.pattern_id))
  return card
}

function renderPatternDetail(panel, pattern, catalog, onOpenSlide) {
  panel.replaceChildren()
  if (!pattern) {
    panel.append(Object.assign(document.createElement('p'), {
      className: 'catalog-detail-empty',
      textContent: 'Выберите паттерн в списке.',
    }))
    return
  }

  const title = document.createElement('div')
  title.className = 'catalog-detail-title'
  title.append(Object.assign(document.createElement('h4'), {
    textContent: patternDisplayLabel(pattern),
  }))
  title.append(Object.assign(document.createElement('p'), {
    textContent: `${pattern.pattern_id} · ${SCOPE_LABELS[pattern.scope] || pattern.scope} · ${pattern.frequency?.instance_count || 0} экземпляров на ${pattern.frequency?.slide_count || 0} слайдах`,
  }))
  panel.append(title)

  const slots = document.createElement('div')
  slots.className = 'catalog-element-list'
  ;[...(pattern.slots?.required || []), ...(pattern.slots?.optional || [])].forEach((slot) => {
    const item = document.createElement('div')
    item.className = 'catalog-element-item'
    const role = slot.role || slot.kind
    const typo = slot.typography?.dominant_size_pt
      ? ` · ${slot.typography.dominant_family || ''} ${slot.typography.dominant_size_pt}pt`
      : ''
    const defaults = slot.defaults?.text
      ? ` · «${slot.defaults.text.slice(0, 24)}»`
      : slot.defaults?.asset
        ? ` · ${slot.defaults.asset}`
        : ''
    item.textContent = `${slot.slot_id} · ${KIND_LABELS[slot.kind] || slot.kind} · ${role}${typo}${defaults}${slot.presence_ratio != null ? ` · ${Math.round(slot.presence_ratio * 100)}%` : ''}`
    slots.append(item)
  })
  panel.append(Object.assign(document.createElement('h5'), { textContent: 'Слоты' }))
  panel.append(slots)

  panel.append(Object.assign(document.createElement('h5'), { textContent: 'Экземпляры' }))
  const instances = document.createElement('div')
  instances.className = 'pattern-instance-list'
  for (const slideNumber of pattern.frequency?.slide_numbers || []) {
    const slide = catalog.slides.find((item) => item.slide_number === slideNumber)
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'pattern-instance-btn'
    button.textContent = `#${slideNumber}${slide?.layout_name ? ` · ${slide.layout_name}` : ''}`
    button.addEventListener('click', () => onOpenSlide(slideNumber))
    instances.append(button)
  }
  panel.append(instances)
}

function renderGalleryView(panel, state, catalog, patternsById, renderContext) {
  const selectedNumber = state.selectedSlideNumber ?? catalog.slides[0]?.slide_number ?? null
  const renderMode = state.slidesRenderMode || 'design-system'

  const summary = document.createElement('p')
  summary.className = 'catalog-intro'
  summary.textContent = renderMode === 'design-system'
    ? `${catalog.summary.slide_count} слайдов через design system · типографика и цвета из шаблонов и tokens · геометрия из каталога`
    : `${catalog.summary.slide_count} слайдов · ${formatSummary(catalog.summary.element_totals)} · raw PPTX render`
  panel.append(summary)

  const layout = document.createElement('div')
  layout.className = 'catalog-layout'

  const grid = document.createElement('div')
  grid.className = 'catalog-grid'

  const detail = document.createElement('aside')
  detail.className = 'catalog-detail-panel'

  const selectedSlide = catalog.slides.find((slide) => slide.slide_number === selectedNumber) || catalog.slides[0]

  function selectSlide(slideNumber) {
    state.selectedSlideNumber = slideNumber
    const slide = catalog.slides.find((item) => item.slide_number === slideNumber)
    if (!slide) return
    grid.querySelectorAll('.catalog-card').forEach((card) => {
      card.classList.toggle('active', card.dataset.slideNumber === String(slideNumber))
    })
    renderSlideDetail(detail, slide, state.jobId, renderContext, renderMode, patternsById)
  }

  catalog.slides.forEach((slide) => {
    grid.append(renderSlideCard(slide, state.jobId, renderContext, renderMode, selectSlide, slide.slide_number === selectedSlide.slide_number))
  })

  renderSlideDetail(detail, selectedSlide, state.jobId, renderContext, renderMode, patternsById)
  layout.append(grid, detail)
  panel.append(layout)
}

function renderPatternsView(panel, state, catalog, patterns, onSwitchView) {
  const selectedId = state.selectedPatternId ?? patterns[0]?.pattern_id ?? null
  const layoutFilter = state.patternLayoutFilter || 'all'
  const layouts = [...new Set(patterns.map((pattern) => pattern.layout_source).filter(Boolean))]
  const filtered = layoutFilter === 'all'
    ? patterns
    : patterns.filter((pattern) => pattern.layout_source === layoutFilter)

  const toolbar = document.createElement('div')
  toolbar.className = 'pattern-toolbar'

  const filter = document.createElement('select')
  filter.className = 'pattern-filter'
  filter.append(Object.assign(document.createElement('option'), { value: 'all', textContent: 'Все layout' }))
  layouts.forEach((layout) => {
    const option = document.createElement('option')
    option.value = layout
    option.textContent = layout.split('/').pop() || layout
    filter.append(option)
  })
  filter.value = layoutFilter
  filter.addEventListener('change', () => {
    state.patternLayoutFilter = filter.value
    state.selectedPatternId = null
    renderSlides(panel, state)
  })
  toolbar.append(Object.assign(document.createElement('label'), {
    textContent: 'Layout: ',
  }), filter)
  panel.append(toolbar)

  const summary = document.createElement('p')
  summary.className = 'catalog-intro'
  summary.textContent = `${filtered.length} паттернов · ${catalog.summary.pattern_instance_count || 0} экземпляров`
  panel.append(summary)

  const layout = document.createElement('div')
  layout.className = 'catalog-layout'

  const list = document.createElement('div')
  list.className = 'pattern-list'

  const detail = document.createElement('aside')
  detail.className = 'catalog-detail-panel'

  const selectedPattern = filtered.find((pattern) => pattern.pattern_id === selectedId) || filtered[0]

  filtered.forEach((pattern) => {
    list.append(renderPatternCard(pattern, pattern.pattern_id === selectedPattern?.pattern_id, (patternId) => {
      state.selectedPatternId = patternId
      renderSlides(panel, state)
    }))
  })

  if (!filtered.length) {
    list.append(Object.assign(document.createElement('p'), {
      className: 'section-empty',
      textContent: 'Паттерны для выбранного layout не найдены.',
    }))
  }

  renderPatternDetail(detail, selectedPattern, catalog, (slideNumber) => {
    state.slidesView = 'gallery'
    state.selectedSlideNumber = slideNumber
    renderSlides(panel, state)
  })

  layout.append(list, detail)
  panel.append(layout)
}

export function renderSlides(panel, state) {
  panel.replaceChildren()
  const catalog = state.report.slides
  const patterns = catalog?.patterns || []
  const patternsById = new Map(patterns.map((pattern) => [pattern.pattern_id, pattern]))
  const view = state.slidesView || 'gallery'

  const title = document.createElement('div')
  title.className = 'section-title'
  const heading = document.createElement('div')
  heading.append(Object.assign(document.createElement('h3'), {
    textContent: view === 'patterns' ? 'Повторяемые паттерны' : 'Все слайды',
  }))
  heading.append(Object.assign(document.createElement('p'), {
    textContent: view === 'patterns'
      ? 'Структурные блоки, найденные в каталоге слайдов. Основа для конструктора.'
      : (state.slidesRenderMode || 'design-system') === 'design-system'
        ? 'Все слайды дека в HTML через design system: layout + token-стили текста.'
        : 'DOM-рендер master/layout + сырой контент из PPTX.',
  }))

  const switcher = document.createElement('div')
  switcher.className = 'catalog-view-switch'
  if (view === 'gallery') {
    ;[
      { id: 'design-system', label: 'Design system' },
      { id: 'faithful', label: 'PPTX raw' },
    ].forEach(({ id, label }) => {
      const button = document.createElement('button')
      button.type = 'button'
      button.className = `catalog-view-btn ${(state.slidesRenderMode || 'design-system') === id ? 'active' : ''}`
      button.textContent = label
      button.addEventListener('click', () => {
        state.slidesRenderMode = id
        renderSlides(panel, state)
      })
      switcher.append(button)
    })
    switcher.append(Object.assign(document.createElement('span'), {
      className: 'catalog-view-divider',
      textContent: '|',
    }))

    const exportButton = document.createElement('button')
    exportButton.type = 'button'
    exportButton.className = 'catalog-view-btn catalog-export-btn'
    exportButton.textContent = 'Скачать PPTX'
    exportButton.title = 'Редактируемый PPTX из каталога слайдов (текст, фигуры, картинки)'
    exportButton.addEventListener('click', async () => {
      if (exportButton.disabled) return
      exportButton.disabled = true
      const originalLabel = exportButton.textContent
      try {
        await exportSlidesToPptx(state, {
          onProgress: ({ phase }) => {
            exportButton.textContent = phase === 'build' ? 'Сборка PPTX…' : 'Экспорт…'
          },
        })
        exportButton.textContent = 'Готово'
        window.setTimeout(() => {
          exportButton.textContent = originalLabel
        }, 1800)
      } catch (error) {
        window.alert(error?.message || 'Не удалось собрать PPTX')
        exportButton.textContent = originalLabel
      } finally {
        exportButton.disabled = false
      }
    })
    switcher.append(exportButton)
  }
  ;[
    { id: 'gallery', label: 'Слайды' },
    { id: 'patterns', label: `Паттерны (${patterns.length})` },
  ].forEach(({ id, label }) => {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = `catalog-view-btn ${view === id ? 'active' : ''}`
    button.textContent = label
    button.addEventListener('click', () => {
      state.slidesView = id
      renderSlides(panel, state)
    })
    switcher.append(button)
  })

  title.append(heading, switcher)
  panel.append(title)

  if (!catalog?.slides?.length) {
    panel.append(Object.assign(document.createElement('div'), {
      className: 'section-empty',
      textContent: 'Каталог слайдов пуст. Перезапустите анализ презентации.',
    }))
    return
  }

  if (view === 'patterns') {
    if (!patterns.length) {
      panel.append(Object.assign(document.createElement('div'), {
        className: 'section-empty',
        textContent: 'Паттерны не найдены. Нужно минимум 2 экземпляра на layout или 3 по деку.',
      }))
      return
    }
    renderPatternsView(panel, state, catalog, patterns)
    return
  }

  renderGalleryView(panel, state, catalog, patternsById, createSlideRenderContext(state.report))
}
