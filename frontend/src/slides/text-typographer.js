const SHORT_RUSSIAN_WORD = /(?<![\p{L}\p{N}_])(?:и|а|но|да|что|как|или|в|во|к|ко|с|со|у|о|об|обо|от|до|из|за|на|по|под|при|для|без|не|ни|же|ли|бы)[ \t]+(?=[\p{L}\p{N}«„“(])/giu
const NBSP = '\u00a0'

// Keep a short conjunction, preposition or particle with the following word.
// Explicit line breaks and all other spacing stay unchanged.
export function typographRussianText(value) {
  if (typeof value !== 'string' || !value) return value
  return value.replace(SHORT_RUSSIAN_WORD, (match) => match.replace(/[ \t]+$/u, NBSP))
}

export function isCodeTextElement(element) {
  return element?.narrative_role === 'snippet'
    || element?.role === 'code'
    || element?.text_role === 'code'
}

function typographFields(item, fields) {
  if (!item || typeof item !== 'object') return item
  const next = { ...item }
  for (const field of fields) {
    if (typeof next[field] === 'string') next[field] = typographRussianText(next[field])
  }
  return next
}

function typographItems(items, fields) {
  return Array.isArray(items) ? items.map((item) => typographFields(item, fields)) : items
}

export function typographSlideSpec(spec) {
  if (!spec) return spec
  return {
    ...spec,
    title: typographRussianText(spec.title),
    text: typographRussianText(spec.text),
    summary_text: typographRussianText(spec.summary_text),
    paragraphs: typographItems(spec.paragraphs, ['heading', 'body']),
    metrics: typographItems(spec.metrics, ['description', 'text']),
    cards: typographItems(spec.cards, ['heading', 'body']),
    lists: typographItems(spec.lists, ['heading', 'body']),
    timelines: typographItems(spec.timelines, ['heading', 'body']),
    icon_lists: typographItems(spec.icon_lists, ['heading', 'body']),
    persons: typographItems(spec.persons, ['heading', 'body']),
    quotes: typographItems(spec.quotes, ['heading', 'body']),
    tables: (spec.tables || []).map((table) => ({
      ...typographFields(table, ['title', 'text']),
      headers: Array.isArray(table?.headers) ? table.headers.map(typographRussianText) : table?.headers,
      rows: Array.isArray(table?.rows)
        ? table.rows.map((row) => Array.isArray(row) ? row.map(typographRussianText) : row)
        : table?.rows,
      columns: typographItems(table?.columns, ['label']),
    })),
    charts: (spec.charts || []).map((chart) => ({
      ...typographFields(chart, ['title', 'text']),
      labels: Array.isArray(chart?.labels) ? chart.labels.map(typographRussianText) : chart?.labels,
    })),
    diagrams: (spec.diagrams || []).map((diagram) => ({
      ...typographFields(diagram, ['title', 'text']),
      nodes: typographItems(diagram?.nodes, ['label', 'text']),
      links: typographItems(diagram?.links, ['label', 'text']),
    })),
  }
}

export function typographSlideText(slide) {
  if (!slide) return slide
  return {
    ...slide,
    content_elements: (slide.content_elements || []).map((element) => {
      if (element.kind !== 'text' || isCodeTextElement(element)) return element
      return {
        ...element,
        text: typographRussianText(element.text),
        text_sample: typographRussianText(element.text_sample),
        text_paragraphs: element.text_paragraphs?.map((paragraph) => typographFields(paragraph, ['text'])),
        text_runs: element.text_runs?.map((run) => typographFields(run, ['text'])),
      }
    }),
  }
}
