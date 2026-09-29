const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp'])

export function formatDuration(ms) {
  const safe = Math.max(0, Number(ms) || 0)
  const totalTenths = Math.floor(safe / 100)
  const minutes = Math.floor(totalTenths / 600)
  const seconds = Math.floor(totalTenths / 10) % 60
  const tenths = totalTenths % 10
  return `${minutes}:${String(seconds).padStart(2, '0')}.${tenths}`
}

export function listFlyableAssets(report) {
  return (report?.assets?.media_files || []).filter((asset) => {
    const extension = String(asset?.extension || '').toLowerCase()
    return Boolean(asset?.filename) && IMAGE_EXTENSIONS.has(extension)
  })
}

export function formatTokenLine(usage) {
  if (!usage || !usage.request_count) return ''
  const number = new Intl.NumberFormat('ru-RU')
  return `${number.format(usage.total_tokens || 0)} токенов · вход ${number.format(usage.input_tokens || 0)} · выход ${number.format(usage.output_tokens || 0)}`
}
