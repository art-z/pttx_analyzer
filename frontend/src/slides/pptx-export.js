export async function exportSlidesToPptx(state, { onProgress } = {}) {
  const catalog = state.report?.slides
  const slides = catalog?.slides || []
  if (!slides.length) {
    throw new Error('Каталог слайдов пуст')
  }
  if (!state.jobId) {
    throw new Error('Нет jobId для экспорта')
  }

  const mode = state.slidesRenderMode || 'design-system'
  const sourceName = String(state.report?.source || 'presentation.pptx')
  const modeLabel = mode === 'faithful' ? 'pptx-raw' : 'design-system'
  const filename = `${sourceName.replace(/\.pptx$/i, '')}-${modeLabel}-editable.pptx`

  onProgress?.({ phase: 'build' })

  const response = await fetch(
    `/jobs/${encodeURIComponent(state.jobId)}/export-editable.pptx?mode=${encodeURIComponent(mode)}`,
  )
  if (!response.ok) {
    let message = 'Не удалось собрать редактируемый PPTX'
    const bodyText = await response.text()
    if (bodyText) {
      try {
        const data = JSON.parse(bodyText)
        message = data.detail || data.message || message
        if (Array.isArray(message)) {
          message = message.map((item) => item?.msg || item).join('; ')
        }
      } catch {
        message = bodyText
      }
    }
    throw new Error(typeof message === 'string' ? message : 'Не удалось собрать редактируемый PPTX')
  }

  const blob = await response.blob()
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  link.click()
  URL.revokeObjectURL(url)
}

export function resolveExportDimensions(slideSize) {
  const widthPt = slideSize.width || 960
  const heightPt = slideSize.height || 540
  const exportWidthPx = 1920
  const exportHeightPx = Math.round((exportWidthPx * heightPt) / widthPt)
  return {
    widthPt,
    heightPt,
    exportWidthPx,
    exportHeightPx,
  }
}
