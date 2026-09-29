/** LLM-сценарий: title+text, KPI и графика собираются через catalog; повторы — вторично. */

export const SCENARIO_MATCH_PRIORITY = {
  primary: 'title_text',
  secondaryBlocksEnabled: true,
}

export function hasNarrativeText(spec) {
  return Boolean(String(spec?.title || '').trim() || String(spec?.text || '').trim())
}

export function hasGraphicBlocks(spec) {
  return (spec?.charts?.length || 0) > 0
    || (spec?.tables?.length || 0) > 0
    || (spec?.diagrams?.length || 0) > 0
}

export function hasMetricBlocks(spec) {
  return (spec?.metrics?.length || 0) > 0
}

export function hasRepeatBlocks(spec) {
  return (spec?.persons?.length || 0) > 0
    || (spec?.lists?.length || 0) > 0
    || (spec?.quotes?.length || 0) > 0
}

export function shouldUseSecondaryBlocks(spec, { textComponentsAvailable = true } = {}) {
  if (!SCENARIO_MATCH_PRIORITY.secondaryBlocksEnabled) return false

  if (!textComponentsAvailable) {
    return hasGraphicBlocks(spec) || hasMetricBlocks(spec) || hasRepeatBlocks(spec)
  }

  if (hasGraphicBlocks(spec) || hasMetricBlocks(spec)) return false

  if (!hasRepeatBlocks(spec)) return false

  return !String(spec?.text || '').trim()
}

export function recommendationSortScore(entry) {
  const slotBoost = {
    slide_title: 120,
    slide_description: 110,
    repeat: 35,
    table: 30,
    chart: 28,
    diagram: 26,
    metric: 45,
  }
  return (slotBoost[entry?.slot] || 0) + (entry?.best?.score || 0)
}
