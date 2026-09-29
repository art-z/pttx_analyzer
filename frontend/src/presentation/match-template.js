import { listAvailableComponents, listSlideTemplates } from '../constructor/templates.js'
import { specBlockCounts } from './slide-spec.js'
import { catalogCoversScenarioBlock } from './match-catalog-blocks.js'

const INTENT_CAPS = {
  title: ['title'],
  section: ['title', 'subtitle'],
  problem: ['title', 'body', 'content', 'list', 'paragraph'],
  solution: ['title', 'body', 'content', 'list', 'paragraph'],
  metrics: ['title', 'body', 'content'],
  features: ['title', 'body', 'content', 'list'],
  process: ['title', 'body', 'content'],
  workflow: ['title', 'body', 'content'],
  comparison: ['title', 'body', 'content'],
  table: ['title', 'body', 'content'],
  timeline: ['title', 'body', 'content'],
  roadmap: ['title', 'body', 'content'],
  architecture: ['title', 'body', 'content'],
  example: ['title', 'body', 'content'],
  quote: ['title', 'body', 'content'],
  team: ['title', 'body', 'content'],
  summary: ['title', 'body', 'content', 'list'],
  cta: ['title', 'body', 'content'],
}

const BLOCK_COMPONENT_HINTS = {
  metrics: ['metric', 'показатель'],
  lists: ['icon_row', 'text_block', 'список', 'ряд'],
  tables: ['table', 'таблиц'],
  charts: ['chart', 'график'],
  diagrams: ['diagram', 'timeline', 'диаграм', 'timeline_step'],
  images: ['image', 'media', 'изображ', 'медиа'],
}

function capabilityScore(capabilities, intent) {
  const expected = INTENT_CAPS[intent] || ['title', 'body', 'content']
  let score = 0
  expected.forEach((cap) => {
    if (capabilities.includes(cap)) score += 8
  })
  if (capabilities.includes('title')) score += 6
  return score
}

function componentScore(available, blockCounts, spec = {}, report = null) {
  let score = 0
  const gaps = []
  const hasNarrative = Boolean(String(spec.title || '').trim() && String(spec.text || '').trim())
  const blockWeight = hasNarrative ? 0.2 : 1

  Object.entries(BLOCK_COMPONENT_HINTS).forEach(([block, hints]) => {
    const count = blockCounts[block] || 0
    if (!count) return
    const match = findComponent(available, hints)
    if (match) {
      score += (20 + Math.min(count, match.profile.maxCount) * 4) * blockWeight
      return
    }
    if (!catalogCoversScenarioBlock(report, block)) {
      gaps.push(`нет компонента для ${block}`)
    }
  })

  return { score, gaps }
}

function textShellBoost(spec, capabilities = []) {
  let score = 0
  if (String(spec?.title || '').trim() && capabilities.includes('title')) score += 42
  if (String(spec?.text || '').trim() && (capabilities.includes('body') || capabilities.includes('content'))) {
    score += 38
  }
  if (String(spec?.title || '').trim() && String(spec?.text || '').trim()) score += 18
  return score
}

function findComponent(available, hints) {
  return available.find(({ component }) => {
    const haystack = `${component.name || ''} ${component.label || ''}`.toLowerCase()
    return hints.some((hint) => haystack.includes(hint))
  }) || null
}

export function matchTemplateForSpec(report, spec, baseTokens) {
  const templates = listSlideTemplates(report)
  const blockCounts = specBlockCounts(spec)
  const ranked = templates.map((item) => {
    const available = listAvailableComponents(report, item.template, baseTokens)
    const caps = item.capabilities || []
    const { score: componentPart, gaps } = componentScore(available, blockCounts, spec, report)
    const score = capabilityScore(caps, spec.intent)
      + textShellBoost(spec, caps)
      + componentPart
      + Math.min(item.slideCount || 0, 40) * 0.5
      + (item.slotCount || 0) * 0.2

    return {
      item,
      score,
      gaps,
      available,
    }
  }).sort((left, right) => right.score - left.score)

  const best = ranked[0] || null
  if (!best) {
    return {
      templateItem: null,
      score: 0,
      gaps: ['в шаблоне не найдено ни одного shell'],
      available: [],
      candidates: [],
    }
  }

  return {
    templateItem: best.item,
    score: Math.round(best.score),
    gaps: best.gaps,
    available: best.available,
    candidates: ranked.slice(0, 3).map((entry) => ({
      name: entry.item.name,
      score: Math.round(entry.score),
      shellId: entry.item.template?.shell_id || null,
    })),
  }
}

export { findComponent, BLOCK_COMPONENT_HINTS }
