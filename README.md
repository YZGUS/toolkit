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
└── examples/
    ├── check-ip.mjs                  # 检测 Chrome 出口 IP
    ├── multi-site-test.mjs           # 多站点登录态验证
    ├── grok-multi-turn.mjs           # Grok 多轮对话
    ├── grok-long-conversation.mjs    # Grok 长上下文记忆测试
    ├── grok-resume.mjs               # Grok 可恢复会话
    ├── qianwen-multi-turn.mjs        # 千问多轮对话
    ├── qianwen-research.mjs          # 千问研究模式（每天 10 次）
    └── qianwen-task.mjs              # 千问任务助理（每天 20 次）
```

## 安装

```bash
cd /Users/cengyi/Desktop/tools/toolkit
npm install
```

## 快速开始

### 1. 启动调试 Chrome（首次会自动复制真实 profile）

```bash
./bin/start-debug-chrome.sh              # 启动；副本已存在则自动同步 cookie
./bin/start-debug-chrome.sh --no-sync    # 跳过 cookie 同步
./bin/start-debug-chrome.sh --rebuild    # 强制重建副本
```

> 真实 Chrome 可以**继续运行**——脚本只会关闭使用副本目录的进程，不再误杀真实 Chrome。

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

解决方案：把真实 profile **完整复制**到 `~/chrome-debug-profile`（含所有 Cookie 和登录态），Chrome 视为"非默认目录"允许调试端口。

### Cookie 在线同步（真实 Chrome 不需要关闭）

副本是首次创建时的快照，之后真实 Chrome 在用的过程中登录的新站点不会自动出现在副本。`ensureDebugChrome()` / `start-debug-chrome.sh` 在副本已存在时会自动：

- **SQLite 在线备份**：用 `sqlite3 .backup` 命令把 `Default/Cookies` 拷到副本，真实 Chrome 在跑也能拿到事务一致的快照
- **普通文件 rsync**：`Local Storage/`、`IndexedDB/`、`Local State`（含 Cookie 加密 key）
- **选择性 kill**：只杀使用副本目录的残留 Chrome（`pkill -f "user-data-dir=$DEBUG_PROFILE"`），不再无差别屠杀真实 Chrome

依赖：`sqlite3` CLI（macOS 自带）。如果不可用会自动回退到 rsync。

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

详细原理与排错见 Obsidian Vault：

```
~/Documents/Obsidian Vault/技术调研/爬虫与采集/Puppeteer/
├── 索引.md
├── Puppeteer 连接真实 Chrome.md
└── Grok Web 自动化.md
```
