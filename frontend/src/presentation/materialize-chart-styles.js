import { extractDesignTokens } from '../constructor/tokens.js'
import { contrastRatio, darkSurfaceFillColor, surfaceFillColor } from './component-template-fit.js'
import {
  resolveChartFillVariants,
  resolveChartPalette,
  resolveChartTextColor,
  resolveSeriesDisplayColor,
} from '../slides/chart-render.js'
import { resolveDiagramRenderStyle } from '../slides/diagram-render.js'
import {
  buildTableMatrix,
  resolveTableLayoutWidthPt,
  resolveTableTextColor,
  resolveTableTextSizePt,
} from '../slides/table-render.js'
import { planSlideChartLabels } from './chart-labels.js'
import { measureTextWidthPt, wrapText } from './text-measure.js'

const TOKEN_CACHE = new WeakMap()
const CIRCULAR_TYPES = new Set(['pie', 'doughnut', 'donut'])
// Series fills (bars, areas, slices) need at least this contrast against the
// surface; a chart moved onto a template whose background equals the first
// series colour would otherwise draw invisible bars.
const MIN_SERIES_CONTRAST = 1.8
const TABLE_RIGHT_MARGIN_NORM = 0.04
const TABLE_EXPAND_MIN_DELTA_PT = 8
const TABLE_EXPAND_NARROW_RATIO = 0.92
const TABLE_TARGET_MAX_LINES = 2

export function contrastingPalette(palette, surface) {
  if (!surface || !palette.length) return palette
  const visible = palette.filter((color) => contrastRatio(color, surface) >= MIN_SERIES_CONTRAST)
  if (!visible.length || visible.length === palette.length) return palette
  return [...visible, ...palette.filter((color) => !visible.includes(color))]
}

function tokensForReport(report) {
  if (!report || typeof report !== 'object') return null
  if (!TOKEN_CACHE.has(report)) TOKEN_CACHE.set(report, extractDesignTokens(report))
  return TOKEN_CACHE.get(report)
}

function chartDataSize(element) {
  const chart = element.chart || {}
  const categories = chart.categories_preview || element.categories_preview || []
  const series = chart.series || element.series_preview || []
  return {
    categoryCount: categories.length,
    seriesCount: series.length,
  }
}

function materializeChartElement(element, tokens, surfaceColor = null, seriesSurface = null) {
  const chart = element.chart || {}
  const chartType = String(element.chart_type || chart.type || 'bar').toLowerCase()
  const { categoryCount, seriesCount } = chartDataSize(element)
  const colorCount = CIRCULAR_TYPES.has(chartType)
    ? Math.max(2, categoryCount, seriesCount)
    : Math.max(2, seriesCount)
  const palette = resolveChartPalette(element, tokens, {
    minColors: colorCount,
    preferDesignSystem: true,
  })
  const fillVariants = resolveChartFillVariants(element, tokens)
  // Native PPTX chart fills only preserve solid colors. Resolve gradients to
  // the same representative color before both DOM preview and export.
  const exportPalette = contrastingPalette(fillVariants.length
    ? palette.map((_, index) => resolveSeriesDisplayColor(fillVariants, palette, index))
    : palette, seriesSurface)
  const styleTokens = {
    ...(chart.style_tokens || element.style_tokens || {}),
    series_palette: exportPalette.map((color) => ({ color })),
  }
  for (const tokenKey of ['category_axis', 'value_axis', 'legend']) {
    const token = styleTokens[tokenKey] || {}
    const typography = token.typography || {}
    styleTokens[tokenKey] = {
      ...token,
      typography: {
        ...typography,
        color: resolveChartTextColor(tokens, styleTokens, {
          typography,
          tokenKey,
          preferBody: true,
          surfaceColor,
        }),
      },
    }
  }
  if (fillVariants.length) {
    styleTokens.series_fill_variants = exportPalette.map((color) => ({ kind: 'solid', color }))
  }

  return {
    ...element,
    series_palette: exportPalette,
    chart: {
      ...chart,
      series_palette: exportPalette,
      style_tokens: styleTokens,
    },
  }
}

function materializeDiagramElement(element, tokens) {
  const resolved = resolveDiagramRenderStyle(element, tokens)
  const current = element.diagram?.style_tokens || element.style_tokens || {}
  const styleTokens = {
    ...current,
    connector: {
      ...(current.connector || {}),
      color: { color: resolved.connector.color },
      width_pt: resolved.connector.widthPt,
      dash: resolved.connector.dash,
    },
    node: {
      ...(current.node || {}),
      fill: { kind: 'solid', color: resolved.node.fill },
      border: {
        ...(current.node?.border || {}),
        color: { color: resolved.node.borderColor },
        width_pt: resolved.node.borderWidthPt,
        dash: resolved.node.borderDash,
      },
      typography: {
        ...(current.node?.typography || {}),
        family: resolved.typography.family,
        size_pt: resolved.typography.sizePt,
        color: resolved.typography.color,
        bold: resolved.typography.bold,
        alignment: resolved.typography.alignment,
      },
    },
    arrow: {
      ...(current.arrow || {}),
      head_type: resolved.connector.headType,
      tail_type: resolved.connector.tailType,
    },
  }
  return {
    ...element,
    style_tokens: styleTokens,
    diagram: {
      ...(element.diagram || {}),
      style_tokens: styleTokens,
    },
  }
}

function tableBodyFontSizePt(tokens) {
  const size = Number(tokens?.bodyTypographyOptions?.[0]?.sizePt)
  return Number.isFinite(size) && size > 0 ? size : 14
}

function tableCellText(table, matrix, rowIndex, colIndex) {
  const cellText = table.cell_text?.[rowIndex]?.[colIndex]
  if (cellText?.text_segments?.length) {
    return cellText.text_segments.map((segment) => segment?.text || '').join('\n').trim()
  }
  if (cellText?.text != null) return String(cellText.text).trim()
  return String(matrix?.[rowIndex]?.[colIndex] ?? '').trim()
}

function tableCellTypography(table, styleTokens, tokens, rowIndex, colIndex) {
  const headerRow = table.structure?.header_row ?? 0
  const isHeader = rowIndex === headerRow
  const tokenKey = isHeader ? 'header_cell' : 'body_cell'
  const source = table.cell_text?.[rowIndex]?.[colIndex]?.typography
    || table.cell_styles?.[rowIndex]?.[colIndex]?.typography
    || styleTokens[tokenKey]?.typography
    || styleTokens.body_cell?.typography
    || styleTokens.whole_cell?.typography
    || {}
  return {
    ...source,
    family: source.family || tokens?.defaultFontFamily,
    size_pt: resolveTableTextSizePt(tokens, styleTokens, {
      typography: source,
      tokenKey,
      isHeader,
    }),
  }
}

function columnWidthsForTable(table, colCount, currentWidthPt) {
  const source = table.column_widths_pt || []
  if (source.length >= colCount) return source.slice(0, colCount).map((value) => Number(value) || 1)
  if (source.length) {
    const average = source.reduce((sum, value) => sum + (Number(value) || 0), 0) / source.length
    return [...source, ...Array.from({ length: colCount - source.length }, () => average || 1)]
      .map((value) => Number(value) || 1)
  }
  const width = currentWidthPt > 0 ? currentWidthPt / Math.max(1, colCount) : 1
  return Array.from({ length: colCount }, () => width)
}

function targetCellWidthPt(text, typography, currentInnerWidthPt) {
  const fontSizePt = Number(typography.size_pt) || 14
  const fullWidth = measureTextWidthPt(text, fontSizePt, typography)
  if (fullWidth <= currentInnerWidthPt) return currentInnerWidthPt
  const currentWrap = wrapText(text, currentInnerWidthPt, fontSizePt, typography)
  if (!currentWrap.overflowWord && currentWrap.lineCount <= TABLE_TARGET_MAX_LINES) {
    return currentInnerWidthPt
  }

  let low = Math.max(1, currentWrap.longestPiecePt || currentInnerWidthPt)
  let high = Math.max(low, Math.min(fullWidth, fontSizePt * 36))
  for (let step = 0; step < 12; step += 1) {
    const mid = (low + high) / 2
    const wrapped = wrapText(text, mid, fontSizePt, typography)
    if (!wrapped.overflowWord && wrapped.lineCount <= TABLE_TARGET_MAX_LINES) high = mid
    else low = mid
  }
  return high
}

function fitTableElementWidth(element, tokens, slide) {
  const table = element.table || {}
  const matrix = buildTableMatrix(element)
  const colCount = Math.max(
    element.cols || 0,
    table.content_model?.columns || 0,
    table.column_widths_pt?.length || 0,
    matrix[0]?.length || 0,
  )
  if (!colCount) return element

  const slideSize = slide?.render?.slide_size_pt || tokens?.slideSize || { width: 960, height: 540 }
  const slideWidthPt = Number(slideSize.width) || 960
  const currentWidthPt = resolveTableLayoutWidthPt(element)
    || Number(element.geometry_norm?.width) * slideWidthPt
  if (!Number.isFinite(currentWidthPt) || currentWidthPt <= 0) return element

  const xNorm = Number(element.geometry_norm?.x) || 0
  const rightLimitNorm = Math.min(1, 1 - TABLE_RIGHT_MARGIN_NORM)
  const availableWidthPt = Math.max(0, (rightLimitNorm - xNorm) * slideWidthPt)
  if (availableWidthPt <= currentWidthPt + TABLE_EXPAND_MIN_DELTA_PT) return element
  if (currentWidthPt >= availableWidthPt * TABLE_EXPAND_NARROW_RATIO) return element

  const styleTokens = table.style_tokens || {}
  const currentCols = columnWidthsForTable(table, colCount, currentWidthPt)
  const currentSum = currentCols.reduce((sum, value) => sum + value, 0) || currentWidthPt
  const normalizedCols = currentCols.map((value) => value / currentSum * currentWidthPt)
  const targetCols = [...normalizedCols]
  const paddingFallback = table.padding_pt || table.frame_padding_pt || {}

  matrix.forEach((row, rowIndex) => {
    row.forEach((_, colIndex) => {
      const text = tableCellText(table, matrix, rowIndex, colIndex)
      if (!text) return
      const typography = tableCellTypography(table, styleTokens, tokens, rowIndex, colIndex)
      const cellStyle = table.cell_styles?.[rowIndex]?.[colIndex]
      const padding = cellStyle?.padding_pt
        || styleTokens.body_cell?.padding_pt
        || styleTokens.whole_cell?.padding_pt
        || paddingFallback
        || {}
      const horizontalPadding = (Number(padding.left) || 0) + (Number(padding.right) || 0) + 4
      const currentInner = Math.max(1, normalizedCols[colIndex] - horizontalPadding)
      const targetInner = targetCellWidthPt(text, typography, currentInner)
      targetCols[colIndex] = Math.max(targetCols[colIndex], targetInner + horizontalPadding)
    })
  })

  const targetWidthPt = Math.min(availableWidthPt, targetCols.reduce((sum, value) => sum + value, 0))
  if (targetWidthPt <= currentWidthPt + TABLE_EXPAND_MIN_DELTA_PT) return element

  const scale = targetWidthPt / targetCols.reduce((sum, value) => sum + value, 0)
  const columnWidthsPt = targetCols.map((value) => Math.max(1, value * scale))
  const geometryNorm = {
    ...(element.geometry_norm || {}),
    width: targetWidthPt / slideWidthPt,
  }
  const geometryPt = {
    ...(element.geometry_pt || {}),
    width_pt: targetWidthPt,
  }
  return {
    ...element,
    geometry_norm: geometryNorm,
    geometry_pt: geometryPt,
    table: {
      ...table,
      layout_width_pt: targetWidthPt,
      column_widths_pt: columnWidthsPt,
      text_fit: {
        ...(table.text_fit || {}),
        expanded_for_cell_text: true,
        previous_width_pt: currentWidthPt,
        width_pt: targetWidthPt,
      },
    },
  }
}

function materializeTableElement(element, tokens, slide = null) {
  const table = element.table || {}
  const styleTokens = { ...(table.style_tokens || {}) }
  for (const tokenKey of ['body_cell', 'whole_cell', 'header_cell']) {
    const cell = styleTokens[tokenKey] || {}
    const typography = cell.typography || {}
    styleTokens[tokenKey] = {
      ...cell,
      typography: {
        ...typography,
        color: resolveTableTextColor(tokens, styleTokens, {
          typography,
          tokenKey,
          isHeader: tokenKey === 'header_cell',
        }),
        family: typography.family || tokens?.defaultFontFamily,
        size_pt: resolveTableTextSizePt(tokens, styleTokens, {
          typography,
          tokenKey,
          isHeader: tokenKey === 'header_cell',
        }) || tableBodyFontSizePt(tokens),
      },
    }
  }
  const materialized = {
    ...element,
    table: {
      ...table,
      style_tokens: styleTokens,
    },
  }
  return fitTableElementWidth(materialized, tokens, slide)
}

export function materializeGraphicStyles(report, slide) {
  if (!slide?.content_elements?.some((element) => (
    element.kind === 'chart' || element.kind === 'diagram' || element.kind === 'table'
  ))) return slide
  const tokens = tokensForReport(report)
  const surfaceColor = darkSurfaceFillColor(slide)
  const seriesSurface = surfaceFillColor(slide)
  const styled = {
    ...slide,
    content_elements: slide.content_elements.map((element) => {
      if (element.kind === 'chart') return materializeChartElement(element, tokens, surfaceColor, seriesSurface)
      if (element.kind === 'diagram') return materializeDiagramElement(element, tokens)
      if (element.kind === 'table') return materializeTableElement(element, tokens, slide)
      return element
    }),
  }
  // Legend / category / value labels: DS colour with contrast against the
  // surface under each chart, size <= body, laid out inside the chart box.
  return planSlideChartLabels(report, styled, tokens).slide
}

// Re-plan chart labels on the final geometry (after the hit-test moved or
// trimmed a chart); charts whose labels cannot fit become layout errors.
export function planFinalChartLabels(report, slide) {
  return planSlideChartLabels(report, slide, tokensForReport(report))
}

export const materializeChartStyles = materializeGraphicStyles
