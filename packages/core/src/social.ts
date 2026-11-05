// Social profile links.
//
// Users never submit a URL. They give an account name and we build the address ourselves from a fixed
// template on a fixed domain. That removes the usual abuse of link fields on a trading site: phishing
// pages, redirectors, and group-invite links (the classic "join my LINE group" investment scam all
// use paths that these templates cannot produce).

export type SocialPlatform = 'threads' | 'instagram' | 'x' | 'facebook' | 'youtube' | 'tiktok' | 'telegram' | 'line'

interface Spec {
  label: string
  /** What a valid account name looks like on that platform. */
  handle: RegExp
  /** Domains a pasted URL may come from. */
  hosts: string[]
  url: (handle: string) => string
  /** For pasted URLs: pull the account name out of the path, or null if the path is not a profile. */
  fromPath: (pathname: string) => string | null
}

const firstSegment = (path: string): string | null => {
  const m = path.match(/^\/@?([^/]+)\/?$/)
  return m ? m[1]! : null
}

export const SOCIAL: Record<SocialPlatform, Spec> = {
  threads: { label: 'Threads', handle: /^[A-Za-z0-9._]{1,30}$/, hosts: ['threads.net', 'threads.com'], url: (h) => `https://www.threads.com/@${h}`, fromPath: firstSegment },
  instagram: { label: 'Instagram', handle: /^[A-Za-z0-9._]{1,30}$/, hosts: ['instagram.com'], url: (h) => `https://www.instagram.com/${h}/`, fromPath: firstSegment },
  x: { label: 'X', handle: /^[A-Za-z0-9_]{1,15}$/, hosts: ['x.com', 'twitter.com'], url: (h) => `https://x.com/${h}`, fromPath: firstSegment },
  facebook: { label: 'Facebook', handle: /^[A-Za-z0-9.]{5,50}$/, hosts: ['facebook.com', 'fb.com'], url: (h) => `https://www.facebook.com/${h}`, fromPath: firstSegment },
  youtube: { label: 'YouTube', handle: /^[A-Za-z0-9._-]{3,30}$/, hosts: ['youtube.com'], url: (h) => `https://www.youtube.com/@${h}`, fromPath: (p) => (p.startsWith('/@') ? firstSegment(p) : null) },
  tiktok: { label: 'TikTok', handle: /^[A-Za-z0-9._]{2,24}$/, hosts: ['tiktok.com'], url: (h) => `https://www.tiktok.com/@${h}`, fromPath: (p) => (p.startsWith('/@') ? firstSegment(p) : null) },
  telegram: { label: 'Telegram', handle: /^[A-Za-z0-9_]{5,32}$/, hosts: ['t.me', 'telegram.me'], url: (h) => `https://t.me/${h}`, fromPath: firstSegment },
  // Add-friend by LINE ID. Group invites live under /ti/g/ and cannot be expressed here.
  line: { label: 'LINE', handle: /^[A-Za-z0-9._-]{4,20}$/, hosts: ['line.me'], url: (h) => `https://line.me/ti/p/~${encodeURIComponent(h)}`, fromPath: (p) => p.match(/^\/ti\/p\/~([^/]+)\/?$/)?.[1] ?? null },
}

export const SOCIAL_PLATFORMS = Object.keys(SOCIAL) as SocialPlatform[]

export const isSocialPlatform = (v: unknown): v is SocialPlatform => typeof v === 'string' && Object.prototype.hasOwnProperty.call(SOCIAL, v)

/**
 * Accepts "name", "@name", or a profile URL on the platform's own domain, and returns the clean
 * account name, or null if it is not a valid account for that platform.
 */
export function normalizeSocial(platform: SocialPlatform, input: unknown): string | null {
  if (typeof input !== 'string') return null
  const spec = SOCIAL[platform]
  let raw = input.trim()
  if (raw.length === 0 || raw.length > 200) return null

  if (/^https?:\/\//i.test(raw) || raw.includes('/')) {
    let url: URL
    try {
      url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`)
    } catch {
      return null
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
    if (url.username || url.password) return null // "https://instagram.com@evil.com" style tricks
    const host = url.hostname.toLowerCase().replace(/^(www|m|mobile)\./, '')
    if (!spec.hosts.includes(host)) return null
    const fromPath = spec.fromPath(decodeURIComponent(url.pathname))
    if (!fromPath) return null
    raw = fromPath
  }

  const handle = raw.replace(/^@/, '')
  return spec.handle.test(handle) ? handle : null
}

export const socialUrl = (platform: SocialPlatform, handle: string): string => SOCIAL[platform].url(handle)
