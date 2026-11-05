# Legal review checklist (before public launch)

The wording lives in `apps/web/src/legal.tsx`. It is written in plain Chinese but has **not** been reviewed by a lawyer. Have one check these points before launch.

## What the platform claims to be
- Records and displays trades and holdings that traders disclose themselves. It does not recommend stocks, send buy or sell signals, or place orders.
- Delayed display (3 to 30 minutes, set by each trader) is there to reduce front-running. It is not a promise that the data is accurate.

## Points to check
1. **Investment advisory licence (投顧).** Does showing a trader's holdings and ranking them count as 投資顧問業務? The text says no recommendation is made and that viewers must decide for themselves, but whether that holds depends on how the leaderboard and "追蹤" feature are read.
2. **Securities Exchange Act, market manipulation.** Terms forbid coordinated pumping and dumping. Is a visible follower count or a "who holds this stock" panel a risk here?
3. **Trader consent.** Traders publish their own trades. Confirm this is covered by their agreement, and that a trader can stop publishing (hide holdings, stop sharing) at any time.
4. **Personal data (個人資料保護法).** Email, password hash, uploaded trades, profile photo and bio. Check the privacy section against what the code actually stores. There is no self-service account deletion yet; the text says so, but a deletion route is probably expected.
5. **Third-party data licence.** TWSE, TPEx and TDCC data are published under the Government Open Data License. Attribution is shown on every screen that uses them. Check the attribution wording is what the licence requires.
6. **Broker data.** The agent reads a trader's own broker records with a read-only key. Check the broker's terms allow this kind of third-party reading.
7. **Reporting and takedown.** Items are hidden after 3 distinct reports and a human reviews them. Check that a complaints contact exists before launch (the text currently has none).

## Facts the text relies on (verify each)
- The 400-lot and 1000-lot bracket boundaries (TDCC levels 12 and 15).
- Ex-dividend announcements (`TWT48U_ALL`) are the right basis for the 除權息 section. The list only shows roughly three weeks ahead, so past ex-dates are archived only if the server saw them before they passed (it refreshes every 6 hours).
- `CashDividend` is NT$ per share. Checked against ETF samples (for example 00406A at 0.138), not yet against a common stock.
- `StockDividendRatio` has **not** been verified. The sample taken on 2026-11-03 had no stock-dividend announcements at all. A trader who holds a stock with a stock dividend is held off the leaderboard until this is checked.
- Margin balances (`MI_MARGN`) are shown in shares and converted to lots.
- Institutional buying and selling (三大法人) and foreign ownership are **not** shown, because the TWSE pages that carry them are blocked to automated access.
