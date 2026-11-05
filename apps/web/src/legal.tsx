import { Header } from './ui.tsx'

/**
 * Plain-language terms. Bump LEGAL_UPDATED whenever the wording changes so people can tell what they agreed to.
 * This platform only records and displays. It never places orders, never recommends a stock, and is not an
 * investment advisory service.
 */
export const LEGAL_UPDATED = '2026-11-03'

export const DISCLAIMER = [
  '本平台僅提供交易紀錄的追蹤與整理，不提供任何投資建議、推薦、買賣訊號或代客操作服務。',
  '平台上的持股與交易，是各交易員或使用者自行揭露的內容，其正確性與完整性由該人負責，本平台不保證。',
  '為防止搶先跟單，交易與持股會依各交易員設定的時間延遲後才顯示。延遲揭露也代表你看到的資料一定不是即時的。',
  '排行榜的報酬率與勝率是依過去紀錄計算，過去的表現不代表未來的獲利，也不應作為投資決策的依據。',
  '「未驗證」的資料（使用者上傳的 CSV 或庫存快照）僅供參考，不列入排行榜。',
  '股票投資有風險，可能損失本金。你的投資決策與後果，應由你自行承擔。',
  '本平台與任何券商、證交所、櫃買中心或集保結算所無隸屬關係。',
]

export const TERMS = [
  '不得刊登不實、偽造或竄改的交易或持股資料，亦不得假冒他人或機構。',
  '不得以本平台進行荐股、操縱股價、或協同拉抬、倒貨等行為。',
  '不得在平台上張貼個人資料（例如他人的帳戶號碼、身分資料），發現時請使用檢舉功能。',
  '平台有權在發現違規時隱藏內容、限制帳號功能或停權。',
  '只能提交你本人的資料。',
]

export const PRIVACY = [
  '我們收集：電子郵件（僅用於登入與帳號通知）、帳號 ID、密碼的雜湊值（不儲存原始密碼）、你上傳的交易與持股資料、頭像與自我介紹。',
  '你設定為公開的資料會顯示給所有人。持股可設為公開、僅顯示比例或完全隱藏。',
  '券商 API 金鑰僅能讀取資料，且可隨時在「我」頁撤銷。本平台不會下單，也不會要求券商交易權限。',
  '我們不會把你的個人資料出售給第三方。',
  '你可以在「我」頁修改自我介紹與頭像。你可以在「設定」頁的「刪除帳號」永久刪除帳號，刪除後所有資料都會從伺服器移除。',
]

export const SOURCES_NOTE =
  '市場資料來源：臺灣證券交易所、證券櫃檯買賣中心、臺灣集中保管結算所，依政府資料開放授權條款公眾釋出。各頁面皆已標示資料來源與日期。'

function Section({ title, items }: { title: string; items: string[] }) {
  return (
    <section className="pad legal-section">
      <h2 className="legal-title">{title}</h2>
      <ul className="legal-list">
        {items.map((t) => (
          <li key={t}>{t}</li>
        ))}
      </ul>
    </section>
  )
}

export function LegalPage() {
  return (
    <>
      <Header title="免責聲明與條款" back="#/me" />
      <div className="pad muted small">最後更新：{LEGAL_UPDATED}</div>
      <Section title="免責聲明" items={DISCLAIMER} />
      <Section title="使用條款" items={TERMS} />
      <Section title="隱私權" items={PRIVACY} />
      <div className="pad muted small">{SOURCES_NOTE}</div>
    </>
  )
}

/** Shown on every page: the short version, with a link to the full text. */
export function Footer() {
  return (
    <footer className="app-footer">
      <p>本平台僅提供交易紀錄追蹤，不提供投資建議。投資有風險，決策請自行判斷。</p>
      <p>
        <a href="#/legal">免責聲明與條款</a> · <a href="#/install">安裝到 iPhone</a>
      </p>
    </footer>
  )
}

/** Notice on a trader's own page: what the numbers are and are not. */
export function TraderNotice() {
  return <div className="notice">以下紀錄由交易員自行揭露，僅供追蹤，不構成投資建議。資料依設定延遲顯示。</div>
}

export function InstallPage() {
  return (
    <>
      <Header title="安裝到 iPhone" back="#/" />
      <section className="pad legal-section">
        <ol className="legal-list">
          <li>用 Safari 開啟這個網站（其他瀏覽器無法加入主畫面）。</li>
          <li>點底部的「分享」按鈕（方框加向上箭頭）。</li>
          <li>往下滑，選擇「加入主畫面」，再按「加入」。</li>
          <li>回到主畫面，從 Trakr 圖示開啟，就會以獨立 App 的方式全螢幕執行。</li>
        </ol>
        <p className="muted small">需要 iOS 16.4 以上，才能收到之後推出的推播通知。目前的新交易提醒在 App 內查看。</p>
      </section>
    </>
  )
}
