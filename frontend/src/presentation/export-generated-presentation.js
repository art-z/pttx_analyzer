import { prepareGeneratedSlides } from './generated-export-scene.js'
import { mountCatalogSlide } from '../templates/slide-render.js'

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

function safeFilename(title) {
  return String(title || 'presentation').replace(/[^\p{L}\p{N}_-]+/gu, '-').replace(/^-+|-+$/g, '') || 'presentation'
}

function escapeHtml(value) {
  return String(value || '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[char])
}

async function dataUrl(response) {
  if (!response.ok) throw new Error('Не удалось встроить ресурс HTML-презентации')
  const blob = await response.blob()
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result)
    reader.onerror = reject
    reader.readAsDataURL(blob)
  })
}

async function inlineCssResources(css, baseUrl) {
  const matches = [...css.matchAll(/url\(\s*(['"]?)([^)'"\s]+)\1\s*\)/gu)]
  const replacements = await Promise.all(matches.map(async (match) => {
    const raw = match[2]
    if (raw.startsWith('data:') || raw.startsWith('#')) return [match[0], match[0]]
    const url = new URL(raw, baseUrl)
    if (url.origin !== location.origin) return [match[0], match[0]]
    return [match[0], `url("${await dataUrl(await fetch(url))}")`]
  }))
  let result = css
  for (const [before, after] of replacements) result = result.replaceAll(before, after)
  return result
}

async function pageCss() {
  const chunks = await Promise.all([...document.styleSheets].map(async (sheet) => {
    if (sheet.href) {
      const url = new URL(sheet.href, location.href)
      if (url.origin !== location.origin) return ''
      const response = await fetch(url)
      if (!response.ok) throw new Error('Не удалось загрузить стили HTML-презентации')
      return inlineCssResources(await response.text(), url)
    }
    try {
      return [...sheet.cssRules].map((rule) => rule.cssText).join('\n')
    } catch {
      return ''
    }
  }))
  return chunks.join('\n')
}

async function exportHtml(state, slides) {
  const pages = []
  for (const slide of slides) {
    const mount = document.createElement('div')
    const frame = mountCatalogSlide(mount, slide, state.jobId)
    for (const image of frame.querySelectorAll('img[src]')) {
      image.src = await dataUrl(await fetch(image.src))
    }
    pages.push(`<section class="export-slide">${frame.outerHTML}</section>`)
  }
  const title = state.presentation?.presentation?.title || 'Презентация'
  const size = slides[0]?.render?.slide_size_pt || { width: 960, height: 540 }
  const css = await pageCss()
  const html = `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><style>${css}\n:root{background:#17212d}body{margin:0;background:#17212d}.export-slide{width:min(100%,${Number(size.width) || 960}px);margin:20px auto;break-after:page}.export-slide .catalog-slide{border-radius:0;box-shadow:none}@page{size:${(Number(size.width) || 960) / 72}in ${(Number(size.height) || 540) / 72}in;margin:0}@media print{body{background:white}.export-slide{width:100%;margin:0;break-after:page}.export-slide:last-child{break-after:auto}}<\/style></head><body>${pages.join('')}<\/body></html>`
  downloadBlob(new Blob([html], { type: 'text/html;charset=utf-8' }), `${safeFilename(title)}-selected.html`)
}

export async function exportGeneratedPresentation(state, slides, format = 'pptx') {
  if (!state?.jobId) throw new Error('Нет jobId для экспорта')
  if (!Array.isArray(slides) || !slides.length) throw new Error('Не выбраны варианты слайдов')
  if (!['pptx', 'pdf', 'html'].includes(format)) throw new Error('Неизвестный формат экспорта')

  const exportSlides = prepareGeneratedSlides(state.report, slides)
  if (format === 'html') return exportHtml(state, exportSlides)
  const response = await fetch(`/jobs/${encodeURIComponent(state.jobId)}/export-generated.${format}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      title: state.presentation?.presentation?.title || 'presentation',
      slides: exportSlides,
    }),
  })
  if (!response.ok) {
    let message = `Не удалось собрать выбранные слайды в ${format.toUpperCase()}`
    try {
      const payload = await response.json()
      message = payload.detail || message
    } catch {
      // Keep the stable user-facing error.
    }
    throw new Error(message)
  }

  const disposition = response.headers.get('Content-Disposition') || ''
  const filename = disposition.match(/filename="?([^";]+)"?/i)?.[1] || `generated-presentation.${format}`
  downloadBlob(await response.blob(), filename)
}
