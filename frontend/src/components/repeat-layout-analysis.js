/** Repeat grids on one slide that share itemSig are often one component split by layout. */

export function normalizeClusterSignature(signature = '') {
  return String(signature)
    .replace(/c\((?:f|i)\{i\}\)/g, 'c({i})')
}

export function instanceSplitKey(instance, clusterSignature = '') {
  const cluster = normalizeClusterSignature(clusterSignature)
  if (!cluster) return null
  const keys = [instance?.repeat?.itemSig, instance?.signature]
    .filter(Boolean)
    .map(normalizeClusterSignature)
  return keys.includes(cluster) ? cluster : null
}

export function layoutSplitItemCount(instances = []) {
  return instances.reduce((sum, instance) => sum + Math.max(1, Number(instance.repeat?.count) || 1), 0)
}

export function childLayoutBoxes(children = []) {
  return children
    .map((child) => child?.bboxPt)
    .filter((box) => box?.width_pt && box?.height_pt)
}

export function areSideBySideChildColumns(group, children = []) {
  const boxes = childLayoutBoxes(children)
  if (boxes.length < 2) return false

  const parentWidth = group?.bboxPt?.width_pt || 0
  if (!parentWidth) return false

  const narrowCount = boxes.filter((box) => box.width_pt <= parentWidth * 0.75).length
  if (narrowCount < 2) return false

  const xSpan = Math.max(...boxes.map((box) => box.x_pt + box.width_pt))
    - Math.min(...boxes.map((box) => box.x_pt))
  const ySpan = Math.max(...boxes.map((box) => box.y_pt + box.height_pt))
    - Math.min(...boxes.map((box) => box.y_pt))

  return xSpan > Math.max(ySpan * 1.2, 1) && xSpan >= parentWidth * 0.55
}

export function areStackedFullWidthRows(group, children = []) {
  const boxes = childLayoutBoxes(children)
  if (boxes.length < 2) return false

  const parentWidth = group?.bboxPt?.width_pt || 0
  const parentHeight = group?.bboxPt?.height_pt || 0
  if (!parentWidth || !parentHeight) return false

  const fullWidthCount = boxes.filter((box) => box.width_pt >= parentWidth * 0.8).length
  if (fullWidthCount < 2) return false

  const xSpan = Math.max(...boxes.map((box) => box.x_pt + box.width_pt))
    - Math.min(...boxes.map((box) => box.x_pt))
  const ySpan = Math.max(...boxes.map((box) => box.y_pt + box.height_pt))
    - Math.min(...boxes.map((box) => box.y_pt))

  const verticallyStacked = ySpan >= parentHeight * 0.45
    && (ySpan > Math.max(xSpan * 1.2, 1) || fullWidthCount >= boxes.length)

  return verticallyStacked
}

export function resolvePageGridCellSignature(group, slideGroups = []) {
  const grid = group?.repeat?.grid
  const rows = Math.max(1, Number(grid?.rows) || 1)
  const cols = Math.max(1, Number(grid?.cols) || 1)
  if (rows < 2 || cols < 2) return null

  const directChildren = slideGroups.filter((item) => item.parentId === group.id)
  const repeatedRows = directChildren.filter((child) => (
    child.layout === 'row'
    && Number(child.repeat?.count) === cols
    && child.repeat?.itemSig
  ))
  if (repeatedRows.length < rows) return null

  const signatures = [...new Set(
    repeatedRows.map((child) => normalizeClusterSignature(child.repeat.itemSig)),
  )]
  return signatures.length === 1 ? signatures[0] : null
}

export function resolveGridRepeatMeta(group, slideGroups = []) {
  const grid = group?.repeat?.grid
  if (!grid) {
    return {
      itemCount: Math.max(1, Number(group?.repeat?.count) || 1),
      splitMode: 'series',
      rows: 1,
      cols: 1,
      cardCols: 1,
    }
  }

  const rows = Math.max(1, Number(grid.rows) || 1)
  const cols = Math.max(1, Number(grid.cols) || 1)
  const directChildren = slideGroups.filter((item) => item.parentId === group.id)
  const colChildCounts = directChildren.map((row) => (
    slideGroups.filter((child) => child.parentId === row.id).length
  ))
  const maxColChildren = colChildCounts.length ? Math.max(...colChildCounts) : 0
  const repeatedRowCellSignature = resolvePageGridCellSignature(group, slideGroups)

  // Page grid: each row holds `cols` independent cell groups (e.g. slide 16 cards).
  // Some decks do not produce a vgroup node for every cell. In that case each
  // direct row still exposes the same repeated itemSig and repeat count.
  if (cols > 1 && (maxColChildren >= cols || repeatedRowCellSignature)) {
    return {
      itemCount: rows * cols,
      splitMode: 'page_grid',
      rows,
      cols,
      cardCols: 1,
    }
  }

  // Horizontal columns: direct children sit side-by-side (slide 29 y[t12,t10] pairs).
  if (directChildren.length >= 2 && areSideBySideChildColumns(group, directChildren)) {
    return {
      itemCount: directChildren.length,
      splitMode: 'horizontal_series',
      rows: 1,
      cols: directChildren.length,
      cardCols: cols,
    }
  }

  // Vertical stack of full-width row cards (slide 20 GRID_MEDIA rows).
  if (directChildren.length >= 2 && areStackedFullWidthRows(group, directChildren)) {
    return {
      itemCount: directChildren.length,
      splitMode: 'row_card',
      rows: directChildren.length,
      cols: 1,
      cardCols: cols,
    }
  }

  // Ambiguous grid metadata without a clear repeat axis.
  if (rows > 1 && cols > 1) {
    return {
      itemCount: Math.max(rows, Number(group?.repeat?.count) || 1),
      splitMode: 'ambiguous_grid',
      rows,
      cols,
      cardCols: cols,
    }
  }

  // Row card fallback: one item bundles internal icon/text columns.
  return {
    itemCount: Math.max(rows, Number(group?.repeat?.count) || 1),
    splitMode: 'row_card',
    rows,
    cols: 1,
    cardCols: cols,
  }
}

export function enrichRepeatMeta(repeat, group, slideGroups = []) {
  if (!repeat) return null
  const meta = resolveGridRepeatMeta(group, slideGroups)
  const pageGridCellSignature = meta.splitMode === 'page_grid'
    ? resolvePageGridCellSignature(group, slideGroups)
    : null
  return {
    ...repeat,
    itemSig: pageGridCellSignature || repeat.itemSig,
    item_count: meta.itemCount,
    split_mode: meta.splitMode,
    card_cols: meta.cardCols,
    layout_rows: meta.rows,
    layout_cols: meta.cols,
  }
}

/** Playground item count: uses enriched repeat.item_count when present. */
export function resolveRepeatItemCount(repeat) {
  if (!repeat) return 1
  if (Number.isFinite(repeat.item_count) && repeat.item_count >= 1) {
    return repeat.item_count
  }
  const grid = repeat.grid
  if (Number.isFinite(grid?.rows) && Number.isFinite(grid?.cols) && grid.rows > 0 && grid.cols > 0) {
    return grid.rows * grid.cols
  }
  return Math.max(1, Number(repeat.count) || 1)
}

export function repeatClusterSignature(group) {
  return normalizeClusterSignature(group?.repeat?.itemSig || group?.signature || '')
}

export function groupHasRepeatOnSlide(group) {
  return Number(group?.repeat?.count) >= 2 || Boolean(group?.repeat?.grid)
}

export function boxesShareHorizontalBand(boxes = [], maxGapNorm = 0.04) {
  if (boxes.length < 2) return true

  const sorted = [...boxes].sort((left, right) => left.y - right.y)
  for (let index = 1; index < sorted.length; index += 1) {
    const previous = sorted[index - 1]
    const current = sorted[index]
    const gap = current.y - (previous.y + previous.height)
    const refHeight = Math.max(previous.height, current.height, 0.02)
    if (gap > Math.max(maxGapNorm, refHeight * 0.45)) return false
  }

  return true
}

export function boxesShareVerticalBand(boxes = [], maxGapNorm = 0.04) {
  if (boxes.length < 2) return true

  const sorted = [...boxes].sort((left, right) => left.x - right.x)
  for (let index = 1; index < sorted.length; index += 1) {
    const previous = sorted[index - 1]
    const current = sorted[index]
    const gap = current.x - (previous.x + previous.width)
    const refWidth = Math.max(previous.width, current.width, 0.02)
    if (gap > Math.max(maxGapNorm, refWidth * 0.45)) return false
  }

  return true
}

export function resolveRepeatFlowAxis(layout, repeat = null) {
  if (repeat?.grid) return repeat.grid.rows >= (repeat.grid.cols || 1) ? 'column' : 'row'
  if (layout === 'row') return 'row'
  if (layout === 'column') return 'column'
  if (layout === 'grid') return 'grid'
  return null
}

export function instancesShareRepeatAxis(instances = []) {
  if (instances.length < 2) return true

  const bySlide = new Map()
  for (const instance of instances) {
    if (!bySlide.has(instance.slide_number)) bySlide.set(instance.slide_number, [])
    bySlide.get(instance.slide_number).push(instance)
  }

  for (const slideInstances of bySlide.values()) {
    if (slideInstances.length < 2) continue

    const boxes = slideInstances
      .map((instance) => instance.container_norm)
      .filter((box) => box?.width && box?.height)
    if (boxes.length < 2) continue

    const axes = slideInstances.map((instance) => resolveRepeatFlowAxis(instance.layout, instance.repeat))
    const uniqueAxes = [...new Set(axes.filter(Boolean))]
    if (uniqueAxes.length !== 1) return false

    const axis = uniqueAxes[0]
    if (axis === 'row') {
      if (!boxesShareHorizontalBand(boxes)) return false
    } else if (axis === 'column') {
      if (!boxesShareVerticalBand(boxes)) return false
    } else {
      return false
    }
  }

  return true
}

export function hasSameSignaturePeersOnDifferentBands(group, slideGroups = []) {
  const signature = repeatClusterSignature(group)
  if (!signature) return false

  const peers = slideGroups.filter((peer) => (
    peer.id !== group.id
    && groupHasRepeatOnSlide(peer)
    && repeatClusterSignature(peer) === signature
  ))
  if (!peers.length) return false

  const pseudoInstances = [group, ...peers].map((item) => ({
    slide_number: 1,
    layout: item.layout,
    repeat: item.repeat,
    container_norm: item.bboxNorm,
  }))
  return !instancesShareRepeatAxis(pseudoInstances)
}

function signatureMatchesItemSig(groupSignature = '', itemSig = '') {
  const signature = normalizeClusterSignature(groupSignature)
  const item = normalizeClusterSignature(itemSig)
  if (!signature || !item) return false
  return signature === item || signature.includes(item) || item.includes(signature)
}

/** Repeat inside one column of a multi-column row (slide 29 g1.2.3). */
export function isRepeatRowSegmentFragment(group, slideGroups = []) {
  if (!groupHasRepeatOnSlide(group)) return false

  const parent = slideGroups.find((item) => item.id === group.parentId)
  if (!parent || parent.layout !== 'row') return false

  const siblings = slideGroups.filter((item) => item.parentId === parent.id)
  if (siblings.length < 3) return false

  const itemSig = group.repeat?.itemSig
  if (!itemSig) return false

  const peerSiblings = siblings.filter((sib) => (
    sib.id !== group.id
    && !groupHasRepeatOnSlide(sib)
    && signatureMatchesItemSig(sib.signature, itemSig)
  ))
  if (!peerSiblings.length) return false

  const parentWidth = parent.bboxNorm?.width || 0
  const groupWidth = group.bboxNorm?.width || 0
  if (!parentWidth || groupWidth >= parentWidth * 0.75) return false

  return true
}

export function shouldSkipRepeatRowSegmentFragment(group, slideGroups = []) {
  return isRepeatRowSegmentFragment(group, slideGroups)
}

function siblingIsMajorLayoutSection(sibling, group, slideGroups = []) {
  if (!sibling || sibling.id === group.id) return false

  const meta = resolveGridRepeatMeta(sibling, slideGroups)
  if (meta.splitMode === 'page_grid' && meta.itemCount >= 4) return true

  const grid = sibling.repeat?.grid
  if (grid && Math.max(1, Number(grid.rows) || 1) * Math.max(1, Number(grid.cols) || 1) >= 6) {
    return true
  }

  const groupArea = (group.bboxNorm?.width || 0) * (group.bboxNorm?.height || 0)
  const siblingArea = (sibling.bboxNorm?.width || 0) * (sibling.bboxNorm?.height || 0)
  return groupArea > 0 && siblingArea > groupArea * 2
}

/** Repeat band at the bottom/top of a multi-section column (slide 49 g1.2.2.2). */
export function isRepeatColumnSectionFragment(group, slideGroups = []) {
  if (!groupHasRepeatOnSlide(group)) return false

  const parent = slideGroups.find((item) => item.id === group.parentId)
  if (!parent || parent.layout !== 'column') return false

  const siblings = slideGroups.filter((item) => item.parentId === parent.id)
  if (siblings.length < 2) return false

  const parentHeight = parent.bboxNorm?.height || 0
  const groupHeight = group.bboxNorm?.height || 0
  if (!parentHeight || groupHeight >= parentHeight * 0.25) return false

  return siblings.some((sibling) => siblingIsMajorLayoutSection(sibling, group, slideGroups))
}

export function shouldSkipRepeatColumnSectionFragment(group, slideGroups = []) {
  return isRepeatColumnSectionFragment(group, slideGroups)
}

const REPEAT_CROSS_AXIS_SPREAD_MAX = 0.08
const REPEAT_LOCAL_SLOT_SPREAD_MAX = 0.07
const REPEAT_CONTAINER_TEXT_SPREAD_MAX = 0.14

export function collectRepeatItemGroups(group, slideGroups = []) {
  const meta = resolveGridRepeatMeta(group, slideGroups)
  const directChildren = slideGroups.filter((item) => item.parentId === group.id)

  if (meta.splitMode === 'page_grid') {
    const cells = directChildren.flatMap((row) => (
      slideGroups.filter((item) => item.parentId === row.id)
    ))
    if (cells.length >= 2) return cells
    // Direct children can be row wrappers rather than item groups. Without
    // cell nodes their text geometry must not be compared as if rows were cards.
    if (resolvePageGridCellSignature(group, slideGroups)) return [group]
    if (directChildren.length >= 2) return directChildren
  }

  if (directChildren.length >= 2) return directChildren
  return [group]
}

function textElementsForGroup(itemGroup) {
  return (itemGroup.elements || []).filter((element) => (
    element?.element_id && (element.kind === 'text' || element.kind === 'badge')
  ))
}

function inferTextRole(element, textElements = []) {
  const sorted = [...textElements].sort((left, right) => (
    (right.typography?.size_pt || 0) - (left.typography?.size_pt || 0)
  ))
  const index = sorted.findIndex((item) => item.element_id === element.element_id)
  if (index === 0) return 'heading'
  return 'body'
}

function textSlotPositionNorm(element, containerNorm) {
  const geometry = element.geometry_norm || {}
  if (!containerNorm?.width || !containerNorm?.height) return null
  return {
    cx: ((geometry.x || 0) + (geometry.width || 0) / 2 - containerNorm.x) / containerNorm.width,
    cy: ((geometry.y || 0) + (geometry.height || 0) / 2 - containerNorm.y) / containerNorm.height,
  }
}

function slotPointSpreadExceeds(rolePoints, maxSpread) {
  for (const points of rolePoints.values()) {
    if (points.length < 2) continue
    const cxSpread = Math.max(...points.map((point) => point.cx)) - Math.min(...points.map((point) => point.cx))
    const cySpread = Math.max(...points.map((point) => point.cy)) - Math.min(...points.map((point) => point.cy))
    if (cxSpread > maxSpread || cySpread > maxSpread) return true
  }
  return false
}

function hasLocalTextSlotSpread(itemGroups, maxSpread) {
  const rolePoints = new Map()

  for (const itemGroup of itemGroups) {
    const textElements = textElementsForGroup(itemGroup)
    const containerNorm = itemGroup.bboxNorm
    if (!containerNorm?.width) continue

    for (const element of textElements) {
      const role = inferTextRole(element, textElements)
      const position = textSlotPositionNorm(element, containerNorm)
      if (!position) continue
      if (!rolePoints.has(role)) rolePoints.set(role, [])
      rolePoints.get(role).push(position)
    }
  }

  return slotPointSpreadExceeds(rolePoints, maxSpread)
}

function hasContainerTextSlotSpread(group, itemGroups, axis, maxSpread) {
  const rolePoints = new Map()
  const containerNorm = group.bboxNorm
  if (!containerNorm?.width) return false

  for (const itemGroup of itemGroups) {
    const textElements = textElementsForGroup(itemGroup)
    for (const element of textElements) {
      const role = inferTextRole(element, textElements)
      const position = textSlotPositionNorm(element, containerNorm)
      if (!position) continue
      if (!rolePoints.has(role)) rolePoints.set(role, [])
      rolePoints.get(role).push(position)
    }
  }

  for (const points of rolePoints.values()) {
    if (points.length < 2) continue
    const spread = Math.max(...points.map((point) => point[axis])) - Math.min(...points.map((point) => point[axis]))
    if (spread > maxSpread) return true
  }

  return false
}

export function hasInconsistentRepeatSlotGeometry(group, slideGroups = []) {
  if (!groupHasRepeatOnSlide(group)) return false

  const meta = resolveGridRepeatMeta(group, slideGroups)
  const itemGroups = collectRepeatItemGroups(group, slideGroups)
  if (itemGroups.length < 2) return false

  const itemBoxes = childLayoutBoxes(itemGroups)
  if (itemBoxes.length >= 2) {
    const parentWidth = group.bboxPt?.width_pt || 1
    const parentHeight = group.bboxPt?.height_pt || 1
    const cxCenters = itemBoxes.map((box) => box.x_pt + box.width_pt / 2)
    const cyCenters = itemBoxes.map((box) => box.y_pt + box.height_pt / 2)
    const cxSpread = (Math.max(...cxCenters) - Math.min(...cxCenters)) / parentWidth
    const cySpread = (Math.max(...cyCenters) - Math.min(...cyCenters)) / parentHeight

    if (meta.splitMode === 'row_card' && cxSpread > REPEAT_CROSS_AXIS_SPREAD_MAX) return true
    if (meta.splitMode === 'horizontal_series' && cySpread > 0.35) return true
  }

  if (hasLocalTextSlotSpread(itemGroups, REPEAT_LOCAL_SLOT_SPREAD_MAX)) return true

  if (meta.splitMode === 'horizontal_series') {
    return hasContainerTextSlotSpread(group, itemGroups, 'cy', REPEAT_CONTAINER_TEXT_SPREAD_MAX)
  }
  if (meta.splitMode === 'row_card') {
    return hasContainerTextSlotSpread(group, itemGroups, 'cx', REPEAT_CONTAINER_TEXT_SPREAD_MAX)
  }

  return false
}

export function shouldSkipInconsistentRepeatSlotGeometry(group, slideGroups = []) {
  return hasInconsistentRepeatSlotGeometry(group, slideGroups)
}

export function hasValidRepeatFlexAxis(group) {
  if (!groupHasRepeatOnSlide(group)) return false
  if (group.repeat?.grid) return group.layout === 'grid'
  return group.layout === 'row' || group.layout === 'column'
}

export function instanceContainerPt(instance) {
  const container = instance?.container
  if (!container?.width_pt || !container?.height_pt) return null
  return {
    x_pt: container.x_pt || 0,
    y_pt: container.y_pt || 0,
    width_pt: container.width_pt,
    height_pt: container.height_pt,
  }
}

export function instanceContainerNorm(instance) {
  const container = instance?.container_norm
  if (!container?.width || !container?.height) return null
  return {
    x: container.x || 0,
    y: container.y || 0,
    width: container.width,
    height: container.height,
  }
}

export function unionBoxesPt(boxes = []) {
  const items = (boxes || []).filter(Boolean)
  if (!items.length) return null
  const x = Math.min(...items.map((box) => box.x_pt))
  const y = Math.min(...items.map((box) => box.y_pt))
  const right = Math.max(...items.map((box) => box.x_pt + box.width_pt))
  const bottom = Math.max(...items.map((box) => box.y_pt + box.height_pt))
  return {
    x_pt: x,
    y_pt: y,
    width_pt: right - x,
    height_pt: bottom - y,
  }
}

export function unionBoxesNorm(boxes = []) {
  const items = (boxes || []).filter(Boolean)
  if (!items.length) return null
  const x = Math.min(...items.map((box) => box.x))
  const y = Math.min(...items.map((box) => box.y))
  const right = Math.max(...items.map((box) => box.x + box.width))
  const bottom = Math.max(...items.map((box) => box.y + box.height))
  return {
    x,
    y,
    width: right - x,
    height: bottom - y,
  }
}

export function unionInstanceContainersPt(instances = []) {
  return unionBoxesPt(instances.map(instanceContainerPt).filter(Boolean))
}

export function unionInstanceContainersNorm(instances = []) {
  return unionBoxesNorm(instances.map(instanceContainerNorm).filter(Boolean))
}

function elementBBoxPt(element, slideSizePt) {
  const geometry = element?.geometry_norm
  if (!geometry?.width || !slideSizePt?.width) return null
  return {
    x_pt: (geometry.x || 0) * slideSizePt.width,
    y_pt: (geometry.y || 0) * slideSizePt.height,
    width_pt: (geometry.width || 0) * slideSizePt.width,
    height_pt: (geometry.height || 0) * slideSizePt.height,
  }
}

function elementBBoxNorm(element) {
  const geometry = element?.geometry_norm
  if (!geometry?.width) return null
  return {
    x: geometry.x || 0,
    y: geometry.y || 0,
    width: geometry.width || 0,
    height: geometry.height || 0,
  }
}

function isVerticallyStackedBoxesPt(boxes = []) {
  if (boxes.length < 2) return false
  const yCenters = boxes.map((box) => box.y_pt + box.height_pt / 2)
  const xCenters = boxes.map((box) => box.x_pt + box.width_pt / 2)
  const ySpread = Math.max(...yCenters) - Math.min(...yCenters)
  const xSpread = Math.max(...xCenters) - Math.min(...xCenters)
  return ySpread > Math.max(xSpread * 0.35, 4)
}

function repeatItemsAreVerticallyStacked(group, slideGroups, boxes = []) {
  if (boxes.length < 2) return false
  if (resolveRepeatFlowAxis(group.layout, group.repeat) === 'column') return true
  const meta = resolveGridRepeatMeta(group, slideGroups)
  if (meta.splitMode === 'row_card') return true
  return isVerticallyStackedBoxesPt(boxes)
}

export function isVerticalRepeatFlow(group, slideGroups = []) {
  if (!group?.repeat?.count || Number(group.repeat.count) < 2) return false
  const meta = resolveGridRepeatMeta(group, slideGroups)
  const axis = resolveRepeatFlowAxis(group.layout, group.repeat)
  if (axis === 'column' || meta.splitMode === 'row_card') return true
  const itemGroups = collectRepeatItemGroups(group, slideGroups)
  return areStackedFullWidthRows(group, itemGroups)
}

export function resolveVerticalRepeatItems(group, slideGroups = [], slide = null) {
  if (!group?.repeat?.count || Number(group.repeat.count) < 2) return null
  if (!isVerticalRepeatFlow(group, slideGroups)) return null

  const itemGroups = collectRepeatItemGroups(group, slideGroups)
  const childBoxes = childLayoutBoxes(itemGroups)
  if (childBoxes.length >= 2 && repeatItemsAreVerticallyStacked(group, slideGroups, childBoxes)) {
    return {
      items: itemGroups.map((itemGroup) => ({
        vgroup_id: itemGroup.id,
        bboxPt: itemGroup.bboxPt,
        bboxNorm: itemGroup.bboxNorm,
        elements: (itemGroup.elements || []).filter((element) => element?.element_id),
      })),
      source: 'child_vgroups',
    }
  }

  if (!slide) return null
  const count = Math.max(2, Number(group.repeat?.count) || 1)
  const elements = (group.elements || []).filter((element) => element?.element_id && element.kind !== 'fill')
  if (elements.length < count) return null

  const slideSizePt = slide.render?.slide_size_pt || { width: 960, height: 540 }
  const perItem = Math.max(1, Math.ceil(elements.length / count))
  const items = []

  for (let index = 0; index < count; index += 1) {
    const chunk = elements.slice(index * perItem, (index + 1) * perItem)
    if (!chunk.length) continue
    const boxesPt = chunk.map((element) => elementBBoxPt(element, slideSizePt)).filter(Boolean)
    const boxesNorm = chunk.map((element) => elementBBoxNorm(element)).filter(Boolean)
    const bboxPt = unionBoxesPt(boxesPt)
    const bboxNorm = unionBoxesNorm(boxesNorm)
    if (!bboxPt || !bboxNorm) continue
    items.push({
      vgroup_id: `${group.id}#${index + 1}`,
      bboxPt,
      bboxNorm,
      elements: chunk,
    })
  }

  if (items.length < 2 || !repeatItemsAreVerticallyStacked(group, slideGroups, items.map((item) => item.bboxPt))) {
    return null
  }

  return { items, source: 'flat_element_groups' }
}

export function resolveVerticalRepeatContainerBBox(group, slideGroups = [], slide = null) {
  const resolved = resolveVerticalRepeatItems(group, slideGroups, slide)
  if (!resolved?.items?.length) return null
  const boxesPt = resolved.items.map((item) => item.bboxPt).filter(Boolean)
  const boxesNorm = resolved.items.map((item) => item.bboxNorm).filter(Boolean)
  if (boxesPt.length < 2) return null
  return {
    bboxPt: unionBoxesPt(boxesPt),
    bboxNorm: unionBoxesNorm(boxesNorm),
    itemCount: resolved.items.length,
    source: resolved.source,
  }
}

export function enrichLayoutSplitsWithContainers(instances = [], splits = []) {
  return splits.map((split) => {
    const splitInstances = instances.filter((item) => split.vgroup_ids?.includes(item.vgroup_id))
    return {
      ...split,
      container: unionInstanceContainersPt(splitInstances),
      container_norm: unionInstanceContainersNorm(splitInstances),
    }
  })
}

export function groupRepeatGridsByItemSig(groups = []) {
  const bySig = new Map()
  for (const group of groups) {
    const itemSig = group.repeat?.itemSig
    if (!itemSig) continue
    if (!bySig.has(itemSig)) bySig.set(itemSig, [])
    bySig.get(itemSig).push(group)
  }
  return bySig
}

export function effectiveRepeatItemCount(groups = []) {
  return groups.reduce((sum, group) => sum + Math.max(1, Number(group.repeat?.count) || 1), 0)
}

export function detectLayoutSplitsFromInstances(instances = [], clusterSignature = '') {
  const cluster = normalizeClusterSignature(clusterSignature)
  if (!cluster) return []

  const bySlide = new Map()
  for (const instance of instances) {
    if (!instanceSplitKey(instance, cluster)) continue
    if (!bySlide.has(instance.slide_number)) bySlide.set(instance.slide_number, [])
    bySlide.get(instance.slide_number).push(instance)
  }

  const splits = []
  for (const [slideNumber, slideInstances] of bySlide) {
    if (slideInstances.length < 2) continue
    if (!instancesShareRepeatAxis(slideInstances)) continue
    splits.push({
      slide_number: slideNumber,
      item_sig: cluster,
      vgroup_ids: slideInstances.map((item) => item.vgroup_id).filter(Boolean),
      grid_count: slideInstances.filter((item) => item.repeat?.grid).length,
      item_count: layoutSplitItemCount(slideInstances),
      layout_split: true,
    })
  }
  return enrichLayoutSplitsWithContainers(instances, splits)
}

export function analyzeSlideRepeatSplits(groups = []) {
  const bySig = groupRepeatGridsByItemSig(groups)
  const splits = []

  for (const [itemSig, repeatGroups] of bySig) {
    if (repeatGroups.length < 2) continue
    splits.push({
      itemSig,
      groupIds: repeatGroups.map((group) => group.id),
      itemCount: effectiveRepeatItemCount(repeatGroups),
      grids: repeatGroups.map((group) => ({
        id: group.id,
        count: group.repeat?.count || 1,
        grid: group.repeat?.grid || null,
      })),
      layoutSplit: true,
    })
  }

  return splits.sort((left, right) => right.itemCount - left.itemCount || left.itemSig.localeCompare(right.itemSig))
}

export function findLayoutSplitForSlide(layoutSplits = [], slideNumber, vgroupId = null) {
  return (layoutSplits || []).find((split) => (
    split.slide_number === slideNumber
    && (!vgroupId || split.vgroup_ids?.includes(vgroupId))
  )) || null
}

export function findLayoutSplitForInstance(component, instance) {
  if (!instance) return null
  const layoutSplits = component?.raw?.layout_splits || component?.layout_splits || []
  return layoutSplits.find((split) => (
    split.slide_number === instance.slide_number
    && split.vgroup_ids?.some((id) => (
      instance.vgroup_id === id
      || instance.vgroup_id?.startsWith(`${id}.`)
      || id?.startsWith(`${instance.vgroup_id}.`)
    ))
  )) || null
}

const MIN_INNER_REPEAT_DEPTH_DELTA = 3
const MIN_INNER_REPEAT_CLUSTERS = 2

function vgroupDepth(group) {
  return group?.depth || group?.id?.split('.').length || 1
}

export function findDeepInnerRepeatGroups(group, slideGroups = [], minDepthDelta = MIN_INNER_REPEAT_DEPTH_DELTA) {
  if (!group?.id) return []
  const parentDepth = vgroupDepth(group)
  return slideGroups.filter((item) => (
    item.id.startsWith(`${group.id}.`)
    && Number(item.repeat?.count) >= 2
    && vgroupDepth(item) >= parentDepth + minDepthDelta
  ))
}

export function shouldSkipOuterRepeatWithInnerRepeats(group, slideGroups = []) {
  return findDeepInnerRepeatGroups(group, slideGroups).length >= MIN_INNER_REPEAT_CLUSTERS
}

export function shouldSkipAmbiguousGridRepeat(group, slideGroups = []) {
  if (!group?.repeat?.grid) return false
  return resolveGridRepeatMeta(group, slideGroups).splitMode === 'ambiguous_grid'
}
