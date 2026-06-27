# toolkit

封装各种自动化工具的工具集。当前包含：

- **chrome**：连接真实 Chrome 进程（保留登录态）
- **grok**：Grok Web 对话自动化
- **utils**：通用工具（DOM 稳定等待、SPA 渲染等待）

## 目录结构

```
toolkit/
├── package.json
├── bin/                        # 可执行脚本
│   ├── start-debug-chrome.sh   # 一键启动带调试端口的 Chrome
│   └── grok-ask.mjs            # Grok CLI
├── src/
│   ├── index.js                # 统一入口
│   ├── chrome/
│   │   ├── debug-chrome.mjs    # Chrome 调试端口管理
│   │   └── connect.mjs         # Puppeteer 连接封装
│   ├── grok/
│   │   └── client.mjs          # Grok 对话客户端
│   └── utils/
│       └── wait.mjs            # 等待工具
└── examples/
    ├── check-ip.mjs            # 检测 Chrome 出口 IP
    ├── multi-site-test.mjs     # 多站点登录态验证
    └── grok-multi-turn.mjs     # Grok 多轮对话
```

## 安装

```bash
cd /Users/cengyi/Desktop/tools/toolkit
npm install
```

## 快速开始

### 1. 启动调试 Chrome（首次会自动复制真实 profile）

```bash
./bin/start-debug-chrome.sh
```

### 2. CLI 提问 Grok

```bash
node bin/grok-ask.mjs "用一句话介绍你自己"
node bin/grok-ask.mjs --screenshot "解释量子计算"
```

### 3. 编程方式使用

```js
import { askGrok, createGrokChat, connectChrome } from '@cengyi/toolkit';

// 单轮
const { reply } = await askGrok('你好');
console.log(reply);

// 多轮
const chat = await createGrokChat();
const r1 = await chat.send('我叫小明');
const r2 = await chat.send('我刚才说什么？');
await chat.close();

// 自定义页面操作
const { browser } = await connectChrome();
const page = await browser.newPage();
await page.goto('https://github.com');
// ...
await page.close();
await browser.disconnect();
```

## 核心原理

### Chrome 安全策略绕过

Chrome 拒绝在默认 profile 目录开启 `--remote-debugging-port`：

```
DevTools remote debugging requires a non-default data directory.
```

解决方案：把真实 profile **完整复制**到 `~/chrome-debug-profile`（含所有 Cookie 和登录态），Chrome 视为"非默认目录"允许调试端口。

### connect vs launch

- `puppeteer.launch()` → 启动新 Chrome 进程，无登录态
- `puppeteer.connect()` → 连接已存在 Chrome，**保留登录态**
- `browser.disconnect()` → 断开 Puppeteer，Chrome 继续运行（connect 模式必用）
- `browser.close()` → 关闭整个 Chrome（仅 launch 模式适用）

## 已验证可工作

- ✅ Grok Web 自动对话
- ✅ GitHub 等已登录站点自动化
- ✅ 多站点登录态复用

## 已知限制

- ❌ ChatGPT/Claude（地理封锁，与 toolkit 无关）
- ⚠️ Grok DOM 结构变化可能影响选择器，需要时更新

## 文档

详细原理与排错见 Obsidian Vault：

```
~/Documents/Obsidian Vault/技术调研/爬虫与采集/Puppeteer/
├── 索引.md
├── Puppeteer 连接真实 Chrome.md
└── Grok Web 自动化.md
```
