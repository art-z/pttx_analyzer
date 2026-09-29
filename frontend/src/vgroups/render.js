import { createSlideRenderContext } from '../slides/resolve-element-style.js'
import { mountDesignSystemSlide } from '../slides/design-system-render.js'
import { detectDeckVgroups, detectSlideVgroups } from '../slides/vgroup-detect.js'
import { analyzeSlideRepeatSplits, unionBoxesPt } from '../components/repeat-layout-analysis.js'
import { mountVgroupSlide, setVgroupHighlight } from '../slides/vgroup-render.js'

const KIND_LABELS = {
  text: 'Текст',
  image: 'Изображение',
  fill: 'Фигура',
  table: 'Таблица',
  chart: 'График',
  diagram: 'Диаграмма',
  line: 'Линия',
  graphic: 'Графика',
}

const LAYOUT_LABELS = {
  row: 'row',
  column: 'column',
  grid: 'grid',
  container: 'container',
  stack: 'stack',
  single: 'single',
}

function formatKindCounts(kindCounts) {
  return Object.entries(kindCounts || {})
    .map(([kind, count]) => `${KIND_LABELS[kind] || kind}×${count}`)
    .join(', ')
}

function formatGroupMeta(group) {
  const parts = [LAYOUT_LABELS[group.layout] || group.layout]
  if (group.repeat?.grid) parts.push(`${group.repeat.grid.rows}×${group.repeat.grid.cols}`)
  else if (group.repeat) parts.push(`repeat×${group.repeat.count}`)
  if (group.kind === 'branch') parts.push(group.flex ? 'flex' : 'abs')
  if (group.alignCross && group.alignCross !== 'mixed') parts.push(`align:${group.alignCross}`)
  parts.push(`${group.elementCount} elem`)
  parts.push(formatKindCounts(group.kindCounts))
  return parts.filter(Boolean).join(' · ')
}

function renderSlideCard(slide, vgroupResult, report, jobId, selected, onSelect) {
  const card = document.createElement('button')
  card.type = 'button'
  card.className = `catalog-card vgroup-card ${selected ? 'active' : ''}`
  card.dataset.slideNumber = String(slide.slide_number)

  const preview = document.createElement('div')
  preview.className = 'catalog-card-preview vgroup-card-preview'
  const context = createSlideRenderContext(report)
  mountVgroupSlide(preview, slide, jobId, context, {
    vgroupResult,
    showBounds: true,
  })
  card.append(preview)

  const meta = document.createElement('div')
  meta.className = 'catalog-card-meta'
  meta.append(Object.assign(document.createElement('strong'), {
    textContent: `#${slide.slide_number}`,
  }))
  meta.append(Object.assign(document.createElement('small'), {
    textContent: `${vgroupResult.summary.groupCount} groups · ${vgroupResult.summary.groupedElementCount} elem`,
  }))
  card.append(meta)

  card.addEventListener('click', () => onSelect(slide.slide_number))
  return card
}

function renderGroupList(groups, mount, state, splitGroupIds = new Set()) {
  const list = document.createElement('div')
  list.className = 'vgroup-list'
  if (!groups.length) {
    list.append(Object.assign(document.createElement('p'), {
      className: 'section-empty',
      textContent: 'На слайде не найдено групп из 2+ элементов.',
    }))
    return list
  }

  function applyHighlight(groupId) {
    setVgroupHighlight(mount, groupId)
  }

  groups.forEach((group) => {
    const item = document.createElement('button')
    item.type = 'button'
    item.className = `vgroup-list-item${state.activeVgroupId === group.id ? ' active' : ''}${splitGroupIds.has(group.id) ? ' vgroup-list-item--split' : ''}`
    item.dataset.vgroup = group.id
    item.style.paddingLeft = `${8 + (group.depth - 1) * 16}px`
    item.append(Object.assign(document.createElement('strong'), {
      textContent: group.id,
    }))
    item.append(Object.assign(document.createElement('span'), {
      textContent: formatGroupMeta(group),
    }))

    item.addEventListener('mouseenter', () => applyHighlight(group.id))
    item.addEventListener('mouseleave', () => applyHighlight(state.activeVgroupId))
    item.addEventListener('click', () => {
      state.activeVgroupId = state.activeVgroupId === group.id ? null : group.id
      list.querySelectorAll('.vgroup-list-item').forEach((entry) => {
        entry.classList.toggle('active', entry.dataset.vgroup === state.activeVgroupId)
      })
      applyHighlight(state.activeVgroupId)
    })

    list.append(item)
  })

  if (state.activeVgroupId) {
    applyHighlight(state.activeVgroupId)
  }

  return list
}

function renderToggle(label, checked, onChange) {
  const toggle = document.createElement('label')
  toggle.className = 'vgroup-toggle'
  const input = document.createElement('input')
  input.type = 'checkbox'
  input.checked = checked
  input.addEventListener('change', () => onChange(input.checked))
  toggle.append(input, document.createTextNode(` ${label}`))
  return toggle
}

function renderSlideDetail(panel, slide, vgroupResult, jobId, renderContext, state) {
  panel.replaceChildren()
  state.activeVgroupId = state.activeVgroupId ?? null

  const title = document.createElement('div')
  title.className = 'catalog-detail-title'
  title.append(Object.assign(document.createElement('h4'), {
    textContent: `Слайд ${slide.slide_number}`,
  }))
  const titleNote = vgroupResult.slideTitle?.elementIds?.length
    ? ` · title: ${vgroupResult.slideTitle.method}`
    : ''
  const summary = vgroupResult.summary
  title.append(Object.assign(document.createElement('p'), {
    textContent: `${summary.groupCount} groups (depth ${summary.maxDepth || 1}) · ${summary.flexNodes} flex · ${summary.repeats} repeat · ${summary.containers} container · ${summary.separators} sep · ${summary.groupedElementCount}/${summary.totalElements} elem${titleNote}`,
  }))
  panel.append(title)

  const layoutSplits = analyzeSlideRepeatSplits(vgroupResult.groups)
  const splitGroupIds = new Set(layoutSplits.flatMap((split) => split.groupIds))
  if (layoutSplits.length) {
    const analysis = document.createElement('section')
    analysis.className = 'content-block vgroup-repeat-analysis'
    analysis.append(Object.assign(document.createElement('h5'), {
      textContent: 'Повторы и компоненты',
    }))
    layoutSplits.forEach((split) => {
      const parts = split.grids.map((grid) => `${grid.id} (${grid.count}${grid.grid ? ` · ${grid.grid.rows}×${grid.grid.cols}` : ''})`)
      const unionBox = unionBoxesPt(split.grids.map((grid) => {
        const group = vgroupResult.groups.find((entry) => entry.id === grid.id)
        return group?.bboxPt || null
      }).filter(Boolean))
      const zoneNote = unionBox
        ? ` · зона компонента ${Math.round(unionBox.width_pt)}×${Math.round(unionBox.height_pt)} pt`
        : ''
      analysis.append(Object.assign(document.createElement('p'), {
        textContent: `${split.groupIds.length} grid-группы (${parts.join(' + ')}) — один компонент «${split.itemSig}», фактически ${split.itemCount} экземпляров${zoneNote}. Верстка разбита на несколько flex-контейнеров.`,
      }))
    })
    panel.append(analysis)
  }

  const toolbar = document.createElement('div')
  toolbar.className = 'vgroup-toolbar'
  const rerender = () => renderVgroups(panel.closest('#panel') || panel, state)
  toolbar.append(renderToggle('Показать рамки групп', Boolean(state.vgroupsShowBounds), (checked) => {
    state.vgroupsShowBounds = checked
    rerender()
  }))
  toolbar.append(renderToggle('Сравнить с плоским DOM', Boolean(state.vgroupsCompareFlat), (checked) => {
    state.vgroupsCompareFlat = checked
    rerender()
  }))
  panel.append(toolbar)

  const groupedMount = document.createElement('div')
  groupedMount.className = 'vgroup-preview-mount'
  mountVgroupSlide(groupedMount, slide, jobId, renderContext, {
    vgroupResult,
    showBounds: Boolean(state.vgroupsShowBounds),
  })

  if (state.vgroupsCompareFlat) {
    const compare = document.createElement('div')
    compare.className = 'vgroup-compare'
    const flatColumn = document.createElement('div')
    flatColumn.className = 'vgroup-compare-column'
    flatColumn.append(Object.assign(document.createElement('h5'), { textContent: 'Плоский DOM (absolute)' }))
    const flatMount = document.createElement('div')
    flatMount.className = 'vgroup-compare-mount'
    mountDesignSystemSlide(flatMount, slide, jobId, renderContext)
    flatColumn.append(flatMount)

    const nestedColumn = document.createElement('div')
    nestedColumn.className = 'vgroup-compare-column'
    nestedColumn.append(Object.assign(document.createElement('h5'), { textContent: 'Visual DOM (nested flex)' }))
    groupedMount.classList.add('vgroup-compare-mount')
    nestedColumn.append(groupedMount)
    compare.append(flatColumn, nestedColumn)
    panel.append(compare)
  } else {
    panel.append(Object.assign(document.createElement('h5'), { textContent: 'Visual DOM (nested flex)' }))
    panel.append(groupedMount)
  }

  panel.append(Object.assign(document.createElement('h5'), { textContent: 'Найденные группы' }))
  panel.append(renderGroupList(vgroupResult.groups, groupedMount, state, splitGroupIds))
}

export function renderVgroups(panel, state) {
  panel.replaceChildren()
  const catalog = state.report?.slides
  if (!catalog?.slides?.length) {
    panel.append(Object.assign(document.createElement('div'), {
      className: 'section-empty',
      textContent: 'Каталог слайдов пуст. Сначала проанализируйте шаблон.',
    }))
    return
  }

  const deck = detectDeckVgroups(catalog, state.report)
  const perSlide = new Map(deck.perSlide.map((item) => [item.slideNumber, item]))

  const title = document.createElement('div')
  title.className = 'section-title'
  const heading = document.createElement('div')
  heading.append(Object.assign(document.createElement('h3'), {
    textContent: 'Visual groups',
  }))
  heading.append(Object.assign(document.createElement('p'), {
    textContent: 'Рекурсивный XY-cut по точным интервалам занятости: ось разреза выбирается по физическому зазору, сепараторам и повторяемости сегментов; плашки с содержимым становятся контейнерами, а bottom-up проход находит периоды и повторяющиеся серии. Результат — вложенный flex-DOM, геометрически идентичный плоскому. Наведите или выберите группу в списке.',
  }))
  title.append(heading)
  panel.append(title)

  const summary = document.createElement('p')
  summary.className = 'catalog-intro'
  summary.textContent = `${deck.summary.totalGroups} groups · ${deck.summary.totalRepeats} repeat-блоков на ${deck.summary.slidesWithGroups} из ${deck.summary.slideCount} слайдов`
  panel.append(summary)

  const layout = document.createElement('div')
  layout.className = 'catalog-layout'

  const grid = document.createElement('div')
  grid.className = 'catalog-grid'

  const detail = document.createElement('aside')
  detail.className = 'catalog-detail-panel'

  const selectedNumber = state.selectedVgroupSlideNumber ?? catalog.slides[0]?.slide_number ?? null
  const selectedSlide = catalog.slides.find((slide) => slide.slide_number === selectedNumber) || catalog.slides[0]
  const selectedVgroups = selectedSlide
    ? (perSlide.get(selectedSlide.slide_number) || detectSlideVgroups(selectedSlide, { report: state.report }))
    : null
  const renderContext = createSlideRenderContext(state.report)

  function selectSlide(slideNumber) {
    state.selectedVgroupSlideNumber = slideNumber
    state.activeVgroupId = null
    const slide = catalog.slides.find((item) => item.slide_number === slideNumber)
    if (!slide) return
    grid.querySelectorAll('.vgroup-card').forEach((card) => {
      card.classList.toggle('active', card.dataset.slideNumber === String(slideNumber))
    })
    const result = perSlide.get(slideNumber) || detectSlideVgroups(slide, { report: state.report })
    renderSlideDetail(detail, slide, result, state.jobId, renderContext, state)
  }

  catalog.slides.forEach((slide) => {
    const result = perSlide.get(slide.slide_number) || detectSlideVgroups(slide, { report: state.report })
    grid.append(renderSlideCard(slide, result, state.report, state.jobId, slide.slide_number === selectedSlide?.slide_number, selectSlide))
  })

  if (selectedSlide && selectedVgroups) {
    renderSlideDetail(detail, selectedSlide, selectedVgroups, state.jobId, renderContext, state)
  }

  layout.append(grid, detail)
  panel.append(layout)
}
