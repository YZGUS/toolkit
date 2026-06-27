# toolkit

封装各种自动化工具的工具集。当前包含：

- **chrome**：连接真实 Chrome 进程（保留登录态），支持 Cookie 在线同步
- **grok**：Grok Web 对话自动化
- **qianwen**：千问（qianwen.com）Web 对话自动化，支持 **任务助理 / 研究 / 思考** 模式
- **utils**：通用工具（DOM 稳定等待、SPA 渲染等待）

## 目录结构

```
toolkit/
├── package.json
├── bin/                        # 可执行脚本
│   ├── start-debug-chrome.sh   # 一键启动带调试端口的 Chrome
│   ├── login-helper.mjs        # 在副本里打开登录页，手动登录一次
│   ├── check-logins.mjs        # 检测各站点登录态
│   ├── grok-ask.mjs            # Grok CLI
│   └── qianwen-ask.mjs         # 千问 CLI
├── src/
│   ├── index.js                # 统一入口
│   ├── chrome/
│   │   ├── debug-chrome.mjs    # Chrome 调试端口管理
│   │   └── connect.mjs         # Puppeteer 连接封装
│   ├── grok/
│   │   └── client.mjs          # Grok 对话客户端
│   ├── qianwen/
│   │   └── client.mjs          # 千问对话客户端
│   └── utils/
│       └── wait.mjs            # 等待工具
└── examples/                          # 示例 & 测试用例（见 examples/README.md）
    ├── README.md                      # 运行方式与编写规范
    ├── chrome/                        # Chrome 连接 / 登录态
    │   ├── check-ip.mjs
    │   └── multi-site-test.mjs
    ├── grok/                          # Grok 对话
    │   ├── multi-turn.mjs
    │   ├── long-conversation.mjs
    │   └── resume.mjs
    └── qianwen/                       # 千问对话
        ├── multi-turn.mjs
        ├── research.mjs               # 研究模式（每天 10 次）
        ├── task.mjs                   # 任务助理（每天 20 次）
        └── modes-test.mjs             # 4 模式回归
```

## 安装

```bash
cd /Users/cengyi/Desktop/tools/toolkit
npm install
```

## 快速开始

### 1. 启动调试 Chrome（首次会自动复制真实 profile）

```bash
./bin/start-debug-chrome.sh              # 启动；副本已存在则原样复用
./bin/start-debug-chrome.sh --rebuild    # 删除副本并重建（需重新登录）

# 首次使用：在副本里登录一次（永久保留）
node bin/login-helper.mjs qianwen grok github
node bin/check-logins.mjs                 # 验证登录态
```

> 真实 Chrome 可以**继续运行**——脚本只会关闭使用副本目录的进程，不再误杀真实 Chrome。
>
> 📖 启动原理 / 登录态 / 排错详见 **[docs/chrome.md](./docs/chrome.md)**。

### 2. CLI 提问

```bash
# Grok
node bin/grok-ask.mjs "用一句话介绍你自己"
node bin/grok-ask.mjs --screenshot "解释量子计算"

# 千问（默认模式）
node bin/qianwen-ask.mjs "用一句话介绍你自己"

# 千问 - 任务助理模式（每天 20 次）
node bin/qianwen-ask.mjs --mode=task "帮我规划本周学习计划"

# 千问 - 研究模式（每天 10 次，回复较慢可能 1-5 分钟）
node bin/qianwen-ask.mjs --mode=research --timeout=600000 "近三年新能源车竞争格局"

# 千问 - 思考模式
node bin/qianwen-ask.mjs --mode=think "推理一下：A>B, B>C，A 与 C 的关系？"
```

### 3. 编程方式使用

```js
import {
  askGrok, createGrokChat,
  askQianwen, createQianwenChat, QIANWEN_MODES,
  connectChrome,
} from '@cengyi/toolkit';

// Grok 单轮
const { reply } = await askGrok('你好');

// 千问 - 研究模式（每天 10 次）
const r = await askQianwen('近三年新能源车竞争格局', { mode: 'research' });
console.log(r.reply);

// 千问 - 任务助理模式（每天 20 次）
await askQianwen('帮我做本周计划', { mode: 'task' });

// 千问多轮，支持中途切换模式
const chat = await createQianwenChat({ mode: 'default' });
await chat.send('我叫小明');
await chat.setMode('research');
await chat.send('调研一下我感兴趣的话题');
const url = chat.getUrl();
await chat.close();

// 恢复同一会话
const chat2 = await createQianwenChat({ conversationUrl: url });
await chat2.send('继续聊...');
await chat2.close();
```

## 核心原理

### Chrome 安全策略绕过

Chrome 拒绝在默认 profile 目录开启 `--remote-debugging-port`：

```
DevTools remote debugging requires a non-default data directory.
```

这是 Chromium 源码里的硬性检查（`remote_debugging_server.cc`），命令行/链接/挂载均无法绕过，只能用非默认目录。

解决方案：把真实 profile 复制到 `~/chrome-debug-profile`（含 Cookie / Local Storage / IndexedDB），Chrome 视为"非默认目录"允许调试端口。

### ⚠️ Chrome 127+ App-Bound Encryption (ABE) 的影响

**Chrome 127（2024 年 7 月）起对 Cookie 启用 App-Bound Encryption**：

- 新写入的 Cookie value 用前缀 `v20`，密钥派生**绑定 profile 绝对路径 + 应用签名**
- 把真实 profile 复制到副本目录后：路径变了 → 密钥不一致 → `v20` cookie **解不开**
- 表现：副本里所有站点都需要重新登录，**复制 cookie 看似成功实则失效**

**toolkit 的应对**：

1. 启动调试 Chrome 时加 `--disable-features=LockProfileCookieDatabase` —— 让旧的 `v10` cookie 仍可解密（部分站点）
2. 对 `v20` cookie 不再尝试同步，改为提供**登录辅助工具**：

   ```bash
   # 在调试 Chrome 中打开常用站点的登录页，手动登录一次（永久保留）
   node bin/login-helper.mjs                       # 全部
   node bin/login-helper.mjs qianwen grok          # 指定
   ```

3. 在调试 Chrome 里登录一次后，cookie 用**副本路径派生的新密钥**加密，存到 `~/chrome-debug-profile/`，之后调用 toolkit 永久保留登录态

**心智模型**：把调试 Chrome 当成"自动化专用的独立浏览器"，与日常 Chrome 完全隔离。这是 Playwright / browserless 等业界项目的标准做法。

### 登录态：副本登录一次即永久保留（不再同步 cookie）

由于 ABE 限制（见上），真实 profile 的 `v20` cookie 在副本里解不开，**同步 cookie 只会把副本里已登好的登录态冲掉**。因此 toolkit 的策略是：

- **副本不存在** → 首次复制一份做引导
- **副本已存在** → 原样复用，**绝不覆盖** cookie
- **选择性 kill**：只杀使用副本目录的残留 Chrome（`pkill -f "user-data-dir=$DEBUG_PROFILE"`），不动真实 Chrome
- 需要刷新登录态时，自己 `node bin/login-helper.mjs <site>` 重新登一次

> 完整说明见 **[docs/chrome.md](./docs/chrome.md)**。

### connect vs launch

- `puppeteer.launch()` → 启动新 Chrome 进程，无登录态
- `puppeteer.connect()` → 连接已存在 Chrome，**保留登录态**
- `browser.disconnect()` → 断开 Puppeteer，Chrome 继续运行（connect 模式必用）
- `browser.close()` → 关闭整个 Chrome（仅 launch 模式适用）

### 多轮对话实现模式

Grok 和千问的 `createXxxChat()` 都采用相同模式：

1. 打开一次目标 URL（`grok.com` / `www.qianwen.com/chat`）
2. **不刷新页面**，每次 `send()` 复用同一个 `page`
3. 服务端通过 URL 上的会话 ID 维护上下文，前端 DOM 增量追加消息
4. 发送后 URL 跳转到 `/chat/<id>`，调用 `chat.getUrl()` 拿到，下次 `createXxxChat({ conversationUrl })` 即可恢复

回复完成判定：
- Grok：DOM 稳定（`waitForDomStable`）
- 千问：DOM 标记 `.qk-markdown-complete` + 稳定法兜底

### 千问模式切换

千问输入框上方有一排「胶囊按钮」（capsule），如：任务助理 / 思考 / 研究 / 千问高考 / PPT 创作 / AI 生视频 / 更多。

- DOM 中实际有两份：`[data-role="visible-capsule"]`（实际可点）和 `[data-role="measure-capsule"]`（仅用于度量布局）—— 自动化必须用前者
- 通过 `aria-pressed="true"|"false"` 标识激活状态
- 同一时刻只能激活一个模式（点新的会替换旧的）

`setQianwenMode(page, mode)` 封装了这些细节，支持的模式：

| mode 值 | 名称 | 每日限额 | 默认超时 |
|---|---|---|---|
| `default` | 普通 | 不限 | 120s |
| `task` | 任务助理 | 20 次/天 | 600s |
| `research` | 研究 | 10 次/天 | 900s |
| `think` | 思考 | - | 240s |

调用 `askQianwen(msg, { mode: 'research' })` 或 `chat.setMode('task')` 即可。

## 示例与测试

所有示例集中在 [`examples/`](./examples/README.md) 下，按客户端分子目录：

```
examples/
├── chrome/   # Chrome 连接 / 登录态
├── grok/     # Grok 对话
└── qianwen/  # 千问对话
```

常用入口：

```bash
# 最小示例
node examples/grok/multi-turn.mjs
node examples/qianwen/multi-turn.mjs

# 千问 4 模式回归（--skip-quota 跳过烧额度的）
node examples/qianwen/modes-test.mjs --skip-quota

# 长上下文记忆 / 持久化会话
node examples/grok/long-conversation.mjs
node examples/grok/resume.mjs "我叫小明"
```

> 📖 **新增示例 / 测试用例前请先阅读 [examples/README.md](./examples/README.md)**——里面有目录约定、文件头模板、CLI 参数风格、烧额度示例处理等强制规范。

## 已验证可工作

- ✅ Grok Web 自动对话（单轮 / 多轮 / 恢复会话）
- ✅ 千问 Web 自动对话（单轮 / 多轮）
- ✅ 千问 **任务助理** 模式（每天 20 次，已实测 ~90s 完成简单任务）
- ✅ 千问 **研究** 模式（每天 10 次，支持长达 15 分钟的等待）
- ✅ 千问 **思考** 模式
- ✅ GitHub 等已登录站点自动化
- ✅ 多站点登录态复用
- ✅ 真实 Chrome 同时运行不受影响

## 已知限制

- ❌ ChatGPT/Claude（地理封锁，与 toolkit 无关）
- ⚠️ Grok / 千问 DOM 结构变化可能影响选择器，需要时更新
- ⚠️ 跨 profile 复制后 `Login Data` 中保存的密码可能失效（Cookie 不受影响）

## 文档

- **[docs/chrome.md](./docs/chrome.md)** — 启动调试 Chrome / 登录态 / 排错（强烈建议先读）
- **[examples/README.md](./examples/README.md)** — 示例索引、运行方式、编写规范（新增 example 前请先读）
- **Obsidian Vault**（详细原理 & 排错笔记）：

  ```
  ~/Documents/Obsidian Vault/技术调研/爬虫与采集/Puppeteer/
  ├── 索引.md
  ├── Puppeteer 连接真实 Chrome.md
  └── Grok Web 自动化.md
  ```
