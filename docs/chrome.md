# 启动调试 Chrome 使用说明

本文档专门讲清楚 toolkit 如何启动 / 连接 Chrome、为什么这么做，以及登录态的正确用法。

## TL;DR（最常用）

```bash
# 1. 启动调试 Chrome（首次会复制一份真实 profile 到副本，1-3 分钟）
./bin/start-debug-chrome.sh

# 2. 首次使用：在副本里登录一次（永久保留，之后不用再登）
node bin/login-helper.mjs qianwen grok github

# 3. 验证登录态
node bin/check-logins.mjs

# 4. 正常使用
node bin/qianwen-ask.mjs "你好"
```

只要副本登录过一次，登录态就**持久**保存在副本里。之后随便关、随便重启，toolkit 都能复用，不会再掉登录。

## 能不能直接绑定到我日常那个已登录的 Chrome？

**不能。** 这是 Chromium 的硬性安全限制，命令行 / 软链接 / 挂载都绕不过：

```
DevTools remote debugging requires a non-default data directory.
```

也就是说，Chrome **拒绝在默认 profile 目录上开启 `--remote-debugging-port`**。你日常用的那个 Chrome 正好跑在默认目录，所以无法对它开调试端口、也就无法用 puppeteer 连上去。

**替代方案（toolkit 采用的）**：复制一份真实 profile 到非默认目录 `~/chrome-debug-profile`（副本），对副本开调试端口。把这个副本当成一个「自动化专用、长期保持登录」的独立浏览器即可——这也是 Playwright / browserless 等业界项目的标准做法。

> 副本登录一次后就是你「已登录状态的浏览器」，toolkit 每次都连它。

## 为什么登录必须在副本里做一次？（ABE）

Chrome 127（2024-07）起对 Cookie 启用 **App-Bound Encryption (ABE)**：

- 新 cookie（value 前缀 `v20`）的密钥**绑定 profile 的绝对路径**。
- 把真实 profile 复制到副本后，路径变了 → 密钥对不上 → 真实 profile 里的 `v20` cookie 在副本里**解不开**。
- 所以「复制 profile」并不能把登录态带过来，必须在副本里**重新登录一次**。
- 在副本里登录后，cookie 用**副本路径派生的新密钥**加密，存到 `~/chrome-debug-profile/Default/Cookies`，从此长期有效。

`--disable-features=LockProfileCookieDatabase` 让旧的 `v10` cookie 仍可读，是对部分老站点的尽力兼容，但**不要指望它能搬运现代站点的登录态**。

## 关键设计：不再同步 cookie

历史版本会在每次启动时用真实 profile 的 cookie 同步覆盖副本。**这是个 bug**：真实 profile 的 `v20` cookie 在副本里解不开，同步只会把副本里好不容易登好的 cookie 冲掉，导致「时而登录、时而掉登录」。

现在的行为：

- **副本不存在** → 首次复制一份做引导。
- **副本已存在** → 原样复用，**绝不覆盖**副本的 cookie。
- 需要刷新登录态时，自己 `node bin/login-helper.mjs <site>` 重新登一次即可。

## 启动流程是怎么工作的

`connectChrome()` → `ensureDebugChrome()` 的逻辑：

1. 探测调试端口 `9222` 是否已开。
   - **已开** → 直接复用现有进程（不复制、不重启），登录态完好。
   - **没开** → 只杀使用副本目录的残留进程（不动你的真实 Chrome）→ 副本不存在则首次复制 → 用副本启动 Chrome。
2. `puppeteer.connect()` 连上调试端口（保留登录态），断开时用 `browser.disconnect()`，Chrome 继续运行。

| 命令 | 作用 |
|---|---|
| `./bin/start-debug-chrome.sh` | 启动调试 Chrome；副本不存在则首次复制 |
| `./bin/start-debug-chrome.sh --rebuild` | 删除副本并重建（副本损坏 / 想彻底重置时用，需重新登录） |
| `node bin/login-helper.mjs [sites...]` | 在副本里打开登录页，手动登录一次 |
| `node bin/check-logins.mjs [sites...]` | 检测各站点登录态（HTTP 探针为准） |

环境变量：`TOOLKIT_DEBUG_PROFILE`（副本路径）、`TOOLKIT_DEBUG_PORT`（端口）。

## 关于「Chrome 正在受自动测试软件的控制」横幅

这条横幅由命令行开关 `--enable-automation` 触发，而它只由 `puppeteer.launch()` / chromedriver 自动添加。toolkit 全程用 `puppeteer.connect()` + 手动 `spawn` 启动 Chrome，**从不添加该开关**，因此正常情况下**不会**出现这条横幅。

容易混淆的另一条是 **「DevTools is debugging this browser」**（黄条）：只要有 puppeteer 连上调试端口就会出现，无害，和登录态无关。

如果你确实看到「受自动测试软件控制」，说明你连的 Chrome 是被别的带 `--enable-automation` 的程序拉起来的（例如旧版脚本或其它工具）。处理：

```bash
# 关掉副本残留进程后用本脚本重新拉起
pkill -9 -f "user-data-dir=$HOME/chrome-debug-profile"
./bin/start-debug-chrome.sh
```

## 常见排错

| 现象 | 原因 / 处理 |
|---|---|
| 打开后没登录 | 副本没登录过，或被旧版同步冲掉。`node bin/login-helper.mjs <site>` 重新登一次 |
| 启动超时 | 副本被锁。`pkill -9 -f "user-data-dir=$HOME/chrome-debug-profile"` 后重试 |
| 副本损坏 / 行为异常 | `./bin/start-debug-chrome.sh --rebuild`，然后重新登录 |
| 端口被占用 | 用 `TOOLKIT_DEBUG_PORT=9333 ./bin/start-debug-chrome.sh` 换端口 |
