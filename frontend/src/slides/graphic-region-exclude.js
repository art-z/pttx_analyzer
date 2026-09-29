/** Native OOXML graphic frames and shape-built chart regions must not participate in vgroup repeats. */

export const GRAPHIC_ELEMENT_KINDS = new Set(['table', 'chart', 'diagram'])
export const MIN_INFERRED_CHART_EXCLUDE_CONFIDENCE = 0.75
export const MIN_INFERRED_CIRCULAR_EXCLUDE_CONFIDENCE = 0.72
export const MIN_INFERRED_DIAGRAM_EXCLUDE_CONFIDENCE = 0.62

function shouldExcludeInferredChart(inferredChart) {
  if (!inferredChart?.consumed_element_ids?.length) return false
  return Number(inferredChart.confidence) >= MIN_INFERRED_CHART_EXCLUDE_CONFIDENCE
}

function shouldExcludeInferredCircularChart(chart) {
  if (!chart?.consumed_element_ids?.length) return false
  return Number(chart.confidence) >= MIN_INFERRED_CIRCULAR_EXCLUDE_CONFIDENCE
}

function shouldExcludeInferredDiagram(inferredDiagram) {
  if (!inferredDiagram?.consumed_element_ids?.length) return false
  return Number(inferredDiagram.confidence) >= MIN_INFERRED_DIAGRAM_EXCLUDE_CONFIDENCE
}

export function collectGraphicExcludedElementIds(slide) {
  const ids = new Set()
  if (!slide) return ids

  if (shouldExcludeInferredChart(slide.inferred_chart)) {
    for (const id of slide.inferred_chart.consumed_element_ids || []) {
      if (id) ids.add(id)
    }
  }

  if (shouldExcludeInferredDiagram(slide.inferred_diagram)) {
    for (const id of slide.inferred_diagram.consumed_element_ids || []) {
      if (id) ids.add(id)
    }
  }

  for (const chart of slide.inferred_circular_charts || []) {
    if (!shouldExcludeInferredCircularChart(chart)) continue
    for (const id of chart.consumed_element_ids || []) {
      if (id) ids.add(id)
    }
  }

  for (const element of slide.content_elements || []) {
    if (!element?.element_id) continue
    if (GRAPHIC_ELEMENT_KINDS.has(element.kind)) {
      ids.add(element.element_id)
    }
    for (const id of element.inference?.consumed_element_ids || []) {
      if (id) ids.add(id)
    }
  }

  return ids
}

export function filterElementsForVgroups(contentElements = [], excludedIds = null) {
  if (!excludedIds?.size) return contentElements
  return contentElements.filter((element) => (
    element?.element_id && !excludedIds.has(element.element_id)
  ))
}

export function isGraphicStructuralElement(element, excludedIds = null) {
  if (!element?.element_id) return false
  if (GRAPHIC_ELEMENT_KINDS.has(element.kind)) return true
  return Boolean(excludedIds?.has(element.element_id))
}
