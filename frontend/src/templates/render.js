import { mountTemplateSlide } from './slide-render.js'
import { buildTitlePositionIndex, similarTemplateIds } from '../presentation/similar-templates.js'

const ROLE_LABELS = {
  title: 'Заголовок',
  subtitle: 'Подзаголовок',
  body: 'Текст',
  content: 'Контент',
}

const CAPABILITY_LABELS = {
  title: 'Заголовок',
  subtitle: 'Подзаголовок',
  paragraph: 'Абзац',
  list: 'Список',
  content: 'Контент',
}

function renderColorRow(label, colors) {
  const row = document.createElement('div')
  row.className = 'template-color-row'
  row.append(Object.assign(document.createElement('span'), { textContent: label }))
  const swatches = document.createElement('div')
  swatches.className = 'template-color-swatches'
  ;(colors || []).slice(0, 6).forEach((color) => {
    const swatch = document.createElement('span')
    swatch.className = 'template-color-swatch'
    swatch.style.backgroundColor = color
    swatch.title = color
    swatches.append(swatch)
  })
  row.append(swatches)
  return row
}

function countLayerStats(template) {
  const layers = template.render?.layers || []
  const images = layers.filter((layer) => layer.kind === 'image').length
  const fills = layers.filter((layer) => layer.kind === 'fill').length
  return { images, fills, total: layers.length }
}

function templateTitle(template) {
  return template?.layout_name || template?.layout_file || template?.template_id || 'Шаблон'
}

function preferredTerminalRoles(template, report) {
  const candidates = new Set(template?.terminal_roles || [])
  const preferred = new Set(template?.preferred_terminal_roles || [])

  // Older reports may have slide-level candidate annotations but no copied
  // role metadata on the template profile yet.
  for (const slide of report?.slides?.slides || []) {
    const candidate = slide.terminal_candidate
    if (!candidate) continue
    const sameTemplate = (template.template_id && slide.template_id === template.template_id)
      || (template.layout_source && slide.layout_source === template.layout_source)
    if (!sameTemplate) continue
    if (candidate.preferred_initial) preferred.add('initial')
    if (candidate.preferred_final) preferred.add('final')
    if ((slide.terminal_roles || []).includes('initial')) candidates.add('initial')
    if ((slide.terminal_roles || []).includes('final')) candidates.add('final')
  }
  return { candidates, preferred }
}

function renderTerminalTemplateBadges(meta, template, report) {
  const { candidates, preferred } = preferredTerminalRoles(template, report)
  if (!candidates.size) return

  const badges = document.createElement('div')
  badges.className = 'template-terminal-badges'
  const labels = [
    ['initial', 'Выбран для начального слайда'],
    ['final', 'Выбран для конечного слайда'],
  ]
  labels.forEach(([role, label]) => {
    if (!candidates.has(role)) return
    const badge = document.createElement('span')
    const isPreferred = preferred.has(role)
    badge.className = `template-terminal-badge${isPreferred ? ' is-preferred' : ''}`
    badge.textContent = isPreferred ? label : `Кандидат: ${role === 'initial' ? 'начальный' : 'конечный'}`
    badges.append(badge)
  })
  meta.append(badges)
}

function renderSimilarTemplates(template, templates, titlePositions) {
  const block = document.createElement('div')
  block.className = 'template-similar'
  block.append(Object.assign(document.createElement('span'), {
    className: 'template-similar-label',
    textContent: 'Похожие',
  }))

  const byId = new Map((templates || []).map((item) => [item.template_id, item]))
  const similar = similarTemplateIds(titlePositions, template.template_id)
    .map((id) => byId.get(id))
    .filter(Boolean)

  if (!similar.length) {
    block.append(Object.assign(document.createElement('p'), {
      className: 'template-similar-empty',
      textContent: 'Нет шаблонов с той же позицией заголовка',
    }))
    return block
  }

  const names = similar.map(templateTitle)
  const list = document.createElement('ul')
  list.className = 'template-similar-list'
  similar.forEach((item, index) => {
    const name = names[index]
    const duplicated = names.filter((value) => value === name).length > 1
    list.append(Object.assign(document.createElement('li'), {
      textContent: duplicated ? `${name} · ${item.template_id}` : name,
    }))
  })
  block.append(list)
  return block
}

function renderTemplateCard(template, jobId, templates, titlePositions, report) {
  const card = document.createElement('article')
  card.className = 'template-card'

  const previewMount = document.createElement('div')
  previewMount.className = 'template-preview-mount'
  mountTemplateSlide(previewMount, template, jobId)
  card.append(previewMount)

  const meta = document.createElement('div')
  meta.className = 'template-card-meta'
  meta.append(Object.assign(document.createElement('strong'), { textContent: templateTitle(template) }))
  renderTerminalTemplateBadges(meta, template, report)

  const stats = countLayerStats(template)
  meta.append(Object.assign(document.createElement('small'), {
    textContent: `${template.slide_count} слайдов · ${stats.total} слоёв шаблона · ${template.editable_slot_count} редактируемых зон`,
  }))
  meta.append(renderSimilarTemplates(template, templates, titlePositions))

  const caps = document.createElement('div')
  caps.className = 'template-capabilities'
  ;(template.capabilities || []).forEach((capability) => {
    caps.append(Object.assign(document.createElement('span'), {
      className: 'template-cap-chip',
      textContent: CAPABILITY_LABELS[capability] || capability,
    }))
  })
  meta.append(caps)

  const layerNote = document.createElement('p')
  layerNote.className = 'template-layer-note'
  layerNote.textContent = template.background_only
    ? `Фоновый layout без исходных текстовых полей: ${stats.fills} заливок, ${stats.images} изображений. Зоны титула рассчитаны для генерации.`
    : `Master + layout: ${stats.fills} заливок, ${stats.images} изображений. Пунктир — editable placeholders без текста.`
  meta.append(layerNote)

  const terminalPlan = template.terminal_text_plans?.initial || template.terminal_text_plans?.final
  if (terminalPlan?.title) {
    const planNote = document.createElement('p')
    planNote.className = 'template-layer-note'
    planNote.textContent = `Титул: до ${terminalPlan.title.max_chars} знаков · ${terminalPlan.title.width_pt}×${terminalPlan.title.height_pt} pt · ${terminalPlan.title.typography?.size_pt || '—'} pt. Описание: ${terminalPlan.text ? `до ${terminalPlan.text.max_chars} знаков` : 'нет зоны'}. Person: ${terminalPlan.person_supported ? 'есть' : 'нет'}.`
    meta.append(planNote)
  }

  const colors = document.createElement('div')
  colors.className = 'template-card-colors'
  colors.append(renderColorRow('Фон', [template.render?.background_color || template.colors?.background].filter(Boolean)))
  colors.append(renderColorRow('Заголовок', [template.colors?.text_styles?.title?.primary].filter(Boolean)))
  colors.append(renderColorRow('Текст', [template.colors?.text_styles?.body?.primary].filter(Boolean)))
  colors.append(renderColorRow('Accent', template.colors?.accent || []))
  meta.append(colors)

  const slots = document.createElement('div')
  slots.className = 'template-slot-list'
  ;(template.editable_slots || []).forEach((slot) => {
    slots.append(Object.assign(document.createElement('span'), {
      className: 'template-slot-chip',
      textContent: ROLE_LABELS[slot.role] || slot.role,
      title: slot.name || slot.placeholder_type,
    }))
  })
  meta.append(slots)

  card.append(meta)
  return card
}

export function renderTemplates(panel, state) {
  panel.replaceChildren()

  const slideTemplates = state.report.slide_templates

  const title = document.createElement('div')
  title.className = 'section-title'
  title.innerHTML = '<div><h3>Шаблоны слайдов</h3><p>Честный рендер master + layout: фон, декор, crop/flip/rotate/mask изображений, отмеченные editable-зоны.</p></div>'
  panel.append(title)

  if (!slideTemplates?.templates?.length) {
    panel.append(Object.assign(document.createElement('div'), {
      className: 'section-empty',
      textContent: 'Редактируемые шаблоны не найдены. Загрузите презентацию заново, чтобы получить render-слои.',
    }))
    return
  }

  const summary = document.createElement('p')
  summary.className = 'template-intro'
  summary.textContent = `${slideTemplates.summary.template_count} шаблонов · только слои master/layout (без контента конкретных слайдов).`
  panel.append(summary)

  const titlePositions = buildTitlePositionIndex(state.report)
  const grid = document.createElement('div')
  grid.className = 'template-grid'
  slideTemplates.templates.forEach((template) => {
    grid.append(renderTemplateCard(template, state.jobId, slideTemplates.templates, titlePositions, state.report))
  })
  panel.append(grid)
}
