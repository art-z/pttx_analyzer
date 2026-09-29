import { tableDataToMatrix, tableMatrixToDataPayload } from './model-data.js'
import {
  inferTableStylePattern,
  rebuildCellStylesFromPattern,
  describeTableStylePattern,
  resolveCellPrototype,
  resolveTemplateCoords,
  resolveAxisTemplateIndex,
  completeCellStyleTypography,
  cellHasVisibleText,
  listBlankStubCells,
  clearBlankStubCellsInMatrix,
} from './table-style-pattern.js'

export { inferTableStylePattern, describeTableStylePattern } from './table-style-pattern.js'

export const MIN_TABLE_COLS = 1
export const MIN_TABLE_ROWS = 2

function slideByNumber(report, slideNumber) {
  return (report?.slides?.slides || []).find((slide) => slide.slide_number === slideNumber) || null
}

function cloneValue(value) {
  if (typeof structuredClone === 'function') return structuredClone(value)
  return JSON.parse(JSON.stringify(value))
}

function extendNumericList(list, targetLength, fallback) {
  const source = Array.isArray(list) ? list : []
  const next = [...source]
  const pad = source.length ? source[source.length - 1] : fallback
  while (next.length < targetLength) next.push(pad)
  return next.slice(0, targetLength)
}

function hasLabelColumn(columnWidthsPt = []) {
  return columnWidthsPt.length >= 2 && columnWidthsPt[0] > columnWidthsPt[1] * 1.15
}

export function templateColIndex(colIndex, sourceColCount, columnWidthsPt = []) {
  if (sourceColCount <= 0) return 0
  if (colIndex < sourceColCount) return colIndex

  if (hasLabelColumn(columnWidthsPt) && sourceColCount > 1) {
    const patternLen = sourceColCount - 1
    return 1 + ((colIndex - 1) % patternLen)
  }
  return colIndex % sourceColCount
}

function templateRowIndex(rowIndex, sourceRowCount, tableMeta = {}, rowPattern = null) {
  if (sourceRowCount <= 0) return 0
  if (rowIndex < sourceRowCount) return rowIndex

  if (rowPattern?.type === 'row_band_2') {
    if (rowIndex < rowPattern.prefix_length) {
      return Math.min(rowIndex, rowPattern.prefix_length - 1)
    }
    const offset = rowIndex - rowPattern.prefix_length
    return rowPattern.prefix_length + (offset % 2)
  }

  const headerRow = Number.isInteger(tableMeta.structure?.header_row)
    ? tableMeta.structure.header_row
    : 0
  const bodyStart = headerRow >= 0 ? headerRow + 1 : 0
  const bodyCount = Math.max(sourceRowCount - bodyStart, 1)
  const bodyOffset = Math.max(rowIndex - bodyStart, 0)
  return bodyStart + (bodyOffset % bodyCount)
}

export function inferRowStylePattern(sourceGrid, tableMeta = {}) {
  const pattern = inferTableStylePattern(sourceGrid, tableMeta)
  if (!pattern?.rows || pattern.rows.body.period !== 2) return null

  const bodyCol = pattern.roles.body_col
  const prefixLength = pattern.rows.prefix.length
  const bandStart = prefixLength
  return {
    type: 'row_band_2',
    prefix_length: prefixLength,
    band_start_row: bandStart,
    band_a_row: bandStart,
    band_b_row: bandStart + 1,
    band_a_fill: sourceGrid[bandStart]?.[bodyCol]?.fill?.color
      || sourceGrid[bandStart]?.[0]?.fill?.color
      || null,
    band_b_fill: sourceGrid[bandStart + 1]?.[bodyCol]?.fill?.color
      || sourceGrid[bandStart + 1]?.[0]?.fill?.color
      || null,
    signatures: pattern.rows.prefix.concat(pattern.rows.body.pattern),
  }
}

export function describeRowStylePattern(pattern) {
  if (!pattern) return null
  if (pattern.type === 'row_band_2') {
    const prefixPart = pattern.prefix_length > 1
      ? `строки 1–${pattern.prefix_length} фиксированный блок`
      : pattern.prefix_length === 1
        ? 'строка 1 фиксированная'
        : 'без фиксированного префикса'

    return {
      summary: `${prefixPart}; далее band 2‑striped (A/B) с шаблона строк ${pattern.band_a_row + 1}/${pattern.band_b_row + 1}`,
      prefix_rows: pattern.prefix_length,
      band_colors: [pattern.band_a_fill, pattern.band_b_fill],
    }
  }

  return describeTableStylePattern(pattern)
}

function extendColumnWidths(columnWidthsPt, targetCount) {
  if (targetCount <= 0) return []
  const source = Array.isArray(columnWidthsPt) ? columnWidthsPt : []
  if (!source.length) return Array(targetCount).fill(80)
  if (targetCount <= source.length) return source.slice(0, targetCount)

  const next = [...source]
  while (next.length < targetCount) {
    const templateIndex = templateColIndex(next.length, source.length, source)
    next.push(source[templateIndex])
  }
  return next
}

function extendRowHeights(rowHeightsPt, targetCount, tableMeta = {}) {
  if (targetCount <= 0) return []
  const source = Array.isArray(rowHeightsPt) ? rowHeightsPt : []
  if (!source.length) return []
  if (targetCount <= source.length) return source.slice(0, targetCount)

  const next = [...source]
  const pattern = inferTableStylePattern(tableMeta.cell_styles, tableMeta)
  while (next.length < targetCount) {
    const templateIndex = pattern?.rows
      ? resolveAxisTemplateIndex(next.length, pattern.rows, source.length)
      : templateRowIndex(next.length, source.length, tableMeta, null)
    next.push(source[templateIndex])
  }
  return next
}

function fallbackTypography(tableMeta, rowIndex) {
  const tokens = tableMeta.style_tokens || {}
  const headerRow = Number.isInteger(tableMeta.structure?.header_row)
    ? tableMeta.structure.header_row
    : 0
  const token = rowIndex === headerRow
    ? (tokens.header_cell || tokens.first_row_cell || tokens.body_cell || tokens.whole_cell)
    : (tokens.body_cell || tokens.whole_cell || tokens.header_cell)
  if (token?.typography) return cloneValue(token.typography)

  const cellTextGrid = tableMeta.cell_text
  if (!Array.isArray(cellTextGrid) || rowIndex < 0 || rowIndex >= cellTextGrid.length) {
    return null
  }

  for (const entry of cellTextGrid[rowIndex] || []) {
    if (!cellHasVisibleText(entry) || !entry?.typography) continue
    return cloneValue(entry.typography)
  }

  return null
}

function styleSignature(style) {
  if (!style) return ''
  return JSON.stringify({
    fill: style.fill?.color || style.fill?.kind || null,
    typo: style.typography?.color || null,
    bold: style.typography?.bold || false,
    size: style.typography?.size_pt || null,
  })
}

function typographySignature(typography) {
  if (!typography) return ''
  return JSON.stringify({
    color: typography.color || null,
    bold: typography.bold || false,
    size: typography.size_pt || null,
    family: typography.family || null,
    alignment: typography.alignment || null,
  })
}

function pickBodyColumn(sourceColCount, columnWidthsPt = []) {
  if (sourceColCount <= 1) return 0
  if (hasLabelColumn(columnWidthsPt) && sourceColCount > 2) return 1
  if (sourceColCount > 2) return 1
  return 0
}

export function inferPositionalPrototypes(sourceGrid, sourceTextGrid, tableMeta = {}) {
  const sourceRowCount = sourceGrid?.length || 0
  const sourceColCount = sourceGrid?.[0]?.length || 0
  if (!sourceRowCount || !sourceColCount) return null

  const headerRow = Number.isInteger(tableMeta.structure?.header_row)
    ? tableMeta.structure.header_row
    : 0
  const bodyRow = Math.min(Math.max(headerRow + 1, 0), sourceRowCount - 1)
  const lastRow = sourceRowCount - 1
  const bodyCol = pickBodyColumn(sourceColCount, tableMeta.column_widths_pt)

  const bodyStyle = sourceGrid[bodyRow]?.[bodyCol] ? cloneValue(sourceGrid[bodyRow][bodyCol]) : null
  const lastColStyle = sourceGrid[bodyRow]?.[sourceColCount - 1]
    ? cloneValue(sourceGrid[bodyRow][sourceColCount - 1])
    : null
  const firstColStyle = sourceGrid[bodyRow]?.[0] ? cloneValue(sourceGrid[bodyRow][0]) : null
  const headerStyle = sourceGrid[headerRow]?.[bodyCol] ? cloneValue(sourceGrid[headerRow][bodyCol]) : null
  const lastRowStyle = sourceGrid[lastRow]?.[bodyCol] ? cloneValue(sourceGrid[lastRow][bodyCol]) : null

  const bodyText = sourceTextGrid?.[bodyRow]?.[bodyCol]
  const lastColText = sourceTextGrid?.[bodyRow]?.[sourceColCount - 1]
  const firstColText = sourceTextGrid?.[bodyRow]?.[0]
  const headerText = sourceTextGrid?.[headerRow]?.[bodyCol]
  const lastRowText = sourceTextGrid?.[lastRow]?.[bodyCol]

  const lastColIsSpecial = Boolean(bodyStyle && lastColStyle
    && styleSignature(lastColStyle) !== styleSignature(bodyStyle))
  const firstColIsSpecial = Boolean(bodyCol !== 0 && bodyStyle && firstColStyle
    && styleSignature(firstColStyle) !== styleSignature(bodyStyle))
  const headerIsSpecial = Boolean(bodyStyle && headerStyle
    && styleSignature(headerStyle) !== styleSignature(bodyStyle))
  const lastRowIsSpecial = Boolean(bodyRow !== lastRow && bodyStyle && lastRowStyle
    && styleSignature(lastRowStyle) !== styleSignature(bodyStyle))
  const lastColTextIsSpecial = Boolean(bodyText && lastColText
    && typographySignature(lastColText?.typography) !== typographySignature(bodyText?.typography))

  return {
    headerRow,
    bodyStyle,
    lastColStyle,
    firstColStyle,
    headerStyle,
    lastRowStyle,
    lastColIsSpecial,
    firstColIsSpecial,
    headerIsSpecial,
    lastRowIsSpecial,
    lastColTextIsSpecial,
    lastColTextTemplate: lastColText && typeof lastColText === 'object' ? cloneValue(lastColText) : null,
    bodyTextTemplate: bodyText && typeof bodyText === 'object' ? cloneValue(bodyText) : null,
    firstColTextTemplate: firstColText && typeof firstColText === 'object' ? cloneValue(firstColText) : null,
    headerTextTemplate: headerText && typeof headerText === 'object' ? cloneValue(headerText) : null,
    lastRowTextTemplate: lastRowText && typeof lastRowText === 'object' ? cloneValue(lastRowText) : null,
    hasPositionalRoles: lastColIsSpecial || firstColIsSpecial || headerIsSpecial || lastRowIsSpecial,
  }
}

export function buildPositionalCellStyle(prototypes, rowIndex, colIndex, rowCount, colCount) {
  if (prototypes.lastColIsSpecial && colIndex === colCount - 1) {
    return cloneValue(prototypes.lastColStyle)
  }
  if (prototypes.firstColIsSpecial && colIndex === 0) {
    return cloneValue(prototypes.firstColStyle)
  }
  if (prototypes.lastRowIsSpecial && rowIndex === rowCount - 1) {
    return cloneValue(prototypes.lastRowStyle)
  }
  if (prototypes.headerIsSpecial && rowIndex === prototypes.headerRow) {
    return cloneValue(prototypes.headerStyle)
  }
  return cloneValue(prototypes.bodyStyle)
}

function mergeTextTypographyFromStyle(textCell, style) {
  if (!textCell) return textCell
  if (!cellHasVisibleText(textCell)) {
    if (!textCell.typography) return textCell
    const next = { ...textCell }
    delete next.typography
    return next
  }
  if (!style?.typography) return textCell
  return {
    ...textCell,
    typography: {
      ...(textCell.typography || {}),
      ...cloneValue(style.typography),
    },
  }
}

function buildPositionalCellText(prototypes, text, rowIndex, colIndex, rowCount, colCount, tableMeta) {
  let template = prototypes.bodyTextTemplate
  let style = prototypes.bodyStyle

  if (prototypes.lastColIsSpecial && colIndex === colCount - 1) {
    template = prototypes.lastColTextTemplate || template
    style = prototypes.lastColStyle || style
  } else if (prototypes.firstColIsSpecial && colIndex === 0) {
    template = prototypes.firstColTextTemplate || template
    style = prototypes.firstColStyle || style
  } else if (prototypes.lastRowIsSpecial && rowIndex === rowCount - 1) {
    template = prototypes.lastRowTextTemplate || template
    style = prototypes.lastRowStyle || style
  } else if (prototypes.headerIsSpecial && rowIndex === prototypes.headerRow) {
    template = prototypes.headerTextTemplate || template
    style = prototypes.headerStyle || style
  }

  if (template && typeof template === 'object') {
    return mergeTextTypographyFromStyle({ ...cloneValue(template), text: String(text) }, style)
  }

  return mergeTextTypographyFromStyle({
    text: String(text),
    typography: fallbackTypography(tableMeta, rowIndex),
  }, style)
}

function resizeCellTextFromPattern(existing, matrix, rowCount, colCount, tableMeta, pattern) {
  const styleGrid = tableMeta.cell_styles || []
  const columnWidthsPt = tableMeta.column_widths_pt || []
  const stubs = new Set(listBlankStubCells(tableMeta).map(([row, col]) => `${row}:${col}`))

  return Array.from({ length: rowCount }, (_, rowIndex) => (
    Array.from({ length: colCount }, (_, colIndex) => {
      const isStub = stubs.has(`${rowIndex}:${colIndex}`)
      const text = isStub ? '' : String(matrix?.[rowIndex]?.[colIndex] ?? '')
      if (isStub) {
        const template = existing?.[rowIndex]?.[colIndex]
        if (template && typeof template === 'object') {
          const next = { ...cloneValue(template), text: '' }
          delete next.typography
          return next
        }
        return { text: '' }
      }
      const style = resolveCellPrototype(
        rowIndex,
        colIndex,
        pattern,
        styleGrid,
        rowCount,
        colCount,
        columnWidthsPt,
        tableMeta,
      )
      const { templateRow, templateCol } = resolveTemplateCoords(
        rowIndex,
        colIndex,
        pattern,
        styleGrid.length,
        styleGrid[0]?.length || 0,
        rowCount,
        colCount,
        columnWidthsPt,
      )
      const template = existing?.[templateRow]?.[templateCol]
      if (template && typeof template === 'object') {
        return mergeTextTypographyFromStyle({ ...cloneValue(template), text }, style)
      }
      return mergeTextTypographyFromStyle({
        text,
        typography: fallbackTypography(tableMeta, rowIndex),
      }, style)
    })
  ))
}

function resizeCellStylesGridByTemplate(existing, rowCount, colCount, tableMeta = {}) {
  const sourceRowCount = existing.length
  const sourceColCount = existing[0]?.length || 0
  const columnWidthsPt = tableMeta.column_widths_pt || []

  return Array.from({ length: rowCount }, (_, rowIndex) => (
    Array.from({ length: colCount }, (_, colIndex) => {
      if (rowIndex < sourceRowCount && colIndex < sourceColCount && existing[rowIndex]?.[colIndex]) {
        return cloneValue(existing[rowIndex][colIndex])
      }
      const templateRow = templateRowIndex(rowIndex, sourceRowCount, tableMeta, null)
      const templateCol = templateColIndex(colIndex, sourceColCount, columnWidthsPt)
      const template = existing[templateRow]?.[templateCol]
      const resolved = template ? cloneValue(template) : null
      return resolved
        ? completeCellStyleTypography(
          resolved,
          tableMeta,
          rowIndex,
          colIndex,
          rowCount,
          colCount,
          existing,
        )
        : null
    })
  ))
}

function resizeCellStylesGrid(existing, rowCount, colCount, tableMeta = {}) {
  if (!Array.isArray(existing) || !existing.length) return existing

  const sourceRowCount = existing.length
  const sourceColCount = existing[0]?.length || 0
  const sizeChanged = rowCount !== sourceRowCount || colCount !== sourceColCount

  if (sizeChanged) {
    const rebuilt = rebuildCellStylesFromPattern(existing, rowCount, colCount, tableMeta)
    if (rebuilt) return rebuilt
  }

  const prototypes = inferPositionalPrototypes(existing, tableMeta.cell_text, tableMeta)
  if (prototypes?.hasPositionalRoles) {
    return Array.from({ length: rowCount }, (_, rowIndex) => (
      Array.from({ length: colCount }, (_, colIndex) => (
        buildPositionalCellStyle(prototypes, rowIndex, colIndex, rowCount, colCount)
      ))
    ))
  }

  return resizeCellStylesGridByTemplate(existing, rowCount, colCount, tableMeta)
}

function updateCellTextFromMatrix(existing, matrix, rowCount, colCount, tableMeta = {}) {
  const stubs = new Set(listBlankStubCells(tableMeta).map(([row, col]) => `${row}:${col}`))
  return Array.from({ length: rowCount }, (_, rowIndex) => (
    Array.from({ length: colCount }, (_, colIndex) => {
      const isStub = stubs.has(`${rowIndex}:${colIndex}`)
      const text = isStub ? '' : String(matrix?.[rowIndex]?.[colIndex] ?? '')
      const current = existing?.[rowIndex]?.[colIndex]
      const next = current && typeof current === 'object'
        ? { ...cloneValue(current), text }
        : {
          text,
          typography: isStub ? undefined : fallbackTypography(tableMeta, rowIndex),
        }
      if (!String(text).trim() || isStub) {
        if (next.typography) {
          const cleaned = { ...next, text: '' }
          delete cleaned.typography
          return cleaned
        }
        return { ...next, text: '' }
      }
      return next
    })
  ))
}

function keepBlankStubCellStyles(styles, tableMeta = {}) {
  if (!Array.isArray(styles) || !styles.length) return styles
  const stubs = listBlankStubCells(tableMeta)
  if (!stubs.length) return cloneValue(styles)
  const next = cloneValue(styles)
  for (const [rowIndex, colIndex] of stubs) {
    if (!next[rowIndex]?.[colIndex]) continue
    const { typography, ...rest } = next[rowIndex][colIndex]
    next[rowIndex][colIndex] = rest
  }
  return next
}

function resolveSourceTableSize(element, tableMeta, previewMatrix) {
  const rowCount = tableMeta.cell_styles?.length
    || element.rows
    || previewMatrix.length
    || 0
  const colCount = tableMeta.cell_styles?.[0]?.length
    || element.cols
    || previewMatrix[0]?.length
    || 0
  return { rowCount, colCount }
}

function resizeCellTextGrid(existing, matrix, rowCount, colCount, tableMeta = {}) {
  const sourceRowCount = existing?.length || 0
  const sourceColCount = existing?.[0]?.length || 0
  const columnWidthsPt = tableMeta.column_widths_pt || []
  const styleGrid = tableMeta.cell_styles || []
  const sizeChanged = rowCount !== sourceRowCount || colCount !== sourceColCount
  const pattern = sizeChanged ? inferTableStylePattern(styleGrid, tableMeta) : null

  if (pattern) {
    return resizeCellTextFromPattern(existing, matrix, rowCount, colCount, tableMeta, pattern)
  }

  const prototypes = inferPositionalPrototypes(styleGrid, existing, tableMeta)
  if (prototypes?.hasPositionalRoles || prototypes?.lastColTextIsSpecial) {
    return Array.from({ length: rowCount }, (_, rowIndex) => (
      Array.from({ length: colCount }, (_, colIndex) => {
        const text = String(matrix?.[rowIndex]?.[colIndex] ?? '')
        return buildPositionalCellText(prototypes, text, rowIndex, colIndex, rowCount, colCount, tableMeta)
      })
    ))
  }

  return Array.from({ length: rowCount }, (_, rowIndex) => (
    Array.from({ length: colCount }, (_, colIndex) => {
      const text = String(matrix?.[rowIndex]?.[colIndex] ?? '')
      const current = existing?.[rowIndex]?.[colIndex]
      if (current && typeof current === 'object' && rowIndex < sourceRowCount && colIndex < sourceColCount) {
        return { ...cloneValue(current), text }
      }

      const templateRow = templateRowIndex(rowIndex, sourceRowCount || styleGrid.length, tableMeta, null)
      const templateCol = templateColIndex(colIndex, sourceColCount, columnWidthsPt)
      const template = existing?.[templateRow]?.[templateCol]
      if (template && typeof template === 'object') {
        return { ...cloneValue(template), text }
      }

      return {
        text,
        typography: fallbackTypography(tableMeta, rowIndex),
      }
    })
  ))
}

function clampMergedCells(mergedCells, rowCount, colCount) {
  return (mergedCells || [])
    .filter((merge) => {
      const row = merge.row ?? 0
      const col = merge.col ?? 0
      return row < rowCount && col < colCount
    })
    .map((merge) => {
      const row = merge.row ?? 0
      const col = merge.col ?? 0
      return {
        ...merge,
        row_span: Math.min(merge.row_span || 1, rowCount - row),
        col_span: Math.min(merge.col_span || 1, colCount - col),
      }
    })
}

export function listGraphicTables(report) {
  const tables = report?.graphic_components?.tables || []
  const hasDetected = tables.some((item) => (
    !item.is_baseline
    && ((item.frequency?.instance_count || 0) > 0 || (item.instances?.length || 0) > 0)
  ))
  if (hasDetected) return tables.filter((item) => !item.is_baseline)
  return tables
}

export function buildTableCapacity(component) {
  const raw = component.raw || component
  const defaultSize = raw.default_size || {}
  const previewRows = raw.data_preview?.rows || []
  const colWidths = raw.column_widths_pt || []
  const rowHeights = raw.row_heights_pt || []
  const structure = raw.structure || {}
  const headerRow = Number.isInteger(structure.header_row) ? structure.header_row : 0

  const knownRows = Math.max(
    defaultSize.rows || 0,
    previewRows.length,
    rowHeights.length,
    MIN_TABLE_ROWS,
  )
  const knownCols = Math.max(
    defaultSize.cols || 0,
    previewRows[0]?.length || 0,
    colWidths.length,
    MIN_TABLE_COLS,
  )

  const minRows = headerRow >= 0 ? headerRow + 2 : MIN_TABLE_ROWS

  return {
    row_count_min: minRows,
    col_count_min: MIN_TABLE_COLS,
    row_count_known: knownRows,
    col_count_known: knownCols,
    row_count_typical: knownRows,
    col_count_typical: knownCols,
    row_count_max: Math.max(knownRows + 3, Math.ceil(knownRows * 1.5), minRows),
    col_count_max: Math.max(knownCols + 2, Math.ceil(knownCols * 1.5), MIN_TABLE_COLS),
    header_row: headerRow,
  }
}

export function resizeTableMatrix(matrix, targetRows, targetCols, structure = {}) {
  const headerRow = Number.isInteger(structure.header_row) ? structure.header_row : 0
  const source = Array.isArray(matrix) && matrix.length ? matrix : []
  let next = source.map((row, rowIndex) => {
    const cells = [...(row || [])]
    while (cells.length < targetCols) {
      const colIndex = cells.length
      if (rowIndex === headerRow) {
        cells.push(`Column ${colIndex + 1}`)
      } else {
        cells.push(cells[cells.length - 1] ?? 'Value')
      }
    }
    return cells.slice(0, targetCols)
  })

  if (!next.length) {
    next = [Array.from({ length: targetCols }, (_, index) => `Column ${index + 1}`)]
  }

  while (next.length < targetRows) {
    const bodyTemplate = next[Math.max(headerRow + 1, next.length - 1)] || Array(targetCols).fill('Value')
    const rowIndex = next.length
    const row = bodyTemplate.map((_, colIndex) => (
      colIndex === 0 && headerRow === 0
        ? `Строка ${rowIndex - headerRow}`
        : 'Value'
    ))
    next.push(row)
  }

  return next.slice(0, targetRows)
}

export function resizeTableModelData(model, rowCount, colCount, structure = {}) {
  const matrix = tableDataToMatrix(model, structure)
  const resized = resizeTableMatrix(matrix, rowCount, colCount, structure)
  const payload = tableMatrixToDataPayload(resized, structure, { componentId: model.component_id })
  return {
    ...payload,
    row_count: rowCount,
    col_count: colCount,
  }
}

export function defaultTableModel(component, instance = null, report = null) {
  const raw = component.raw || {}
  const structure = raw.structure || {}
  const capacity = component.capacity || buildTableCapacity(component)
  let matrix = raw.data_preview?.rows || []

  if (instance?.element_id && report) {
    const slide = slideByNumber(report, instance.slide_number)
    const element = (slide?.content_elements || []).find((item) => item.element_id === instance.element_id)
    matrix = element?.preview
      || element?.table?.data_preview?.rows
      || matrix
  }

  const rowCount = matrix.length || capacity.row_count_typical
  const colCount = matrix[0]?.length || capacity.col_count_typical
  const payload = tableMatrixToDataPayload(matrix, structure, { componentId: component.id })
  return {
    ...payload,
    row_count: rowCount,
    col_count: colCount,
  }
}

export function resizeTableStructureMeta(element, rowCount, colCount, matrix = null) {
  const next = { ...(element || {}) }
  const tableMeta = { ...(next.table || {}) }
  const colWidths = tableMeta.column_widths_pt || []
  const rowHeights = tableMeta.row_heights_pt || []
  const blankStubs = listBlankStubCells(tableMeta)
  const previewMatrix = clearBlankStubCellsInMatrix(
    matrix
      || next.preview
      || tableMeta.data_preview?.rows
      || [],
    tableMeta,
  )
  const fallbackColWidth = colWidths.length
    ? colWidths.reduce((sum, value) => sum + value, 0) / colWidths.length
    : 80
  const fallbackRowHeight = rowHeights.length
    ? rowHeights.reduce((sum, value) => sum + value, 0) / rowHeights.length
    : 24

  const nextColumnWidths = colWidths.length
    ? extendColumnWidths(colWidths, colCount)
    : extendNumericList(colWidths, colCount, fallbackColWidth)
  const nextRowHeights = rowHeights.length
    ? extendRowHeights(rowHeights, rowCount, tableMeta)
    : extendNumericList(rowHeights, rowCount, fallbackRowHeight)

  const nextTableMeta = {
    ...tableMeta,
    column_widths_pt: nextColumnWidths,
    row_heights_pt: nextRowHeights,
    data_preview: { rows: previewMatrix },
    structure: {
      ...(tableMeta.structure || {}),
      merged_cells: clampMergedCells(tableMeta.structure?.merged_cells, rowCount, colCount),
      ...(blankStubs.length ? { blank_stub_cells: blankStubs } : {}),
    },
  }
  next.preview = previewMatrix

  const prototypes = inferPositionalPrototypes(tableMeta.cell_styles, tableMeta.cell_text, tableMeta)
  if (prototypes?.lastColIsSpecial || prototypes?.lastColTextIsSpecial) {
    nextTableMeta.structure = {
      ...nextTableMeta.structure,
      flags: {
        ...(nextTableMeta.structure?.flags || {}),
        last_col: true,
      },
    }
  }
  if (prototypes?.firstColIsSpecial) {
    nextTableMeta.structure = {
      ...nextTableMeta.structure,
      flags: {
        ...(nextTableMeta.structure?.flags || {}),
        first_col: true,
      },
    }
  }

  const sourceSize = resolveSourceTableSize(next, tableMeta, previewMatrix)
  const sizeChanged = rowCount !== sourceSize.rowCount || colCount !== sourceSize.colCount
  const styleSourceMeta = {
    ...tableMeta,
    preview_matrix: previewMatrix,
    column_widths_pt: colWidths.length ? colWidths : nextColumnWidths,
  }

  if (Array.isArray(tableMeta.cell_styles) && tableMeta.cell_styles.length) {
    nextTableMeta.cell_styles = sizeChanged
      ? resizeCellStylesGrid(tableMeta.cell_styles, rowCount, colCount, styleSourceMeta)
      : keepBlankStubCellStyles(tableMeta.cell_styles, tableMeta)
  }

  if (previewMatrix.length) {
    nextTableMeta.cell_text = (!sizeChanged && tableMeta.cell_text)
      ? updateCellTextFromMatrix(tableMeta.cell_text, previewMatrix, rowCount, colCount, tableMeta)
      : resizeCellTextGrid(
        tableMeta.cell_text,
        previewMatrix,
        rowCount,
        colCount,
        styleSourceMeta,
      )
  }

  if (tableMeta.content_model) {
    nextTableMeta.content_model = {
      ...tableMeta.content_model,
      rows: rowCount,
      columns: colCount,
    }
  }

  next.rows = rowCount
  next.cols = colCount
  next.table = nextTableMeta
  return next
}
