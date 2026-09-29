import { createCoverageContext } from './component-coverage.js'

const BLOCKING_CODES = new Set(['text_overflow', 'text_overlap', 'outside_slide'])

function selectedVariants(item) {
  return item?.previewVariants || item?.variants || []
}

function textField(element, slide) {
  const value = String(element?.text || '').trim()
  const title = String(slide?.title || '').trim()
  const body = String(slide?.text || '').trim()
  const id = String(element?.element_id || '').toLowerCase()
  if (value && title && (value === title || title.includes(value)) || /title|заголов/.test(id)) return 'title'
  if (value && body && (value === body || body.includes(value)) || /description|body|subtitle|text/.test(id)) return 'text'
  return 'context'
}

function contextCategory(element, slide) {
  const text = String(element?.text || '').trim()
  if (!text) return null
  for (const [category, items] of Object.entries(slide?.context || {})) {
    if (!Array.isArray(items)) continue
    if (items.some((item) => {
      if (typeof item === 'string') return item.includes(text) || text.includes(item)
      return ['heading', 'body', 'title', 'text', 'description', 'label', 'name']
        .some((key) => {
          const value = String(item?.[key] || '').trim()
          return value && (value === text || value.includes(text))
        })
    })) return category
  }
  return null
}

function issueForElement(issue, catalogSlide, slide) {
  const element = (catalogSlide?.content_elements || []).find((item) => item.element_id === issue.element_id)
  const field = textField(element, slide)
  const box = element?.geometry_pt || {}
  return {
    category: issue.code,
    field,
    context_category: field === 'context' ? contextCategory(element, slide) : null,
    text_length: String(element?.text || '').length,
    box_width_pt: Math.round(Number(box.width_pt) || 0),
    box_height_pt: Math.round(Number(box.height_pt) || 0),
    font_size_pt: Number(element?.typography?.size_pt) || null,
  }
}

function measuredTextOverflow(catalogSlide, slide) {
  const size = catalogSlide?.render?.slide_size_pt || { width: 960, height: 540 }
  return (catalogSlide?.content_elements || []).flatMap((element) => {
    if (element?.kind !== 'text' || !String(element.text || '').trim()) return []
    const field = textField(element, slide)
    if (field !== 'title' && field !== 'text') return []
    const font = Number(element?.typography?.size_pt)
    const box = element?.geometry_pt || {}
    const width = Number(box.width_pt) || Number(element?.geometry_norm?.width) * size.width
    const height = Number(box.height_pt) || Number(element?.geometry_norm?.height) * size.height
    if (!(font >= 8 && width > 0 && height > 0)) return []
    const charsPerLine = Math.max(1, Math.floor(width / (font * 0.44)))
    const needed = String(element.text).split('\n').reduce((count, line) => (
      count + Math.max(1, Math.ceil(line.length / charsPerLine))
    ), 0)
    const available = height / (font * 1.12)
    return needed > available * 1.2 && needed - available >= 0.8
      ? [issueForElement({ code: 'text_overflow', element_id: element.element_id }, catalogSlide, slide)]
      : []
  })
}

function variantIssues(variant, slide) {
  const catalogSlide = variant?.catalogSlide
  const validation = catalogSlide?.layout_validation
  const validationIssues = (validation?.issues || [...(validation?.errors || []), ...(validation?.warnings || [])])
    .filter((issue) => BLOCKING_CODES.has(issue?.code))
    .flatMap((issue) => {
      const ids = issue.element_ids?.length ? issue.element_ids : [issue.element_id]
      return ids.map((elementId) => issueForElement({ ...issue, element_id: elementId }, catalogSlide, slide))
    })
  const extra = measuredTextOverflow(catalogSlide, slide)
  return [...validationIssues, ...extra].filter((issue, index, all) => (
    all.findIndex((candidate) => candidate.category === issue.category && candidate.field === issue.field
      && candidate.text_length === issue.text_length) === index
  ))
}

function similarityKey(variant) {
  if (!variant) return ''
  const template = variant.templateId || variant.catalogSlide?.template_id || variant.catalogSlide?.layout_source
  return template ? `${template}|${variant.dataBlock || ''}` : ''
}

function contentTokens(value) {
  return new Set(String(value || '').toLowerCase().match(/[\p{L}\p{N}]+/gu) || [])
}

function tooSimilarText(left, right) {
  const a = contentTokens(left)
  const b = contentTokens(right)
  if (a.size < 6 || b.size < 6) return false
  const shared = [...a].filter((word) => b.has(word)).length
  return shared / Math.max(a.size, b.size) >= 0.85
}

export function collectLayoutFeedback(slides, builds, report = null) {
  const issues = []
  const keys = []
  ;(slides || []).forEach((slide, position) => {
    const variants = selectedVariants(builds?.[position])
    const slideIssues = []
    if (!variants.length) {
      slideIssues.push(
        { category: 'no_usable_variant', field: 'title', text_length: String(slide?.title || '').length },
        { category: 'no_usable_variant', field: 'text', text_length: String(slide?.text || '').length },
        {
          category: 'no_usable_variant',
          field: 'context',
          context_categories: Object.entries(slide?.context || {})
            .filter(([, items]) => Array.isArray(items) && items.length)
            .map(([category]) => category),
        },
      )
    } else {
      const all = variants.map((variant) => variantIssues(variant, slide))
      if (all.every((item) => item.length)) {
        const shortest = all.reduce((best, item) => item.length < best.length ? item : best)
        slideIssues.push(...shortest.slice(0, 3))
      }
    }
    keys.push(similarityKey(variants[0]))
    if (slideIssues.length) issues.push({ slide: position + 1, issues: slideIssues })
  })
  for (let index = 2; index < keys.length; index += 1) {
    const locked = [index - 2, index - 1, index].every((position) => (
      selectedVariants(builds?.[position]).every((variant) => similarityKey(variant) === keys[index])
    ))
    if (locked && keys[index] && keys[index] === keys[index - 1] && keys[index] === keys[index - 2]) {
      const entry = issues.find((item) => item.slide === index + 1)
      const similarity = {
        category: 'repetitive_layout',
        field: 'context',
        context_categories: Object.entries(slides[index]?.context || {})
          .filter(([, items]) => Array.isArray(items) && items.length)
          .map(([category]) => category),
        template_id: keys[index].split('|')[0],
      }
      if (entry) entry.issues.push(similarity)
      else issues.push({ slide: index + 1, issues: [similarity] })
    }
  }
  for (let index = 1; index < slides.length; index += 1) {
    const previous = slides[index - 1]
    const current = slides[index]
    const repeatedTitle = String(current?.title || '').trim().length >= 8
      && String(current.title).trim().toLowerCase() === String(previous?.title || '').trim().toLowerCase()
    const repeatedText = tooSimilarText(previous?.text, current?.text)
    if (!repeatedTitle && !repeatedText) continue
    const entry = issues.find((item) => item.slide === index + 1)
    const duplicate = {
      category: 'repetitive_content',
      field: repeatedTitle ? 'title' : 'text',
      similar_to_slide: index,
    }
    if (entry) entry.issues.push(duplicate)
    else issues.push({ slide: index + 1, issues: [duplicate] })
  }
  if (report) {
    const coverage = createCoverageContext(report)
    const contentPositions = slides.map((slide, index) => (
      ['title', 'summary', 'cta'].includes(slide?.intent) || index === 0 || index === slides.length - 1
        ? -1 : index
    )).filter((index) => index >= 0)
    if (contentPositions.length) {
      const exposed = new Set((builds || []).flatMap((build) => selectedVariants(build))
        .map((variant) => coverage.componentKeys[variant.componentId]).filter(Boolean))
      const allocated = new Set()
      for (const family of coverage.targetKeys.filter((key) => !exposed.has(key))) {
        const category = family.startsWith('chart:') ? 'charts'
          : family === 'table' ? 'tables' : 'icon_lists'
        const position = contentPositions.find((index) => (category !== 'charts' || !allocated.has(index))
          && !(slides[index]?.context?.[category] || []).length)
        if (position == null) continue
        if (category === 'charts') allocated.add(position)
        const entry = issues.find((item) => item.slide === position + 1)
        const issue = {
          category: 'missing_component_coverage',
          field: 'context',
          context_category: category,
          component_family: family,
        }
        if (entry) entry.issues.push(issue)
        else issues.push({ slide: position + 1, issues: [issue] })
      }
    }
  }
  return issues.sort((left, right) => left.slide - right.slide)
}
