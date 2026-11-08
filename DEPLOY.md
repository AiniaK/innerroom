# 部署說明：把內在房間搬到你自己的網站

這份文件一步步帶你完成所有設定。全部使用免費方案，**不需要綁信用卡**。

- 標示 **【你操作】** 的步驟需要你自己登入帳號、輸入密碼或金鑰。
- 標示 **【可以請 Claude 做】** 的步驟，我可以在你的電腦上幫你執行。

## 開始之前

### 會用到的帳號

| 服務 | 用途 | 費用 |
|---|---|---|
| GitHub | 放網站檔案、GitHub Pages 網站主機 | 免費 |
| Google Cloud | 建立「用 Google 登入」的用戶端 | 免費，不需要開啟計費 |
| Notion | 留言資料庫 | 免費方案即可 |
| Cloudflare | 執行 Worker（小伺服器） | 免費方案，不需要信用卡 |

### 金鑰的保管原則

過程中會拿到兩把**金鑰**：GitHub token 和 Notion 金鑰。

- 只貼到兩個地方：本文件指定的終端機指令，或密碼管理工具。
- **不要**貼進任何檔案，也不要貼進和 Claude 的對話。
- 萬一不小心外流，到原本建立的頁面把它刪掉，再建一把新的。

下面這些**不是**秘密，可以放心記在筆記裡：

- Google 用戶端 ID
- Worker 網址
- Notion 資料庫 ID
- KV ID

建議先開一個筆記，記下這幾項（不含金鑰）：

```
GitHub 帳號：
網站網址：https://帳號.github.io/innerroom/
Google 用戶端 ID：
Notion 資料庫 ID：
Worker 網址：
```

---

## 第 1 步：建立 GitHub repo 並上傳網站

### 1-1 【你操作】註冊或登入 GitHub

到 <https://github.com> 註冊或登入。

### 1-2 【你操作】設定 email 隱私

repo 會是**公開的**：GitHub Pages 免費方案只支援公開 repo。所有檔案和每次修改的紀錄，任何人都看得到，包括 commit 的作者 email。

1. 打開 <https://github.com/settings/emails>。
2. 勾選 **Keep my email addresses private**。
3. 畫面上會出現一個像 `12345678+帳號@users.noreply.github.com` 的地址，把它記下來。
4. 再勾選 **Block command line pushes that expose my email**。

目前專案的 commit 紀錄用的是你的 Gmail。**上傳之前**，請把上面那個 noreply 地址告訴 Claude。我會把專案裡所有 commit 的作者 email 換成它，之後的 commit 也會用它。

> 為什麼要上傳前做：一旦推上 GitHub，舊紀錄就很難完全清除。

### 1-3 【你操作】安裝 GitHub Desktop

到 <https://desktop.github.com> 下載安裝，打開後用你的 GitHub 帳號登入。

> 不需要安裝 Homebrew 或 `gh` 指令。

### 1-4 【你操作】把專案發布成 GitHub repo

1. GitHub Desktop 選單 **File → Add Local Repository…**
2. 按 **Choose…**，選 `~/projects/innerroom` 資料夾，按 **Add Repository**。
3. 按上方的 **Publish repository**。
4. Name 填 `innerroom`。
5. **取消勾選「Keep this code private」**，否則 GitHub Pages 無法免費使用。
6. 按 **Publish Repository**，等它上傳完成。專案約 25 MB，需要一點時間。

### 1-5 【你操作】開啟 GitHub Pages

1. 打開 `https://github.com/帳號/innerroom`。
2. 點上方的 **Settings**，左邊選 **Pages**。
3. 在 **Build and deployment** 設定：
   - **Source** 選 **Deploy from a branch**。
   - **Branch** 選 `main`，資料夾選 `/ (root)`，按 **Save**。
4. 等 1～2 分鐘，重新整理這一頁。上方會出現 **Your site is live at `https://帳號.github.io/innerroom/`**。

打開這個網址，應該就能進房間了。這時留言本會顯示「還在準備中」，後台也還不能登入，這是正常的，後面的步驟會一一接上。

> 網站網址記下來。後面設定 Google 和 Worker 時，要用的是**不含路徑**的 `https://帳號.github.io`。

### 1-6 【你操作】建立權限最小的 GitHub 金鑰

這把金鑰給 Worker 用，讓後台可以把修改存進 repo。它只能寫入 `innerroom` 這一個 repo 的檔案，碰不到你的其他 repo 或帳號設定。

1. 打開 <https://github.com/settings/personal-access-tokens/new>。
   - 或從右上角大頭貼 → **Settings** → 左下 **Developer settings** → **Personal access tokens** → **Fine-grained tokens** → **Generate new token**。
2. 填寫：
   - **Token name**：`innerroom-worker`
   - **Expiration**：選 **Custom**，設一年後的日期。請在行事曆記下到期日，到期前要換新的（換法見最後的「日常維護」）。
   - **Resource owner**：你的帳號。
   - **Repository access**：選 **Only select repositories**，再選 `innerroom`。
3. **Permissions → Repository permissions**：找到 **Contents**，改成 **Read and write**。
   - 畫面會自動加上 **Metadata: Read-only**，這是必要的。
   - **其他全部保持 No access**。
4. 按 **Generate token**。
5. 複製 `github_pat_` 開頭的那串字，暫時存進密碼管理工具。**這個頁面關掉後就看不到了**；如果沒複製到，刪掉重建一把就好。

---

## 第 2 步：建立「用 Google 登入」的用戶端

### 2-1 【你操作】建立 Google Cloud 專案

1. 打開 <https://console.cloud.google.com>，用你的 Google 帳號登入。第一次使用要同意服務條款。
2. 上方專案選單 → **新增專案**。
3. 專案名稱填 `innerroom`，按 **建立**。
4. 建立好之後，確認上方已切換到這個專案。

> Google Cloud 可能會邀請你開啟「免費試用」或設定帳單，**不需要**，直接略過。建立登入用戶端不會產生任何費用。

### 2-2 【你操作】設定同意畫面（Google Auth Platform）

1. 打開 <https://console.cloud.google.com/auth/overview>，按 **開始**（Get started）。
2. **應用程式資訊**：
   - 應用程式名稱填 `內在房間`。
   - 使用者支援電子郵件選你的 email。
3. **目標對象**：選 **外部**（External）。
4. **聯絡資訊**：填你的 email。
5. 勾選同意政策，按 **建立**。

### 2-3 【你操作】發布應用程式（讓所有訪客都能登入）

剛建立時是「測試中」，只有你加進名單的人能登入。訪客要能用 Google 登入留言，必須發布：

1. 左邊選 **目標對象**（Audience）。
2. **發布狀態**下按 **發布應用程式**（Publish app），再按確認。
3. 狀態會變成 **正式版**（In production）。

> 我們只用 Google 登入最基本的資訊（確認身分用），不需要送 Google 審查。

### 2-4 【你操作】建立網頁用戶端

1. 左邊選 **用戶端**（Clients）→ **建立用戶端**。
2. **應用程式類型**選 **網頁應用程式**。
3. 名稱填 `innerroom-web`。
4. **已授權的 JavaScript 來源**按 **新增 URI**，加入兩個：
   - `https://帳號.github.io`（你的網站，不含 `/innerroom`）
   - `http://localhost:8000`（本機測試用）
5. **已授權的重新導向 URI**留空，不需要。
6. 按 **建立**。
7. 複製畫面上的**用戶端 ID**，格式像 `123456789-xxxx.apps.googleusercontent.com`，記進筆記。這不是秘密。
   - 畫面上可能也有「用戶端密鑰」，我們用不到，不用複製。

> 新增的網址可能要等 5 分鐘到幾個小時才會生效。如果等一下測試時 Google 按鈕顯示錯誤，先等一會兒再試。

---

## 第 3 步：建立 Notion 留言資料庫

### 3-1 【你操作】建立 integration（讓 Worker 能讀寫資料庫）

1. 打開 <https://www.notion.so/profile/integrations>，按 **新增整合**（New integration）。
2. 填寫：
   - **名稱**：`內在房間留言`
   - **關聯的工作空間**：選你要放留言的工作空間。
   - **類型**：**內部**（Internal）。
3. 按 **儲存**，再按 **設定整合**（Configure integration settings）。
4. **功能**（Capabilities）勾選：
   - **讀取內容**、**更新內容**、**插入內容**。
   - 使用者資訊選 **不需要使用者資訊**（No user information）。
   - 按 **儲存**。
5. 在 **內部整合密鑰**（Internal Integration Secret）按 **顯示**，再按複製。這是 `ntn_` 開頭的金鑰，暫時存進密碼管理工具。

### 3-2 【你操作】建立留言資料庫

1. 在 Notion 左側新增一個頁面，標題打 `內在房間留言`。
2. 在頁面內容輸入 `/database`，選 **資料庫 - 整頁**（Database - Full page）。
3. 依下表設定欄位。**名稱要一字不差，包括空格**：

   | 欄位名稱 | 類型 | 怎麼做 |
   |---|---|---|
   | `暱稱` | 標題 | 把預設的「名稱」（Name）欄位改名為 `暱稱` |
   | `內容` | 文字（Text） | 新增欄位 |
   | `時間` | 日期（Date） | 新增欄位 |
   | `登入方式` | 選取（Select） | 新增欄位（選項不用先建，Worker 會自動寫入「Google 登入」） |
   | `留言者 Google ID` | 文字（Text） | 新增欄位 |
   | `公開` | 核取方塊（Checkbox） | 新增欄位 |
   | `編輯時間` | 日期（Date） | 新增欄位：留言者自己編輯的時間 |
   | `悄悄話` | 核取方塊（Checkbox） | 新增欄位：只給房主看的留言 |

   預設的「標籤」（Tags）等其他欄位可以刪掉。

4. 建議把 `時間` 欄位設定成同時顯示時間：點欄位名稱 → 編輯屬性 → **時間格式**選 24 小時制，**包含時間**。

### 3-3 【你操作】把資料庫分享給 integration

1. 在資料庫頁面右上角按 **•••**。
2. 選 **連線**（Connections），找到 `內在房間留言`，按確認。

> 新版 Notion 如果在頁面選單找不到「連線」：到 integration（現在叫「連接」）的設定頁 → **Content access**（內容存取權限）→ **Edit access**，展開 **Private**，只勾選 `內在房間留言`，按 **Save**。

沒做這一步，Worker 會找不到資料庫。

### 3-4 【你操作】複製資料庫 ID

1. 在資料庫頁面右上角按 **•••** → **複製連結**。
2. 連結長得像：

   ```
   https://www.notion.so/你的工作空間/1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d?v=…
   ```

3. `?v=` **前面**那串 32 個字元的英文數字就是資料庫 ID，記進筆記。

### 3-5（建議）建立「待審核」檢視

1. 在資料庫上方按 **+** 新增一個表格檢視，命名 `待審核`。
2. 篩選條件設 `公開` **未勾選**，而且 `悄悄話` **未勾選**。

以後打開這個檢視，就能看到所有等你審核的留言（訪客編輯過的留言會先隱藏，出現在這裡）：勾選「公開」就是通過，房間約 3 分鐘內會出現。悄悄話不會出現在房間，就算勾了「公開」也一樣。

---

## 第 4 步：部署 Cloudflare Worker

### 4-1 【你操作】註冊 Cloudflare

1. 打開 <https://dash.cloudflare.com/sign-up>，用 email 和密碼註冊，不需要信用卡。
2. 到信箱收驗證信，點連結完成驗證。
3. 登入後，左邊選 **Workers 和 Pages**（Workers & Pages）。如果要你選擇 `workers.dev` 子網域，填一個你喜歡的英文名字，例如帳號名稱。

> 註冊時如果看到加入網域（Add a site）或升級方案的畫面，都可以略過。我們只用免費的 Workers。

### 4-2 【你操作】讓終端機登入 Cloudflare

打開「終端機」，執行：

```
cd ~/projects/innerroom/worker
npm install
npx wrangler login
```

瀏覽器會打開 Cloudflare 的授權頁面，確認後按 **Allow**，看到成功訊息就可以回到終端機。

> 如果 `npm install` 出現 `install-scripts … not yet covered` 的警告，可以忽略。

### 4-3 【可以請 Claude 做】建立 KV 並填好設定檔

這一步需要的資料都不是秘密，可以把以下資料告訴 Claude，由我來改 `wrangler.toml`：

- GitHub 帳號
- Google 用戶端 ID

自己做的話：

1. 執行：

   ```
   npx wrangler kv namespace create KV
   ```

2. 把輸出裡的 `id = "…"` 那串字，貼到 `worker/wrangler.toml` 最下面 `[[kv_namespaces]]` 的 `id`。
3. 修改 `[vars]`：

   ```toml
   GITHUB_REPO = "你的帳號/innerroom"
   ALLOWED_ORIGINS = "https://你的帳號.github.io,http://localhost:8000"
   GOOGLE_CLIENT_ID = "你的用戶端 ID.apps.googleusercontent.com"
   ```

### 4-4 【你操作】存入金鑰

在 `worker` 資料夾裡，**一行一行**執行。

- 每一行會要你貼上一個值。貼上時畫面不會顯示任何字，這是正常的，貼完按 Enter。
- 第一次執行時如果問你要不要建立新的 Worker，輸入 `Y`。

```
npx wrangler secret put OWNER_EMAILS
```
貼上你自己的 Gmail，也就是你要用來登入後台的帳號。

```
npx wrangler secret put GITHUB_TOKEN
```
貼上第 1-6 步的 `github_pat_…`。

```
npx wrangler secret put NOTION_TOKEN
```
貼上第 3-1 步的 `ntn_…`。

```
npx wrangler secret put NOTION_DATABASE_ID
```
貼上第 3-4 步的 32 個字元。

```
openssl rand -hex 32
npx wrangler secret put HASH_SECRET
```
第一行會產生一串亂數，複製它，再在第二行貼上。這把不用另外保存；**設定後不要更換**，否則封鎖名單會失效。

### 4-5 【可以請 Claude 做】部署

```
npm run deploy
```

完成後會顯示 Worker 網址，例如 `https://innerroom-api.你的子網域.workers.dev`，記進筆記。

### 4-6 檢查設定

用瀏覽器打開 `https://innerroom-api.你的子網域.workers.dev/api/health`。

- 確認 `configured` 和 `format` 裡每一項都是 `true`。
- `format` 是 `false` 代表金鑰貼錯了。最常見的原因是剪貼簿裡是別的內容，請重新複製金鑰，再執行一次對應的 `secret put`。
- `ALLOWED_ORIGINS` 要顯示你的網站網址。
- 哪一項是 `false`，就回到對應的步驟補上。

---

## 第 5 步：讓網站接上 Worker

### 5-1 【可以請 Claude 做】填寫 `config.js`

打開專案根目錄的 `config.js`，填入：

```js
workerUrl: 'https://innerroom-api.你的子網域.workers.dev',
googleClientId: '你的用戶端 ID.apps.googleusercontent.com',
githubRepo: '你的帳號/innerroom',
```

### 5-2 【可以請 Claude 做】填寫隱私權說明的聯絡方式

打開 `privacy.html`，把「（房主聯絡 email）」換成你想公開的聯絡信箱。建議另開一個專用信箱，不一定要用你的主要 Gmail。

### 5-3 【你操作】上傳到 GitHub

1. 打開 GitHub Desktop，左邊會列出修改的檔案。
2. 左下 **Summary** 填 `接上 Worker 與 Google 登入`，按 **Commit to main**。
3. 按上方 **Push origin**。

等 1～2 分鐘，網站就會更新。

---

## 第 6 步：上線檢查

逐項確認。打勾的就是沒問題：

- [ ] **房間**：打開 `https://帳號.github.io/innerroom/`，電視、平板音樂、展品都正常。
- [ ] **未登入**：不登入打開留言本，看得到公開的留言，但只有「使用 Google 帳戶登入」按鈕，沒有留言表單。
- [ ] **Google 登入留言**：登入後送出。留言立即出現，Notion 那筆的 `公開`已勾選，`留言者 Google ID`是一串亂碼。
- [ ] **編輯與審核**：編輯剛剛那則留言，畫面標示「審核中（只有你看得到）」，Notion 的 `公開`變成未勾選、`編輯時間`有值。在後台或 Notion 勾選 `公開`，約 3 分鐘後留言重新出現，並標示「已編輯」。
- [ ] **悄悄話**：勾選「悄悄話」送出，只有自己看得到，Notion 的 `悄悄話`已勾選。
- [ ] **刪除**：刪除自己的一則留言，Notion 那筆移到垃圾桶。
- [ ] **後台登入**：打開 `https://帳號.github.io/innerroom/admin.html`，用你的 Gmail 登入，能看到各個分頁。
- [ ] **後台儲存**：隨便改一個物件的說明，按「儲存並更新房間」。
  - 顯示「已送出，網站約 1 分鐘後更新」。
  - 約 1～2 分鐘後顯示「網站已更新」。
  - GitHub repo 會多一個 commit「後台更新：物件說明」。
- [ ] **上傳**：在「影片與音樂」上傳一個小的 MP3 或 MP4，`media/` 檔案清單會出現它。
- [ ] **非房主**：用另一個 Google 帳號登入後台，應顯示「這個 Google 帳號不是房主」。
- [ ] **手機 LINE**：把房間網址傳到 LINE，在 LINE 裡打開留言本，應看到「用瀏覽器開啟」和「複製連結」。

全部通過後，可以把 `ALLOWED_ORIGINS` 和 Google 用戶端裡的 `http://localhost:8000` 拿掉。這一步不是必要的，留著方便以後在本機測試。

---

## 遇到問題時

| 狀況 | 可能原因與解法 |
|---|---|
| 網站打開是 404 | GitHub Pages 還在建置，等 2 分鐘；確認 Settings → Pages 的 Branch 是 `main`、`/ (root)` |
| 留言本一直顯示「還在準備中」 | `config.js` 的 `workerUrl` 沒填，或還沒 Push；手機上請重新整理 |
| 留言本顯示「現在讀不到留言」 | 打開 `/api/health` 檢查設定；`ALLOWED_ORIGINS` 要和網站網址完全一致（`https`、沒有結尾斜線、不含 `/innerroom`） |
| Google 按鈕出現錯誤或無法登入 | 用戶端的「已授權的 JavaScript 來源」少了你的網址，或剛加上還沒生效；也確認第 2-3 步已發布 |
| 一般訪客無法用 Google 登入，只有你可以 | 同意畫面還在「測試中」，請做第 2-3 步 |
| 後台顯示「這個 Google 帳號不是房主」 | `OWNER_EMAILS` 的 email 打錯；重新執行 `npx wrangler secret put OWNER_EMAILS` |
| 後台儲存顯示「GitHub 金鑰無效或權限不足」 | token 過期、選錯 repo，或 Contents 不是 Read and write；重建 token 後重新 `secret put GITHUB_TOKEN` |
| 留言送出顯示「送出沒有成功」 | Notion 欄位名稱不一致（例如少了空格），或資料庫沒分享給 integration（第 3-3 步） |
| 想看 Worker 的錯誤紀錄 | Cloudflare 後台 → Workers 和 Pages → `innerroom-api` → **記錄**（Logs）；或在 `worker` 資料夾執行 `npx wrangler tail` |

---

## 日常維護

- **修改房間內容**：用後台 `admin.html`，不需要碰程式。
- **審核留言**：在後台「留言管理」，或直接在 Notion 勾選「公開」。
- **GitHub token 到期前換新**：照第 1-6 步建一把新的，然後執行：

  ```
  cd ~/projects/innerroom/worker
  npx wrangler secret put GITHUB_TOKEN
  ```

  再到 GitHub 把舊的那把刪掉。
- **改了 Worker 程式**：在 `worker` 資料夾執行 `npm run deploy`。
- **改了房間的物件或展品**（修改 `index.html`）：在專案資料夾執行 `node tools/build-catalog.mjs`，再 commit 並 Push。
- **用 GitHub Desktop 同步**：後台儲存時，是 Worker 直接把 commit 寫進 GitHub。所以你在電腦上修改專案之前，先在 GitHub Desktop 按 **Fetch origin** → **Pull origin**，把最新內容拉下來，避免衝突。

## 免費額度

| 服務 | 免費額度 | 超過時 |
|---|---|---|
| GitHub Pages | 網站 1 GB、每月流量約 100 GB | 不會收費，GitHub 可能來信提醒 |
| Cloudflare Workers | 每天 10 萬次請求、KV 每天寫入 1000 次 | 不會收費，當天超出的請求暫時失敗，隔天恢復 |
| Notion | 免費方案 API 不另外收費 | API 每秒約 3 次的速度限制 |
| Google 登入 | 免費 | — |

影片越大，訪客載入越久，也越快用掉 GitHub 流量。建議每支影片壓在 20 MB 以內。
