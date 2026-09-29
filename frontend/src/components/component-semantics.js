import { buildContainerCapacity, defaultContainerModel, isIterableRepeatComponent } from './container-catalog.js'
import { listAllComponents, listComponentTemplates } from './catalog.js'
import { specBlockCounts } from '../presentation/slide-spec.js'

export const SEMANTIC_TEXT_ROLES = new Set([
  'title',
  'subtitle',
  'heading',
  'body',
  'description',
  'text',
  'content',
  'list',
  'caption',
  'label',
])

// Intent is a hint from the model, not a verdict: wherever it affects ranking
// it adds at most this small bonus on top of the data-driven fit.
export const INTENT_RANK_BONUS = 4

export const CONTEXT_BLOCK_INTENTS = {
  metrics: ['metrics', 'problem'],
  cards: ['features', 'solution', 'summary'],
  lists: ['process', 'workflow', 'solution'],
  timelines: ['timeline', 'roadmap'],
  icon_lists: ['features', 'solution', 'summary'],
  tables: ['comparison', 'table'],
  charts: ['timeline', 'roadmap', 'metrics', 'comparison'],
  diagrams: ['process', 'workflow', 'architecture', 'solution'],
  persons: ['team'],
  quotes: ['quote'],
  snippets: ['example', 'architecture'],
  images: ['example', 'title'],
}

export const ITEM_PATTERNS = {
  card: {
    id: 'card',
    label: 'Карточка',
    roles: ['heading', 'body'],
    optionalRoles: ['image'],
    contextBlocks: ['cards', 'persons', 'quotes'],
  },
  metric_card: {
    id: 'metric_card',
    label: 'KPI-карточка',
    roles: ['heading', 'body'],
    contextBlocks: ['metrics'],
  },
  numbered_list: {
    id: 'numbered_list',
    label: 'Нумерованный список',
    roles: ['heading', 'body'],
    contextBlocks: ['lists'],
  },
  timeline: {
    id: 'timeline',
    label: 'Таймлайн',
    roles: ['heading', 'body'],
    contextBlocks: ['timelines'],
  },
  icon_list: {
    id: 'icon_list',
    label: 'Список с иконками',
    roles: ['body'],
    optionalRoles: ['image', 'icon'],
    contextBlocks: ['icon_lists'],
  },
  text_block: {
    id: 'text_block',
    label: 'Текстовый блок',
    roles: ['body'],
    contextBlocks: [],
  },
}

const PATTERN_BY_ID = Object.fromEntries(Object.values(ITEM_PATTERNS).map((item) => [item.id, item]))

export function semanticFieldsFromSlots(slots = []) {
  const fields = {}
  for (const slot of slots) {
    const value = slot?.text ?? slot?.label ?? null
    if (value == null || String(value).trim() === '') continue
    const role = slot?.role === 'text' ? 'body' : slot?.role
    if (role && (role === 'image' || !role.startsWith('text_'))) {
      fields[role] = String(value)
    }
  }
  return fields
}

function collectSlotRoles(component) {
  const required = component.slots?.required || component.raw?.slots?.required || []
  const optional = component.slots?.optional || component.raw?.slots?.optional || []
  const kinds = new Set()
  const roles = new Set()
  for (const slot of [...required, ...optional]) {
    if (slot?.kind) kinds.add(slot.kind)
    if (slot?.role) roles.add(slot.role === 'text' ? 'body' : slot.role)
  }
  return { required, optional, kinds, roles: [...roles] }
}

function headingSamples(component) {
  const samples = []
  for (const instance of component.instances || []) {
    for (const slot of instance.slots || []) {
      if (!['heading', 'title'].includes(slot?.role)) continue
      const value = String(slot?.text ?? slot?.label ?? '').trim()
      if (value) samples.push(value)
    }
  }
  return samples
}

function isTimelineHeading(value) {
  const heading = String(value).trim()
  return /(?:^|[^\d])(?:18|19|20|21)\d{2}(?:[^\d]|$)/u.test(heading)
    || /^(?:q[1-4]|[1-4]\s*кв(?:артал)?|(?:январ|феврал|март|апрел|ма|июн|июл|август|сентябр|октябр|ноябр|декабр)[ьяейта]*)$/iu.test(heading)
    || /^\d{1,2}[./-]\d{1,2}(?:[./-]\d{2,4})?$/u.test(heading)
}

function isListNumber(value) {
  return /^\d{1,3}[.)]?$/u.test(String(value).trim())
}

function isMetricValue(value) {
  return /^[+\-]?(?:\d+(?:[.,]\d+)?)\s*(?:%|‰|×|x|₽|\$|€|£)$/iu.test(String(value).trim())
}

function detectItemPattern({ kinds, roles, headings = [] }) {
  const hasImage = kinds.has('image') || kinds.has('icon') || roles.includes('image') || roles.includes('icon')
  const hasHeading = roles.includes('heading') || roles.includes('title')
  const hasBody = roles.includes('body') || roles.includes('description') || roles.includes('text')

  if (!hasHeading && hasImage) return 'icon_list'
  if (hasHeading && headings.length && headings.every(isTimelineHeading)) return 'timeline'
  if (hasHeading && headings.length && headings.every(isListNumber)) return 'numbered_list'
  if (hasHeading && headings.length && headings.every(isMetricValue)) return 'metric_card'
  if (hasHeading) return 'card'
  if (hasBody) return 'text_block'
  return 'text_block'
}

function contextBlocksForPattern(patternId, roles) {
  const pattern = PATTERN_BY_ID[patternId]
  const blocks = [...(pattern?.contextBlocks || [])]
  if (patternId === 'metric_card') {
    if (roles.includes('heading') && roles.includes('body')) {
      blocks.push('metrics', 'lists')
    }
  }
  return [...new Set(blocks)]
}

function intentsForContextBlocks(blocks) {
  const intents = new Set()
  blocks.forEach((block) => {
    (CONTEXT_BLOCK_INTENTS[block] || []).forEach((intent) => intents.add(intent))
  })
  return [...intents]
}

export function inferComponentSemantics(component) {
  const { roles, kinds } = collectSlotRoles(component)
  const pattern = detectItemPattern({ kinds, roles, headings: headingSamples(component) })
  const patternMeta = PATTERN_BY_ID[pattern] || ITEM_PATTERNS.text_block
  const contextBlocks = contextBlocksForPattern(pattern, roles)
  const capacity = component.capacity || buildContainerCapacity(component)
  const semanticRoles = roles.filter((role) => SEMANTIC_TEXT_ROLES.has(role) || role === 'image')
  const roleOrder = ['image', 'icon', 'title', 'subtitle', 'heading', 'body', 'description', 'content', 'list', 'caption', 'label']
  const orderedRoles = roleOrder.filter((role) => semanticRoles.includes(role))
    .concat(semanticRoles.filter((role) => !roleOrder.includes(role)))

  return {
    pattern,
    patternLabel: patternMeta.label,
    roles: orderedRoles.length ? orderedRoles : patternMeta.roles,
    optionalRoles: patternMeta.optionalRoles || [],
    contextBlocks,
    intents: intentsForContextBlocks(contextBlocks),
    itemCountKnown: capacity.item_count_known ?? null,
    itemCountMax: capacity.item_count_max ?? null,
    layout: component.layout || component.instances?.[0]?.layout || null,
    signature: component.variantSignature || component.raw?.signature || null,
    fieldSchema: buildFieldSchema(pattern, semanticRoles.length ? semanticRoles : patternMeta.roles),
  }
}

export function buildFieldSchema(pattern, roles = []) {
  const patternMeta = PATTERN_BY_ID[pattern] || ITEM_PATTERNS.text_block
  const effectiveRoles = roles.length ? roles : patternMeta.roles
  return effectiveRoles.map((role) => ({
    role,
    label: roleLabel(role),
    required: (patternMeta.roles || []).includes(role),
  }))
}

export function roleLabel(role) {
  return ({
    title: 'Заголовок',
    subtitle: 'Подзаголовок',
    heading: 'Заголовок карточки',
    body: 'Подпись / описание',
    description: 'Описание',
    text: 'Текст',
    content: 'Контент',
    list: 'Пункт',
    caption: 'Подпись',
    label: 'Метка',
    image: 'Изображение',
  })[role] || role
}

export function mapContextItemToFields(block, item, roles = ['heading', 'body']) {
  const canonical = {
    heading: item?.heading || item?.title || item?.name || '',
    body: item?.body || item?.text || item?.description || item?.bio || '',
  }

  if (block === 'persons') {
    canonical.heading = item?.heading || item?.name || item?.title || ''
    canonical.body = item?.body || item?.bio || item?.text || ''
  }
  if (block === 'metrics') {
    canonical.heading = item?.title || item?.display || item?.value || ''
    canonical.body = item?.description || item?.body || item?.text || ''
  }
  if (block === 'quotes') {
    canonical.heading = item?.heading || item?.title || ''
    canonical.body = item?.body || item?.text || item?.quote || ''
  }

  const fields = {}
  if (String(canonical.heading).trim()) fields.heading = String(canonical.heading)
  if (String(canonical.body).trim()) fields.body = String(canonical.body)
  if (roles.includes('image') && item?.image) fields.image = item.image
  return fields
}

export function buildContainerModelFromContext(component, instance, spec, { block = null } = {}) {
  if (!spec || !component || !instance) return null
  const semantics = component.semantics || inferComponentSemantics(component)
  const counts = specBlockCounts(spec)
  const targetBlock = block || semantics.contextBlocks.find((name) => (counts[name] || 0) > 0)
  if (!targetBlock) return null

  const sourceItems = spec[targetBlock] || []
  if (!sourceItems.length) return null

  const base = defaultContainerModel(component, instance)
  const maxItems = base.capacity?.max || semantics.itemCountMax || sourceItems.length
  const itemCount = Math.min(maxItems, sourceItems.length)

  return {
    ...base,
    item_count: itemCount,
    items: sourceItems.slice(0, itemCount).map((item, index) => ({
      index: index + 1,
      fields: mapContextItemToFields(targetBlock, item, semantics.roles),
    })),
    data_source: {
      intent: spec.intent,
      purpose: spec.purpose || null,
      context_block: targetBlock,
    },
  }
}

export function scoreRepeatComponent(component, spec, blockCounts) {
  const semantics = component.semantics || inferComponentSemantics(component)
  let score = 0
  const reasons = []

  if (semantics.intents.includes(spec.intent)) {
    score += INTENT_RANK_BONUS
    reasons.push(`intent:${spec.intent}`)
  }

  semantics.contextBlocks.forEach((block) => {
    const count = blockCounts[block] || 0
    if (!count) return
    score += 24 + Math.min(count, semantics.itemCountKnown || count) * 4
    reasons.push(`${block}:${count}`)
  })

  if (spec.intent === 'team' && (blockCounts.persons || 0) >= 2 && semantics.pattern === 'card') {
    score += INTENT_RANK_BONUS
    reasons.push('team:card')
  }

  if ((blockCounts.metrics || 0) >= 3 && ['metric_card', 'card'].includes(semantics.pattern)) {
    score += 18
    reasons.push('metrics:cards')
  }

  const needed = Math.max(
    blockCounts.persons,
    blockCounts.metrics,
    blockCounts.cards,
    blockCounts.lists,
    blockCounts.timelines,
    blockCounts.icon_lists,
  )
  if (needed > 0 && semantics.itemCountMax && needed > semantics.itemCountMax) {
    score -= 24
    reasons.push(`capacity:${needed}>${semantics.itemCountMax}`)
  }

  if (semantics.itemCountKnown && needed > 0) {
    const delta = Math.abs(needed - semantics.itemCountKnown)
    score += Math.max(0, 12 - delta * 2)
  }

  return { score, reasons, semantics }
}

export function matchRepeatComponents(report, spec, { templateId = null, limit = 5 } = {}) {
  const blockCounts = specBlockCounts(spec)
  return listAllComponents(report)
    .filter((component) => isIterableRepeatComponent(component))
    .map((component) => {
      const templates = listComponentTemplates(report, component)
      const resolvedTemplateId = templateId && templates.some((item) => item.templateId === templateId)
        ? templateId
        : templates[0]?.templateId || null
      const { score, reasons, semantics } = scoreRepeatComponent(component, spec, blockCounts)
      return {
        component,
        semantics,
        score,
        reasons,
        templateId: resolvedTemplateId,
        templates,
      }
    })
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score || right.component.frequency.instance_count - left.component.frequency.instance_count)
    .slice(0, limit)
}

export function resolveSlideAssemblyPlan(report, rawSlide) {
  const spec = typeof rawSlide === 'object' && rawSlide?.intent
    ? rawSlide
    : null
  if (!spec) return null

  const blockCounts = specBlockCounts(spec)
  const repeatMatches = matchRepeatComponents(report, spec)
  const primaryBlock = [
    'persons', 'metrics', 'cards', 'lists', 'timelines', 'icon_lists', 'quotes',
  ].find((block) => (blockCounts[block] || 0) > 0) || null
  const best = repeatMatches[0] || null

  return {
    intent: spec.intent,
    purpose: spec.purpose || '',
    primaryContextBlock: primaryBlock,
    repeatComponent: best ? {
      id: best.component.id,
      label: best.component.label,
      templateId: best.templateId,
      score: best.score,
      reasons: best.reasons,
      semantics: best.semantics,
    } : null,
    slideFields: {
      title: spec.title || null,
      text: spec.text || null,
    },
    containerPayload: best && primaryBlock
      ? buildContainerModelFromContext(
        best.component,
        best.component.instances?.[0] || null,
        spec,
        { block: primaryBlock },
      )
      : null,
  }
}

export function repeatSemanticsLegend(component) {
  const semantics = component.semantics || inferComponentSemantics(component)
  const pattern = PATTERN_BY_ID[semantics.pattern] || ITEM_PATTERNS.text_block
  const exampleFields = {
    heading: 'Заголовок',
    body: 'Основной текст',
  }
  if (semantics.roles.includes('image')) exampleFields.image = 'asset_id'

  return {
    semantics,
    pattern,
    exampleItem: { index: 1, fields: exampleFields },
    mappingNote: [
      'Модель отдаёт slide.intent + slide.context.*',
      'Компонент выбирается по semantics.pattern, contextBlocks и item_count',
      'Шаблон — по template_id экземпляров компонента',
      'items[].fields используют единый контракт heading + body',
      'Внутренние роли шаблона title/description/text связываются автоматически',
    ],
  }
}
