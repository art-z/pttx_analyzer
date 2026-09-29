import { normalizeMetricItems } from './metric-contract.js'

function firstText(item, keys) {
  for (const key of keys) {
    const value = String(item?.[key] ?? '').trim()
    if (value) return value
  }
  return ''
}

function normalizeHeadingBody(item, {
  stringField = 'heading',
  headingKeys = ['heading', 'title', 'name', 'label'],
  bodyKeys = ['body', 'text', 'description', 'bio', 'caption'],
  defaultHeading = '',
} = {}) {
  const source = item && typeof item === 'object' ? item : {}
  const scalar = typeof item === 'string' || (item != null && typeof item !== 'object')
    ? String(item)
    : ''
  const heading = firstText(source, headingKeys)
    || (stringField === 'heading' ? scalar : '')
    || defaultHeading
  const body = firstText(source, bodyKeys)
    || (stringField === 'body' ? scalar : '')
  const {
    title: _title,
    text: _text,
    name: _name,
    label: _label,
    description: _description,
    bio: _bio,
    caption: _caption,
    quote: _quote,
    ...extra
  } = source

  return {
    ...extra,
    heading,
    body,
  }
}

function normalizeParagraph(item) {
  return normalizeHeadingBody(item, {
    stringField: 'body',
    headingKeys: ['heading', 'title'],
    bodyKeys: ['body', 'text', 'description'],
  })
}

function paragraphText(item) {
  return [item.heading, item.body].filter(Boolean).join(': ')
}

function repeatContextBlock(item) {
  const heading = String(item?.heading || '').trim()
  if (!heading) return 'icon_lists'
  if (
    /(?:^|[^\d])(?:18|19|20|21)\d{2}(?:[^\d]|$)/u.test(heading)
    || /^(?:q[1-4]|[1-4]\s*кв(?:артал)?|(?:январ|феврал|март|апрел|ма|июн|июл|август|сентябр|октябр|ноябр|декабр)[ьяейта]*)$/iu.test(heading)
    || /^\d{1,2}[./-]\d{1,2}(?:[./-]\d{2,4})?$/u.test(heading)
  ) return 'timelines'
  if (/^\d{1,3}[.)]?$/u.test(heading)) return 'lists'
  return 'cards'
}

function inferMetricsFromShortNumericHeadings(items) {
  const candidates = items
    .filter((item) => {
      const heading = String(item.heading || '').trim()
      return heading.length > 0
        && heading.length <= 16
        && /\d/u.test(heading)
        && /[^\d.,+\-\s]/u.test(heading)
        && item.body
    })
    .map((item) => ({
      title: item.heading,
      text: item.body,
    }))
  return normalizeMetricItems(candidates).metrics
}

export function normalizeSlideSpec(slide) {
  const context = slide?.context || slide || {}
  const paragraphs = (context.paragraphs || []).map(normalizeParagraph).filter((item) => (
    item.heading || item.body
  ))
  const normalizedListItems = (context.lists || []).map((item) => normalizeHeadingBody(item)).filter((item) => (
    item.heading || item.body
  ))
  const legacyRepeatItems = {
    cards: [],
    lists: [],
    timelines: [],
    icon_lists: [],
  }
  normalizedListItems.forEach((item) => legacyRepeatItems[repeatContextBlock(item)].push(item))
  const cards = [
    ...(context.cards || []).map((item) => normalizeHeadingBody(item)),
    ...legacyRepeatItems.cards,
  ].filter((item) => item.heading || item.body)
  const lists = legacyRepeatItems.lists
  const timelines = [
    ...(context.timelines || []).map((item) => normalizeHeadingBody(item)),
    ...legacyRepeatItems.timelines,
  ].filter((item) => item.heading || item.body)
  const iconLists = [
    ...(context.icon_lists || []).map((item) => normalizeHeadingBody(item, { stringField: 'body' })),
    ...legacyRepeatItems.icon_lists,
  ].filter((item) => item.heading || item.body)
  const normalizedMetrics = normalizeMetricItems(context.metrics || slide?.metrics || [])
  const inferredMetrics = normalizedMetrics.metrics.length
    ? []
    : inferMetricsFromShortNumericHeadings(normalizedListItems)
  const metricIssues = [...(slide?.metric_issues || []), ...normalizedMetrics.issues]
  const paragraphBody = paragraphs.map(paragraphText).filter(Boolean).join('\n\n')
  return {
    index: slide?.index ?? null,
    intent: String(slide?.intent || 'content').toLowerCase(),
    purpose: slide?.purpose || '',
    title: slide?.title || '',
    text: paragraphBody || slide?.text || '',
    summary_text: slide?.text || '',
    paragraphs,
    metrics: normalizedMetrics.metrics.length ? normalizedMetrics.metrics : inferredMetrics,
    metric_issues: metricIssues.filter((issue, index, items) => (
      items.findIndex((candidate) => (
        candidate.index === issue.index
        && candidate.code === issue.code
        && String(candidate.missing_or_invalid) === String(issue.missing_or_invalid)
      )) === index
    )),
    cards,
    lists,
    timelines,
    icon_lists: iconLists,
    tables: context.tables || [],
    charts: context.charts || [],
    diagrams: context.diagrams || [],
    persons: (context.persons || []).map((item) => normalizeHeadingBody(item, {
      headingKeys: ['heading', 'name', 'title'],
      bodyKeys: ['body', 'bio', 'text', 'description'],
    })),
    quotes: (context.quotes || []).map((item) => normalizeHeadingBody(item, {
      stringField: 'body',
      headingKeys: ['heading', 'title'],
      bodyKeys: ['body', 'text', 'quote'],
    })),
    snippets: context.snippets || [],
    images: (context.images || []).map((item) => normalizeHeadingBody(item)),
  }
}

export function specBlockCounts(spec) {
  return {
    paragraphs: spec.paragraphs.length,
    metrics: spec.metrics.length,
    cards: spec.cards.length,
    lists: spec.lists.length,
    timelines: spec.timelines.length,
    icon_lists: spec.icon_lists.length,
    tables: spec.tables.length,
    charts: spec.charts.length,
    diagrams: spec.diagrams.length,
    persons: spec.persons.length,
    quotes: spec.quotes.length,
    snippets: spec.snippets.length,
    images: spec.images.length,
  }
}
