const MAX_INPUT_BYTES = 20 * 1024 * 1024

/**
 * Centre-crops to a square and re-encodes as JPEG. Drawing through a canvas drops every piece of
 * metadata, including the GPS position and camera details phones embed in photos, so none of it
 * leaves the device. It also keeps the upload to a few tens of KB.
 */
export async function toSquareJpeg(file: File, size = 256, quality = 0.85): Promise<Blob> {
  if (!file.type.startsWith('image/')) throw new Error('請選擇圖片檔')
  if (file.size > MAX_INPUT_BYTES) throw new Error('圖片檔案太大')

  const url = URL.createObjectURL(file)
  try {
    // <img> honours the EXIF rotation in Safari, so portrait photos come out upright.
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image()
      el.onload = () => resolve(el)
      el.onerror = () => reject(new Error('無法讀取這張圖片，請換一張（建議 JPEG 或 PNG）'))
      el.src = url
    })
    const side = Math.min(img.naturalWidth, img.naturalHeight)
    if (!side) throw new Error('無法讀取這張圖片')

    const canvas = document.createElement('canvas')
    canvas.width = size
    canvas.height = size
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('這個瀏覽器無法處理圖片')
    ctx.fillStyle = '#ffffff' // transparent PNGs would otherwise turn black in JPEG
    ctx.fillRect(0, 0, size, size)
    ctx.drawImage(img, (img.naturalWidth - side) / 2, (img.naturalHeight - side) / 2, side, side, 0, 0, size, size)

    return await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('圖片轉換失敗'))), 'image/jpeg', quality),
    )
  } finally {
    URL.revokeObjectURL(url)
  }
}
