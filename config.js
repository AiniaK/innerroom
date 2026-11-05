// 內在房間的公開設定。
// 這裡的值都不是密碼，放在網站上是安全的（Google 用戶端 ID 本來就會出現在網頁裡）。
// 真正的金鑰（GitHub、Notion）只存在 Cloudflare Worker 的 secrets，絕對不要寫進這個檔案。
window.ROOM_CONFIG = {
  // Cloudflare Worker 的網址，第四階段部署後填入，例如 'https://innerroom-api.你的帳號.workers.dev'
  workerUrl: '',
  // Google OAuth 用戶端 ID，第六階段建立後填入，例如 '1234567890-abc.apps.googleusercontent.com'
  googleClientId: '343926158795-3cglv3m79q6n7lojtne9od790fn57bvr.apps.googleusercontent.com',
  // GitHub repo，例如 '你的帳號/innerroom'。後台「改用 GitHub 網頁上傳」的連結會用到
  githubRepo: 'AiniaK/innerroom',
  githubBranch: 'main',
};
