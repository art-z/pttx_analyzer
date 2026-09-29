import './style.css'
import './lite.css'
import { exportGeneratedPresentation } from './presentation/export-generated-presentation.js'
import { prepareGeneratedSlide } from './presentation/generated-export-scene.js'
import { ensurePresentationFonts } from './slides/design-system-render.js'
import { mountCatalogSlide } from './templates/slide-render.js'
import { formatDuration, formatTokenLine, listFlyableAssets } from './lite-session.js'
import { collectLayoutFeedback } from './presentation/layout-feedback.js'

const $ = (selector) => document.querySelector(selector)

const session = {
  file: null,
  brief: '',
  running: false,
  jobId: null,
  report: null,
  presentation: null,
  llmUsage: null,
  slides: [],
  timer: null,
  flight: null,
  intake: null,
  exporting: false,
  exportFormat: null,
}

function setHidden(selector, hidden) {
  $(selector).hidden = hidden
}

function showError(message) {
  const node = $('#lite-error')
  node.hidden = !message
  node.textContent = message || ''
}

function showResultError(message) {
  const node = $('#lite-result-error')
  node.hidden = !message
  node.textContent = message || ''
}

function updateStartButton() {
  $('#lite-start').disabled = session.running || !session.file || !session.brief.trim()
}

function setFile(file) {
  if (!file) return
  if (!file.name.toLowerCase().endsWith('.pptx')) {
    session.file = null
    $('#lite-file-title').textContent = 'Презентация-шаблон'
    $('#lite-file-hint').textContent = 'Нужен файл .pptx'
    updateStartButton()
    showError('Выберите файл в формате .pptx')
    return
  }
  session.file = file
  $('#lite-file-title').textContent = file.name
  $('#lite-file-hint').textContent = 'Можно выбрать другой файл'
  showError('')
  updateStartButton()
}

function showForm() {
  setHidden('#lite-form', false)
  setHidden('#lite-wait', true)
  setHidden('#lite-result', true)
  stopFlight()
  stopIntake()
  hideUploadProgress()
}

function showWait(status) {
  setHidden('#lite-form', true)
  setHidden('#lite-wait', false)
  setHidden('#lite-result', true)
  $('#lite-status').textContent = status
}

function showResult() {
  setHidden('#lite-form', true)
  setHidden('#lite-wait', true)
  setHidden('#lite-result', false)
  stopFlight()
  stopIntake()
  hideUploadProgress()
}

function startTimer() {
  const started = performance.now()
  const tick = () => {
    const label = formatDuration(performance.now() - started)
    $('#lite-timer').textContent = label
    $('#lite-elapsed').textContent = label
  }
  tick()
  const id = window.setInterval(tick, 100)
  session.timer = {
    stop() {
      window.clearInterval(id)
      const label = formatDuration(performance.now() - started)
      $('#lite-timer').textContent = label
      $('#lite-elapsed').textContent = label
      session.timer = null
      return label
    },
  }
}

function stopTimer() {
  return session.timer ? session.timer.stop() : $('#lite-timer').textContent
}

function stopFlight() {
  session.flight?.stop()
  session.flight = null
  $('#lite-stage').replaceChildren()
}

function humanBytes(value) {
  const units = ['Б', 'КБ', 'МБ', 'ГБ']
  let amount = Number(value) || 0
  let unit = 0
  while (amount >= 1024 && unit < units.length - 1) {
    amount /= 1024
    unit += 1
  }
  const digits = amount >= 10 || unit === 0 ? 0 : 1
  return `${amount.toFixed(digits)} ${units[unit]}`
}

function setUploadProgress({ loaded = 0, total = 0, complete = false, processing = false } = {}) {
  const upload = $('#lite-upload')
  upload.hidden = false
  const percent = total > 0 ? Math.min(100, Math.round((loaded / total) * 100)) : 0
  $('#lite-upload-bar').style.width = `${complete ? 100 : percent}%`
  $('#lite-upload-percent').textContent = total > 0 || complete ? `${complete ? 100 : percent}%` : '...'
  $('#lite-upload-label').textContent = processing ? 'Файл принят' : 'Принимаем файл'
  $('#lite-upload-bytes').textContent = total > 0
    ? `${humanBytes(Math.min(loaded, total))} из ${humanBytes(total)}`
    : 'Передаём файл на сервер'
}

function hideUploadProgress() {
  $('#lite-upload').hidden = true
  $('#lite-upload-bar').style.width = '0%'
  $('#lite-upload-percent').textContent = '0%'
  $('#lite-upload-bytes').textContent = ''
}

function spawnIntakeShape() {
  const shape = document.createElement('span')
  shape.className = `lite-intake-shape${Math.random() > 0.48 ? ' lite-intake-shape--square' : ''}`
  const angle = Math.random() * Math.PI * 2
  const distance = 42 + Math.random() * 32
  const size = 12 + Math.random() * 22
  shape.style.setProperty('--from-x', `calc(-50% + ${Math.cos(angle) * distance}vw)`)
  shape.style.setProperty('--from-y', `calc(-50% + ${Math.sin(angle) * distance}vh)`)
  shape.style.setProperty('--size', `${size.toFixed(1)}px`)
  shape.style.setProperty('--rot', `${(Math.random() * 220 - 110).toFixed(1)}deg`)
  shape.style.setProperty('--duration', `${900 + Math.random() * 700}ms`)
  shape.addEventListener('animationend', () => shape.remove())
  $('#lite-intake').append(shape)
}

function startIntake() {
  stopIntake()
  let stopped = false
  const launch = () => {
    if (stopped) return
    const count = 6 + Math.floor(Math.random() * 4)
    for (let index = 0; index < count; index += 1) spawnIntakeShape()
  }
  launch()
  const id = window.setInterval(launch, 360)
  session.intake = {
    stop() {
      stopped = true
      window.clearInterval(id)
      $('#lite-intake').replaceChildren()
    },
  }
}

function stopIntake() {
  session.intake?.stop()
  session.intake = null
}

function spawnAsset(asset) {
  const image = document.createElement('img')
  image.className = 'lite-fly'
  image.alt = ''
  image.src = `/jobs/${encodeURIComponent(session.jobId)}/assets/${encodeURIComponent(asset.filename)}`
  const angle = Math.random() * Math.PI * 2
  const distance = 34 + Math.random() * 28
  image.style.setProperty('--dx', `${Math.cos(angle) * distance}vw`)
  image.style.setProperty('--dy', `${Math.sin(angle) * distance}vh`)
  image.style.setProperty('--rot', `${(Math.random() * 36 - 18).toFixed(1)}deg`)
  image.style.width = `${52 + Math.random() * 84}px`
  image.style.animationDuration = `${1500 + Math.random() * 1100}ms`
  image.style.animationDelay = `${Math.random() * 180}ms`
  image.addEventListener('animationend', () => image.remove())
  image.addEventListener('error', () => image.remove())
  $('#lite-stage').append(image)
}

function startFlight(assets) {
  stopFlight()
  if (!assets.length || !session.jobId) return
  let cursor = 0
  let stopped = false
  const launch = () => {
    if (stopped) return
    const count = 5 + Math.floor(Math.random() * 3)
    for (let index = 0; index < count; index += 1) {
      spawnAsset(assets[cursor % assets.length])
      cursor += 1
    }
  }
  launch()
  const id = window.setInterval(launch, 1000)
  session.flight = {
    stop() {
      stopped = true
      window.clearInterval(id)
    },
  }
}

async function readError(response, fallback) {
  try {
    const payload = await response.json()
    return payload.detail || fallback
  } catch {
    return fallback
  }
}

async function loadDefaultBrief() {
  try {
    const response = await fetch('/prompts/default-brief')
    const data = await response.json()
    if (!response.ok || session.brief.trim()) return
    session.brief = String(data.brief || '')
    $('#lite-brief').value = session.brief
    updateStartButton()
  } catch {
    // The field stays empty until the user writes a brief.
  }
}

async function analyzeTemplate() {
  $('#lite-status').textContent = 'Загружаем шаблон'
  startIntake()
  setUploadProgress({ loaded: 0, total: session.file?.size || 0 })
  const body = new FormData()
  body.append('file', session.file)
  const data = await uploadAnalyze(body)
  session.jobId = data.job_id
  session.report = data.report
  stopIntake()
  hideUploadProgress()
  startFlight(listFlyableAssets(data.report))
}

function uploadAnalyze(body) {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest()
    request.open('POST', '/analyze')
    request.responseType = 'json'
    request.upload.addEventListener('progress', (event) => {
      setUploadProgress({
        loaded: event.loaded,
        total: event.lengthComputable ? event.total : session.file?.size || 0,
      })
    })
    request.upload.addEventListener('load', () => {
      $('#lite-status').textContent = 'Шаблон загружен, разбираем структуру'
      setUploadProgress({
        loaded: session.file?.size || 0,
        total: session.file?.size || 0,
        complete: true,
        processing: true,
      })
    })
    request.addEventListener('load', () => {
      const payload = request.response
      if (request.status >= 200 && request.status < 300) {
        resolve(payload)
        return
      }
      reject(new Error(payload?.detail || 'Не удалось разобрать шаблон'))
    })
    request.addEventListener('error', () => reject(new Error('Не удалось передать файл на сервер')))
    request.addEventListener('abort', () => reject(new Error('Загрузка файла прервана')))
    request.send(body)
  })
}

async function generatePresentation() {
  $('#lite-status').textContent = 'Генерируем презентацию'
  const response = await fetch(`/jobs/${encodeURIComponent(session.jobId)}/generate-presentation`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ brief: session.brief.trim() }),
  })
  if (!response.ok) throw new Error(await readError(response, 'Не удалось создать презентацию'))
  const data = await response.json()
  session.presentation = data.presentation
  session.llmUsage = data.llm_usage || null
  return data.presentation
}

function assembleSlides(rawSlides, totalSlides = rawSlides.length) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./lite-assemble.worker.js', import.meta.url), { type: 'module' })
    const built = rawSlides.map((slide) => ({ slide, variants: [], selectedIndex: 0 }))
    let finished = 0
    const fail = (error) => {
      worker.terminate()
      reject(error instanceof Error ? error : new Error('Не удалось собрать слайды'))
    }
    worker.onmessage = (event) => {
      const message = event.data || {}
      if (message.type === 'error') {
        fail(new Error(message.message || 'Не удалось собрать слайды'))
        return
      }
      if (message.type === 'slide') {
        const item = built[message.index]
        item.variants = message.variants || []
        item.selectedIndex = item.variants.length ? 0 : -1
        finished += 1
        $('#lite-status').textContent = `Собираем слайды · ${finished} из ${rawSlides.length}`
      }
      if (message.type === 'done') {
        worker.terminate()
        resolve(built)
      }
    }
    worker.onerror = (event) => fail(new Error(event.message || 'Не удалось собрать слайды'))
    worker.postMessage({
      report: session.report,
      slides: rawSlides,
      totalSlides,
      title: session.presentation?.presentation?.title || 'presentation',
    })
  })
}

function chosenSlides() {
  return session.slides
    .map((item) => item.variants[item.selectedIndex]?.catalogSlide)
    .filter(Boolean)
}

function updateDownloadButton() {
  const count = chosenSlides().length
  document.querySelectorAll('[data-lite-export-format]').forEach((button) => {
    button.disabled = session.exporting || count === 0
    const format = button.dataset.liteExportFormat.toUpperCase()
    button.textContent = session.exportFormat === button.dataset.liteExportFormat
      ? `Собираем ${format}…` : `Скачать ${format}`
  })
}

async function renderGrid() {
  const grid = $('#lite-grid')
  ensurePresentationFonts()
  grid.replaceChildren()
  for (let index = 0; index < session.slides.length; index += 1) {
    const item = session.slides[index]
    const section = document.createElement('section')
    section.className = 'lite-slide'
    const heading = document.createElement('div')
    heading.className = 'lite-slide-head'
    const label = document.createElement('span')
    label.textContent = `${String(item.slide.index ?? index + 1).padStart(2, '0')} · ${String(item.slide.intent || 'slide').toUpperCase()}`
    const title = document.createElement('strong')
    title.textContent = item.variants[item.selectedIndex]?.titleText || item.slide.title || 'Без названия'
    heading.append(label, title)

    const row = document.createElement('div')
    row.className = 'lite-variants'
    row.setAttribute('role', 'radiogroup')
    row.setAttribute('aria-label', title.textContent)
    if (!item.variants.length) {
      const empty = document.createElement('p')
      empty.className = 'lite-slide-empty'
      empty.textContent = 'Варианты не собраны'
      row.append(empty)
    } else {
      item.variants.forEach((variant, variantIndex) => {
        const button = document.createElement('button')
        button.type = 'button'
        button.className = 'lite-card'
        button.setAttribute('role', 'radio')
        const selected = variantIndex === item.selectedIndex
        button.classList.toggle('is-selected', selected)
        button.setAttribute('aria-checked', String(selected))
        button.setAttribute('aria-label', variant.label)
        const preview = document.createElement('div')
        preview.className = 'lite-card-preview'
        mountCatalogSlide(preview, prepareGeneratedSlide(session.report, variant.catalogSlide), session.jobId)
        button.append(preview)
        button.addEventListener('click', () => {
          item.selectedIndex = variantIndex
          title.textContent = variant.titleText || item.slide.title || 'Без названия'
          row.querySelectorAll('.lite-card').forEach((card, cardIndex) => {
            const active = cardIndex === variantIndex
            card.classList.toggle('is-selected', active)
            card.setAttribute('aria-checked', String(active))
          })
        })
        row.append(button)
      })
    }
    section.append(heading, row)
    grid.append(section)
    await new Promise((resolve) => window.setTimeout(resolve, 0))
  }
  updateDownloadButton()
}

async function downloadSelected(format = 'pptx') {
  const slides = chosenSlides()
  if (session.exporting || !slides.length) return
  session.exporting = true
  session.exportFormat = format
  showResultError('')
  updateDownloadButton()
  try {
    await exportGeneratedPresentation({
      jobId: session.jobId,
      report: session.report,
      presentation: session.presentation,
    }, slides, format)
  } catch (error) {
    showResultError(error.message || 'Не удалось скачать презентацию')
  } finally {
    session.exporting = false
    session.exportFormat = null
    updateDownloadButton()
  }
}

async function start() {
  if (session.running || !session.file || !session.brief.trim()) return
  session.running = true
  session.jobId = null
  session.report = null
  session.presentation = null
  session.llmUsage = null
  session.slides = []
  showError('')
  showResultError('')
  updateStartButton()
  showWait('Запускаем')
  startTimer()
  try {
    await analyzeTemplate()
    const generated = await generatePresentation()
    const slides = generated?.presentation?.slides || []
    if (!slides.length) throw new Error('Модель не вернула слайды')
    $('#lite-status').textContent = 'Собираем слайды'
    session.slides = await assembleSlides(slides)
    session.presentation.layout_issues_after_review = collectLayoutFeedback(slides, session.slides, session.report)
    if (session.presentation.layout_issues_after_review.length) {
      showResultError(`После проверки остались замечания на слайдах: ${session.presentation.layout_issues_after_review.map((item) => item.slide).join(', ')}. Проверьте варианты перед скачиванием.`)
    }
    $('#lite-status').textContent = 'Показываем варианты'
    $('#lite-tokens').textContent = formatTokenLine(session.llmUsage)
    showResult()
    await renderGrid()
    stopTimer()
  } catch (error) {
    stopTimer()
    stopFlight()
    stopIntake()
    hideUploadProgress()
    showForm()
    showError(error.message || 'Не удалось собрать презентацию')
  } finally {
    session.running = false
    updateStartButton()
  }
}

$('#lite-brief').addEventListener('input', (event) => {
  session.brief = event.target.value
  updateStartButton()
})
$('#lite-file').addEventListener('change', (event) => setFile(event.target.files?.[0]))
$('#lite-drop').addEventListener('dragover', (event) => {
  event.preventDefault()
})
$('#lite-drop').addEventListener('drop', (event) => {
  event.preventDefault()
  setFile(event.dataTransfer?.files?.[0])
})
$('#lite-drop').addEventListener('keydown', (event) => {
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault()
    $('#lite-file').click()
  }
})
$('#lite-start').addEventListener('click', start)
document.querySelectorAll('[data-lite-export-format]').forEach((button) => {
  button.addEventListener('click', () => downloadSelected(button.dataset.liteExportFormat))
})
$('#lite-again').addEventListener('click', () => {
  showForm()
  updateStartButton()
})

loadDefaultBrief()
