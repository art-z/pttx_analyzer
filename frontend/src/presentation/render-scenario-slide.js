import { toCanvas } from 'html-to-image'
import { ensurePresentationFonts } from '../slides/design-system-render.js'
import { mountCatalogSlide } from '../templates/slide-render.js'
import { buildScenarioSlide } from './build-slide.js'
import { prepareGeneratedSlide } from './generated-export-scene.js'

const RASTER_WIDTH = 480
let rasterQueue = Promise.resolve()

function enqueueRasterTask(task) {
  const run = rasterQueue.then(task, task)
  rasterQueue = run.catch(() => {})
  return run
}

function mountCatalogPreview(mount, report, catalogSlide, jobId) {
  const preview = document.createElement('div')
  preview.className = 'presentation-slide-preview presentation-slide-preview--catalog'
  mount.append(preview)

  ensurePresentationFonts()
  mountCatalogSlide(preview, prepareGeneratedSlide(report, catalogSlide), jobId)
  return () => {}
}

function canvasToWebp(canvas) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => blob ? resolve(blob) : reject(new Error('Не удалось создать preview-изображение')),
      'image/webp',
      0.86,
    )
  })
}

async function waitForRasterAssets(stage) {
  await ensurePresentationFonts()
  const images = [...stage.querySelectorAll('img')]
  await Promise.all(images.map(async (image) => {
    if (image.complete) return
    try {
      await image.decode()
    } catch {
      // The rasterizer will still capture the available fallback state.
    }
  }))
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
}

function rasterizeCatalogPreview(target, report, catalogSlide, jobId, label) {
  let disposed = false
  let objectUrl = null

  target.replaceChildren(Object.assign(document.createElement('span'), {
    className: 'presentation-slide-raster-status',
    textContent: 'Растеризация…',
  }))

  enqueueRasterTask(async () => {
    if (disposed) return
    const stage = document.createElement('div')
    stage.className = 'presentation-raster-stage'
    stage.style.width = `${RASTER_WIDTH}px`
    document.body.append(stage)
    try {
      mountCatalogPreview(stage, report, catalogSlide, jobId)
      await waitForRasterAssets(stage)
      if (disposed) return
      const preview = stage.querySelector('.presentation-slide-preview')
      if (!preview) throw new Error('DOM-превью не создано')
      const canvas = await toCanvas(preview, {
        backgroundColor: '#ffffff',
        cacheBust: false,
        pixelRatio: 1,
        skipAutoScale: true,
      })
      const blob = await canvasToWebp(canvas)
      if (disposed) return
      objectUrl = URL.createObjectURL(blob)
      const image = document.createElement('img')
      image.className = 'presentation-slide-raster-image'
      image.alt = label || 'Вариант слайда'
      image.loading = 'lazy'
      image.decoding = 'async'
      image.src = objectUrl
      target.replaceChildren(image)
    } catch (error) {
      if (!disposed) {
        target.replaceChildren(Object.assign(document.createElement('span'), {
          className: 'presentation-slide-raster-error',
          textContent: error?.message || 'Не удалось растрировать preview',
        }))
      }
    } finally {
      stage.remove()
    }
  })

  return () => {
    disposed = true
    target.replaceChildren()
    if (objectUrl) URL.revokeObjectURL(objectUrl)
  }
}

function mountDataStepCell(parent, step, buildResult, jobId) {
  const cell = document.createElement('article')
  cell.className = 'presentation-slide-data-step'

  const head = document.createElement('div')
  head.className = 'presentation-slide-data-step-head'
  head.append(
    Object.assign(document.createElement('span'), {
      className: 'presentation-slide-data-step-index',
      textContent: String(step.order || ''),
    }),
    Object.assign(document.createElement('strong'), { textContent: step.label || step.key }),
  )

  const mount = document.createElement('div')
  mount.className = 'presentation-slide-data-step-preview'

  cell.append(head, mount)
  parent.append(cell)

  if (step.catalogSlide) return rasterizeCatalogPreview(
    mount,
    buildResult.report,
    step.catalogSlide,
    jobId,
    step.label || step.key,
  )

  mount.append(Object.assign(document.createElement('p'), {
    className: 'presentation-slide-analysis-error',
    textContent: step.gaps?.[0] || 'Preview недоступен',
  }))
  return () => {}
}

export function mountScenarioSlidePreviewVariants(container, buildResult, jobId, {
  selectedKey = null,
  onSelect = null,
} = {}) {
  container.replaceChildren()

  const variants = buildResult.previewVariants || []
  if (variants.length) {
    const row = document.createElement('div')
    row.className = 'presentation-slide-variants-row'
    const activeKey = selectedKey && variants.some((item) => item.key === selectedKey)
      ? selectedKey
      : variants[0].key
    const disposers = []
    variants.forEach((variant, index) => {
      const card = document.createElement('button')
      card.type = 'button'
      card.className = `presentation-slide-variant${variant.key === activeKey ? ' active' : ''}`
      card.dataset.variantKey = variant.key
      card.setAttribute('aria-pressed', String(variant.key === activeKey))

      const head = document.createElement('span')
      head.className = 'presentation-slide-variant-head'
      head.append(
        Object.assign(document.createElement('strong'), { textContent: `Вариант ${index + 1}` }),
        Object.assign(document.createElement('small'), { textContent: variant.sublabel || variant.label || '' }),
      )
      const mount = document.createElement('span')
      mount.className = 'presentation-slide-variant-preview'
      card.append(head, mount)
      row.append(card)

      if (variant.catalogSlide) disposers.push(rasterizeCatalogPreview(
        mount,
        buildResult.report,
        variant.catalogSlide,
        jobId,
        variant.sublabel || variant.label || `Вариант ${index + 1}`,
      ))

      card.addEventListener('click', () => {
        row.querySelectorAll('.presentation-slide-variant').forEach((item) => {
          const active = item.dataset.variantKey === variant.key
          item.classList.toggle('active', active)
          item.setAttribute('aria-pressed', String(active))
        })
        onSelect?.(variant)
      })
    })
    container.append(row)
    return () => disposers.forEach((dispose) => dispose())
  }

  const dataSteps = buildResult.dataSteps || []
  if (dataSteps.length) {
    const row = document.createElement('div')
    row.className = 'presentation-slide-data-steps-row'
    const disposers = dataSteps.map((step) => mountDataStepCell(row, step, buildResult, jobId))
    container.append(row)
    return () => disposers.forEach((dispose) => dispose())
  }

  return mountScenarioSlidePreview(container, buildResult, jobId)
}

export function mountScenarioSlidePreview(container, buildResult, jobId) {
  container.replaceChildren()

  if (buildResult.catalogSlide) {
    const mount = document.createElement('div')
    mount.className = 'presentation-slide-preview-mount'
    container.append(mount)
    return rasterizeCatalogPreview(
      mount,
      buildResult.report,
      buildResult.catalogSlide,
      jobId,
      buildResult.match?.templateName || 'Слайд',
    )
  }

  container.append(Object.assign(document.createElement('p'), {
    className: 'presentation-slide-analysis-error',
    textContent: buildResult.gaps[0] || 'Не удалось собрать preview',
  }))
  return () => {}
}

export function createScenarioSlideCard(slide, report, jobId, baseTokens) {
  const buildResult = buildScenarioSlide(report, slide, baseTokens)
  return { buildResult }
}
