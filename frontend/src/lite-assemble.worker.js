import { extractDesignTokens } from './constructor/tokens.js'
import { takeSlideVariants } from './lite-assemble.js'
import { createCoverageContext } from './presentation/component-coverage.js'

self.onmessage = (event) => {
  const { report, slides, title, totalSlides } = event.data || {}
  try {
    const tokens = extractDesignTokens(report)
    const context = createCoverageContext(report)
    ;(slides || []).forEach((slide, index) => {
      let variants = []
      try {
        variants = takeSlideVariants(
          report,
          slide,
          tokens,
          context,
          `${title || 'presentation'}|${slide.index ?? index + 1}|${slide.intent || ''}`,
          { position: index, totalSlides: totalSlides || slides.length },
        )
      } catch {
        variants = []
      }
      self.postMessage({ type: 'slide', index, variants })
    })
    self.postMessage({ type: 'done' })
  } catch (error) {
    self.postMessage({
      type: 'error',
      message: error?.message || 'Не удалось собрать слайды',
    })
  }
}
