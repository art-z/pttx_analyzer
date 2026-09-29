const ROLE_LABELS = {
  title: 'Заголовок',
  subtitle: 'Подзаголовок',
  body: 'Текст',
  content: 'Контент',
}

const DEFAULT_CONTENT = {
  title: 'Заголовок',
  subtitle: 'Подзаголовок',
  body: 'Текст',
  content: 'Контент',
}

const ROLE_LOOKUP = {
  title: ['title', 'ctrTitle'],
  subtitle: ['subtitle', 'subTitle'],
  body: ['body'],
  content: ['content', 'obj'],
}

function roundNorm(value) {
  return Math.round((Number(value) || 0) * 1000) / 1000
}

function renderShellKey(slide) {
  const render = slide?.render || {}
  const layerKey = (render.layers || []).map((layer) => {
    const geometry = layer.geometry_norm || {}
    return [
      layer.kind || '',
      layer.asset || '',
      roundNorm(geometry.x),
      roundNorm(geometry.y),
      roundNorm(geometry.width),
      roundNorm(geometry.height),
    ].join(':')
  }).join('|')
  return `${slide.layout_source || ''}::${render.background_color || ''}::${layerKey}`
}

export function collectPatternElementIds(slide, patterns) {
  const ids = new Set()
  const slideNumber = slide?.slide_number
  if (!slideNumber) return ids

  for (const pattern of patterns || []) {
    for (const instance of pattern.instances || []) {
      if (instance.slide_number !== slideNumber) continue
      for (const element of instance.elements || []) {
        if (element.element_id) ids.add(element.element_id)
      }
    }
  }
  return ids
}

export function buildShellSlide(slide, report, options = {}) {
  if (!slide) return null
  let contentElements = slide.content_elements || []

  if (report?.slide_semantics) {
    contentElements = contentElements.filter((element) => !element.component_ref)
  } else {
    const patternIds = collectPatternElementIds(slide, report?.slides?.patterns)
    contentElements = contentElements.filter((element) => !patternIds.has(element.element_id))
  }

  if (options.titleOnly) {
    const title = findShellTitleElement({ ...slide, content_elements: contentElements })
    contentElements = title ? [title] : []
  }

  return {
    ...slide,
    content_elements: contentElements,
  }
}

export function findShellTitleElement(shellSlide) {
  const candidates = (shellSlide?.content_elements || [])
    .filter((element) => element.kind === 'text' && (element.text || '').trim())
    .sort((left, right) => {
      const leftY = left.geometry_norm?.y ?? 1
      const rightY = right.geometry_norm?.y ?? 1
      return leftY - rightY || (left.geometry_norm?.x ?? 0) - (right.geometry_norm?.x ?? 0)
    })

  return candidates.find((element) => (element.geometry_norm?.y ?? 1) < 0.22) || candidates[0] || null
}

function pickPreviewSlide(slides, report) {
  let best = slides[0]
  let bestHasTitle = false

  for (const slide of slides) {
    const title = findShellTitleElement(buildShellSlide(slide, report))
    if (title && !bestHasTitle) {
      best = slide
      bestHasTitle = true
      continue
    }
    if (!bestHasTitle && slide.slide_number < best.slide_number) {
      best = slide
    }
  }

  return best
}

function buildTemplateFromShell(shell, report) {
  const catalogSlides = report?.slides?.slides || []
  const previewSlide = catalogSlides.find((slide) => slide.slide_number === shell.preview_slide)
  const shellSlide = previewSlide ? buildShellSlide(previewSlide, report, { titleOnly: true }) : null

  return {
    ...(shell.profile || {}),
    source: 'restored_shell',
    shell_id: shell.shell_id,
    slide_numbers: shell.slide_numbers || [],
    slide_count: shell.slide_count || 0,
    preview_slide: shell.preview_slide,
    render: shell.render || shell.profile?.render,
    shellSlide,
    contentRegion: shell.content_region,
    allowed_components: shell.allowed_components || [],
  }
}

export function listSlideTemplates(report) {
  const semanticsShells = report?.slide_semantics?.shell_templates || []
  if (semanticsShells.length) {
    return semanticsShells.map((shell) => ({
      id: shell.layout_source,
      name: shell.layout_name || shell.profile?.layout_name || shell.layout_source,
      slideCount: shell.slide_count || 0,
      slotCount: shell.profile?.editable_slot_count || 0,
      capabilities: shell.profile?.capabilities || [],
      previewSlideNumber: shell.preview_slide,
      exampleSlideNumbers: (shell.slide_numbers || []).slice(0, 6),
      shellSlide: buildShellSlide(
        (report?.slides?.slides || []).find((slide) => slide.slide_number === shell.preview_slide),
        report,
        { titleOnly: true },
      ),
      template: buildTemplateFromShell(shell, report),
    })).sort((left, right) => (
      right.slideCount - left.slideCount
      || left.name.localeCompare(right.name, 'ru')
    ))
  }

  const catalogSlides = report?.slides?.slides || []
  const layoutProfiles = new Map(
    (report.slide_templates?.templates || []).map((template) => [template.layout_source, template]),
  )
  const groups = new Map()

  catalogSlides.forEach((slide) => {
    if (!slide.layout_source) return
    const key = renderShellKey(slide)
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(slide)
  })

  const items = []
  groups.forEach((slides) => {
    slides.sort((left, right) => left.slide_number - right.slide_number)
    const layoutSource = slides[0].layout_source
    const profile = layoutProfiles.get(layoutSource)
    if (!profile) return

    const slideNumbers = slides.map((slide) => slide.slide_number)
    const previewSlide = pickPreviewSlide(slides, report)
    const shellSlide = buildShellSlide(previewSlide, report, { titleOnly: true })

    items.push({
      id: layoutSource,
      name: profile.layout_name || slides[0].layout_name || profile.layout_file,
      slideCount: slides.length,
      slotCount: profile.editable_slot_count || 0,
      capabilities: profile.capabilities || [],
      previewSlideNumber: previewSlide.slide_number,
      exampleSlideNumbers: slideNumbers.slice(0, 6),
      shellSlide,
      template: {
        ...profile,
        source: 'restored_shell',
        slide_numbers: slideNumbers,
        slide_count: slides.length,
        preview_slide: previewSlide.slide_number,
        render: slides[0].render || profile.render,
        shellSlide,
        contentRegion: buildTemplateContentRegion({
          ...profile,
          slide_numbers: slideNumbers,
        }),
      },
    })
  })

  items.sort((left, right) => (
    right.slideCount - left.slideCount
    || left.name.localeCompare(right.name, 'ru')
  ))
  return items
}

export function findSlideTemplate(report, templateId) {
  if (!templateId) return null
  const item = listSlideTemplates(report).find((entry) => entry.id === templateId)
  if (item?.template) return item.template
  return (report.slide_templates?.templates || []).find((template) => template.layout_source === templateId) || null
}

const PATTERN_LABELS = {
  TEXT_BLOCK: 'Текстовый блок',
  metric: 'Показатель',
  ICON_ROW: 'Ряд иконок',
  MEDIA_CARD: 'Медиа-карточка',
  IMAGE_BLOCK: 'Изображение',
  SHAPE_BLOCK: 'Фигура',
  TABLE: 'Таблица',
  CHART: 'График',
  DIAGRAM: 'Диаграмма',
  BLOCK: 'Блок',
}

export function findAllowedComponent(template, componentId) {
  return (template?.allowed_components || []).find((entry) => entry.component_id === componentId) || null
}

export function registryComponentFromAllowed(entry) {
  const component = entry.component || {}
  return {
    id: entry.component_id,
    label: entry.label || entry.name,
    container: entry.container || component.container || {},
    slots: entry.slots || component.slots || { required: [], optional: [] },
    frequency: component.frequency,
    pattern: null,
    registry: component,
    name: entry.name,
  }
}

export function patternDisplayLabel(pattern) {
  const code = pattern?.name || pattern?.label
  return PATTERN_LABELS[code] || code || pattern?.pattern_id || 'Паттерн'
}

export function componentDisplayLabel(component) {
  if (component?.label) return component.label
  if (component?.name) return PATTERN_LABELS[component.name] || component.name
  return patternDisplayLabel(component?.pattern) || component?.id || 'Компонент'
}

export function findRegistryInstance(component, template) {
  const allowed = findAllowedComponent(template, component.id)
  const registry = component.registry || allowed?.component
  if (!registry) return null
  const slideNumbers = new Set(template?.slide_numbers || [])
  return (registry.instances || []).find((item) => slideNumbers.has(item.slide_number))
    || registry.instances?.[0]
    || null
}

export function listSlidePatterns(report) {
  return report?.slides?.patterns || []
}

export function filterPatternsForTemplate(patterns, template) {
  if (!template) return []
  const layoutSource = template.layout_source
  if (!layoutSource) return []

  return (patterns || [])
    .filter((pattern) => {
      if (pattern.layout_source === layoutSource) return true
      return (pattern.layout_sources || []).includes(layoutSource)
    })
    .map((pattern) => ({
      ...pattern,
      templateOverlap: (pattern.frequency?.slide_numbers || []).filter(
        (slideNumber) => (template.slide_numbers || []).includes(slideNumber),
      ).length || pattern.frequency?.slide_count || 0,
    }))
    .sort((left, right) => (
      (right.frequency?.instance_count || 0) - (left.frequency?.instance_count || 0)
      || (right.templateOverlap || 0) - (left.templateOverlap || 0)
      || patternDisplayLabel(left).localeCompare(patternDisplayLabel(right), 'ru')
    ))
}

export function patternAsComponent(pattern) {
  return {
    id: pattern.pattern_id,
    label: patternDisplayLabel(pattern),
    container: pattern.container || {},
    slots: pattern.slots || { required: [], optional: [] },
    frequency: pattern.frequency,
    pattern,
  }
}

export function findPatternPlacement(pattern, template) {
  const layout = template?.layout_source
  const instance = (pattern?.instances || []).find((item) => item.layout_source === layout)
    || pattern?.instances?.[0]
  const container = instance?.container
  if (container) {
    return {
      x: container.x ?? 0.12,
      y: container.y ?? 0.18,
      width: container.width ?? pattern.container?.width_norm ?? 0.35,
      height: container.height ?? pattern.container?.height_norm ?? 0.22,
    }
  }
  return findComponentPlacement(template)
}

export function findPatternInstance(pattern, template) {
  if (!pattern) return null
  const slideNumbers = new Set(template?.slide_numbers || [])
  const layout = template?.layout_source
  return (pattern.instances || []).find((item) => slideNumbers.has(item.slide_number))
    || (pattern.instances || []).find((item) => item.layout_source === layout)
    || pattern.instances?.[0]
    || null
}

function relativeElementCenter(element, container) {
  const geometry = element?.geometry_norm || {}
  const cx = (geometry.x || 0) + (geometry.width || 0) / 2
  const cy = (geometry.y || 0) + (geometry.height || 0) / 2
  const relCx = container?.width ? (cx - (container.x || 0)) / container.width : cx
  const relCy = container?.height ? (cy - (container.y || 0)) / container.height : cy
  return { relCx, relCy }
}

function slotMatchesElement(slot, element, container) {
  const slotKind = slot.kind
  const elementKind = element?.kind
  if (slotKind === elementKind) return true
  if (slotKind === 'image' && (elementKind === 'image' || elementKind === 'icon')) return true
  return false
}

export function buildSlotDefaults(component, instance) {
  const defaults = {}
  const slots = [...component.slots?.required || [], ...component.slots?.optional || []]
  slots.forEach((slot) => {
    if (slot.defaults?.asset || slot.defaults?.text) {
      defaults[slot.slot_id] = { ...slot.defaults }
    }
  })

  if (!instance?.container) return defaults

  for (const slot of slots) {
    const pos = slot.position || {}
    let best = null
    let bestDistance = Infinity
    for (const element of instance.elements || []) {
      if (!slotMatchesElement(slot, element, instance.container)) continue
      const { relCx, relCy } = relativeElementCenter(element, instance.container)
      const distance = Math.hypot((relCx - (pos.cx_norm ?? 0.5)), (relCy - (pos.cy_norm ?? 0.5)))
      if (distance < bestDistance) {
        bestDistance = distance
        best = element
      }
    }
    if (!best || bestDistance > 0.18) continue
    defaults[slot.slot_id] = {
      ...(defaults[slot.slot_id] || {}),
      ...(best.asset ? { asset: best.asset } : {}),
      ...(best.text_sample ? { text: best.text_sample } : {}),
    }
  }
  return defaults
}

export function filterComponentsForTemplate(components, template) {
  if (!template) return []
  const slideSet = new Set(template.slide_numbers || [])
  if (!slideSet.size) return []

  return components
    .map((component) => {
      const overlapSlides = (component.frequency?.slide_numbers || []).filter((slideNumber) => slideSet.has(slideNumber))
      return {
        component,
        overlapCount: overlapSlides.length,
      }
    })
    .filter((item) => item.overlapCount > 0)
    .sort((left, right) => (
      right.overlapCount - left.overlapCount
      || (right.component.frequency?.instance_count || 0) - (left.component.frequency?.instance_count || 0)
      || left.component.label.localeCompare(right.component.label, 'ru')
    ))
    .map(({ component, overlapCount }) => ({
      ...component,
      templateOverlap: overlapCount,
    }))
}

export function normalizeSlotRole(role) {
  if (role === 'ctrTitle') return 'title'
  if (role === 'subTitle') return 'subtitle'
  if (role === 'obj') return 'content'
  return role || 'content'
}

export function slotRoleLabel(role) {
  return ROLE_LABELS[normalizeSlotRole(role)] || role || 'Зона'
}

export function isEditableTextSlot(slot) {
  const role = normalizeSlotRole(slot?.role || slot?.placeholder_type)
  return slot?.kind === 'placeholder' && Object.prototype.hasOwnProperty.call(ROLE_LABELS, role)
}

export function getEditableSlots(template) {
  return (template?.editable_slots || []).filter(isEditableTextSlot)
}

export function getEditableSlot(template, role) {
  const aliases = ROLE_LOOKUP[role] || [role]
  return getEditableSlots(template).find((slot) => {
    const slotRole = slot.role || slot.placeholder_type
    return aliases.includes(slotRole) || aliases.includes(normalizeSlotRole(slotRole))
  }) || null
}

export function boxFromGeometry(geometryNorm) {
  const geometry = geometryNorm || {}
  return {
    x: geometry.x ?? 0,
    y: geometry.y ?? 0,
    width: geometry.width ?? 0.2,
    height: geometry.height ?? 0.1,
  }
}

function normalizeHex(color) {
  const raw = String(color || '').trim()
  const short = raw.match(/^#?([0-9a-f]{3})$/i)?.[1]
  if (short) return `#${short.split('').map((item) => item + item).join('').toUpperCase()}`
  const long = raw.match(/^#?([0-9a-f]{6})$/i)?.[1]
  return long ? `#${long.toUpperCase()}` : null
}

function relativeLuminance(color) {
  const hex = normalizeHex(color)
  if (!hex) return null
  const channels = [1, 3, 5].map((offset) => parseInt(hex.slice(offset, offset + 2), 16) / 255)
    .map((value) => (value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4))
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2]
}

function contrastRatio(left, right) {
  const leftLum = relativeLuminance(left)
  const rightLum = relativeLuminance(right)
  if (leftLum == null || rightLum == null) return null
  const lighter = Math.max(leftLum, rightLum)
  const darker = Math.min(leftLum, rightLum)
  return (lighter + 0.05) / (darker + 0.05)
}

function readableTextColor(style, template, fallbackColors = []) {
  const background = template?.render?.background_color || template?.colors?.background || null
  const colors = [
    style?.layout,
    style?.primary,
    ...(style?.candidates || []),
    ...fallbackColors,
  ].filter(Boolean)
  if (!background) return colors[0] || null

  const primary = style?.layout || style?.primary || colors[0]
  if (primary && (contrastRatio(primary, background) ?? Infinity) >= 3) return primary

  return colors.find((color) => (contrastRatio(color, background) ?? 0) >= 3) || primary || null
}

export function resolveRoleTextColor(template, role, tokens, slot = null) {
  const normalizedRole = normalizeSlotRole(role)
  const style = template?.colors?.text_styles?.[normalizedRole]
    || template?.colors?.text_styles?.default
    || template?.colors?.text_styles?.body
  const typoColor = slot?.typography?.color

  if (typoColor) return typoColor
  const readable = readableTextColor(style, template, [
    ...(normalizedRole === 'title' ? (tokens?.titleColors || []) : []),
    tokens?.defaultTextColor,
  ])
  if (readable) return readable
  if (normalizedRole === 'title') return tokens?.titleColors?.[0] || tokens?.defaultTextColor
  return tokens?.defaultTextColor || '#000000'
}

export function getRoleColorOptions(template, role, tokens) {
  const normalizedRole = normalizeSlotRole(role)
  const style = template?.colors?.text_styles?.[normalizedRole]
    || template?.colors?.text_styles?.default
    || template?.colors?.text_styles?.body
  const seen = new Set()
  const options = []
  for (const color of [
    readableTextColor(style, template, [
      ...(normalizedRole === 'title' ? (tokens?.titleColors || []) : []),
      tokens?.defaultTextColor,
    ]),
    style?.layout,
    style?.primary,
    ...(style?.candidates || []),
    ...(template?.colors?.text || []),
    ...(tokens?.titleColors || []),
    tokens?.defaultTextColor,
  ]) {
    if (!color || seen.has(color)) continue
    seen.add(color)
    options.push(color)
  }
  return options
}

export function typographyFromTemplateSlot(slot, template, tokens, role) {
  const normalizedRole = normalizeSlotRole(role || slot.role || slot.placeholder_type)
  const typo = slot?.typography || {}
  const style = template?.colors?.text_styles?.[normalizedRole]
  const color = resolveRoleTextColor(template, role, tokens, slot)
  const lineHeightRatio = typo.line_height_ratio
    ?? (typo.line_height_pt && typo.size_pt ? typo.line_height_pt / typo.size_pt : null)
    ?? (slot?.paragraph_spacing_pt?.line_spacing_ratio ?? 1.1)
  const sizePt = typo.size_pt || (normalizedRole === 'title' ? 32 : 14)

  return {
    family: typo.family || tokens?.defaultFontFamily || 'Arial',
    sizePt,
    lineHeightPt: lineHeightRatio ? Math.round(sizePt * lineHeightRatio * 100) / 100 : null,
    lineHeightRatio,
    bold: Boolean(typo.bold),
    color,
    role: normalizedRole,
    alignment: typo.alignment || 'l',
    maxSizePt: typo.size_pt || null,
    minSizePt: typo.size_pt ? Math.max(8, Math.round(typo.size_pt * 0.7)) : 8,
  }
}

export function findComponentPlacement(template) {
  const slot = getEditableSlot(template, 'content')
    || getEditableSlot(template, 'body')
    || getEditableSlots(template).slice(-1)[0]
  if (!slot) {
    return { x: 0.12, y: 0.18, width: 0.35, height: 0.22 }
  }
  const box = boxFromGeometry(slot.geometry_norm)
  return { x: box.x, y: box.y, width: box.width, height: box.height }
}

function placementKey(box) {
  if (!box) return ''
  const round = (value) => Math.round((value || 0) * 1000) / 1000
  return [round(box.x), round(box.y), round(box.width), round(box.height)].join(':')
}

function sortPlacements(left, right) {
  return (left.y - right.y) || (left.x - right.x)
}

export function buildTemplateContentRegion(template) {
  if (template?.contentRegion) return template.contentRegion

  const titleSlot = getEditableSlot(template, 'title') || getEditableSlots(template)[0]
  const titleBox = titleSlot
    ? boxFromGeometry(titleSlot.geometry_norm)
    : { x: 0.056, y: 0.101, width: 0.89, height: 0.094 }
  const margin = 0.018
  const y = Math.min(0.94, titleBox.y + titleBox.height + margin)

  return {
    x: titleBox.x,
    y,
    width: titleBox.width,
    height: Math.max(0.08, 0.96 - y),
  }
}

function boxFitsRegion(box, region) {
  if (!box || !region) return false
  const epsilon = 0.004
  return (
    box.x >= region.x - epsilon
    && box.y >= region.y - epsilon
    && box.x + box.width <= region.x + region.width + epsilon
    && box.y + box.height <= region.y + region.height + epsilon
  )
}

function normalizePlacementBox(container, component) {
  return {
    x: container?.x ?? 0.12,
    y: container?.y ?? 0.18,
    width: container?.width ?? component?.container?.width_norm ?? 0.35,
    height: container?.height ?? component?.container?.height_norm ?? 0.22,
  }
}

function computePeakSlideCount(component, template, contentRegion) {
  const pattern = component?.pattern
  const slideNumbers = new Set(template?.slide_numbers || [])
  const perSlide = new Map()

  for (const instance of pattern?.instances || []) {
    if (slideNumbers.size && !slideNumbers.has(instance.slide_number)) continue
    if (template?.layout_source && instance.layout_source && instance.layout_source !== template.layout_source) continue
    const box = normalizePlacementBox(instance.container, component)
    if (!boxFitsRegion(box, contentRegion)) continue
    perSlide.set(instance.slide_number, (perSlide.get(instance.slide_number) || 0) + 1)
  }

  if (!perSlide.size) return 0
  return Math.max(...perSlide.values())
}

export function getComponentPlacementProfile(component, template) {
  const contentRegion = buildTemplateContentRegion(template)
  const allowed = findAllowedComponent(template, component.id)
  if (allowed) {
    return {
      contentRegion,
      placements: allowed.placements || [],
      maxCount: allowed.max_count || 0,
      peakSlideCount: allowed.peak_slide_count || 0,
      allowed: (allowed.max_count || 0) > 0,
    }
  }

  const placements = listComponentPlacements(component, template, {
    contentRegion,
    requireInRegion: true,
    allowFallback: false,
  })
  const peakSlideCount = computePeakSlideCount(component, template, contentRegion)
  const maxCount = placements.length
    ? Math.min(placements.length, peakSlideCount || placements.length)
    : 0

  return {
    contentRegion,
    placements,
    maxCount,
    peakSlideCount,
    allowed: maxCount > 0,
  }
}

export function listComponentPlacements(component, template, options = {}) {
  const layout = template?.layout_source
  const pattern = component?.pattern
  const slideNumbers = new Set(template?.slide_numbers || [])
  const contentRegion = options.contentRegion || buildTemplateContentRegion(template)
  const requireInRegion = options.requireInRegion !== false
  const allowFallback = options.allowFallback === true
  const seen = new Set()
  const placements = []

  const pushPlacement = (container) => {
    if (!container) return
    const box = normalizePlacementBox(container, component)
    if (requireInRegion && !boxFitsRegion(box, contentRegion)) return
    const key = placementKey(box)
    if (seen.has(key)) return
    seen.add(key)
    placements.push(box)
  }

  if (pattern?.instances?.length) {
    for (const instance of pattern.instances) {
      if (layout && instance.layout_source && instance.layout_source !== layout) continue
      if (slideNumbers.size && instance.slide_number && !slideNumbers.has(instance.slide_number)) continue
      pushPlacement(instance.container)
    }
  }

  if (!placements.length && component?.frequency?.instances?.length) {
    for (const instance of component.frequency.instances) {
      if (layout && instance.layout_source && instance.layout_source !== layout) continue
      if (slideNumbers.size && instance.slide_number && !slideNumbers.has(instance.slide_number)) continue
      pushPlacement(instance.container || instance.bbox_norm)
    }
  }

  if (!placements.length && allowFallback) {
    pushPlacement(findPatternPlacement(pattern || component, template))
  }

  return placements.sort(sortPlacements)
}

export function fallbackComponentPlacement(template, component, index, contentRegion = null) {
  const region = contentRegion || buildTemplateContentRegion(template)
  const width = component?.container?.width_norm || 0.35
  const height = component?.container?.height_norm || 0.22
  const gap = 0.02
  const cols = Math.max(1, Math.floor((region.width - gap) / (width + gap)))
  const row = Math.floor(index / cols)
  const col = index % cols
  return {
    x: Math.min(region.x + region.width - width, region.x + col * (width + gap)),
    y: Math.min(region.y + region.height - height, region.y + row * (height + gap)),
    width,
    height,
  }
}

export function maxComponentCloneCount(component, template) {
  return getComponentPlacementProfile(component, template).maxCount
}

export function listAvailableComponents(report, template, tokens) {
  if (template?.allowed_components?.length) {
    return template.allowed_components
      .filter((entry) => (entry.max_count || 0) > 0)
      .map((entry) => ({
        source: 'registry',
        component: registryComponentFromAllowed(entry),
        profile: {
          contentRegion: template.contentRegion || buildTemplateContentRegion(template),
          placements: entry.placements || [],
          maxCount: entry.max_count || 0,
          peakSlideCount: entry.peak_slide_count || 0,
          allowed: (entry.max_count || 0) > 0,
        },
      }))
      .sort((left, right) => (
        right.profile.maxCount - left.profile.maxCount
        || left.component.label.localeCompare(right.component.label, 'ru')
      ))
  }

  const patterns = filterPatternsForTemplate(report?.slides?.patterns, template)
  const legacy = filterComponentsForTemplate(tokens?.components || [], template)
  const seen = new Set()
  const items = []

  patterns.forEach((pattern) => {
    const component = patternAsComponent(pattern)
    if (seen.has(component.id)) return
    const profile = getComponentPlacementProfile(component, template)
    if (!profile.allowed) return
    seen.add(component.id)
    items.push({ source: 'pattern', component, profile })
  })

  legacy.forEach((component) => {
    if (seen.has(component.id)) return
    const profile = getComponentPlacementProfile(component, template)
    if (!profile.allowed) return
    seen.add(component.id)
    items.push({ source: 'legacy', component, profile })
  })

  items.sort((left, right) => (
    right.profile.maxCount - left.profile.maxCount
    || (right.component.templateOverlap || 0) - (left.component.templateOverlap || 0)
    || (left.source === 'pattern' ? 0 : 1) - (right.source === 'pattern' ? 0 : 1)
    || (left.component.label || '').localeCompare(right.component.label || '', 'ru')
  ))

  return items
}

export function formatSlotBounds(bounds) {
  if (!bounds) return '—'
  const pct = (value) => `${Math.round(value * 1000) / 10}%`
  return `${pct(bounds.x)} · ${pct(bounds.y)} · ${pct(bounds.width)} × ${pct(bounds.height)}`
}

export function defaultContentForRole(role) {
  return DEFAULT_CONTENT[normalizeSlotRole(role)] || 'Текст'
}
