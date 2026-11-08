# 內在房間 Worker

在 Cloudflare Workers（免費方案）上執行的小伺服器，負責兩件事：

1. **房主內容 API**：後台 `admin.html` 儲存內容、上傳或刪除影片音樂時，由 Worker 驗證房主身分，再透過 GitHub API 提交到 repo。GitHub Pages 約 1 分鐘後自動更新網站。
2. **留言 API**：讀取公開留言（用 KV 快取 3 分鐘）、新增留言（必須用 Google 登入，立即公開；悄悄話只給房主看）、留言者刪除或編輯自己的留言（編輯限 7 天內，編輯後等房主審核）、房主審核、刪除、封鎖。留言存在 Notion 資料庫。

房間本身（`index.html`）是純靜態網站，只有留言本會呼叫 Worker。就算 Worker 暫時出問題，房間其他部分照常運作。

## API 一覽

| 方法 | 路徑 | 誰可以用 | 用途 |
|---|---|---|---|
| GET | `/api/health` | 任何人 | 檢查設定是否齊全（只顯示有沒有設定，不顯示內容） |
| GET | `/api/comments` | 網站訪客 | 已公開的留言，最近 200 則 |
| POST | `/api/comments` | 登入的訪客 | 新增留言 `{ nickname, content, whisper, credential, elapsed, website }` |
| POST | `/api/comments/mine` | 登入的訪客 | 自己的留言（含審核中、悄悄話、被隱藏的）`{ credential }` |
| PATCH | `/api/comments/:id` | 留言者本人 | 編輯 `{ credential, content, whisper }`，送出 7 天內；編輯後取消公開，等房主審核 |
| POST | `/api/comments/:id/delete` | 留言者本人 | 刪除自己的留言 `{ credential }`（移到 Notion 垃圾桶） |
| GET | `/api/me` | 房主 | 確認登入的是房主 |
| GET／PUT | `/api/content` | 房主 | 讀取／儲存 `content.json` |
| GET | `/api/media` | 房主 | 列出 `media/` 裡的檔案 |
| PUT／DELETE | `/api/media?path=media/…` | 房主 | 上傳／刪除檔案 |
| GET | `/api/admin/comments` | 房主 | 所有留言（含未公開），最近 300 則 |
| PATCH／DELETE | `/api/admin/comments/:id` | 房主 | 公開或取消公開 `{ public }`（悄悄話不能公開）／刪除（移到 Notion 垃圾桶，30 天內可復原） |
| GET | `/api/admin/blocks` | 房主 | 封鎖名單 |
| PUT／DELETE | `/api/admin/blocks/:代號` | 房主 | 封鎖／解除封鎖某個 Google 帳號 |

「房主」的意思是：請求帶著 Google ID token，Worker 驗證簽章、有效期限和用戶端 ID 都正確，而且 email 已驗證、在 `OWNER_EMAILS` 白名單裡。

## 設定

### 寫在 `wrangler.toml` 的設定（不是秘密，會進 git）

| 名稱 | 說明 |
|---|---|
| `GITHUB_REPO` | 你的 repo，例如 `ainia/innerroom` |
| `GITHUB_BRANCH` | 通常是 `main` |
| `ALLOWED_ORIGINS` | 允許呼叫 Worker 的網站網址，逗號分隔，不要結尾斜線。例如 `https://ainia.github.io,http://localhost:8000` |
| `GOOGLE_CLIENT_ID` | Google OAuth 用戶端 ID |
| `NOTION_VERSION` | Notion API 版本，維持 `2025-09-03` |
| `[[kv_namespaces]]` 的 `id` | KV 的 ID，建立方式見下方 |

> GitHub Pages 的網址如果是 `https://帳號.github.io/innerroom/`，`ALLOWED_ORIGINS` 只要寫 `https://帳號.github.io`：瀏覽器送出的來源網址不含路徑。

### 用 `wrangler secret put` 存的金鑰（秘密，絕對不能進 git）

| 名稱 | 說明 |
|---|---|
| `OWNER_EMAILS` | 房主的 Google email，多個用逗號分隔 |
| `GITHUB_TOKEN` | fine-grained personal access token，只選這個 repo，權限只開「Contents：Read and write」 |
| `NOTION_TOKEN` | Notion integration 的金鑰 |
| `NOTION_DATABASE_ID` | 留言資料庫的 ID（資料庫網址裡那串 32 個字元） |
| `HASH_SECRET` | 至少 32 個字元的亂數，用來把 Google ID 和 IP 轉成無法還原的代號。設定後不要更換，否則封鎖名單會失效 |

產生 `HASH_SECRET` 的方法（在終端機執行，把輸出的那串字貼進 secret）：

```
openssl rand -hex 32
```

## 部署步驟

> 建立 GitHub token、Notion 資料庫和 Google 用戶端的詳細步驟在專案的部署說明文件裡（第六階段）。這裡是 Worker 本身的部分。

需要 Node.js 22 以上。以下指令都在 `worker/` 資料夾裡執行。

1. 安裝工具：

   ```
   cd worker
   npm install
   ```

   如果看到 `install-scripts ... not yet covered by allowScripts` 的警告，可以忽略，不影響部署。

2. **登入 Cloudflare（你自己操作）**：會打開瀏覽器，請登入你的 Cloudflare 帳號並按「Allow」。

   ```
   npx wrangler login
   ```

3. 建立 KV：

   ```
   npx wrangler kv namespace create KV
   ```

   把輸出裡的 `id = "…"` 貼到 `wrangler.toml` 的 `[[kv_namespaces]]`。

4. 修改 `wrangler.toml` 的 `[vars]`：填入 `GITHUB_REPO`、`ALLOWED_ORIGINS`、`GOOGLE_CLIENT_ID`。

5. **存入金鑰（你自己操作）**：每一行執行後會要你貼上值，貼上時畫面不會顯示，按 Enter 即可。

   ```
   npx wrangler secret put OWNER_EMAILS
   npx wrangler secret put GITHUB_TOKEN
   npx wrangler secret put NOTION_TOKEN
   npx wrangler secret put NOTION_DATABASE_ID
   npx wrangler secret put HASH_SECRET
   ```

   第一次執行時如果問你要不要建立 Worker，回答 `Y`。

6. 部署：

   ```
   npm run deploy
   ```

   最後會顯示 Worker 的網址，例如 `https://innerroom-api.你的帳號.workers.dev`。

7. 打開 `https://innerroom-api.你的帳號.workers.dev/api/health`，確認 `configured` 和 `format` 裡每一項都是 `true`。`format` 是 `false` 代表金鑰貼錯了（例如貼成別的內容），重新執行 `npx wrangler secret put` 那一行即可。

8. 把 Worker 網址填進專案根目錄的 `config.js` 的 `workerUrl`，commit 並 push。

之後修改 Worker 程式，只要再執行一次 `npm run deploy`。

## 測試

```
npm test
```

在 Node.js 裡用假的 GitHub、Notion、Google 和 KV 測試所有 API，不需要網路，也不會碰到真的帳號。

```
npm run check
```

只打包、不部署，確認設定檔和程式沒有錯誤。

## 安全設計

- **金鑰只在 Worker 裡**：GitHub、Notion 金鑰和 `HASH_SECRET` 都存在 Cloudflare 的 secrets，前端和 git 裡都沒有。
- **GitHub 權限最小**：token 只能寫入這一個 repo 的檔案內容。Worker 還會再檢查：
  - 上傳只能放進 `media/`，副檔名只能是 mp4、webm、mp3、m4a、jpg。
  - `content.json` 只接受房間認得的欄位，影片音樂路徑必須在 `media/` 底下，連結只能是 YouTube 或 Spotify。
- **CORS**：只接受 `ALLOWED_ORIGINS` 裡的網址，其他網站的請求一律回 403。
- **防灌水**
  - 頻率限制：每個 IP 10 分鐘 3 則、一天 15 則；每個 Google 帳號 10 分鐘 5 則、一天 30 則；編輯每個帳號 10 分鐘 10 次、一天 40 次。
  - 暱稱最多 20 字、內容最多 500 字和 20 行、最多 3 個連結。
  - 隱藏欄位擋機器人，開啟留言本不到 2.5 秒就送出也會被擋。
- **HTML 跳脫**
  - Worker 會清掉控制字元和看不見的字元，留言以純文字存進 Notion。
  - API 回傳純文字 JSON（並加上 `X-Content-Type-Options: nosniff`）。房間顯示留言時一律當成文字處理，不會把留言內容當成 HTML 執行。
- **隱私**
  - Notion 裡只存「留言者 Google ID」的雜湊代號，不存 Google 名字、email 或大頭貼。
  - IP 只用雜湊後的代號做頻率限制，24 小時後自動刪除，不會寫進 Notion。

## 免費方案的限制

| 項目 | 免費額度 | 這個 Worker 的用量 |
|---|---|---|
| 請求數 | 每天 10 萬次 | 只有留言本和後台會呼叫 |
| CPU 時間 | 每次 10 毫秒 | 大檔案用串流原樣轉交，等待網路的時間不算 CPU |
| KV 讀取 | 每天 10 萬次 | 每次讀留言 1～2 次 |
| KV 寫入 | 每天 1000 次 | 每則留言 2～3 次、公開留言快取最多每 3 分鐘 1 次、封鎖名單異動 1 次 |
| 上傳大小 | 每次 100 MB | 後台限制單檔 25 MB |

KV 寫入額度用完時，留言仍然可以送出和讀取，只是當天快取和頻率限制會比較不準，隔天（UTC 00:00）自動恢復。超過免費額度時 Cloudflare 不會自動收費，只會暫時拒絕超出的請求。
