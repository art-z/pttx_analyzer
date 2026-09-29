/**
 * Flex stacking for slide catalog elements.
 * Used for split text groups today; same primitive will serve tables and repeaters.
 */

export function buildRenderQueue(contentElements) {
  const sorted = [...contentElements].sort((left, right) => (left.z_index || 0) - (right.z_index || 0))
  const renderedGroups = new Set()
  const queue = []

  for (const element of sorted) {
    const groupId = element.text_group_id
    if (groupId) {
      if (renderedGroups.has(groupId)) continue
      renderedGroups.add(groupId)
      const members = sorted
        .filter((item) => item.text_group_id === groupId)
        .sort((left, right) => (left.text_line_index ?? 0) - (right.text_line_index ?? 0))
      queue.push({
        kind: 'flex_stack',
        layout: resolveFlexStackDirection(members),
        members,
        zIndex: element.z_index ?? 0,
        anchor: element,
      })
      continue
    }
    queue.push({ kind: 'element', element })
  }

  return queue
}

export function stackGeometryNorm(members) {
  const anchor = members[0]
  if (anchor?.text_group_geometry_norm) return anchor.text_group_geometry_norm
  return unionGeometryNorm(members.map((member) => member.geometry_norm))
}

export function unionGeometryNorm(geometries) {
  const items = (geometries || []).filter(Boolean)
  if (!items.length) return { x: 0, y: 0, width: 0, height: 0 }
  const x = Math.min(...items.map((item) => item.x || 0))
  const y = Math.min(...items.map((item) => item.y || 0))
  const right = Math.max(...items.map((item) => (item.x || 0) + (item.width || 0)))
  const bottom = Math.max(...items.map((item) => (item.y || 0) + (item.height || 0)))
  return {
    x,
    y,
    width: Math.max(0, right - x),
    height: Math.max(0, bottom - y),
  }
}

export function resolveTextGroupLineGapPt(members) {
  if (!members || members.length < 2) return 0
  const spacing = members[0]?.text_group_spacing_pt
  const direction = resolveFlexStackDirection(members)
  const gap = direction === 'row' ? spacing?.item_gap_pt : spacing?.line_gap_pt
  if (gap != null) {
    return Math.max(0, Number(gap))
  }
  return 0
}

export function resolveFlexStackDirection(members) {
  return members?.[0]?.text_group_spacing_pt?.flex_stack_direction === 'row' ? 'row' : 'column'
}

export function flexStackItemWidthPercent(element, geometry, direction = 'column') {
  if (direction !== 'row') return 100
  const itemWidth = element?.geometry_norm?.width || 0
  const groupWidth = geometry?.width || 0
  if (!itemWidth || !groupWidth) return 50
  return Math.max(1, Math.min(100, (itemWidth / groupWidth) * 100))
}

export function resolveFlexStackAlignItems(members) {
  const explicit = members?.[0]?.text_group_spacing_pt?.flex_stack_align_items
  if (explicit) return explicit
  const alignment = members?.[0]?.typography?.alignment
    || members?.[0]?.alignment
    || 'l'
  return textAlignToFlexAlign(alignment)
}

/** Centered split metric stacks: skip txBody insets and tight PPTX lnSpc in flex layout. */
export function flexStackUsesCompactDisplayLayout(members) {
  const anchor = members?.[0]
  if (!anchor?.split_from_shape || (members?.length ?? 0) < 2) return false
  if (anchor.vertical_anchor !== 'ctr') return false
  return anchor.text_group_spacing_pt?.flex_stack_layout === 'compact_display'
}

export function resolveFlexStackBodyInsetsPt(members) {
  if (flexStackUsesCompactDisplayLayout(members)) return null
  return members?.[0]?.body_insets_pt ?? null
}

export function applyFlexStackLineHeight(node, element, options = {}) {
  if (!node || !element) return
  if (options.compactDisplayLayout) {
    const ratio = options.lineHeightRatio
    node.style.lineHeight = ratio != null ? String(ratio) : '1'
    return
  }
  const groupSpacing = element?.text_group_spacing_pt
  const groupRatio = groupSpacing?.render_line_height_ratio
  if (groupRatio != null) {
    node.style.lineHeight = String(groupRatio)
    return
  }
  const spacing = element.paragraph_spacing_pt || {}
  const ratio = Number(spacing.line_spacing_ratio)
  if (spacing.line_height_applicable === false && Number.isFinite(ratio) && ratio > 0 && ratio < 1.5) {
    node.style.lineHeight = String(ratio)
    return
  }
  node.style.lineHeight = '1'
}

export function mountFlexStack(container, geometry, options = {}) {
  const node = document.createElement('div')
  node.className = options.className || 'catalog-flex-stack'
  node.style.position = 'absolute'
  node.style.boxSizing = 'border-box'
  node.style.pointerEvents = options.pointerEvents ?? 'none'
  node.style.zIndex = String(options.zIndex ?? 0)
  node.style.display = 'flex'
  node.style.flexDirection = options.direction || 'column'
  node.style.alignItems = options.alignItems || 'stretch'
  node.style.justifyContent = options.justifyContent || 'flex-start'
  node.style.height = 'auto'
  node.style.overflow = 'visible'

  const geom = geometry || {}
  node.style.left = `${(geom.x || 0) * 100}%`
  node.style.top = `${(geom.y || 0) * 100}%`
  node.style.width = `${(geom.width || 0) * 100}%`
  node.style.maxWidth = `${(geom.width || 0) * 100}%`
  if (options.fillHeight && geom.height) {
    node.style.height = `${geom.height * 100}%`
  }

  if (options.title) node.title = options.title
  if (options.dataset) {
    for (const [key, value] of Object.entries(options.dataset)) {
      node.dataset[key] = value
    }
  }

  container.append(node)
  return node
}

export function textAlignToFlexAlign(alignment) {
  if (alignment === 'ctr') return 'center'
  if (alignment === 'r') return 'flex-end'
  return 'flex-start'
}

export function verticalAnchorToJustifyContent(anchor) {
  const value = String(anchor ?? '').trim().toLowerCase()
  if (['ctr', 'middle', 'center', 'centre', 'c', 'm', 'mid'].includes(value)) return 'center'
  if (['b', 'bottom'].includes(value)) return 'flex-end'
  return 'flex-start'
}

export function applyTextAlignment(node, alignment) {
  if (!node) return
  if (alignment === 'ctr') node.style.textAlign = 'center'
  else if (alignment === 'r') node.style.textAlign = 'right'
  else if (alignment === 'just') node.style.textAlign = 'justify'
  else node.style.textAlign = 'left'
}

export function applyTextBoxLayout(node, verticalAnchor, alignment) {
  if (!node) return
  const anchor = verticalAnchor || 't'
  const align = alignment || 'l'
  const needsFlex = anchor !== 't' || align === 'ctr' || align === 'r'
  if (!needsFlex) return

  node.style.display = 'flex'
  node.style.flexDirection = 'column'
  node.style.justifyContent = verticalAnchorToJustifyContent(anchor)
  node.style.alignItems = textAlignToFlexAlign(align)
  node.style.width = node.style.width || '100%'
  node.style.boxSizing = 'border-box'
}

export function applyVerticalTextAnchor(node, anchor, alignment = null) {
  if (!node) return
  if (alignment != null) {
    applyTextBoxLayout(node, anchor, alignment)
    return
  }
  if (!anchor || anchor === 't') return
  applyTextBoxLayout(node, anchor, 'l')
}

/** PPTX text boxes wrap by default; only explicit line breaks need pre-wrap; wrap="none" never wraps. */
export function resolveTextWhiteSpace(text, wrap = null) {
  if (String(wrap ?? '').trim().toLowerCase() === 'none') return 'pre'
  return (text || '').includes('\n') ? 'pre-wrap' : 'normal'
}
