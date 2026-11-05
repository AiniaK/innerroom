# 內在房間 innerroom

一個可以走進去探索的 3D 房間（黏土風、紙張質感），以 three.js 製作。

## 目前的檔案

| 檔案 | 用途 |
|---|---|
| `index.html` | 房間本體（目前與 Claude 上發布的版本相同） |
| `content.json` | 房主在後台設定的內容：物件名稱與彈窗、展品、火勢、電視與音樂設定 |
| `media/tv-adventure.mp4` | 電視播放的影片 |
| `media/music-Blue_720p.mp4` | 平板播放的音樂影片 |

> 注意：`index.html` 目前仍以 Claude 平台的檔案網址（`/_blob/…`）讀取影片與音樂。
> 搬到 GitHub Pages 時，會改成讀取 `media/` 資料夾裡的檔案。

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
