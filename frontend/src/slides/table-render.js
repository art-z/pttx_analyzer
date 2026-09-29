import { verticalAnchorToJustifyContent } from './flex-layout.js'
import { applyFillStyle, strokeColorCss, typographyColorCss } from './fill-styles.js'
import { applyParagraphSpacingPt, ptToSlideCqh, ptToSlideCqw, slideHeightPt, slideWidthPt } from './slide-metrics.js'
import { populateTextLineContent, stripBulletPlaceholder, usesBulletRowLayout } from './text-list.js'
import { cellHasVisibleText, isBlankStubCell } from '../components/table-style-pattern.js'

function normalizeHexColor(value) {
  if (!value) return null
  const cleaned = String(value).trim().toUpperCase()
  const hex = cleaned.startsWith('#') ? cleaned : `#${cleaned}`
  return /^#[0-9A-F]{6}$/.test(hex) ? hex : null
}

export function resolveTableTextColor(tokens, styleTokens = {}, { typography = null, tokenKey = null, isHeader = false } = {}) {
  if (typography?.color) {
    const withAlpha = typographyColorCss(typography)
    if (withAlpha) return withAlpha
    const normalizedExplicit = normalizeHexColor(typography.color)
    if (normalizedExplicit) return normalizedExplicit
  }

  const candidates = [
    tokenKey && styleTokens[tokenKey]?.typography?.color,
    tokenKey && styleTokens[tokenKey]?.color,
    styleTokens.body_cell?.typography?.color,
    styleTokens.header_cell?.typography?.color,
    tokens?.bodyTypographyOptions?.[0]?.color,
    tokens?.defaultTextColor,
    tokens?.themeColors?.dk1,
    tokens?.themeColors?.tx1,
    '#17212D',
  ]
  for (const candidate of candidates) {
    const normalized = normalizeHexColor(candidate)
    if (normalized) return normalized
  }
  return '#17212D'
}

function firstFinitePositive(values) {
  for (const value of values) {
    const number = Number(value)
    if (Number.isFinite(number) && number > 0) return number
  }
  return null
}

export function resolveTableTextSizePt(tokens, styleTokens = {}, { typography = null, tokenKey = null, isHeader = false } = {}) {
  return firstFinitePositive([
    typography?.size_pt,
    typography?.sizePt,
    tokenKey && styleTokens[tokenKey]?.typography?.size_pt,
    tokenKey && styleTokens[tokenKey]?.typography?.sizePt,
    isHeader && styleTokens.header_cell?.typography?.size_pt,
    styleTokens.body_cell?.typography?.size_pt,
    styleTokens.whole_cell?.typography?.size_pt,
    tokens?.bodyTypographyOptions?.[0]?.sizePt,
    tokens?.bodyTypography?.sizePt,
    14,
  ])
}

function tableDimensions(element) {
  const tableMeta = element.table || {}
  const preview = element.preview || tableMeta.data_preview?.rows || []
  const rowCount = element.rows
    || tableMeta.content_model?.rows
    || tableMeta.row_heights_pt?.length
    || preview.length
    || 1
  const colCount = element.cols
    || tableMeta.content_model?.columns
    || tableMeta.column_widths_pt?.length
    || preview[0]?.length
    || 1
  return { rowCount, colCount, preview }
}

export function buildTableMatrix(element) {
  const { rowCount, colCount, preview } = tableDimensions(element)
  return Array.from({ length: rowCount }, (_, rowIndex) => {
    const previewRow = preview[rowIndex] || []
    return Array.from({ length: colCount }, (_, colIndex) => previewRow[colIndex] ?? '')
  })
}

function tableStructureFlags(tableMeta, rowCount, colCount) {
  const flags = { ...(tableMeta.structure?.flags || {}) }
  const rules = tableMeta.style_rules || {}
  const tokens = tableMeta.style_tokens || {}

  if (tableMeta.structure?.header_row != null) {
    flags.first_row = true
  }
  if (rules.firstRow || tokens.first_row_cell || tokens.header_cell) {
    flags.first_row = flags.first_row ?? true
  }
  if (rules.firstCol || tokens.first_col_cell) {
    flags.first_col = true
  }
  if (rules.lastCol || tokens.last_col_cell) {
    flags.last_col = true
  }
  if (rules.lastRow || tokens.last_row_cell) {
    flags.last_row = true
  }
  if (rules.band1H || rules.band2H || tokens.band1_row_cell || tokens.band2_row_cell) {
    flags.band_row = true
  }
  if (rules.band1V || rules.band2V || tokens.band1_col_cell || tokens.band2_col_cell) {
    flags.band_col = true
  }

  if (flags.last_row == null && rowCount > 0) {
    flags.last_row = false
  }
  if (flags.last_col == null && colCount > 0) {
    flags.last_col = false
  }

  return flags
}

function cellStylePartNames(flags, row, col, rowCount, colCount) {
  const isFirstRow = flags.first_row && row === 0
  const isLastRow = flags.last_row && row === rowCount - 1
  const isFirstCol = flags.first_col && col === 0
  const isLastCol = flags.last_col && col === colCount - 1
  const parts = []

  if (isFirstRow && isFirstCol) parts.push('nwCell')
  if (isFirstRow && isLastCol) parts.push('neCell')
  if (isLastRow && isFirstCol) parts.push('swCell')
  if (isLastRow && isLastCol) parts.push('seCell')
  if (isFirstRow) parts.push('firstRow')
  if (isLastRow) parts.push('lastRow')
  if (isFirstCol) parts.push('firstCol')
  if (isLastCol) parts.push('lastCol')
  if (flags.band_row && !isFirstRow && !isLastRow) {
    const ordinal = row - (flags.first_row ? 1 : 0)
    parts.push(ordinal % 2 ? 'band2H' : 'band1H')
  }
  if (flags.band_col && !isFirstCol && !isLastCol) {
    const ordinal = col - (flags.first_col ? 1 : 0)
    parts.push(ordinal % 2 ? 'band2V' : 'band1V')
  }
  parts.push('wholeTbl')
  return parts
}

function mergeCellStyles(base, overlay) {
  if (!overlay) return { ...(base || {}) }
  const result = { ...(base || {}) }
  for (const [key, value] of Object.entries(overlay)) {
    if (!value) continue
    if (key === 'borders' && typeof value === 'object') {
      const merged = { ...(result.borders || {}) }
      for (const [side, stroke] of Object.entries(value)) {
        if (isInvisibleTableBorder(stroke)) {
          merged[side] = {
            width_pt: 0,
            color: { kind: 'none', alpha: 0 },
            visible: false,
          }
        } else {
          merged[side] = stroke
        }
      }
      if (Object.keys(merged).length) {
        result.borders = merged
      } else {
        delete result.borders
      }
    } else {
      result[key] = value
    }
  }
  return result
}

function resolveCellStyleFromRules(tableMeta, rowIndex, colIndex, rowCount, colCount) {
  const rules = tableMeta.style_rules || {}
  if (!Object.keys(rules).length) return null

  const flags = tableStructureFlags(tableMeta, rowCount, colCount)
  const applicable = new Set(cellStylePartNames(flags, rowIndex, colIndex, rowCount, colCount))
  const mergeOrder = [
    'wholeTbl',
    'band1H',
    'band2H',
    'band1V',
    'band2V',
    'firstRow',
    'lastRow',
    'firstCol',
    'lastCol',
    'nwCell',
    'neCell',
    'swCell',
    'seCell',
  ]
  let merged = null
  for (const partName of mergeOrder) {
    if (!applicable.has(partName)) continue
    const partStyle = rules[partName]
    if (partStyle) {
      merged = mergeCellStyles(merged, partStyle)
    }
  }
  return merged && Object.keys(merged).length ? merged : null
}

function resolveCellStyleLegacy(tableMeta, rowIndex, colIndex, rowCount, colCount) {
  const tokens = tableMeta.style_tokens || {}
  const flags = tableStructureFlags(tableMeta, rowCount, colCount)
  const headerRow = tableMeta.structure?.header_row

  if (headerRow != null && rowIndex === headerRow) {
    return tokens.header_cell || tokens.first_row_cell || tokens.body_cell
  }
  if (flags.first_col && colIndex === 0) {
    return tokens.first_col_cell || tokens.body_cell || tokens.whole_cell
  }
  if (flags.last_col && colIndex === colCount - 1) {
    return tokens.last_col_cell || tokens.body_cell || tokens.whole_cell
  }
  if (flags.band_row) {
    const bandStart = flags.first_row ? 1 : 0
    if (rowIndex >= bandStart) {
      const ordinal = rowIndex - bandStart
      return (ordinal % 2 ? tokens.band2_row_cell : tokens.band1_row_cell)
        || tokens.body_cell
        || tokens.whole_cell
    }
  }
  return tokens.body_cell || tokens.whole_cell || tokens.header_cell
}

function mergeAnchorCol(mergedCells, rowIndex, colIndex) {
  for (const merge of mergedCells || []) {
    const row = merge.row ?? 0
    const col = merge.col ?? 0
    const rowSpan = merge.row_span || 1
    const colSpan = merge.col_span || 1
    if (rowIndex < row || rowIndex >= row + rowSpan) continue
    if (colIndex < col || colIndex >= col + colSpan) continue
    if (rowIndex === row && colIndex === col) return null
    return col
  }
  return null
}

function findMergeAt(mergedCells, rowIndex, colIndex) {
  for (const merge of mergedCells || []) {
    const row = merge.row ?? 0
    const col = merge.col ?? 0
    const colSpan = merge.col_span || 1
    if (rowIndex !== row) continue
    if (colIndex < col || colIndex >= col + colSpan) continue
    return {
      merge,
      isAnchor: colIndex === col,
      colSpan,
      anchorCol: col,
      lastCol: col + colSpan - 1,
    }
  }
  return null
}

function previousFilledCol(previewRow, colIndex) {
  if (colIndex <= 0 || !previewRow?.length) return null
  for (let col = colIndex - 1; col >= 0; col -= 1) {
    if (String(previewRow[col] ?? '').trim()) return col
  }
  return null
}

function styleAnchorCol(tableMeta, rowIndex, colIndex, previewRow) {
  const fromMerge = mergeAnchorCol(tableMeta.structure?.merged_cells, rowIndex, colIndex)
  if (fromMerge != null) return fromMerge

  const direct = tableMeta.cell_styles?.[rowIndex]?.[colIndex]
  if (direct || colIndex <= 0) return null
  if (String(previewRow?.[colIndex] ?? '').trim()) return null
  return previousFilledCol(previewRow, colIndex)
}

function resolveCellStyleCore(element, rowIndex, colIndex, rowCount, colCount) {
  const tableMeta = element.table || {}
  const styleGrid = tableMeta.cell_styles
  const direct = styleGrid?.[rowIndex]?.[colIndex]
  const fromRules = resolveCellStyleFromRules(tableMeta, rowIndex, colIndex, rowCount, colCount)
  const legacy = resolveCellStyleLegacy(tableMeta, rowIndex, colIndex, rowCount, colCount)

  if (direct) return direct
  if (fromRules) return fromRules
  return legacy
}

function resolveCellStyle(element, rowIndex, colIndex, rowCount, colCount, previewRow) {
  const tableMeta = element.table || {}
  const anchorCol = styleAnchorCol(tableMeta, rowIndex, colIndex, previewRow)
  if (anchorCol != null && anchorCol !== colIndex) {
    return resolveCellStyleCore(element, rowIndex, anchorCol, rowCount, colCount)
  }
  return resolveCellStyleCore(element, rowIndex, colIndex, rowCount, colCount)
}

function columnWeightsForCount(designWeights, colCount) {
  if (colCount <= 0) return [1]
  if (!designWeights?.length) {
    return Array.from({ length: colCount }, () => 1)
  }

  if (colCount <= designWeights.length) {
    return designWeights.slice(0, colCount)
  }

  const averageWeight = designWeights.reduce((sum, value) => sum + (value || 0), 0) / designWeights.length
  return [
    ...designWeights,
    ...Array.from({ length: colCount - designWeights.length }, () => averageWeight || 1),
  ]
}

export function resolveTableLayoutWidthPt(element) {
  const tableMeta = element.table || {}
  const designWidth = tableMeta.layout_width_pt
  if (designWidth) return designWidth

  const colWidths = tableMeta.column_widths_pt || []
  const colSum = colWidths.reduce((sum, value) => sum + (value || 0), 0)
  return colSum || element.geometry_pt?.width_pt || 0
}

/** Layout height after backend reconciliation (grid/content vs PPTX frame). */
export function resolveTableDesignHeightPt(element) {
  const tableMeta = element.table || {}
  const layoutHeight = tableMeta.layout_height_pt
  if (layoutHeight > 0) return layoutHeight
  const shapeHeight = element.geometry_pt?.height_pt ?? tableMeta.max_height_pt ?? null
  return shapeHeight > 0 ? shapeHeight : null
}

function resolveTableContentAreaHeightPt(element, slideSizePt) {
  const tableMeta = element.table || {}
  const slideHeight = slideHeightPt(slideSizePt)
  if (!slideHeight) return null

  const bottomMarginPt = tableMeta.content_bottom_margin_pt
  const yPt = element.geometry_pt?.y_pt
  const yNorm = element.geometry_norm?.y

  if (bottomMarginPt != null) {
    const topPt = typeof yPt === 'number'
      ? yPt
      : typeof yNorm === 'number'
        ? yNorm * slideHeight
        : 0
    return Math.max(slideHeight - topPt - bottomMarginPt, 0)
  }

  if (typeof yNorm === 'number') {
    const bottomNorm = tableMeta.content_bottom_margin_norm
    const bottomEdge = typeof bottomNorm === 'number' ? 1 - bottomNorm : 1
    return Math.max(slideHeight * (bottomEdge - yNorm), 0)
  }

  if (typeof yPt === 'number') {
    return Math.max(slideHeight - yPt, 0)
  }

  return tableMeta.available_height_pt || null
}

/** Max render height: PPTX frame first; content safe area only when frame height is missing. */
function resolveTableMaxHeightPt(element, slideSizePt) {
  return resolveTableDesignHeightPt(element) ?? resolveTableContentAreaHeightPt(element, slideSizePt)
}

export function resolveTableTargetHeightPt(element) {
  return resolveTableDesignHeightPt(element)
}

export function tableIntrinsicHeightPt(tableMeta, rowCount) {
  const rowHeights = tableMeta?.row_heights_pt || []
  if (!rowHeights.length || rowCount <= 0) return null
  return columnWeightsForCount(rowHeights, rowCount)
    .reduce((sum, value) => sum + (value || 0), 0)
}

export function shouldStretchTableHeight(element, rowCount) {
  const tableMeta = element.table || {}
  const sizingMode = tableMeta.structure?.row_sizing?.mode
  if (sizingMode === 'fit_content') {
    return Boolean(resolveTableDesignHeightPt(element) && tableMeta.row_heights_pt?.length)
  }
  if (sizingMode === 'fixed') {
    const designHeightPt = resolveTableDesignHeightPt(element)
    if (!designHeightPt) return false
    const intrinsicHeightPt = tableIntrinsicHeightPt(tableMeta, rowCount)
    if (intrinsicHeightPt == null) return true
    return intrinsicHeightPt < designHeightPt - 0.5
  }

  const frameHeightPt = tableMeta.frame_height_pt ?? element.geometry_pt?.height_pt
  const gridSum = tableIntrinsicHeightPt(tableMeta, rowCount)
  if (frameHeightPt && gridSum && frameHeightPt > gridSum + 1) {
    return Boolean(tableMeta.row_heights_pt?.length)
  }

  const designHeightPt = resolveTableDesignHeightPt(element)
  if (!designHeightPt) return false
  const intrinsicHeightPt = tableIntrinsicHeightPt(tableMeta, rowCount)
  if (intrinsicHeightPt == null) return true
  return intrinsicHeightPt < designHeightPt - 0.5
}

export function isFixedRowSizing(tableMeta, rowCount = 0) {
  if (tableMeta?.structure?.row_sizing?.mode === 'fit_content') {
    return false
  }
  if (tableMeta?.structure?.row_sizing?.mode === 'fixed') {
    return true
  }

  const frameHeightPt = tableMeta?.frame_height_pt
  const gridSum = tableIntrinsicHeightPt(tableMeta, rowCount)
  if (frameHeightPt && gridSum && frameHeightPt > gridSum + 1) {
    return false
  }

  const heights = tableMeta?.row_heights_pt || []
  if (heights.length < 2) {
    return false
  }
  const rounded = heights.map((value) => Math.round((value || 0) * 10) / 10)
  return new Set(rounded).size === 1
}

export function usesExplicitRowHeights(tableMeta, rowCount) {
  return isFixedRowSizing(tableMeta, rowCount)
    && Boolean(tableMeta?.row_heights_pt?.length)
    && rowCount > 0
}

function resolveTableLayoutHeightPt(element, rowCount) {
  const tableMeta = element.table || {}
  const designHeightPt = resolveTableDesignHeightPt(element)
  if (isFixedRowSizing(tableMeta, rowCount)) {
    return designHeightPt || tableIntrinsicHeightPt(tableMeta, rowCount) || null
  }
  return designHeightPt || tableIntrinsicHeightPt(tableMeta, rowCount) || null
}

function gridColumnTrackTemplate(columnWidthsPt, colCount) {
  return columnWeightsForCount(columnWidthsPt, colCount)
    .map((weight) => `${weight || 1}fr`)
    .join(' ')
}

function gridRowTrackTemplate(rowHeightsPt, rowCount, slideHeight, { stretch = false } = {}) {
  const weights = columnWeightsForCount(rowHeightsPt, rowCount)
  if (stretch) {
    return weights
      .map((weight) => `minmax(min-content, ${weight || 1}fr)`)
      .join(' ')
  }
  if (slideHeight) {
    return weights
      .map((weight) => ptToSlideCqh(weight || 0, slideHeight))
      .join(' ')
  }
  return weights.map((weight) => `${weight || 1}fr`).join(' ')
}

function isInvisibleTableBorder(border) {
  if (!border) return true
  if (border.visible === false) return true
  const color = border.color
  if (color && typeof color === 'object') {
    if (color.kind === 'none') return true
    if (Number(color.alpha ?? 1) <= 0) return true
  }
  return false
}

function applyBorderSide(cell, side, border, widthPt) {
  if (isInvisibleTableBorder(border)) return
  const color = strokeColorCss(border.color)
  if (!color) return
  const lineWidth = ptToSlideCqw(border.width_pt || 0.75, widthPt)
  const style = border.dash && border.dash !== 'solid' ? border.dash : 'solid'
  cell.style[`border${side}`] = `${lineWidth} ${style} ${color}`
}

function applyCellBorders(cell, borders, widthPt) {
  if (!borders) return
  applyBorderSide(cell, 'Top', borders.top, widthPt)
  applyBorderSide(cell, 'Right', borders.right, widthPt)
  applyBorderSide(cell, 'Bottom', borders.bottom, widthPt)
  applyBorderSide(cell, 'Left', borders.left, widthPt)
}

function resolveTableCellEdgeBorders(styleGrid, rowIndex, colIndex, rowCount, colCount, mergeInfo = null) {
  const current = styleGrid?.[rowIndex]?.[colIndex]?.borders || {}
  const above = rowIndex > 0 ? styleGrid?.[rowIndex - 1]?.[colIndex]?.borders || {} : null
  const leftCell = colIndex > 0 ? styleGrid?.[rowIndex]?.[colIndex - 1]?.borders || {} : null
  const lastCol = mergeInfo?.lastCol ?? colIndex
  const lastCell = styleGrid?.[rowIndex]?.[lastCol]?.borders || current

  const borders = {
    top: rowIndex === 0 ? current.top : (above?.bottom || current.top),
    left: colIndex === 0 ? current.left : (leftCell?.right || current.left),
    right: lastCol === colCount - 1 ? lastCell.right : null,
    bottom: rowIndex === rowCount - 1 ? current.bottom : null,
  }
  return Object.fromEntries(Object.entries(borders).filter(([, stroke]) => stroke))
}

function buildTableStyleGrid(element, matrix, rowCount, colCount) {
  return matrix.map((row, rowIndex) => (
    row.map((_, colIndex) => resolveCellStyle(element, rowIndex, colIndex, rowCount, colCount, row))
  ))
}

function applyCellPadding(cell, paddingPt, widthPt) {
  if (!paddingPt || !widthPt) return
  if (paddingPt.top) cell.style.paddingTop = ptToSlideCqw(paddingPt.top, widthPt)
  if (paddingPt.right) cell.style.paddingRight = ptToSlideCqw(paddingPt.right, widthPt)
  if (paddingPt.bottom) cell.style.paddingBottom = ptToSlideCqw(paddingPt.bottom, widthPt)
  if (paddingPt.left) cell.style.paddingLeft = ptToSlideCqw(paddingPt.left, widthPt)
}

function applyCellTypography(cell, typography, widthPt, {
  tokens = null,
  styleTokens = {},
  tokenKey = null,
  isHeader = false,
} = {}) {
  const family = typography?.family || tokens?.defaultFontFamily
  if (family) {
    cell.style.fontFamily = `"${family}", Arial, sans-serif`
  }
  const sizePt = resolveTableTextSizePt(tokens, styleTokens, { typography, tokenKey, isHeader })
  if (sizePt && widthPt) {
    cell.style.fontSize = ptToSlideCqw(sizePt, widthPt)
  }
  cell.style.fontWeight = typography?.bold ? '700' : '400'
  cell.style.color = resolveTableTextColor(tokens, styleTokens, { typography, tokenKey, isHeader })
  const alignment = typography?.alignment
  if (alignment === 'ctr') cell.style.textAlign = 'center'
  else if (alignment === 'r') cell.style.textAlign = 'right'
  else if (alignment === 'just') cell.style.textAlign = 'justify'
  else cell.style.textAlign = 'left'
}

function applyCellStyle(cell, token, widthPt, {
  skipTypography = false,
  edgeBorders = null,
  tokens = null,
  styleTokens = {},
  tokenKey = null,
  isHeader = false,
} = {}) {
  if (!token) return
  applyFillStyle(cell, token.fill)
  applyCellPadding(cell, token.padding_pt, widthPt)
  applyCellBorders(cell, edgeBorders || token.borders, widthPt)
  if (!skipTypography) {
    applyCellTypography(cell, token.typography, widthPt, { tokens, styleTokens, tokenKey, isHeader })
  }

  if (token.vertical_anchor) {
    cell.style.display = 'flex'
    cell.style.flexDirection = 'column'
    cell.style.justifyContent = verticalAnchorToJustifyContent(token.vertical_anchor)
    if (!skipTypography) {
      const alignment = token.typography?.alignment
      cell.style.alignItems = alignment === 'ctr'
        ? 'center'
        : alignment === 'r'
          ? 'flex-end'
          : 'flex-start'
    }
  }
}

function mountTableCellContent(cell, cellText, cellStyle, slideSizePt, {
  tokens = null,
  styleTokens = {},
  tokenKey = null,
  isHeader = false,
} = {}) {
  if (!cellHasVisibleText(cellText)) {
    return false
  }

  const slideWidth = slideWidthPt(slideSizePt)
  const sourceTypography = cellText.typography || {}
  const fallbackTypography = {
    ...sourceTypography,
    color: resolveTableTextColor(tokens, styleTokens, {
      typography: sourceTypography,
      tokenKey,
      isHeader,
    }),
    family: sourceTypography.family || tokens?.defaultFontFamily,
    size_pt: resolveTableTextSizePt(tokens, styleTokens, {
      typography: sourceTypography,
      tokenKey,
      isHeader,
    }),
  }
  const wrapper = document.createElement('div')
  wrapper.className = 'catalog-table-cell-content ds-table-cell-content'
  wrapper.style.width = '100%'
  wrapper.style.minWidth = '0'
  wrapper.style.boxSizing = 'border-box'
  wrapper.style.whiteSpace = 'pre-wrap'
  wrapper.style.wordBreak = 'break-word'

  if (cellText.text_segments?.length) {
    wrapper.style.display = 'flex'
    wrapper.style.flexDirection = 'column'
    wrapper.style.alignItems = 'stretch'
    cellText.text_segments.forEach((segment, index) => {
      const line = document.createElement('div')
      line.className = 'catalog-table-cell-segment ds-table-cell-segment'
      const pseudoElement = {
        text: segment.text || '',
        bullet: segment.bullet,
        paragraph_spacing_pt: segment.paragraph_spacing_pt,
        typography: segment.typography || fallbackTypography,
      }
      if (!populateTextLineContent(line, pseudoElement, pseudoElement.typography, slideSizePt, { skipMetric: true })) {
        applyCellTypography(line, pseudoElement.typography, slideWidth, { tokens, styleTokens, tokenKey, isHeader })
        line.textContent = stripBulletPlaceholder(pseudoElement.text)
      }
      const spacing = { ...(segment.paragraph_spacing_pt || {}) }
      if (index === 0) spacing.space_before = 0
      applyParagraphSpacingPt(line, spacing, slideWidth, { skipHangingIndent: usesBulletRowLayout(pseudoElement) })
      wrapper.append(line)
    })
  } else {
    const pseudoElement = {
      text: cellText.text || '',
      bullet: cellText.bullet,
      text_paragraphs: cellText.text_paragraphs,
      paragraph_spacing_pt: cellText.paragraph_spacing_pt,
      typography: fallbackTypography,
    }
    if (!populateTextLineContent(wrapper, pseudoElement, fallbackTypography, slideSizePt, { skipMetric: true })) {
      applyCellTypography(wrapper, fallbackTypography, slideWidth, { tokens, styleTokens, tokenKey, isHeader })
      wrapper.textContent = stripBulletPlaceholder(pseudoElement.text)
    }
  }

  cell.append(wrapper)
  return true
}

export function resolveTableGeometryNorm(element, slideSizePt) {
  const frame = element.geometry_norm || {}
  const slideWidth = slideWidthPt(slideSizePt)
  const slideHeight = slideHeightPt(slideSizePt)
  const tableMeta = element.table || {}
  const paddingPt = tableMeta.padding_pt || tableMeta.frame_padding_pt
  const outerWidthPt = element.geometry_pt?.width_pt
  const outerHeightPt = element.geometry_pt?.height_pt

  if (paddingPt && outerWidthPt && slideWidth) {
    return {
      x: frame.x,
      y: frame.y,
      width: outerWidthPt / slideWidth,
      height: outerHeightPt && slideHeight ? outerHeightPt / slideHeight : frame.height,
    }
  }

  const layoutWidthPt = resolveTableLayoutWidthPt(element)
  if (!slideWidth || !layoutWidthPt) {
    return {
      x: frame.x,
      y: frame.y,
      width: frame.width,
    }
  }

  return {
    x: frame.x,
    y: frame.y,
    width: layoutWidthPt / slideWidth,
  }
}

export function mountStyledTable(node, element, slideSizePt, { tokens = null } = {}) {
  const tableMeta = element.table || {}
  const styleTokens = tableMeta.style_tokens || {}
  const headerRow = tableMeta.structure?.header_row ?? 0
  const paddingPt = tableMeta.padding_pt || tableMeta.frame_padding_pt
  const { rowCount, colCount } = tableDimensions(element)
  const matrix = buildTableMatrix(element)
  const slideWidth = slideWidthPt(slideSizePt)
  const slideHeight = slideHeightPt(slideSizePt)
  const layoutWidthPt = resolveTableLayoutWidthPt(element)
  const layoutHeightPt = resolveTableLayoutHeightPt(element, rowCount)
  const outerWidthPt = paddingPt ? element.geometry_pt?.width_pt : null
  const outerHeightPt = paddingPt ? element.geometry_pt?.height_pt : null
  const maxHeightPt = resolveTableMaxHeightPt(element, slideSizePt)
  const fixedRowHeights = usesExplicitRowHeights(tableMeta, rowCount)
  const stretchHeight = shouldStretchTableHeight(element, rowCount)
  const sizedVertically = fixedRowHeights || stretchHeight

  node.classList.add('catalog-table', 'ds-table')
  node.style.boxSizing = 'border-box'
  if (paddingPt && slideWidth) {
    applyCellPadding(node, paddingPt, slideWidth)
  }
  if (paddingPt && outerHeightPt && slideHeight) {
    const outerHeightCqh = ptToSlideCqh(outerHeightPt, slideHeight)
    node.style.height = outerHeightCqh
    node.style.minHeight = outerHeightCqh
    node.style.maxHeight = outerHeightCqh
    node.style.overflow = 'visible'
  } else if (sizedVertically && layoutHeightPt && slideHeight) {
    const layoutHeightCqh = ptToSlideCqh(layoutHeightPt, slideHeight)
    node.style.height = layoutHeightCqh
    node.style.minHeight = layoutHeightCqh
    node.style.maxHeight = layoutHeightCqh
    node.style.overflow = 'visible'
  } else {
    node.style.height = 'auto'
    node.style.minHeight = ''
    node.style.maxHeight = maxHeightPt && slideHeight
      ? ptToSlideCqh(maxHeightPt, slideHeight)
      : 'none'
    node.style.overflow = maxHeightPt ? 'auto' : 'visible'
  }
  if (outerWidthPt && slideWidth) {
    node.style.width = ptToSlideCqw(outerWidthPt, slideWidth)
  } else if (layoutWidthPt && slideWidth) {
    node.style.width = ptToSlideCqw(layoutWidthPt, slideWidth)
  }
  node.style.maxWidth = node.style.width

  if (!matrix.length) {
    node.append(Object.assign(document.createElement('span'), {
      className: 'catalog-table-badge',
      textContent: `${rowCount}×${colCount}`,
    }))
    return node
  }

  const grid = document.createElement('div')
  grid.className = 'catalog-table-grid ds-table-grid'
  grid.style.display = 'grid'
  grid.style.width = '100%'
  grid.style.boxSizing = 'border-box'
  grid.style.gridTemplateColumns = gridColumnTrackTemplate(tableMeta.column_widths_pt, colCount)
  if (fixedRowHeights || stretchHeight) {
    grid.style.gridTemplateRows = gridRowTrackTemplate(
      tableMeta.row_heights_pt,
      rowCount,
      slideHeight,
      { stretch: stretchHeight },
    )
    grid.style.gridAutoRows = 'unset'
    grid.style.height = stretchHeight ? '100%' : 'auto'
    grid.style.alignContent = stretchHeight ? 'stretch' : 'start'
  } else {
    grid.style.height = 'auto'
    grid.style.alignContent = 'start'
    grid.style.gridTemplateRows = ''
    grid.style.gridAutoRows = 'auto'
  }

  const styleGrid = buildTableStyleGrid(element, matrix, rowCount, colCount)
  const mergedCells = tableMeta.structure?.merged_cells || []

  matrix.forEach((row, rowIndex) => {
    row.forEach((cellText, colIndex) => {
      const mergeInfo = findMergeAt(mergedCells, rowIndex, colIndex)
      if (mergeInfo && !mergeInfo.isAnchor) {
        return
      }

      const cell = document.createElement('div')
      cell.className = 'catalog-table-cell ds-table-cell'
      cell.style.boxSizing = 'border-box'
      cell.style.minWidth = '0'
      cell.style.minHeight = sizedVertically ? '0' : ''
      cell.style.height = sizedVertically ? '100%' : 'auto'
      cell.style.overflow = 'visible'
      if (mergeInfo?.colSpan > 1) {
        cell.style.gridColumn = `${colIndex + 1} / span ${mergeInfo.colSpan}`
      }

      const cellStyle = styleGrid[rowIndex][colIndex]
      const isHeader = rowIndex === headerRow
      const tokenKey = isHeader ? 'header_cell' : 'body_cell'
      const edgeBorders = resolveTableCellEdgeBorders(
        styleGrid,
        rowIndex,
        colIndex,
        rowCount,
        colCount,
        mergeInfo,
      )
      const cellTextData = tableMeta.cell_text?.[rowIndex]?.[colIndex]
      const blankStub = isBlankStubCell(tableMeta, rowIndex, colIndex)
      const typographyContext = { tokens, styleTokens, tokenKey, isHeader }
      const previewText = blankStub ? '' : (typeof cellText === 'string' ? cellText : '')
      const hasVisibleText = !blankStub && (cellHasVisibleText(cellTextData)
        || cellHasVisibleText(previewText))
      applyCellStyle(cell, cellStyle, slideWidth, {
        skipTypography: true,
        edgeBorders,
        ...typographyContext,
      })

      cell.style.whiteSpace = 'pre-wrap'
      cell.style.wordBreak = 'break-word'

      if (blankStub) {
        cell.textContent = ''
      } else if (cellTextData && hasVisibleText) {
        if (!mountTableCellContent(cell, cellTextData, cellStyle, slideSizePt, typographyContext)) {
          cell.textContent = cellTextData.text || previewText
          applyCellTypography(
            cell,
            cellTextData.typography,
            slideWidth,
            typographyContext,
          )
        }
      } else if (hasVisibleText) {
        cell.textContent = previewText
        applyCellTypography(cell, cellStyle?.typography, slideWidth, typographyContext)
      } else {
        cell.textContent = cellTextData?.text || previewText
      }

      grid.append(cell)
    })
  })

  node.append(grid)
  return node
}
