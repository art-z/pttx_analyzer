import { listAllComponents } from '../components/catalog.js'
import { inferComponentSemantics } from '../components/component-semantics.js'

function iconListHasTextAndIcon(component) {
  const slots = [...(component.slots?.required || []), ...(component.slots?.optional || [])]
  return slots.some((slot) => slot.kind === 'text' && ['body', 'text', 'description'].includes(slot.role))
    && slots.some((slot) => ['image', 'icon'].includes(slot.kind) || ['image', 'icon'].includes(slot.role))
}

export function componentCoverageKey(component) {
  if (!component) return null
  if (component.kind === 'chart') {
    if (component.chartType === 'bar' || component.chartType === 'line') return `chart:${component.chartType}`
    if (component.chartType === 'pie' || component.chartType === 'doughnut') return 'chart:circular'
    return null
  }
  if (component.kind === 'table') return 'table'
  if (component.group === 'repeats' && inferComponentSemantics(component).pattern === 'icon_list'
    && iconListHasTextAndIcon(component)) return 'icon_list'
  return null
}

export function createCoverageContext(report) {
  const eligible = listAllComponents(report).filter((component) => component.fitting_templates?.length
    && (component.kind !== 'table' || !component.capacity?.row_count_max
      || component.capacity.row_count_max >= 5))
  const componentKeys = Object.create(null)
  const targetKeys = new Set()
  const targetComponents = new Set()
  for (const component of eligible) {
    const key = componentCoverageKey(component)
    if (key) {
      componentKeys[component.id] = key
      targetKeys.add(key)
    }
    if (!key && !['repeats', 'metrics', 'narrative'].includes(component.group)
      && !['chart', 'diagram', 'image'].includes(component.kind)) continue
    targetComponents.add(component.id)
  }
  return {
    blockUsage: Object.create(null),
    componentUsage: Object.create(null),
    templateUsage: Object.create(null),
    lastTemplateByComponent: Object.create(null),
    coverageUsage: Object.create(null),
    componentExposure: Object.create(null),
    componentKeys,
    targetKeys: [...targetKeys],
    targetComponents: [...targetComponents],
  }
}

export function recordDisplayedVariants(context, variants) {
  const displayed = (variants || []).filter((variant) => variant?.catalogSlide)
  const primary = displayed[0]
  if (primary) {
    for (const [bucket, key] of [
      [context.blockUsage, primary.dataBlock],
      [context.componentUsage, primary.componentId],
      [context.templateUsage, primary.templateId || primary.catalogSlide?.layout_source],
    ]) {
      if (key) bucket[key] = (bucket[key] || 0) + 1
    }
    const templateId = primary.templateId || primary.catalogSlide?.layout_source
    if (primary.componentId && templateId) context.lastTemplateByComponent[primary.componentId] = templateId
    // Cover/ending bookends: the other bookend avoids repeating this template.
    if (primary.terminalRole && templateId) {
      context.terminalTemplateUsage ||= {}
      context.terminalTemplateUsage[templateId] = (context.terminalTemplateUsage[templateId] || 0) + 1
    }
  }
  // Every offered variant counts as exposure, not just the default selection.
  for (const variant of displayed) {
    const componentId = variant.componentId
    const key = context.componentKeys?.[componentId]
    if (componentId) context.componentExposure[componentId] = (context.componentExposure[componentId] || 0) + 1
    if (key) context.coverageUsage[key] = (context.coverageUsage[key] || 0) + 1
  }
}
