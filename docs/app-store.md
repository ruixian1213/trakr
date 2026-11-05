# Trakr 上架 App Store（iPhone）指南

## 現況

- **已完成：** iOS 殼（Capacitor）已產生在 `apps/web/ios/`，Bundle ID `com.trakr.app`，顯示名稱 Trakr，版本 1.0（1）。
- **已完成：** 自助刪除帳號（App Store 審核規範 5.1.1(v) 要求）。在「設定」頁輸入密碼後永久刪除，後端會在一個交易中移除所有相關資料。
- **尚未完成，會卡住送審：**
  1. **封鎖功能已實作（雙向隱藏）。** 貼文與留言是使用者產生內容，規範 1.2 要求能封鎖與檢舉。
  2. **沒有正式網域與 HTTPS 伺服器。** iOS 殼會直接載入正式網址，所以必須先有公開的 HTTPS 網域。
  3. **沒有 Apple Developer 帳號（年費 US$99）**，也沒有 Mac 可以建置。Windows 可以用雲端建置服務（見下方步驟 3）。
  4. **隱私政策與支援網址需要公開可讀**。目前的條款與隱私頁在 App 內（`#/legal`），需要放到網站上並提供一個聯絡信箱。
  5. **隱私政策中的「不出售個人資料」承諾**，需要你本人與律師確認（見 `docs/legal-review.md`）。

## 審核風險（先評估）

| 規範 | 風險 | 我們的狀態 |
| --- | --- | --- |
| 4.2 最低功能 | 純網頁殼容易被退件 | 有 iOS 殼與獨立圖示，但功能大多是網頁。可加推播或更多原生功能來降低風險 |
| 1.2 使用者產生內容 | 需要檢舉與封鎖 | 已實作：檢舉、封鎖（雙向隱藏貼文、留言、交易與持倉） |
| 5.1.1(v) 刪除帳號 | 無法刪除會被退件 | 已實作（`POST /api/me/delete`，設定頁） |
| 3.1 / 金融內容 | 股票相關內容可能被要求說明授權與免責 | 有免責聲明，平台只追蹤、不推薦、不下單。審核時要能清楚說明 |
| 5.1.2 資料使用 | 隱私問卷需要和實際資料一致 | 收集：電子郵件、交易紀錄、庫存、使用者內容。要如實填寫 |
| 授權 | TWSE 資料有授權條款與來源標示 | 已在 App 內標示來源。需確認商業使用範圍 |

## 步驟

### 1. 部署伺服器（HTTPS）

- 把 `apps/server` 部署到公開網域，例如 `https://trakr.example.com`。
- 資料庫目前是 SQLite（`TOT_DB` 指定路徑），記得定期備份。
- 設定 `TOT_TRUST_PROXY=1`，因為通常會放在反向代理後面。

### 2. 用正式網址產生 iOS 專案設定

```bash
cd apps/web
CAP_SERVER_URL=https://trakr.example.com npx cap sync ios
```

`capacitor.config.ts` 會在沒有設定 `CAP_SERVER_URL` 時直接報錯，避免送出一個沒有內容的 App。

### 3. 建置與上傳

有兩種方式，擇一：

- **A. 有 Mac：** 執行 `npx cap open ios` 開啟 Xcode，在 Signing & Capabilities 選你的 Team，然後 Product → Archive → Distribute App → App Store Connect。
- **B. 沒有 Mac（Windows 較實際）：** 用雲端建置服務（例如 Codemagic、EAS Build 或 Xcode Cloud），把 `apps/web/ios` 專案交給它建置，並在它的設定中填入 Apple 帳號與憑證。

### 4. App Store Connect

- 建立 App，Bundle ID 選 `com.trakr.app`。
- 填寫名稱（Trakr）、副標題、關鍵字、描述（說明只追蹤、不推薦、不下單，並附免責）。
- 截圖：至少 6.9 吋 iPhone 截圖。
- 隱私權政策網址與支援網址（需要公開可讀）。
- App 隱私問卷：如實填寫收集的資料類型。
- **審核備註：** 提供一組測試帳號（使用正式環境的測試帳號，不要用開發用的 `demo_alpha` 密碼），並說明 App 的用途與如何驗證。

### 5. 送審前檢查

- [x] 封鎖使用者功能已完成（規範 1.2）
- [ ] 正式網域可用，HTTPS 憑證有效
- [ ] 隱私政策與條款可公開讀取
- [ ] 刪除帳號流程在正式站測過一次
- [ ] 免責聲明在 App 內清楚顯示
- [ ] TWSE 資料授權已確認（見 `docs/legal-review.md`）
- [ ] 律師審閱完成

## 目前的建議順序

1. 上線網站前後都要用正式網域實際測一次封鎖與刪除帳號。
2. 選網域、部署 HTTPS 伺服器。
3. 註冊 Apple Developer，確認 Trakr 名稱在商標與 App Store 上沒有衝突。
4. 律師審閱，然後用正式網址建置、上傳、送審。
