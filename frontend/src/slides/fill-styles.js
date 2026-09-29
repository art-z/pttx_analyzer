function hexToRgb(hex) {
  if (!/^#[0-9A-F]{6}$/i.test(hex || '')) return null
  return {
    r: parseInt(hex.slice(1, 3), 16),
    g: parseInt(hex.slice(3, 5), 16),
    b: parseInt(hex.slice(5, 7), 16),
  }
}

export function rgbaColor(color, alpha = 1) {
  const rgb = hexToRgb(color)
  if (!rgb) return color || 'transparent'
  const resolvedAlpha = Math.max(0, Math.min(1, Number(alpha ?? 1)))
  if (resolvedAlpha >= 0.999) return color
  if (resolvedAlpha <= 0) return 'transparent'
  return `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${resolvedAlpha})`
}

export function solidFillCss(fill) {
  if (!fill || fill.kind === 'none') return null
  const color = fill.color
  if (!color) return null
  return rgbaColor(color, fill.alpha ?? 1)
}

export function gradientFillCss(fill) {
  if (!fill?.stops?.length) return null
  const stops = [...fill.stops]
    .sort((left, right) => (left.position ?? 0) - (right.position ?? 0))
    .map((stop) => {
      const position = Math.round((stop.position ?? 0) * 1000) / 10
      return `${rgbaColor(stop.color, stop.alpha ?? 1)} ${position}%`
    })
    .join(', ')

  if (fill.kind === 'radial_gradient') {
    const rect = fill.fill_to_rect || {}
    const atX = Math.round(((rect.l ?? 0.5) + (rect.r ?? 0.5)) * 50)
    const atY = Math.round(((rect.t ?? 0.5) + (rect.b ?? 0.5)) * 50)
    return `radial-gradient(circle at ${atX}% ${atY}%, ${stops})`
  }

  const angle = fill.angle_deg ?? 0
  return `linear-gradient(${angle}deg, ${stops})`
}

export function fillBackgroundCss(fill) {
  if (!fill) return null
  if (fill.kind === 'linear_gradient' || fill.kind === 'radial_gradient') {
    return gradientFillCss(fill)
  }
  return solidFillCss(fill)
}

export function applyFillStyle(node, fill) {
  if (!node || !fill) return false
  const css = fillBackgroundCss(fill)
  if (!css) return false
  if (fill.kind === 'linear_gradient' || fill.kind === 'radial_gradient') {
    node.style.backgroundColor = 'transparent'
    node.style.backgroundImage = css
  } else {
    node.style.backgroundImage = 'none'
    node.style.backgroundColor = css
  }
  return true
}

export function typographyColorCss(typography) {
  if (!typography?.color) return null
  return rgbaColor(typography.color, typography.alpha ?? 1)
}

export function strokeColorCss(stroke) {
  const color = stroke?.color
  if (!color) return null
  if (typeof color === 'string') return color
  return solidFillCss(color)
}
