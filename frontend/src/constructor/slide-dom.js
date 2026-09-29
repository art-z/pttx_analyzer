import { isTitleTextElement, pickBodyTypography, pickTitleTypography } from './tokens.js'
import { mountTemplateBackground } from '../templates/slide-render.js'
import { boxFromGeometry, buildTemplateContentRegion, slotRoleLabel } from './templates.js'
import { isTemplateBoundElement } from './model.js'
import { shouldApplyLineHeight } from '../slides/text-list.js'

function resolveTypography(element, tokens) {
  const typo = element.typography || {}
  if (isTemplateBoundElement(element) && typo.family && typo.sizePt) {
    return {
      ...typo,
      color: typo.color || tokens.defaultTextColor,
    }
  }
  if (isTitleTextElement(element)) {
    const base = pickTitleTypography(tokens)
    return {
      ...base,
      ...typo,
      family: typo.family || base.family,
      sizePt: typo.sizePt || base.sizePt,
      color: typo.color || base.color,
      bold: typo.bold ?? base.bold,
    }
  }
  if (typo.family && typo.sizePt) return typo
  return { ...pickBodyTypography(tokens), ...typo }
}

function ptToPx(sizePt, slideWidthPx, slideWidthPt) {
  return (sizePt * slideWidthPx) / slideWidthPt
}

function applyTextStyles(node, element, tokens, slideWidthPx, slideWidthPt) {
  const typo = resolveTypography(element, tokens)
  node.style.fontFamily = `"${typo.family || tokens.defaultFontFamily}", ${tokens.themeFonts?.major?.latin || 'Arial'}, sans-serif`
  node.style.fontSize = `${ptToPx(typo.sizePt || 14, slideWidthPx, slideWidthPt)}px`
  node.style.fontWeight = typo.bold ? '700' : '400'
  if (shouldApplyLineHeight(typo, element.paragraph_spacing_pt || {})) {
    if (typo.lineHeightPt) node.style.lineHeight = `${ptToPx(typo.lineHeightPt, slideWidthPx, slideWidthPt)}px`
    else node.style.lineHeight = String(typo.lineHeightRatio || 1.15)
  } else {
    node.style.lineHeight = 'normal'
  }
  node.style.color = typo.color || tokens.defaultTextColor
  node.style.overflow = 'hidden'
  node.style.wordBreak = 'break-word'
  if (typo.alignment === 'ctr') node.style.textAlign = 'center'
  else if (typo.alignment === 'r') node.style.textAlign = 'right'
  else node.style.textAlign = 'left'
}

function placeElement(node, box, parentBox = null) {
  const base = parentBox || { x: 0, y: 0, width: 1, height: 1 }
  const left = (base.x + box.x * base.width) * 100
  const top = (base.y + box.y * base.height) * 100
  const width = box.width * base.width * 100
  const height = box.height * base.height * 100
  node.style.left = `${left}%`
  node.style.top = `${top}%`
  node.style.width = `${width}%`
  node.style.height = `${height}%`
}

function renderLeaf(element, tokens, jobId, slideWidthPx, slideWidthPt, parentBox, selectedId, onSelect, readOnly = false) {
  const node = document.createElement('div')
  node.className = `constructor-element constructor-element--${element.type}`
  node.dataset.elementId = element.id
  if (element.id === selectedId) node.classList.add('is-selected')

  placeElement(node, element, parentBox)

  if (element.type === 'text') {
    node.classList.add('constructor-text')
    node.contentEditable = readOnly ? 'false' : 'true'
    node.spellcheck = false
    node.textContent = element.content || ''
    applyTextStyles(node, element, tokens, slideWidthPx, slideWidthPt)
    if (!readOnly) {
      node.addEventListener('input', () => { element.content = node.textContent })
      node.addEventListener('focus', () => onSelect(element.id))
    }
  } else if (element.type === 'image') {
    node.classList.add('constructor-image')
    if (element.asset && jobId) {
      const img = document.createElement('img')
      img.src = `/jobs/${encodeURIComponent(jobId)}/assets/${encodeURIComponent(element.asset)}`
      img.alt = element.asset
      img.draggable = false
      img.style.objectFit = element.objectFit || 'contain'
      node.append(img)
    } else {
      node.classList.add('constructor-image--empty')
      node.textContent = element.role === 'icon' ? 'Icon' : 'Image'
    }
  } else if (element.type === 'shape') {
    node.classList.add('constructor-shape')
    node.style.background = element.fill || 'rgba(0,119,255,0.12)'
  }

  node.addEventListener('pointerdown', (event) => {
    event.stopPropagation()
    onSelect(element.id)
  })

  return node
}

function renderElement(element, tokens, jobId, slideWidthPx, slideWidthPt, parentBox, selectedId, onSelect, readOnly = false) {
  if (element.type === 'component') {
    const group = document.createElement('div')
    group.className = 'constructor-element constructor-element--component'
    group.dataset.elementId = element.id
    if (element.id === selectedId) group.classList.add('is-selected')
    placeElement(group, element)

    const frame = document.createElement('div')
    frame.className = 'constructor-component-frame'
    group.append(frame)

    if (Number.isFinite(element.cloneIndex)) {
      const badge = document.createElement('span')
      badge.className = 'constructor-component-badge'
      badge.textContent = `#${element.cloneIndex + 1}`
      group.append(badge)
    }

    for (const child of element.children || []) {
      group.append(renderLeaf(child, tokens, jobId, slideWidthPx, slideWidthPt, element, selectedId, onSelect, readOnly))
    }

    group.addEventListener('pointerdown', (event) => {
      if (event.target === group || event.target === frame) {
        event.stopPropagation()
        onSelect(element.id)
      }
    })
    return group
  }

  return renderLeaf(element, tokens, jobId, slideWidthPx, slideWidthPt, parentBox, selectedId, onSelect, readOnly)
}

export function mountSlideDom(container, slide, tokens, options) {
  const { jobId, selectedElementId, onSelect, onBackgroundClick, readOnly = false } = options
  container.replaceChildren()

  const viewport = document.createElement('div')
  viewport.className = 'constructor-slide-viewport'

  const stage = document.createElement('div')
  stage.className = 'constructor-slide-stage'

  const slideNode = document.createElement('div')
  slideNode.className = 'constructor-slide'
  slideNode.style.background = slide.template ? 'transparent' : (slide.background || tokens.defaultBackground)
  slideNode.style.aspectRatio = `${tokens.slideSize.width} / ${tokens.slideSize.height}`

  const bgMount = document.createElement('div')
  bgMount.className = 'constructor-slide-bg'
  if (slide.template) {
    mountTemplateBackground(bgMount, slide.template, jobId)
  }
  slideNode.append(bgMount)

  const slotsMount = document.createElement('div')
  slotsMount.className = 'constructor-slide-slots'
  slideNode.append(slotsMount)

  const elementsMount = document.createElement('div')
  elementsMount.className = 'constructor-slide-elements'
  slideNode.append(elementsMount)

  const measure = () => {
    const slideWidthPx = slideNode.clientWidth
    const slideWidthPt = tokens.slideSize.width
    slotsMount.replaceChildren()
    if (slide.template) {
      for (const slot of slide.template.editable_slots || []) {
        const box = boxFromGeometry(slot.geometry_norm)
        const guide = document.createElement('div')
        guide.className = 'constructor-slot-guide'
        const role = slot.role || slot.placeholder_type
        guide.title = slotRoleLabel(role)
        const occupied = slide.elements.some((element) => element.templateSlotId === slot.shape_id)
        if (occupied) guide.classList.add('is-occupied')
        if (selectedElementId && slide.elements.some((element) => element.id === selectedElementId && element.templateSlotId === slot.shape_id)) {
          guide.classList.add('is-active')
        }
        placeElement(guide, box)
        slotsMount.append(guide)
      }

      const contentRegion = buildTemplateContentRegion(slide.template)
      const regionGuide = document.createElement('div')
      regionGuide.className = 'constructor-content-region'
      regionGuide.title = 'Content-зона: сюда можно ставить компоненты'
      placeElement(regionGuide, contentRegion)
      slotsMount.append(regionGuide)
    }
    elementsMount.replaceChildren()
    for (const element of slide.elements) {
      elementsMount.append(renderElement(element, tokens, jobId, slideWidthPx, slideWidthPt, null, selectedElementId, onSelect, readOnly))
    }
  }

  slideNode.addEventListener('pointerdown', () => onBackgroundClick?.())
  stage.append(slideNode)
  viewport.append(stage)
  container.append(viewport)

  const observer = new ResizeObserver(() => measure())
  observer.observe(slideNode)
  measure()

  return () => observer.disconnect()
}
