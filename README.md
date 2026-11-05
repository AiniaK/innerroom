# 內在房間 innerroom

一個可以走進去探索的 3D 房間（黏土風、紙張質感），以 three.js 製作。

## 目前的檔案

| 檔案 | 用途 |
|---|---|
| `index.html` | 房間本體（純靜態，不需要登入，也不依賴任何伺服器） |
| `content.json` | 房主在後台設定的內容：物件名稱與彈窗、展品、火勢、電視與音樂設定。影片和音樂用 `src` 寫檔案路徑 |
| `data/models.js` | 3D 模型資料（貓、狗、櫻花場景、臥佛、Pocky），原本內嵌在 `index.html` |
| `assets/exhibits/` | 白牆展品的圖片與「一束光」影片 |
| `assets/moon.jpg` | 月亮貼圖 |
| `media/` | 電視影片、平板音樂（後台上傳的檔案也會放這裡） |
| `admin.html`、`admin.js` | 房主後台（Google 登入後才能使用，透過 Worker 把修改提交到 GitHub） |
| `config.js` | 公開設定：Worker 網址、Google 用戶端 ID、GitHub repo 名稱（都不是密碼） |
| `data/catalog.json` | 後台用的物件清單、預設文字、展品尺寸，由 `tools/build-catalog.mjs` 從房間產生 |
| `tools/build-catalog.mjs` | 改了 `index.html` 的物件或展品之後，執行 `node tools/build-catalog.mjs` 重新產生 `data/catalog.json` |
| `worker/` | Cloudflare Worker：後台儲存到 GitHub、留言 API。部署方式見 `worker/README.md` |
| `privacy.html` | 隱私權說明：留言收集哪些資料、怎麼使用 |
| `DEPLOY.md` | 部署說明：GitHub、Google、Notion、Cloudflare 的設定步驟 |
| `.nojekyll` | 讓 GitHub Pages 直接提供檔案，不經過 Jekyll 處理 |

## 架構

全部使用免費方案。

- **網站**：GitHub Pages，純靜態。一般訪客打開房間不需要登入，也不依賴伺服器。
- **後台**：`admin.html`，只有房主需要用 Google 登入。
  - 儲存時，Worker 把 `content.json` 提交到 GitHub，GitHub Pages 約 1 分鐘後更新。
  - 影片和音樂也經由 Worker 存進 `media/`。
- **伺服器程式**：Cloudflare Workers（`worker/`）。
  - GitHub、Notion 金鑰只存在 Worker 的 secrets 裡。
- **留言**：Notion 資料庫為主，Cloudflare KV 做快取。
  - Google 登入的留言立即公開；匿名留言要房主審核。
  - 在 Notion 勾選「公開」就是審核通過。

部署步驟見 [`DEPLOY.md`](DEPLOY.md)，Worker 的細節見 [`worker/README.md`](worker/README.md)，訪客隱私權說明在 [`privacy.html`](privacy.html)。

## 本機預覽

在這個資料夾執行：

```
python3 -m http.server 8000
```

再打開 http://localhost:8000 。

> `python3 -m http.server` 不支援影片的分段讀取，Safari 在本機可能播不出電視和音樂，請用 Chrome 預覽。
> 放上 GitHub Pages 後沒有這個限制，iPhone 和 Safari 都能正常播放。
