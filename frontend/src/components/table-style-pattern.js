function cloneValue(value) {
  if (typeof structuredClone === 'function') return structuredClone(value)
  return JSON.parse(JSON.stringify(value))
}

export function cellStyleSignature(style) {
  if (!style) return ''
  return JSON.stringify({
    fill: style.fill?.color || style.fill?.kind || null,
    typo: style.typography?.color || null,
    bold: style.typography?.bold || false,
    size: style.typography?.size_pt || null,
    family: style.typography?.family || null,
    align: style.typography?.alignment || null,
    borders: style.borders ? JSON.stringify(style.borders) : null,
  })
}

export function bandStyleSignature(style) {
  if (!style) return '_'
  return JSON.stringify({
    fill: style.fill?.color || style.fill?.kind || null,
  })
}

export function buildStyleIdMatrix(sourceGrid, signatureFn = bandStyleSignature) {
  const sigToId = new Map()
  const styleIds = {}
  const prototypes = {}
  let nextIndex = 0

  const idForSignature = (signature, prototype) => {
    if (!signature || signature === '_') return '_'
    if (!sigToId.has(signature)) {
      const id = String.fromCharCode(65 + nextIndex)
      nextIndex += 1
      sigToId.set(signature, id)
      styleIds[id] = signature
      prototypes[id] = prototype ? cloneValue(prototype) : null
    }
    return sigToId.get(signature)
  }

  const matrix = (sourceGrid || []).map((row) => (
    (row || []).map((cell) => idForSignature(signatureFn(cell), cell))
  ))

  return { matrix, styleIds, prototypes }
}

export function axisSignaturesFromMatrix(matrix, axis, compact = false) {
  if (!matrix.length) return []

  const compactSignature = (values) => {
    const unique = [...new Set(values.filter(Boolean))]
    if (unique.length === 1) return unique[0]
    return values.join('')
  }

  if (axis === 'row') {
    return matrix.map((row) => (compact ? compactSignature(row) : row.join('')))
  }

  const colCount = matrix[0]?.length || 0
  return Array.from({ length: colCount }, (_, colIndex) => {
    const values = matrix.map((row) => row[colIndex] || '_')
    return compact ? compactSignature(values) : values.join('')
  })
}

const DEFAULT_AXIS_OPTIONS = {
  minBodyMatchRate: 0.84,
  maxPeriod: 2,
  maxPrefixLen: 4,
  maxSuffixLen: 1,
  prefixPenalty: 0.015,
  suffixPenalty: 0.015,
  periodPenalty: 0.005,
}

export function inferAxisPattern(signatures, options = {}) {
  const config = { ...DEFAULT_AXIS_OPTIONS, ...options }
  const total = signatures?.length || 0
  if (total === 0) return null

  let best = null

  for (let prefixLen = 0; prefixLen <= Math.min(total, config.maxPrefixLen); prefixLen += 1) {
    for (let suffixLen = 0; suffixLen <= Math.min(total - prefixLen, config.maxSuffixLen); suffixLen += 1) {
      const bodyLen = total - prefixLen - suffixLen
      if (bodyLen <= 0) continue

      const bodySigs = signatures.slice(prefixLen, total - suffixLen)
      const maxPeriod = Math.min(bodyLen, config.maxPeriod)

      for (let period = 1; period <= maxPeriod; period += 1) {
        if (bodyLen > 1 && period >= bodyLen) continue

        const pattern = bodySigs.slice(0, period)
        let matches = 0
        for (let index = 0; index < bodyLen; index += 1) {
          if (bodySigs[index] === pattern[index % period]) matches += 1
        }
        const bodyMatchRate = matches / bodyLen
        if (bodyMatchRate < config.minBodyMatchRate) continue

        const complexity = prefixLen + suffixLen + period
        const score = bodyMatchRate
          - config.prefixPenalty * prefixLen
          - config.suffixPenalty * suffixLen
          - config.periodPenalty * period

        if (!best
          || score > best.score + 0.001
          || (Math.abs(score - best.score) <= 0.001 && complexity < best.complexity)) {
          best = {
            prefix: signatures.slice(0, prefixLen),
            body: { period, pattern: [...pattern] },
            suffix: signatures.slice(total - suffixLen),
            score,
            bodyMatchRate,
            complexity,
          }
        }
      }
    }
  }

  return best
}

function pickBodyRow(sourceGrid, tableMeta = {}) {
  const rowCount = sourceGrid?.length || 0
  if (!rowCount) return 0

  const headerRow = Number.isInteger(tableMeta.structure?.header_row)
    ? tableMeta.structure.header_row
    : 0
  return Math.min(Math.max(headerRow + 1, 0), rowCount - 1)
}

function pickBodyColumn(sourceColCount, columnWidthsPt = []) {
  if (sourceColCount <= 1) return 0
  if (columnWidthsPt.length >= 2 && columnWidthsPt[0] > columnWidthsPt[1] * 1.15 && sourceColCount > 2) {
    return 1
  }
  if (sourceColCount > 2) return 1
  return 0
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

function axisHasEdgeRole(axisPattern, edge) {
  if (!axisPattern) return false
  const { prefix, suffix, body } = axisPattern
  if (edge === 'suffix' && suffix.length === 1 && body?.pattern?.length) {
    return suffix[0] !== body.pattern[0]
  }
  if (edge === 'prefix' && prefix.length === 1 && body?.pattern?.length) {
    return prefix[0] !== body.pattern[0]
  }
  return false
}

export function resolveAxisTemplateIndex(index, axisPattern, sourceLength) {
  if (!axisPattern || sourceLength <= 0) return Math.max(0, Math.min(index, sourceLength - 1))

  const prefixLen = axisPattern.prefix.length
  const suffixLen = axisPattern.suffix.length
  const bodyEnd = sourceLength - suffixLen

  if (index < prefixLen) return index

  if (suffixLen > 0 && index >= sourceLength - suffixLen) {
    return bodyEnd + (index - (sourceLength - suffixLen))
  }

  const bodyOffset = Math.max(index - prefixLen, 0)
  const patternOffset = bodyOffset % axisPattern.body.period
  return prefixLen + patternOffset
}

function typographyColor(style) {
  return style?.typography?.color || null
}

function isTransparentTypography(typography) {
  if (!typography) return false
  if (typography.alpha === 0 || typography.opacity === 0) return true
  const color = typography.color
  if (color && typeof color === 'object' && color.alpha === 0) return true
  if (typeof color === 'string' && color.toLowerCase() === 'transparent') return true
  return false
}

export function cellHasVisibleText(cellTextEntry) {
  if (cellTextEntry == null) return false
  if (typeof cellTextEntry === 'string') return cellTextEntry.trim().length > 0
  const text = String(cellTextEntry.text ?? '').trim()
  if (!text) return false
  return !isTransparentTypography(cellTextEntry.typography)
}

function cellHasVisibleTextAt(tableMeta, rowIndex, colIndex) {
  const cellTextGrid = tableMeta.cell_text
  if (cellTextGrid?.[rowIndex]?.[colIndex] != null) {
    return cellHasVisibleText(cellTextGrid[rowIndex][colIndex])
  }
  const preview = tableMeta.preview_matrix || tableMeta.data_preview?.rows
  if (preview?.[rowIndex]?.[colIndex] !== undefined) {
    return cellHasVisibleText(String(preview[rowIndex][colIndex] ?? ''))
  }
  return false
}

function resolveTargetCellHasVisibleText(tableMeta, rowIndex, colIndex) {
  if (Array.isArray(tableMeta.preview_matrix)) {
    return cellHasVisibleText(String(tableMeta.preview_matrix?.[rowIndex]?.[colIndex] ?? ''))
  }
  return cellHasVisibleTextAt(tableMeta, rowIndex, colIndex)
}

export function headerRowIndex(tableMeta = {}) {
  return Number.isInteger(tableMeta.structure?.header_row)
    ? tableMeta.structure.header_row
    : 0
}

/**
 * Source cells that intentionally have no text (and thus no typography),
 * but sit in a header row that otherwise carries labels.
 * Classic case: NW corner of a table with column headers and row labels.
 * Uses cell_text / data_preview only — never the transient preview_matrix.
 * These cells must stay empty even when model data tries to fill them.
 */
export function listBlankStubCells(tableMeta = {}) {
  const explicit = tableMeta.structure?.blank_stub_cells
  if (Array.isArray(explicit)) {
    return explicit.filter((cell) => Array.isArray(cell) && cell.length === 2
      && Number.isInteger(cell[0]) && Number.isInteger(cell[1]))
  }
  const headerRow = headerRowIndex(tableMeta)
  const probe = {
    cell_text: tableMeta.cell_text,
    data_preview: tableMeta.data_preview,
    cell_styles: tableMeta.cell_styles,
    structure: tableMeta.structure,
  }
  const styleGrid = probe.cell_styles || []
  const preview = probe.data_preview?.rows || []
  const rowCount = Math.max(styleGrid.length, preview.length, headerRow + 1)
  const colCount = Math.max(styleGrid[0]?.length || 0, preview[0]?.length || 0)
  if (rowCount <= 0 || colCount <= 1) return []

  let headerHasText = false
  for (let colIndex = 0; colIndex < colCount; colIndex += 1) {
    if (cellHasVisibleTextAt(probe, headerRow, colIndex)) {
      headerHasText = true
      break
    }
  }
  if (!headerHasText) return []

  const stubs = []
  for (let colIndex = 0; colIndex < colCount; colIndex += 1) {
    if (cellHasVisibleTextAt(probe, headerRow, colIndex)) continue
    stubs.push([headerRow, colIndex])
  }
  return stubs
}

export function isBlankStubCell(tableMeta, rowIndex, colIndex) {
  return listBlankStubCells(tableMeta).some(([row, col]) => row === rowIndex && col === colIndex)
}

export function clearBlankStubCellsInMatrix(matrix, tableMeta = {}) {
  const stubs = listBlankStubCells(tableMeta)
  if (!stubs.length || !Array.isArray(matrix)) return matrix
  return matrix.map((row, rowIndex) => {
    if (!Array.isArray(row)) return row
    const next = [...row]
    for (const [stubRow, stubCol] of stubs) {
      if (stubRow === rowIndex && stubCol < next.length) next[stubCol] = ''
    }
    return next
  })
}

export function borrowHeaderTypography(tableMeta = {}, sourceGrid = [], rowIndex = 0) {
  const headerRow = headerRowIndex(tableMeta)
  const tokens = tableMeta.style_tokens || {}
  const token = tokens.header_cell || tokens.first_row_cell || tokens.body_cell || tokens.whole_cell
  if (token?.typography) {
    const typography = {}
    TYPOGRAPHY_FIELDS.forEach((field) => {
      if (token.typography[field] != null) typography[field] = token.typography[field]
    })
    if (Object.keys(typography).length) return typography
  }

  const colCount = sourceGrid[headerRow]?.length
    || tableMeta.cell_styles?.[headerRow]?.length
    || tableMeta.data_preview?.rows?.[headerRow]?.length
    || 0
  for (let colIndex = 0; colIndex < colCount; colIndex += 1) {
    if (!cellHasVisibleTextAt(tableMeta, headerRow, colIndex)) continue
    const cellTypo = cellTypographyAt(tableMeta, sourceGrid, headerRow, colIndex)
    const typography = {}
    TYPOGRAPHY_FIELDS.forEach((field) => {
      if (cellTypo[field] != null) typography[field] = cellTypo[field]
    })
    if (Object.keys(typography).length) return typography
  }

  const inferred = inferRowTypography(sourceGrid, rowIndex === headerRow ? headerRow : rowIndex, null, tableMeta)
  return inferred
}

function stripCellStyleTypography(style) {
  if (!style?.typography) return style
  const { typography, ...rest } = style
  return rest
}

const TYPOGRAPHY_FIELDS = ['color', 'size_pt', 'family', 'bold', 'alignment']

function typographySignature(typography) {
  if (!typography) return ''
  return JSON.stringify({
    color: typography.color || null,
    size: typography.size_pt || null,
    family: typography.family || null,
    bold: typography.bold || false,
    align: typography.alignment || null,
  })
}

function resolveBodyTypographyBounds(sourceRowCount, tableMeta = {}, pattern = null) {
  const headerRow = Number.isInteger(tableMeta.structure?.header_row)
    ? tableMeta.structure.header_row
    : (pattern?.roles?.header_row ?? 0)
  const suffixLen = pattern?.rows?.suffix?.length || 0
  const bodyEnd = suffixLen > 0 && pattern?.roles?.last_row
    ? sourceRowCount - suffixLen
    : sourceRowCount
  const bodyStart = Math.min(Math.max(headerRow + 1, 0), Math.max(bodyEnd - 1, 0))
  const bodyCount = Math.max(bodyEnd - bodyStart, 1)
  return { bodyStart, bodyEnd, bodyCount }
}

function resolveBodyTypographyTemplateRow(rowIndex, sourceRowCount, tableMeta = {}, pattern = null) {
  const { bodyStart, bodyCount } = resolveBodyTypographyBounds(sourceRowCount, tableMeta, pattern)
  const bodyOffset = Math.max(rowIndex - bodyStart, 0)
  return bodyStart + (bodyOffset % bodyCount)
}

function typographyTemplateRowDiffersFromBody(templateRow, tableMeta, sourceGrid, pattern) {
  if (!sourceGrid?.length) return false
  const { bodyStart } = resolveBodyTypographyBounds(sourceGrid.length, tableMeta, pattern)
  if (templateRow === bodyStart) return false

  const sourceColCount = sourceGrid[0]?.length || 0
  const bodyCol = pickBodyColumn(sourceColCount, tableMeta.column_widths_pt || [])
  const compareCols = [bodyCol]
  if (detectFirstColTypographyRole(tableMeta, sourceGrid)) {
    compareCols.unshift(0)
  }
  if (detectLastColTypographyRole(tableMeta, sourceGrid)) {
    compareCols.push(sourceColCount - 1)
  }

  return compareCols.some((colIndex) => {
    const templateSig = typographySignature(cellTypographyAt(tableMeta, sourceGrid, templateRow, colIndex))
    const bodySig = typographySignature(cellTypographyAt(tableMeta, sourceGrid, bodyStart, colIndex))
    return templateSig !== bodySig
  })
}

function resolveTypographyRowIndex(
  rowIndex,
  pattern,
  sourceRowCount,
  tableMeta = {},
  sourceGrid = [],
  targetRowCount = 0,
) {
  if (sourceRowCount <= 0) return 0
  if (rowIndex < sourceRowCount) return rowIndex

  const suffixLen = pattern?.rows?.suffix?.length || 0
  if (suffixLen > 0 && pattern?.roles?.last_row && targetRowCount > 0) {
    if (rowIndex === targetRowCount - 1) return sourceRowCount - 1
    if (rowIndex >= targetRowCount - suffixLen) {
      return sourceRowCount - suffixLen + (rowIndex - (targetRowCount - suffixLen))
    }
  }

  if (pattern?.rows?.body?.period > 1) {
    return resolveAxisTemplateIndex(rowIndex, pattern.rows, sourceRowCount)
  }

  if (pattern?.rows) {
    const axisRow = resolveAxisTemplateIndex(rowIndex, pattern.rows, sourceRowCount)
    if (!typographyTemplateRowDiffersFromBody(axisRow, tableMeta, sourceGrid, pattern)) {
      return axisRow
    }
  }

  return resolveBodyTypographyTemplateRow(rowIndex, sourceRowCount, tableMeta, pattern)
}

function detectFirstColTypographyRole(tableMeta, sourceGrid) {
  if (tableMeta.structure?.flags?.first_col) return true

  const sourceColCount = sourceGrid?.[0]?.length || 0
  if (sourceColCount <= 1) return false

  const bodyCol = pickBodyColumn(sourceColCount, tableMeta.column_widths_pt || [])
  if (bodyCol === 0) return false

  const headerRow = Number.isInteger(tableMeta.structure?.header_row)
    ? tableMeta.structure.header_row
    : 0
  const cellTextGrid = tableMeta.cell_text
  let matches = 0
  let checks = 0

  for (let rowIndex = headerRow + 1; rowIndex < sourceGrid.length; rowIndex += 1) {
    if (!cellHasVisibleTextAt(tableMeta, rowIndex, 0)) continue
    if (!cellHasVisibleTextAt(tableMeta, rowIndex, bodyCol)) continue
    checks += 1
    const firstColTypo = cellTextGrid?.[rowIndex]?.[0]?.typography
      || sourceGrid[rowIndex]?.[0]?.typography
    const bodyTypo = cellTextGrid?.[rowIndex]?.[bodyCol]?.typography
      || sourceGrid[rowIndex]?.[bodyCol]?.typography
    if (typographySignature(firstColTypo) !== typographySignature(bodyTypo)) {
      matches += 1
    }
  }

  return checks >= 2 && matches / checks >= 0.6
}

function detectLastColTypographyRole(tableMeta, sourceGrid) {
  if (tableMeta.structure?.flags?.last_col) return true

  const sourceColCount = sourceGrid?.[0]?.length || 0
  if (sourceColCount <= 1) return false

  const bodyCol = pickBodyColumn(sourceColCount, tableMeta.column_widths_pt || [])
  const sourceLastCol = sourceColCount - 1
  if (bodyCol === sourceLastCol) return false

  const headerRow = Number.isInteger(tableMeta.structure?.header_row)
    ? tableMeta.structure.header_row
    : 0
  let matches = 0
  let checks = 0

  for (let rowIndex = headerRow + 1; rowIndex < sourceGrid.length; rowIndex += 1) {
    if (!cellHasVisibleTextAt(tableMeta, rowIndex, sourceLastCol)) continue
    if (!cellHasVisibleTextAt(tableMeta, rowIndex, bodyCol)) continue
    checks += 1
    const lastColTypo = cellTypographyAt(tableMeta, sourceGrid, rowIndex, sourceLastCol)
    const bodyTypo = cellTypographyAt(tableMeta, sourceGrid, rowIndex, bodyCol)
    if (typographySignature(lastColTypo) !== typographySignature(bodyTypo)) {
      matches += 1
    }
  }

  return checks >= 2 && matches / checks >= 0.6
}

function cellTypographyAt(tableMeta, sourceGrid, rowIndex, colIndex) {
  const cellTextEntry = tableMeta.cell_text?.[rowIndex]?.[colIndex]
  if (cellTextEntry && cellHasVisibleText(cellTextEntry)) {
    return cellTextEntry.typography || {}
  }
  return sourceGrid[rowIndex]?.[colIndex]?.typography || {}
}

function inferFirstColTypography(sourceGrid, rowIndex, pattern, tableMeta, targetRowCount = 0) {
  const sourceRowCount = sourceGrid?.length || 0
  if (!sourceRowCount) return null

  const typographyRowIndex = resolveTypographyRowIndex(
    rowIndex,
    pattern,
    sourceRowCount,
    tableMeta,
    sourceGrid,
    targetRowCount,
  )
  const cellTypo = cellTypographyAt(tableMeta, sourceGrid, typographyRowIndex, 0)
  const typography = {}
  TYPOGRAPHY_FIELDS.forEach((field) => {
    if (cellTypo[field] != null) typography[field] = cellTypo[field]
  })
  return Object.keys(typography).length ? typography : null
}

function inferLastColTypography(sourceGrid, rowIndex, pattern, tableMeta, targetRowCount = 0) {
  const sourceColCount = sourceGrid?.[0]?.length || 0
  if (!sourceColCount) return null

  const sourceLastCol = sourceColCount - 1
  const typographyRowIndex = resolveTypographyRowIndex(
    rowIndex,
    pattern,
    sourceGrid.length,
    tableMeta,
    sourceGrid,
    targetRowCount,
  )
  const cellTypo = cellTypographyAt(tableMeta, sourceGrid, typographyRowIndex, sourceLastCol)
  const typography = {}
  TYPOGRAPHY_FIELDS.forEach((field) => {
    if (cellTypo[field] != null) typography[field] = cellTypo[field]
  })
  return Object.keys(typography).length ? typography : null
}

function inferRowTypography(sourceGrid, rowIndex, pattern, tableMeta, options = {}) {
  const sourceRowCount = sourceGrid?.length || 0
  if (!sourceRowCount) return null

  const skipFirstCol = options.skipFirstCol === true
  const skipLastCol = options.skipLastCol === true
  const typographyRowIndex = resolveTypographyRowIndex(
    rowIndex,
    pattern,
    sourceRowCount,
    tableMeta,
    sourceGrid,
    options.targetRowCount || 0,
  )
  const sourceColCount = sourceGrid[0]?.length || 0
  const bodyCol = pickBodyColumn(sourceColCount, tableMeta.column_widths_pt || [])
  const accentCol = sourceColCount - 1
  const hasAccentCol = isAccentColumn(sourceGrid, accentCol, bodyCol)
  const sourceLastCol = sourceColCount - 1
  const sourceRow = sourceGrid[typographyRowIndex] || []
  const typography = {}

  for (let colIndex = 0; colIndex < sourceRow.length; colIndex += 1) {
    if (skipFirstCol && colIndex === 0) continue
    if (skipLastCol && colIndex === sourceLastCol) continue
    if (!skipLastCol && hasAccentCol && colIndex === accentCol) continue
    if (!cellHasVisibleTextAt(tableMeta, typographyRowIndex, colIndex)) continue
    const cellTypo = cellTypographyAt(tableMeta, sourceGrid, typographyRowIndex, colIndex)
    TYPOGRAPHY_FIELDS.forEach((field) => {
      if (typography[field] == null && cellTypo[field] != null) {
        typography[field] = cellTypo[field]
      }
    })
  }

  const prefixLen = pattern?.rows?.prefix?.length || 0
  if (prefixLen > 1 && rowIndex > 0 && rowIndex < prefixLen) {
    const prefixRow = sourceGrid[prefixLen - 1] || []
    for (let colIndex = 0; colIndex < prefixRow.length; colIndex += 1) {
      if (skipFirstCol && colIndex === 0) continue
      if (skipLastCol && colIndex === sourceLastCol) continue
      if (!skipLastCol && hasAccentCol && colIndex === accentCol) continue
      if (!cellHasVisibleTextAt(tableMeta, prefixLen - 1, colIndex)) continue
      const cellTypo = cellTypographyAt(tableMeta, sourceGrid, prefixLen - 1, colIndex)
      TYPOGRAPHY_FIELDS.forEach((field) => {
        if (typography[field] == null && cellTypo[field] != null) {
          typography[field] = cellTypo[field]
        }
      })
    }
  }

  return Object.keys(typography).length ? typography : null
}

function isAccentColumn(sourceGrid, colIndex, bodyCol = 0) {
  const sourceColCount = sourceGrid?.[0]?.length || 0
  if (colIndex !== sourceColCount - 1 || sourceColCount <= 1) return false

  const bodySample = sourceGrid.find((row) => row?.[bodyCol])?.[bodyCol]
  const accentSample = sourceGrid.find((row) => row?.[colIndex])?.[colIndex]
  if (!bodySample || !accentSample) return false

  return bandStyleSignature(bodySample) !== bandStyleSignature(accentSample)
}

function inferRowTextColor(sourceGrid, rowIndex, pattern = null, tableMeta = {}, options = {}) {
  const sourceColCount = sourceGrid?.[0]?.length || 0
  const bodyCol = pickBodyColumn(sourceColCount, tableMeta.column_widths_pt || [])
  const accentCol = sourceColCount - 1
  const hasAccentCol = isAccentColumn(sourceGrid, accentCol, bodyCol)
  const skipFirstCol = options.skipFirstCol === true
  const skipLastCol = options.skipLastCol === true
  const sourceLastCol = sourceColCount - 1
  const typographyRowIndex = resolveTypographyRowIndex(
    rowIndex,
    pattern,
    sourceGrid.length,
    tableMeta,
    sourceGrid,
    options.targetRowCount || 0,
  )
  const sourceRow = sourceGrid?.[typographyRowIndex] || []

  for (let colIndex = 0; colIndex < sourceRow.length; colIndex += 1) {
    if (skipFirstCol && colIndex === 0) continue
    if (skipLastCol && colIndex === sourceLastCol) continue
    if (!skipLastCol && hasAccentCol && colIndex === accentCol) continue
    if (!cellHasVisibleTextAt(tableMeta, typographyRowIndex, colIndex)) continue
    const color = typographyColor(cellTypographyAt(tableMeta, sourceGrid, typographyRowIndex, colIndex))
      || typographyColor(sourceRow[colIndex])
    if (color) return color
  }

  const prefixLen = pattern?.rows?.prefix?.length || 0
  if (prefixLen > 1 && rowIndex > 0 && rowIndex < prefixLen) {
    for (let colIndex = 0; colIndex < (sourceGrid[prefixLen - 1]?.length || 0); colIndex += 1) {
      if (skipFirstCol && colIndex === 0) continue
      if (skipLastCol && colIndex === sourceLastCol) continue
      if (!skipLastCol && hasAccentCol && colIndex === accentCol) continue
      if (!cellHasVisibleTextAt(tableMeta, prefixLen - 1, colIndex)) continue
      const color = typographyColor(cellTypographyAt(tableMeta, sourceGrid, prefixLen - 1, colIndex))
        || typographyColor(sourceGrid[prefixLen - 1]?.[colIndex])
      if (color) return color
    }
  }

  return null
}

export function inferDefaultTableTextColor(sourceGrid, tableMeta = {}, options = {}) {
  const tokens = tableMeta.style_tokens || {}
  const rules = tableMeta.style_rules || {}
  const sourceColCount = sourceGrid?.[0]?.length || 0
  const bodyCol = pickBodyColumn(sourceColCount, tableMeta.column_widths_pt || [])
  const accentCol = sourceColCount - 1
  const hasAccentCol = isAccentColumn(sourceGrid, accentCol, bodyCol)
  const skipLastCol = options.skipLastCol ?? hasAccentCol
  const prefixLen = options.prefixLen ?? 0

  const counts = new Map()
  sourceGrid.forEach((row, rowIndex) => {
    if (prefixLen > 0 && rowIndex < prefixLen) return
    row.forEach((cell, colIndex) => {
      if (skipLastCol && colIndex === accentCol) return
      if (!cellHasVisibleTextAt(tableMeta, rowIndex, colIndex)) return
      const color = typographyColor(cell)
      if (color) counts.set(color, (counts.get(color) || 0) + 1)
    })
  })

  if (counts.size) {
    return [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0]
  }

  for (const key of ['band2_row_cell', 'whole_cell', 'header_cell', 'first_row_cell', 'body_cell']) {
    const color = typographyColor(tokens[key])
    if (color) return color
  }

  for (const key of ['wholeTbl', 'band1H', 'band2H', 'firstRow']) {
    const color = typographyColor(rules[key])
    if (color) return color
  }

  return '#000000'
}

export function completeCellStyleTypography(
  style,
  tableMeta = {},
  rowIndex = 0,
  colIndex = 0,
  targetRowCount = 0,
  targetColCount = 0,
  sourceGrid = [],
  pattern = null,
) {
  if (!style) return style

  if (!resolveTargetCellHasVisibleText(tableMeta, rowIndex, colIndex)) {
    return stripCellStyleTypography(style)
  }

  // Design stubs (empty header corner) stay empty: never invent typography for them
  // even if transient target text briefly appeared in preview_matrix.
  if (isBlankStubCell(tableMeta, rowIndex, colIndex)) {
    return stripCellStyleTypography(style)
  }

  const sourceColCount = sourceGrid?.[0]?.length || 0
  const bodyCol = pickBodyColumn(sourceColCount, tableMeta.column_widths_pt || [])
  const accentSourceCol = sourceColCount - 1
  const hasAccentCol = isAccentColumn(sourceGrid, accentSourceCol, bodyCol)
  const tokens = tableMeta.style_tokens || {}
  const rules = tableMeta.style_rules || {}
  const firstColRole = pattern?.roles?.first_col || detectFirstColTypographyRole(tableMeta, sourceGrid)
  const lastColRole = pattern?.roles?.last_col || detectLastColTypographyRole(tableMeta, sourceGrid) || hasAccentCol
  const isTargetLastCol = lastColRole && colIndex === targetColCount - 1
  const typographyRowIndex = resolveTypographyRowIndex(
    rowIndex,
    pattern,
    sourceGrid.length,
    tableMeta,
    sourceGrid,
    targetRowCount,
  )
  let typography = {}

  if (firstColRole && colIndex === 0) {
    typography = {
      ...(inferFirstColTypography(sourceGrid, rowIndex, pattern, tableMeta, targetRowCount) || {}),
    }
  } else if (isTargetLastCol) {
    typography = {
      ...(inferLastColTypography(sourceGrid, rowIndex, pattern, tableMeta, targetRowCount) || {}),
    }
  } else {
    typography = {
      ...(inferRowTypography(sourceGrid, rowIndex, pattern, tableMeta, {
        skipFirstCol: firstColRole,
        skipLastCol: lastColRole,
        targetRowCount,
      }) || {}),
    }
  }

  const typographyColIndex = isTargetLastCol
    ? accentSourceCol
    : (lastColRole && colIndex === accentSourceCol && colIndex !== targetColCount - 1
      ? bodyCol
      : colIndex)
  const cellTextTypo = cellTypographyAt(tableMeta, sourceGrid, typographyRowIndex, typographyColIndex)
  TYPOGRAPHY_FIELDS.forEach((field) => {
    if (cellTextTypo[field] != null) typography[field] = cellTextTypo[field]
  })

  if (isTargetLastCol) {
    if (cellHasVisibleTextAt(tableMeta, typographyRowIndex, accentSourceCol)) {
      Object.assign(typography, cellTypographyAt(tableMeta, sourceGrid, typographyRowIndex, accentSourceCol))
    }
    TYPOGRAPHY_FIELDS.forEach((field) => {
      if (typography[field] != null) return
      const tokenValue = tokens.last_col_cell?.typography?.[field] ?? tokens.last_col_cell?.[field]
      const ruleValue = rules.lastCol?.typography?.[field] ?? rules.lastCol?.[field]
      if (tokenValue != null) typography[field] = tokenValue
      else if (ruleValue != null) typography[field] = ruleValue
    })
  }

  if (!typography.color) {
    const accentColor = isTargetLastCol
      ? (typographyColor(tokens.last_col_cell) || typographyColor(rules.lastCol))
      : null
    const rowColor = accentColor || inferRowTextColor(sourceGrid, rowIndex, pattern, tableMeta, {
      skipFirstCol: firstColRole && colIndex !== 0,
      skipLastCol: lastColRole && !isTargetLastCol,
      targetRowCount,
    })
    typography.color = rowColor || inferDefaultTableTextColor(sourceGrid, tableMeta, {
      skipLastCol: lastColRole,
      prefixLen: pattern?.rows?.prefix?.length || 0,
    })
  }

  return { ...style, typography }
}

export function resolveTemplateCoords(
  rowIndex,
  colIndex,
  pattern,
  sourceRowCount,
  sourceColCount,
  targetRowCount,
  targetColCount,
  columnWidthsPt = [],
) {
  const bodySourceCols = pattern.roles.last_col
    ? Math.max(sourceColCount - 1, 1)
    : sourceColCount
  const accentSourceCol = sourceColCount - 1

  let templateRow = resolveAxisTemplateIndex(rowIndex, pattern.rows, sourceRowCount)
  let templateCol = colIndex

  if (pattern.roles.last_row && rowIndex === targetRowCount - 1) {
    templateRow = sourceRowCount - 1
  } else if (targetRowCount !== sourceRowCount && pattern.rows?.suffix?.length) {
    templateRow = resolveAxisTemplateIndex(
      rowIndex,
      { ...pattern.rows, suffix: [] },
      sourceRowCount,
    )
  }

  if (pattern.roles.last_col && colIndex === targetColCount - 1) {
    templateCol = accentSourceCol
  } else if (pattern.roles.last_col && targetColCount !== sourceColCount) {
    templateCol = colIndex < bodySourceCols
      ? colIndex
      : templateColIndex(colIndex, bodySourceCols, columnWidthsPt)
    templateCol = Math.min(templateCol, bodySourceCols - 1)
  } else if (colIndex < sourceColCount) {
    templateCol = colIndex
  } else {
    templateCol = templateColIndex(colIndex, sourceColCount, columnWidthsPt)
  }

  if (pattern.rows?.prefix?.length && rowIndex < pattern.rows.prefix.length) {
    templateRow = rowIndex
  }

  if (pattern.roles.first_col && colIndex === 0) {
    templateCol = 0
  }

  templateRow = Math.min(Math.max(templateRow, 0), sourceRowCount - 1)
  templateCol = Math.min(Math.max(templateCol, 0), sourceColCount - 1)
  return { templateRow, templateCol }
}

function scorePatternAgainstMatrix(idMatrix, pattern, columnWidthsPt = []) {
  const rowCount = idMatrix.length
  const colCount = idMatrix[0]?.length || 0
  if (!rowCount || !colCount) return 0

  let matches = 0
  for (let rowIndex = 0; rowIndex < rowCount; rowIndex += 1) {
    for (let colIndex = 0; colIndex < colCount; colIndex += 1) {
      const { templateRow, templateCol } = resolveTemplateCoords(
        rowIndex,
        colIndex,
        pattern,
        rowCount,
        colCount,
        rowCount,
        colCount,
        columnWidthsPt,
      )
      if (idMatrix[templateRow][templateCol] === idMatrix[rowIndex][colIndex]) matches += 1
    }
  }
  return matches / (rowCount * colCount)
}

export function inferTableStylePattern(sourceGrid, tableMeta = {}) {
  if (!Array.isArray(sourceGrid) || !sourceGrid.length) return null

  const { matrix, styleIds, prototypes } = buildStyleIdMatrix(sourceGrid)
  const rowSignatures = axisSignaturesFromMatrix(matrix, 'row', true)
  const colSignatures = axisSignaturesFromMatrix(matrix, 'col', false)

  const rows = inferAxisPattern(rowSignatures, { maxSuffixLen: 1, maxPrefixLen: 4 })
  const columns = inferAxisPattern(colSignatures, { maxSuffixLen: 1, maxPrefixLen: 2 })
  if (!rows && !columns) return null

  const rowCount = matrix.length
  const colCount = matrix[0]?.length || 0
  const columnWidthsPt = tableMeta.column_widths_pt || []

  const pattern = {
    version: 1,
    style_ids: styleIds,
    prototypes,
    matrix,
    rows,
    columns,
    roles: {
      header_row: Number.isInteger(tableMeta.structure?.header_row)
        ? tableMeta.structure.header_row
        : 0,
      last_col: axisHasEdgeRole(columns, 'suffix') || detectLastColTypographyRole(tableMeta, sourceGrid),
      first_col: axisHasEdgeRole(columns, 'prefix') || detectFirstColTypographyRole(tableMeta, sourceGrid),
      last_row: axisHasEdgeRole(rows, 'suffix'),
      body_row: pickBodyRow(sourceGrid, tableMeta),
      body_col: pickBodyColumn(colCount, columnWidthsPt),
    },
    confidence: 0,
  }

  pattern.confidence = scorePatternAgainstMatrix(matrix, pattern, columnWidthsPt)
  if (pattern.confidence < 0.85) return null

  return pattern
}

export function resolveCellPrototype(
  rowIndex,
  colIndex,
  pattern,
  sourceGrid,
  targetRowCount = sourceGrid.length,
  targetColCount = sourceGrid[0]?.length || 0,
  columnWidthsPt = [],
  tableMeta = {},
) {
  const sourceRowCount = sourceGrid.length
  const sourceColCount = sourceGrid[0]?.length || 0
  if (!sourceRowCount || !sourceColCount) return null

  let style = null

  if (rowIndex < sourceRowCount && colIndex < sourceColCount) {
    if (pattern.rows?.prefix?.length && rowIndex < pattern.rows.prefix.length) {
      style = sourceGrid[rowIndex]?.[colIndex]
      if (style) style = cloneValue(style)
    }
  }

  if (!style) {
    const { templateRow, templateCol } = resolveTemplateCoords(
      rowIndex,
      colIndex,
      pattern,
      sourceRowCount,
      sourceColCount,
      targetRowCount,
      targetColCount,
      columnWidthsPt,
    )

    const template = sourceGrid[templateRow]?.[templateCol]
      || sourceGrid[templateRow]?.[pattern.roles.body_col]
      || sourceGrid[pattern.roles.body_row]?.[templateCol]
      || sourceGrid[pattern.roles.body_row]?.[pattern.roles.body_col]
      || sourceGrid[0]?.[0]

    style = template ? cloneValue(template) : null
  }

  return style
    ? completeCellStyleTypography(
      style,
      tableMeta,
      rowIndex,
      colIndex,
      targetRowCount,
      targetColCount,
      sourceGrid,
      pattern,
    )
    : null
}

export function rebuildCellStylesFromPattern(
  sourceGrid,
  rowCount,
  colCount,
  tableMeta = {},
  pattern = null,
) {
  const resolvedPattern = pattern || inferTableStylePattern(sourceGrid, tableMeta)
  if (!resolvedPattern) return null

  const columnWidthsPt = tableMeta.column_widths_pt || []
  return Array.from({ length: rowCount }, (_, rowIndex) => (
    Array.from({ length: colCount }, (_, colIndex) => (
      resolveCellPrototype(
        rowIndex,
        colIndex,
        resolvedPattern,
        sourceGrid,
        rowCount,
        colCount,
        columnWidthsPt,
        tableMeta,
      )
    ))
  ))
}

export function describeTableStylePattern(pattern) {
  if (!pattern) return null

  const describeAxis = (axisPattern, label) => {
    if (!axisPattern) return `${label}: uniform`
    const prefixPart = axisPattern.prefix.length
      ? `${label} prefix ${axisPattern.prefix.length}`
      : `${label} prefix 0`
    const suffixPart = axisPattern.suffix.length
      ? `, suffix ${axisPattern.suffix.length}`
      : ''
    return `${prefixPart}, body period ${axisPattern.body.period}${suffixPart}`
  }

  return {
    summary: [describeAxis(pattern.rows, 'rows'), describeAxis(pattern.columns, 'cols')].join('; '),
    confidence: pattern.confidence,
    matrix: pattern.matrix,
    roles: pattern.roles,
  }
}
