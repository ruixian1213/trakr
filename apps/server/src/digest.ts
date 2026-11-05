import { createHmac, timingSafeEqual } from 'node:crypto'

/**
 * Email digest of trades from the traders a user follows. Opt-in only.
 * Nothing here recommends a trade: the email lists what was executed and when, and says so.
 */

export interface DigestTrade {
  handle: string
  symbol: string
  side: 'buy' | 'sell'
  qty: number
  price: number
  executedAt: string
}

export interface Mailer {
  send(to: string, subject: string, text: string): Promise<void>
}

/** Unsubscribe link token: an HMAC of the user id, keyed with a server secret. No secret, no digest. */
export function unsubscribeToken(userId: number, secret: string): string {
  return createHmac('sha256', secret).update(`digest-unsubscribe:${userId}`).digest('hex')
}

export function unsubscribeTokenValid(userId: number, token: string, secret: string): boolean {
  const expected = Buffer.from(unsubscribeToken(userId, secret))
  const given = Buffer.from(token)
  return given.length === expected.length && timingSafeEqual(given, expected)
}

const taipei = (iso: string) =>
  new Date(iso).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })

export function digestMessage(trades: DigestTrade[], unsubscribeUrl: string): { subject: string; text: string } {
  const lines = trades.map(
    (t) => `${taipei(t.executedAt)}  ${t.handle}  ${t.side === 'buy' ? '買進' : '賣出'} ${t.symbol} ${t.qty.toLocaleString('en-US')} 股 @ ${t.price}`,
  )
  const subject = `Trakr：你追蹤的交易員有 ${trades.length} 筆新成交`
  const text = [
    '以下是你追蹤的交易員，已過其公開延遲時間的成交紀錄（時間為台北時間）：',
    '',
    ...lines,
    '',
    '本信僅列出成交紀錄，不構成任何投資建議或推薦。',
    '',
    `取消訂閱：${unsubscribeUrl}`,
  ].join('\n')
  return { subject, text }
}

/** Sends through Resend's HTTP API. Needs an API key and a verified sender address from your Resend account. */
export function resendMailer(apiKey: string, from: string, fetchImpl: typeof fetch = fetch): Mailer {
  return {
    async send(to, subject, text) {
      const res = await fetchImpl('https://api.resend.com/emails', {
        method: 'POST',
        headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({ from, to, subject, text }),
      })
      if (!res.ok) throw new Error(`mail provider returned ${res.status}`)
    },
  }
}
