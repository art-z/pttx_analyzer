function formatVariantLine(variant) {
  if (!variant) return null
  return [
    variant.sublabel || variant.label,
    variant.score != null ? `score ${variant.score}` : null,
    variant.reasons?.slice(0, 2).join(', '),
  ].filter(Boolean).join(' · ')
}

function formatBuildResultSelection(buildResult) {
  if (buildResult.match?.textMeta) {
    const meta = buildResult.match.textMeta
    return [
      meta.placementLabel || meta.templateLabel || 'Title + text',
      meta.templateLabel && meta.placementLabel ? meta.templateLabel : null,
      meta.slideNumber ? `слайд ${meta.slideNumber}` : null,
      meta.score != null ? `score ${meta.score}` : null,
    ].filter(Boolean).join(' · ')
  }

  if (buildResult.match?.repeatMeta) {
    const meta = buildResult.match.repeatMeta
    return [
      meta.componentLabel || meta.componentId,
      meta.templateId,
      meta.score != null ? `score ${meta.score}` : null,
    ].filter(Boolean).join(' · ')
  }

  if (buildResult.match?.graphicMeta) {
    const meta = buildResult.match.graphicMeta
    return [
      meta.componentLabel || meta.kind,
      meta.chartType,
      meta.score != null ? `score ${meta.score}` : null,
    ].filter(Boolean).join(' · ')
  }

  if (buildResult.match?.templateName) {
    return [
      `Shell: ${buildResult.match.templateName}`,
      buildResult.match.score != null ? `score ${buildResult.match.score}` : null,
    ].filter(Boolean).join(' · ')
  }

  return null
}

export function summarizePresentationSelection(buildResult) {
  const variants = buildResult?.previewVariants || []
  const original = variants.find((item) => item.role === 'original')
  const best = variants.find((item) => item.role === 'best')
  const alternatives = variants.filter((item) => item.role === 'alternative').slice(0, 3)

  return {
    template: original?.sublabel || original?.label || null,
    selected: formatVariantLine(best) || formatBuildResultSelection(buildResult),
    alternatives: alternatives.map((item) => formatVariantLine(item)).filter(Boolean),
  }
}
