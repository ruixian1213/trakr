# 台股券商 API 調查：哪些能唯讀取得成交、庫存與損益

調查日期：2026-11-03。這份文件把每一項結論標成三種可信度，請依標記判斷能不能直接拿來做決策：

- **官方已確認**：我直接讀了券商官方文件。
- **第三方／新聞**：來自教學文章或新聞報導，沒有在官方文件核對到。
- **未查證**：沒有找到可靠資料，不能當成事實。

## 結論先看

| 券商 | SDK | 能否限制為「無下單權限」金鑰 | 庫存 | 未實現損益 | 已實現損益 | 成交明細 | 本專案狀態 |
|---|---|---|---|---|---|---|---|
| **永豐金證券** Shioaji | Python | 可以（第三方）：建立金鑰時可勾選權限，教學列出 行情／帳務／下單／正式環境，並可綁定 IP、設到期日 | `list_positions`（官方已確認） | `list_positions` 內的 `pnl` 欄位（官方已確認） | 官方文件有 Profit Loss 頁，欄位**未確認** | `list_trades` 的 `deals`（官方已確認） | 已寫轉接器，**未對真實帳戶測試** |
| **富邦證券** Neo API | Python／Node.js／C++／C#／Go | 可以（新聞）：導入 API Key 登入與權限控管，可限 IP，分別控管行情、下單、帳戶；**選項名稱未確認** | `accounting.inventories`（官方已確認） | 有 UnrealizedPnLDetail 頁（官方已確認存在），方法名稱**未確認** | `accounting.realized_gains_and_loses`、另有已實現彙總頁（官方已確認） | 帳務頁**未列**交易歷史查詢，成交回報方式**未確認** | 尚未實作 |
| 元大證券 | — | 未查證 | 未查證 | 未查證 | 未查證 | 未查證 | 未評估 |
| 群益證券 | — | 未查證 | 未查證 | 未查證 | 未查證 | 未查證 | 未評估 |
| 凱基證券 | — | 未查證 | 未查證 | 未查證 | 未查證 | 未查證 | 未評估 |
| 玉山證券 | — | 未查證 | 未查證 | 未查證 | 未查證 | 未查證 | 未評估 |

我**沒有**查到元大、群益、凱基、玉山的公開 API 文件，所以不在這裡列出它們的功能，避免誤導你。唯一查到的是玉山的 API 服務契約：申請人須親持身分證明文件臨櫃申請並簽名蓋章，首次使用 API 下單前要與券商完成連線測試並留存紀錄。這代表有些券商的 API 是「臨櫃申請」制，不是線上自助。

## 已確認的細節

### 永豐金 Shioaji

- 登入使用 API Key 與 Secret Key（1.0 版之後）。Secret Key 只在建立當下顯示一次，遺失只能刪除重辦。
- 申請前須是永豐金證券客戶，並完成服務條款簽署與 API 測試。第三方資料指出測試有時段限制（週一至週五 08:00–20:00），請以券商現行規定為準。
- 官方文件確認的讀取函式：
  - `api.list_positions(account, unit=Unit.Share)`：庫存，欄位含 `code`、`quantity`、`price`（均價）、`last_price`、`pnl`、`direction`、`cond`。
  - `api.update_status(account)` 之後讀取 `Trade` 物件：`order`（id、seqno、ordno、action、price、quantity、order_lot…）、`status`（status、deals、order_quantity、deal_quantity…）。`deals` 內有 `seq`、`price`、`quantity`、`ts`。
- 「官方」沒說明的事：建立金鑰時**確切有哪些權限選項**。權限的說法來自永豐自己的 richclub 教學頁與第三方教學，請你登入 API 管理頁面親眼確認，再寫進對使用者的說明。

### 富邦 Neo API

官方「帳務管理」頁列出的查詢功能：庫存查詢、未實現損益查詢、已實現損益彙總、已實現損益查詢、維持率查詢、交割款查詢、銀行餘額查詢。

- `sdk.accounting.inventories(account)`：回傳 `is_success`、`data`、`message`。每筆庫存含日期、股票代號、委託類型（現股／融資／融券／借券）、昨日庫存、今日庫存、買進／賣出成交股數與價金、零股庫存。
- `sdk.accounting.realized_gains_and_loses(account)`：每筆含 `date`、`stock_no`、`buy_sell`、`filled_qty`、`filled_price`、`order_type`、`realized_profit`、`realized_loss`。
- 查詢交割款、餘額的功能存在，**方法名稱與欄位我沒有取得**。
- 登入方式：新聞指出已導入 API Key 登入；舊式登入需要憑證檔。**本專案若要做富邦轉接器，必須先確認「只用唯讀金鑰、不載入憑證」是否可行。**若富邦要求載入憑證才能查帳務，就不符合本專案「不載入憑證」的設計，需要另外評估。

## 本專案真正需要哪些資料

| 需求 | 用途 | 券商必須提供 |
|---|---|---|
| 成交明細（價格、股數、時間、單號） | 交易紀錄、雜湊鏈、已實現損益、勝率 | **必要** |
| 庫存 | 持倉顯示、與成交紀錄對帳 | **必要** |
| 現金（含交割款） | 推算權益與出入金，計算時間加權報酬率 | **必要** |
| 券商自己算的未實現／已實現損益 | 與本專案計算結果交叉比對 | 選用 |

本專案**自己計算**已實現損益（FIFO）與報酬率，不直接採用券商的損益欄位，原因是各家成本算法不同（平均成本 vs 先進先出），而且要在不同券商之間公平比較。券商的損益欄位適合拿來做交叉檢查，不適合直接排名。

目前本專案**未計入**的項目：現金股利、股票股利、除權息調整、融資融券利息。這些會讓報酬率與券商帳面有差距，要在說明文件中向使用者交代。

## 對每一家券商要問的五個問題

接洽券商或評估新券商時，請逐項確認並留存書面答覆：

1. 能否建立**不含下單權限**的 API 金鑰？選項叫什麼？
2. 讀取帳務是否**需要載入憑證（CA）**？
3. 能否查詢**當日與歷史**成交明細？歷史能回溯多久？
4. 有沒有庫存、現金／交割款的查詢？欄位單位是「股」還是「張」？
5. 服務條款是否允許使用者把自己的帳務資料**提供給第三方平台**展示？這點最重要，有些條款可能禁止轉傳。

## 建議順序

1. 永豐 Shioaji：已有轉接器，先用模擬環境與小額實盤驗證。
2. 富邦 Neo：官方帳務查詢最完整，但要先解決上面的「憑證」問題。
3. 其他券商：先發信詢問上列五個問題，再決定要不要做。
4. 長期：與券商談正式資料授權（方案 B），這是補上「使用者可能另開帳戶挑著綁」這個漏洞的唯一辦法。

## 來源

- 永豐 Shioaji 官方文件：[持倉查詢](https://sinotrade.github.io/tutor/accounting/position/)、[下單與委託狀態](https://sinotrade.github.io/tutor/order/Stock/)
- 永豐 API 金鑰申請教學（永豐 richclub）：[API 申請教學](https://www.sinotrade.com.tw/richclub/shioajipro/-API%E7%94%B3%E8%AB%8B%E6%95%99%E5%AD%B8-%E6%B0%B8%E8%B1%90%E9%87%91%E8%AD%89%E5%88%B8Shioaji-API-%E9%87%91%E9%91%B0%E7%94%B3%E8%AB%8B%E8%88%87%E8%A8%AD%E5%AE%9A%E5%85%A8%E6%94%BB%E7%95%A5-%E5%9C%96%E8%A7%A3%E4%BA%94%E6%AD%A5%E9%A9%9F%E8%BC%95%E9%AC%86%E6%90%9E%E5%AE%9A--6a9abae51c650a35afa372b3)
- 第三方教學：[iT 邦幫忙（Shioaji 申請）](https://ithelp.ithome.com.tw/articles/10405357)
- 富邦 Neo 官方文件：[庫存查詢](https://www.fbs.com.tw/TradeAPI/docs/trading/library/python/accountManagement/inventories)、[已實現損益查詢](https://www.fbs.com.tw/TradeAPI/docs/trading/library/python/accountManagement/RealizedPnLDetail)
- 富邦新一代 API 新聞（API Key 與權限控管）：[中時 Wantrich](https://wantrich.chinatimes.com/news/20250717900359-420101)
- 玉山證券 API 服務契約：[API202610.pdf](https://www.esunsec.com.tw/-/media/EsunSec/Files/Legal-Disclaimers/contract/F131/API202610.pdf)
