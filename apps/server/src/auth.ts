import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'

const scryptAsync = promisify(scrypt) as (pw: string, salt: Buffer, keylen: number) => Promise<Buffer>

export const PASSWORD_MIN = 8
export const PASSWORD_MAX = 128 // bounds the work an attacker can force per request

export async function hashPassword(pw: string): Promise<string> {
  const salt = randomBytes(16)
  const hash = await scryptAsync(pw, salt, 64)
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`
}

export async function verifyPassword(pw: string, stored: string): Promise<boolean> {
  const [alg, salt, hash] = stored.split('$')
  if (alg !== 'scrypt' || !salt || !hash) return false
  const got = await scryptAsync(pw, Buffer.from(salt, 'hex'), 64)
  const want = Buffer.from(hash, 'hex')
  return got.length === want.length && timingSafeEqual(got, want)
}

/** Verified against when the email is unknown, so response time does not reveal which emails exist. */
export const DUMMY_HASH = await hashPassword(randomBytes(8).toString('hex'))

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  for (const part of (header ?? '').split(';')) {
    const i = part.indexOf('=')
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim())
  }
  return out
}

/** Sliding-window attempt counter, in memory. Use a shared store if you run more than one server. */
export class Limiter {
  private hits = new Map<string, number[]>()
  constructor(
    private max: number,
    private windowMs: number,
    private now: () => number,
  ) {}

  private recent(key: string): number[] {
    const cutoff = this.now() - this.windowMs
    const list = (this.hits.get(key) ?? []).filter((t) => t > cutoff)
    if (list.length) this.hits.set(key, list)
    else this.hits.delete(key)
    return list
  }

  allowed(key: string): boolean {
    return this.recent(key).length < this.max
  }

  record(key: string) {
    this.hits.set(key, [...this.recent(key), this.now()])
  }

  reset(key: string) {
    this.hits.delete(key)
  }
}
