import { extractDesignTokens, getTitleTypographyChoices, isTitleTextElement, buildTokensForTemplate } from './tokens.js'
import {
  addSlide,
  clearTemplateSelection,
  countComponentInstances,
  createConstructorDocument,
  getSelectedElement,
  insertImage,
  insertTextBlock,
  isTemplateBoundElement,
  removeSelectedElement,
  selectTemplate,
  syncComponentInstances,
  updateSelectedElement,
} from './model.js'
import { mountSlideDom } from './slide-dom.js'
import {
  componentDisplayLabel,
  findSlideTemplate,
  formatSlotBounds,
  getComponentPlacementProfile,
  getRoleColorOptions,
  listAvailableComponents,
  listSlideTemplates,
  patternDisplayLabel,
  slotRoleLabel,
} from './templates.js'
import { mountCatalogSlide } from '../templates/slide-render.js'

let fontStylesInjected = false

async function ensurePresentationFonts() {
  if (fontStylesInjected) return
  try {
    const response = await fetch('/fonts/font-aliases.json')
    if (!response.ok) return
    const registry = await response.json()
    const rules = []
    for (const [aliasFamily, config] of Object.entries(registry.aliases || {})) {
      for (const [styleName, relativePath] of Object.entries(config.styles || {})) {
        const weight = styleName === 'bold' || styleName === 'demibold' ? 700 : styleName === 'medium' ? 500 : 400
        rules.push(`@font-face{font-family:"${config.family}";src:url("/fonts/${relativePath}") format("truetype");font-weight:${weight};font-style:normal;font-display:swap;}`)
        rules.push(`@font-face{font-family:"${aliasFamily}";src:url("/fonts/${relativePath}") format("truetype");font-weight:${weight};font-style:normal;font-display:swap;}`)
      }
    }
    if (rules.length) {
      const style = document.createElement('style')
      style.dataset.constructorFonts = 'true'
      style.textContent = rules.join('')
      document.head.append(style)
      fontStylesInjected = true
    }
  } catch {
    // Local fonts are optional until files are added.
  }
}

export function ensureConstructorState(state) {
  if (state.constructor) {
    const template = findSlideTemplate(state.report, state.constructor.doc.selectedTemplateId)
    state.constructor.tokens = buildTokensForTemplate(state.constructor.baseTokens, template)
    return state.constructor
  }
  const baseTokens = extractDesignTokens(state.report)
  state.constructor = {
    baseTokens,
    tokens: baseTokens,
    doc: createConstructorDocument(state.report, baseTokens),
  }
  ensurePresentationFonts()
  return state.constructor
}

function field(label, control) {
  const wrap = document.createElement('label')
  wrap.className = 'constructor-field'
  const title = document.createElement('span')
  title.textContent = label
  wrap.append(title, control)
  return wrap
}

function renderProperties(panel, state, rerender) {
  panel.replaceChildren()
  const { doc, tokens } = state.constructor
  const selected = getSelectedElement(doc)
  const template = findSlideTemplate(state.report, doc.selectedTemplateId)
  if (!selected) {
    panel.append(Object.assign(document.createElement('p'), {
      className: 'constructor-panel-empty',
      textContent: 'Выберите элемент на слайде или добавьте компонент из палитры.',
    }))
    return
  }

  panel.append(Object.assign(document.createElement('h4'), { textContent: `${selected.type}${selected.label ? ` · ${selected.label}` : ''}` }))

  if (selected.type === 'component') {
    const template = findSlideTemplate(state.report, doc.selectedTemplateId)
    const component = resolveLibraryComponent(state, selected.componentId)
    if (component) {
      const slide = doc.slides[doc.activeSlideIndex]
      const currentCount = countComponentInstances(slide, selected.componentId)
      const profile = getComponentPlacementProfile(component, template)
      const maxCount = profile.maxCount

      panel.append(Object.assign(document.createElement('p'), {
        className: 'constructor-slot-meta',
        textContent: maxCount
          ? `${maxCount} разрешённых позиций в content-зоне · сейчас ${currentCount} экз.`
          : 'На этом шаблоне нет разрешённых позиций для компонента.',
      }))

      const slider = document.createElement('input')
      slider.type = 'range'
      slider.min = '0'
      slider.max = String(maxCount)
      slider.disabled = maxCount === 0
      slider.step = '1'
      slider.value = String(currentCount)
      slider.className = 'constructor-clone-slider'
      const value = document.createElement('span')
      value.className = 'constructor-clone-value'
      value.textContent = `${currentCount} экз.`
      slider.addEventListener('input', () => {
        const nextCount = Number(slider.value)
        value.textContent = `${nextCount} экз.`
        syncComponentInstances(doc, component, nextCount, tokens)
        rerender({ preserveSelection: true })
      })
      const sliderWrap = document.createElement('div')
      sliderWrap.className = 'constructor-clone-control'
      sliderWrap.append(slider, value)
      panel.append(field('Количество на слайде', sliderWrap))
    }
  }

  if (isTemplateBoundElement(selected)) {
    panel.append(Object.assign(document.createElement('p'), {
      className: 'constructor-slot-meta',
      textContent: `Зона шаблона: ${slotRoleLabel(selected.templateSlotRole || selected.role)} · ${formatSlotBounds(selected.slotBounds)}`,
    }))
  }

  if (selected.type === 'text' || (selected.typography && selected.content !== undefined)) {
    const content = document.createElement('textarea')
    content.className = 'constructor-input'
    content.rows = 4
    content.value = selected.content || ''
    content.addEventListener('input', () => {
      updateSelectedElement(doc, { content: content.value })
      rerender({ preserveSelection: true })
    })
    panel.append(field('Текст', content))

    const isTitle = isTitleTextElement(selected)
    const templateBound = isTemplateBoundElement(selected)
    const typographyOptions = isTitle && !templateBound ? (tokens.titleTypographyOptions || []) : null

    const family = document.createElement('select')
    family.className = 'constructor-input'
    const families = templateBound
      ? [selected.typography?.family || tokens.defaultFontFamily]
      : (isTitle
        ? [...new Set(typographyOptions.map((item) => item.family))]
        : [...new Set(tokens.typeScales.map((scale) => scale.family))])
    families.forEach((name) => {
      const option = document.createElement('option')
      option.value = name
      option.textContent = name
      family.append(option)
    })
    family.value = selected.typography?.family || families[0] || tokens.defaultFontFamily
    family.disabled = templateBound
    if (!templateBound) {
      family.addEventListener('change', () => {
        const nextOption = isTitle
          ? getTitleTypographyChoices(tokens, { typography: { family: family.value } })[0]
          : null
        updateSelectedElement(doc, {
          typography: {
            family: family.value,
            sizePt: nextOption?.sizePt ?? selected.typography?.sizePt,
            scaleLevel: nextOption?.scaleLevel ?? selected.typography?.scaleLevel,
            lineHeightRatio: nextOption?.lineHeightRatio ?? selected.typography?.lineHeightRatio,
            bold: nextOption?.bold ?? selected.typography?.bold,
          },
        })
        rerender({ preserveSelection: true })
      })
    }
    panel.append(field(isTitle ? 'Шрифт заголовка' : 'Шрифт', family))

    if (templateBound) {
      const size = document.createElement('input')
      size.className = 'constructor-input'
      size.readOnly = true
      size.value = `${selected.typography?.sizePt || 14} pt · из шаблона`
      panel.append(field('Размер', size))
    } else if (isTitle) {
      const size = document.createElement('select')
      size.className = 'constructor-input'
      const choices = getTitleTypographyChoices(tokens, selected)
      choices.forEach((item) => {
        const option = document.createElement('option')
        option.value = String(item.sizePt)
        option.textContent = `${item.sizePt} pt${item.titleProbability != null ? ` · title ${Math.round(item.titleProbability * 100)}%` : ''}`
        size.append(option)
      })
      size.value = String(selected.typography?.sizePt || choices[0]?.sizePt || 14)
      size.addEventListener('change', () => {
        const choice = choices.find((item) => String(item.sizePt) === size.value)
        if (!choice) return
        updateSelectedElement(doc, {
          typography: {
            sizePt: choice.sizePt,
            scaleLevel: choice.scaleLevel,
            lineHeightRatio: choice.lineHeightRatio,
            bold: choice.bold,
          },
        })
        rerender({ preserveSelection: true })
      })
      panel.append(field('Размер заголовка', size))
    } else {
      const size = document.createElement('input')
      size.type = 'number'
      size.min = '8'
      size.max = '120'
      size.step = '0.5'
      size.className = 'constructor-input'
      size.value = String(selected.typography?.sizePt || 14)
      size.addEventListener('change', () => {
        updateSelectedElement(doc, { typography: { sizePt: Number(size.value) } })
        rerender({ preserveSelection: true })
      })
      panel.append(field('Размер, pt', size))
    }
  }

  if (selected.type === 'image') {
    const asset = document.createElement('select')
    asset.className = 'constructor-input'
    const empty = document.createElement('option')
    empty.value = ''
    empty.textContent = '— без изображения —'
    asset.append(empty)
    tokens.mediaAssets.forEach((item) => {
      const option = document.createElement('option')
      option.value = item.filename
      option.textContent = item.filename
      asset.append(option)
    })
    asset.value = selected.asset || ''
    asset.addEventListener('change', () => {
      updateSelectedElement(doc, { asset: asset.value || null })
      rerender({ preserveSelection: true })
    })
    panel.append(field('Медиафайл', asset))
  }

  if (selected.typography) {
    const isTitle = isTitleTextElement(selected)
    const role = selected.templateSlotRole || selected.role
    const colorOptions = template
      ? getRoleColorOptions(template, role, tokens)
      : (isTitle ? (tokens.titleColors || []) : (tokens.palette || []))
    const color = document.createElement('select')
    color.className = 'constructor-input'
    colorOptions.forEach((value) => {
      const option = document.createElement('option')
      option.value = value
      option.textContent = value
      color.append(option)
    })
    const currentColor = selected.typography.color || colorOptions[0] || tokens.defaultTextColor
    color.value = colorOptions.includes(currentColor) ? currentColor : (colorOptions[0] || currentColor)
    color.addEventListener('change', () => {
      updateSelectedElement(doc, { typography: { color: color.value } })
      rerender({ preserveSelection: true })
    })
    panel.append(field(isTitle ? 'Цвет заголовка' : 'Цвет', color))
  } else if (selected.fill != null) {
    const color = document.createElement('input')
    color.type = 'color'
    color.className = 'constructor-color-input'
    const currentColor = selected.fill || tokens.defaultTextColor
    color.value = /^#[0-9a-fA-F]{6}$/.test(currentColor) ? currentColor : '#000000'
    color.addEventListener('input', () => {
      updateSelectedElement(doc, { fill: color.value })
      rerender({ preserveSelection: true })
    })
    panel.append(field('Цвет', color))
  }

  const remove = document.createElement('button')
  remove.type = 'button'
  remove.className = 'constructor-danger-btn'
  remove.textContent = 'Удалить элемент'
  remove.addEventListener('click', () => {
    removeSelectedElement(doc)
    rerender()
  })
  panel.append(remove)
}

function renderSlideStrip(container, state, rerender) {
  container.replaceChildren()
  const { doc } = state.constructor
  doc.slides.forEach((slide, index) => {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = `constructor-slide-thumb ${index === doc.activeSlideIndex ? 'active' : ''}`
    button.textContent = String(index + 1)
    button.addEventListener('click', () => {
      doc.activeSlideIndex = index
      doc.selectedElementId = null
      rerender()
    })
    container.append(button)
  })

  const add = document.createElement('button')
  add.type = 'button'
  add.className = 'constructor-slide-add'
  add.textContent = '+'
  add.title = 'Новый слайд'
  add.addEventListener('click', () => {
    addSlide(doc, state.constructor.tokens)
    rerender()
  })
  container.append(add)
}

function renderTemplatePicker(container, state, onSelectTemplate) {
  container.replaceChildren()
  const templates = listSlideTemplates(state.report)

  container.append(Object.assign(document.createElement('h4'), { textContent: 'Выберите шаблон слайда' }))
  container.append(Object.assign(document.createElement('p'), {
    className: 'constructor-library-note',
    textContent: 'Шаблон — восстановленный слайд без компонентов: заголовок, фон и декоративные слои. Слайды 38, 39, 40, 42 и похожие с одним фоном группируются вместе.',
  }))

  if (!templates.length) {
    container.append(Object.assign(document.createElement('p'), {
      className: 'constructor-panel-empty',
      textContent: 'Шаблоны не найдены. Сначала проанализируйте презентацию.',
    }))
    return
  }

  const grid = document.createElement('div')
  grid.className = 'constructor-template-grid'

  templates.forEach((item) => {
    const card = document.createElement('button')
    card.type = 'button'
    card.className = 'constructor-template-card'
    card.dataset.templateId = item.id

    const preview = document.createElement('div')
    preview.className = 'constructor-template-card-preview'
    if (item.shellSlide) {
      mountCatalogSlide(preview, item.shellSlide, state.jobId)
    }
    card.append(preview)

    const meta = document.createElement('div')
    meta.className = 'constructor-template-card-meta'
    meta.append(Object.assign(document.createElement('strong'), { textContent: item.name }))
    const examples = item.exampleSlideNumbers?.length
      ? ` · напр. ${item.exampleSlideNumbers.map((slideNumber) => `#${slideNumber}`).join(', ')}`
      : ''
    meta.append(Object.assign(document.createElement('small'), {
      textContent: `${item.slideCount} слайдов · превью #${item.previewSlideNumber}${examples}`,
    }))
    card.append(meta)

    card.addEventListener('click', () => onSelectTemplate(item.template))
    grid.append(card)
  })

  container.append(grid)
}

function renderTemplateSummary(container, template, onChangeTemplate) {
  container.replaceChildren()
  const header = document.createElement('div')
  header.className = 'constructor-template-active'

  const text = document.createElement('div')
  text.append(Object.assign(document.createElement('strong'), {
    textContent: template.layout_name || template.layout_file,
  }))
  const previewLabel = template.preview_slide ? ` · превью #${template.preview_slide}` : ''
  text.append(Object.assign(document.createElement('small'), {
    textContent: `${template.slide_count} восстановленных слайдов${previewLabel} · без компонентов`,
  }))
  header.append(text)

  const change = document.createElement('button')
  change.type = 'button'
  change.className = 'constructor-template-change'
  change.textContent = 'Сменить'
  change.addEventListener('click', onChangeTemplate)
  header.append(change)
  container.append(header)
}

function resolveLibraryComponent(state, componentId) {
  const template = findSlideTemplate(state.report, state.constructor.doc.selectedTemplateId)
  return listAvailableComponents(state.report, template, state.constructor.tokens)
    .find((item) => item.component.id === componentId)?.component || null
}

function renderComponentLibrary(container, state, rerender) {
  container.replaceChildren()
  const { doc, tokens } = state.constructor
  const template = findSlideTemplate(state.report, doc.selectedTemplateId)
  const slide = doc.slides[doc.activeSlideIndex]
  const items = listAvailableComponents(state.report, template, tokens)

  container.append(Object.assign(document.createElement('h4'), { textContent: 'Компоненты шаблона' }))
  container.append(Object.assign(document.createElement('p'), {
    className: 'constructor-library-note',
    textContent: items.length
      ? 'Компоненты и лимиты клонов выведены из реальных позиций на слайдах этого шаблона — только внутри content-зоны под заголовком.'
      : 'На слайдах выбранного шаблона нет компонентов с разрешёнными позициями — можно добавить заголовок или текст вручную.',
  }))

  if (!items.length) {
    container.append(Object.assign(document.createElement('p'), {
      className: 'constructor-panel-empty',
      textContent: 'Нет компонентов для этого шаблона.',
    }))
    return
  }

  items.forEach(({ source, component, profile }) => {
    const label = source === 'registry'
      ? componentDisplayLabel(component)
      : (source === 'pattern' ? patternDisplayLabel(component.pattern) : component.label)
    const scope = component.pattern?.scope === 'deck' ? 'deck' : 'layout'
    const maxCount = profile.maxCount
    const currentCount = countComponentInstances(slide, component.id)

    const card = document.createElement('div')
    card.className = 'constructor-component-card constructor-component-card--interactive'

    const head = document.createElement('div')
    head.className = 'constructor-component-card-head'
    head.innerHTML = `<strong>${label}</strong><small>${component.slots.required.length} req · ${component.slots.optional.length} opt · макс ${maxCount} · ${scope}</small>`
    card.append(head)

    const slider = document.createElement('input')
    slider.type = 'range'
    slider.min = '0'
    slider.max = String(maxCount)
    slider.step = '1'
    slider.value = String(Math.min(currentCount, maxCount))
    slider.disabled = maxCount === 0
    slider.className = 'constructor-clone-slider'
    slider.title = `0–${maxCount} экземпляров`

    const value = document.createElement('span')
    value.className = 'constructor-clone-value'
    value.textContent = `${currentCount} экз.`

    slider.addEventListener('input', () => {
      const nextCount = Number(slider.value)
      value.textContent = `${nextCount} экз.`
      syncComponentInstances(doc, component, nextCount, tokens)
      rerender({ preserveSelection: true })
    })

    const addOne = document.createElement('button')
    addOne.type = 'button'
    addOne.className = 'constructor-clone-add'
    addOne.textContent = '+1'
    addOne.title = 'Добавить один экземпляр'
    addOne.disabled = maxCount === 0 || currentCount >= maxCount
    addOne.addEventListener('click', () => {
      const nextCount = Math.min(maxCount, countComponentInstances(slide, component.id) + 1)
      slider.value = String(nextCount)
      value.textContent = `${nextCount} экз.`
      syncComponentInstances(doc, component, nextCount, tokens)
      rerender({ preserveSelection: true })
    })

    const controls = document.createElement('div')
    controls.className = 'constructor-clone-control'
    controls.append(slider, value, addOne)
    card.append(controls)
    container.append(card)
  })
}

export function renderConstructor(panel, state, callbacks) {
  const constructor = ensureConstructorState(state)
  const { doc, tokens } = constructor
  let disposeSlideDom = null

  panel.replaceChildren()
  document.querySelector('.shell')?.classList.add('constructor-mode')

  const selectedTemplate = findSlideTemplate(state.report, doc.selectedTemplateId)

  const title = document.createElement('div')
  title.className = 'section-title'
  title.innerHTML = selectedTemplate
    ? '<div><h3>Конструктор</h3><p>Шаблон = восстановленный слайд без компонентов. Дальше накидывайте компоненты и клонируйте их слайдером.</p></div>'
    : '<div><h3>Конструктор</h3><p>Выберите шаблон из восстановленных слайдов — затем добавляйте компоненты и клонируйте их слайдером.</p></div>'
  panel.append(title)

  const layout = document.createElement('div')
  layout.className = 'constructor-layout'

  const library = document.createElement('aside')
  library.className = 'constructor-library'

  const canvasPanel = document.createElement('section')
  canvasPanel.className = 'constructor-canvas-panel'

  const properties = document.createElement('aside')
  properties.className = 'constructor-properties'

  if (!selectedTemplate) {
    layout.className = 'constructor-layout constructor-layout--picker'
    renderTemplatePicker(canvasPanel, state, (template) => {
      selectTemplate(doc, template, constructor.baseTokens)
      constructor.tokens = buildTokensForTemplate(constructor.baseTokens, template)
      callbacks.onChange()
    })
    library.append(Object.assign(document.createElement('p'), {
      className: 'constructor-panel-empty',
      textContent: 'Компоненты появятся после выбора шаблона.',
    }))
    layout.append(library, canvasPanel)
    panel.append(layout)
    return
  }

  const templateSummaryMount = document.createElement('div')
  renderTemplateSummary(templateSummaryMount, selectedTemplate, () => {
    clearTemplateSelection(doc, tokens)
    callbacks.onChange()
  })
  library.append(templateSummaryMount)

  const componentMount = document.createElement('div')
  library.append(componentMount)

  library.append(Object.assign(document.createElement('h4'), { textContent: 'Медиа' }))
  const mediaList = document.createElement('div')
  mediaList.className = 'constructor-media-list'
  tokens.mediaAssets.slice(0, 12).forEach((asset) => {
    const item = document.createElement('button')
    item.type = 'button'
    item.className = 'constructor-media-item'
    if (state.jobId && asset.kind === 'image') {
      const img = document.createElement('img')
      img.src = `/jobs/${encodeURIComponent(state.jobId)}/assets/${encodeURIComponent(asset.filename)}`
      img.alt = asset.filename
      item.append(img)
    } else {
      item.textContent = asset.filename
    }
    item.title = asset.filename
    mediaList.append(item)
  })
  library.append(mediaList)

  const toolbar = document.createElement('div')
  toolbar.className = 'constructor-toolbar'
  const addTitle = document.createElement('button')
  addTitle.type = 'button'
  addTitle.className = 'constructor-tool-btn'
  addTitle.textContent = '+ Заголовок'
  const addBody = document.createElement('button')
  addBody.type = 'button'
  addBody.className = 'constructor-tool-btn'
  addBody.textContent = '+ Текст'
  canvasPanel.append(toolbar)

  const meta = document.createElement('div')
  meta.className = 'constructor-slide-meta'
  meta.textContent = `${tokens.slideSize.width}×${tokens.slideSize.height} pt · ${tokens.themeName}`
  canvasPanel.append(meta)

  const slideMount = document.createElement('div')
  slideMount.className = 'constructor-slide-mount'
  canvasPanel.append(slideMount)

  const strip = document.createElement('div')
  strip.className = 'constructor-slide-strip'
  canvasPanel.append(strip)

  toolbar.append(addTitle, addBody)

  layout.append(library, canvasPanel, properties)
  panel.append(layout)

  const rerender = (options = {}) => {
    if (!options.preserveSelection) disposeSlideDom?.()
    const slide = doc.slides[doc.activeSlideIndex]
    renderSlideStrip(strip, state, rerender)
    renderProperties(properties, state, rerender)
    disposeSlideDom = mountSlideDom(slideMount, slide, tokens, {
      jobId: state.jobId,
      selectedElementId: doc.selectedElementId,
      onSelect: (id) => {
        doc.selectedElementId = id
        rerender({ preserveSelection: true })
      },
      onBackgroundClick: () => {
        doc.selectedElementId = null
        rerender({ preserveSelection: true })
      },
    })
  }

  renderComponentLibrary(componentMount, state, rerender)
  addTitle.addEventListener('click', () => {
    insertTextBlock(doc, tokens, 'title')
    rerender()
  })
  addBody.addEventListener('click', () => {
    insertTextBlock(doc, tokens, 'body')
    rerender()
  })
  mediaList.querySelectorAll('.constructor-media-item').forEach((item, assetIndex) => {
    const asset = tokens.mediaAssets[assetIndex]
    if (!asset) return
    item.addEventListener('click', () => {
      insertImage(doc, asset)
      rerender()
    })
  })

  rerender()
}

export function teardownConstructorMode() {
  document.querySelector('.shell')?.classList.remove('constructor-mode')
}
