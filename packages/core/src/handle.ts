// Account IDs (the "@id" people see and link to).
//
// An ID is unique without regard to case, so "Alice", "alice" and "ALICE" are one ID. The spelling a
// person chose is kept for display, but identity is the lower-cased key. IDs are ASCII only, which
// also rules out look-alike letters from other alphabets (a Cyrillic "а" in "аlice").

export const HANDLE_RE = /^[A-Za-z0-9_]{3,20}$/

/** Words that would let someone pass as the platform, its staff, a broker, or a page of the app. */
export const RESERVED_HANDLES: ReadonlySet<string> = new Set([
  // the platform and its staff
  'admin', 'administrator', 'root', 'system', 'support', 'help', 'helpdesk', 'official', 'staff', 'moderator', 'mod', 'service', 'security', 'billing', 'team', 'tot', 'trakr',
  // data source and brokers: an account named after them would look endorsed by them
  'twse', 'tpex', 'sinotrade', 'shioaji', 'fubon', 'yuanta', 'capital', 'kgi', 'esun',
  // pages and generic words
  'null', 'undefined', 'anonymous', 'api', 'www', 'app', 'web', 'me', 'my', 'you', 'settings', 'login', 'logout', 'signin', 'signout', 'signup', 'register', 'auth', 'account', 'accounts', 'about', 'terms', 'privacy', 'contact', 'home', 'global', 'leaderboard', 'market', 'feed', 'forum', 'post', 'posts', 'comment', 'comments', 'report', 'search', 'explore', 'notifications',
])

// "admin2", "trakr_support": the usual ways to impersonate without using the exact reserved word.
const RESERVED_PREFIXES = ['admin', 'trakr']

export type HandleProblem = 'format' | 'reserved'

/** The key identity is compared on. */
export const handleKey = (handle: string): string => handle.toLowerCase()

export function handleProblem(handle: unknown): HandleProblem | null {
  if (typeof handle !== 'string' || !HANDLE_RE.test(handle)) return 'format'
  const key = handleKey(handle)
  if (RESERVED_HANDLES.has(key) || RESERVED_PREFIXES.some((p) => key.startsWith(p))) return 'reserved'
  return null
}

export const HANDLE_MESSAGES: Record<HandleProblem | 'taken', string> = {
  format: '帳號 ID 需為 3 到 20 個英文字母、數字或底線',
  reserved: '這個帳號 ID 為系統保留，請換一個',
  taken: '這個帳號 ID 已經有人使用',
}
