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

## 搬家計畫（第二階段）

- **網站**：GitHub Pages（免費）
- **留言**：Cloudflare Workers + D1（免費）
  - Google 登入的留言立即公開；匿名留言需房主審核
  - 留言同步到 Notion，在 Notion 勾選「公開」即審核通過
- **後台**：獨立的 `admin.html`，只有房主需要登入
- **內容**：沿用 `content.json`

## 本機預覽

在這個資料夾執行：

```
python3 -m http.server 8000
```

再打開 http://localhost:8000 。

> `python3 -m http.server` 不支援影片的分段讀取，Safari 在本機可能播不出電視和音樂，請用 Chrome 預覽。
> 放上 GitHub Pages 後沒有這個限制，iPhone 和 Safari 都能正常播放。
