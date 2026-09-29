import { buildScenarioSlide } from './presentation/build-slide.js'
import { recordDisplayedVariants } from './presentation/component-coverage.js'

function slimVariant(variant, index) {
  return {
    key: variant.key || `variant-${index + 1}`,
    label: `Вариант ${index + 1}`,
    sublabel: variant.sublabel || variant.label || '',
    dataBlock: variant.dataBlock || null,
    componentId: variant.componentId || null,
    templateId: variant.templateId || variant.catalogSlide?.template_id || variant.catalogSlide?.layout_source || null,
    titleVariant: variant.titleVariant || null,
    titleText: variant.titleText || null,
    // Set on paragraph fallbacks (presentation/paragraph-fallback.js).
    fallback: variant.fallback || null,
    catalogSlide: JSON.parse(JSON.stringify(variant.catalogSlide)),
  }
}

export function takeSlideVariants(report, slide, tokens, context, seed, lifecycle = {}) {
  const result = buildScenarioSlide(report, slide, tokens, {
    selectionContext: context,
    seed,
    ...lifecycle,
  })
  const variants = (result.previewVariants || [])
    .filter((variant) => variant.catalogSlide)
    .slice(0, 3)
    .map(slimVariant)
  recordDisplayedVariants(context, result.previewVariants?.slice(0, 3))
  return variants
}
