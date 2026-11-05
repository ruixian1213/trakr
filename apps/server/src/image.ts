// Just enough image parsing to decide whether an upload is safe to store and serve. We never decode
// pixels on the server; we read the type from the file signature (not from what the client claims)
// and the declared dimensions, because a tiny file can declare a huge canvas that exhausts the
// memory of every browser that later displays it.

export interface ImageInfo {
  mime: 'image/jpeg' | 'image/png'
  width: number
  height: number
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

// Start-of-frame markers carry the dimensions. C4 (DHT), C8 (JPG) and CC (DAC) are not frames.
const isSof = (m: number) => m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc

function jpegInfo(b: Buffer): ImageInfo | null {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null
  let i = 2
  while (i + 4 <= b.length) {
    if (b[i] !== 0xff) return null
    let marker = b[i + 1]!
    while (marker === 0xff && i + 2 < b.length) {
      i++
      marker = b[i + 1]!
    }
    if (marker === 0xd9 || marker === 0xda) return null // end of image / start of scan before any frame header
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2
      continue
    }
    const len = b.readUInt16BE(i + 2)
    if (len < 2) return null
    if (isSof(marker)) {
      if (i + 9 > b.length) return null
      return { mime: 'image/jpeg', height: b.readUInt16BE(i + 5), width: b.readUInt16BE(i + 7) }
    }
    i += 2 + len
  }
  return null
}

function pngInfo(b: Buffer): ImageInfo | null {
  if (b.length < 24 || !b.subarray(0, 8).equals(PNG_SIGNATURE)) return null
  if (b.toString('ascii', 12, 16) !== 'IHDR') return null
  return { mime: 'image/png', width: b.readUInt32BE(16), height: b.readUInt32BE(20) }
}

export function inspectImage(buf: Buffer): ImageInfo | null {
  return jpegInfo(buf) ?? pngInfo(buf)
}

export const AVATAR_MAX_BYTES = 200_000
export const AVATAR_MIN_SIDE = 32
export const AVATAR_MAX_SIDE = 1024

/** Returns a reason in Chinese for the user, or null if the image is acceptable. */
export function avatarProblem(buf: Buffer): string | null {
  if (buf.length === 0) return '沒有收到圖片'
  if (buf.length > AVATAR_MAX_BYTES) return '圖片太大'
  const info = inspectImage(buf)
  if (!info) return '只支援 JPEG 或 PNG 圖片'
  if (info.width < AVATAR_MIN_SIDE || info.height < AVATAR_MIN_SIDE) return '圖片太小'
  if (info.width > AVATAR_MAX_SIDE || info.height > AVATAR_MAX_SIDE) return '圖片尺寸過大'
  return null
}
