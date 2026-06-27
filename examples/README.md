# examples — 示例 / 测试用例

按"对话客户端 + 工具子模块"组织，每个 client 一个文件夹。

## 目录结构

```
examples/
├── README.md              # ← 你在这里
├── chrome/                # Chrome 连接 / 多站点登录态相关
│   ├── check-ip.mjs       #   检测调试 Chrome 的出口 IP
│   └── multi-site-test.mjs #  多站点登录态验证
├── grok/                  # Grok 对话相关
│   ├── multi-turn.mjs     #   多轮对话最小示例
│   ├── long-conversation.mjs # 长上下文记忆测试（4 轮渐进校验）
│   └── resume.mjs         #   持久化会话 URL，跨进程续接
└── qianwen/               # 千问对话相关
    ├── multi-turn.mjs     #   多轮对话最小示例
    ├── research.mjs       #   研究模式（每天 10 次）
    ├── task.mjs           #   任务助理模式（每天 20 次）
    └── modes-test.mjs     #   4 种模式（default/think/task/research）完整回归
```

## 运行方式

每个示例都是独立的 ESM 入口：

```bash
# 简单示例（不烧额度）
node examples/grok/multi-turn.mjs
node examples/qianwen/multi-turn.mjs

# 千问按模式
node examples/qianwen/research.mjs "近三年新能源车竞争格局"
node examples/qianwen/task.mjs "帮我规划一份本周学习计划"

# 完整回归（仅 default + think，不烧额度）
node examples/qianwen/modes-test.mjs --skip-quota

# 完整回归（包含 task / research，会消耗每日额度）
node examples/qianwen/modes-test.mjs

# 长上下文记忆测试
node examples/grok/long-conversation.mjs

# 持久化会话
node examples/grok/resume.mjs "我叫小明"
node examples/grok/resume.mjs "我刚才说我叫什么？"
node examples/grok/resume.mjs --reset "开新话题"
```

前置条件：调试 Chrome 已通过 `bin/start-debug-chrome.sh` 启动，且对应站点已登录（`node bin/login-helper.mjs <site>`）。

## 编写规范

新增示例 / 测试用例时遵循以下约定，保持目录可读、可发现：

### 1. 文件位置

| 客户端 / 工具 | 目录 |
|---|---|
| Grok 相关 | `examples/grok/` |
| 千问相关 | `examples/qianwen/` |
| 新加 ChatGPT / Claude / LongCat 等新客户端 | `examples/<name>/` （配合 `src/<name>/`） |
| 仅 Chrome 连接 / 登录态相关 | `examples/chrome/` |

文件名采用**短横线小写**，**不带模块前缀**（已经在子目录里了，无需重复）：

- ✅ `examples/qianwen/research.mjs`
- ❌ `examples/qianwen/qianwen-research.mjs`
- ❌ `examples/qianwen/Research.mjs`

### 2. 文件头注释（强制）

每个示例顶部必须有 doc 注释，说明：

1. 用途（一两句话）
2. 用法示例（命令行 + 参数说明）
3. 注意事项（额度限制 / 登录要求 / 耗时）

样板：

```js
#!/usr/bin/env node
/**
 * 示例：千问任务助理模式（每天 20 次）
 *
 * 用法：
 *   node examples/qianwen/task.mjs "帮我规划一次三天的杭州旅游"
 *
 * 注意：
 * - 任务助理通常耗时数分钟，且回复以多步任务输出形式呈现
 * - 必须已登录 qianwen.com
 */
import { askQianwen } from '../../src/qianwen/client.mjs';
// ...
```

并使文件可执行：`chmod +x examples/<dir>/<file>.mjs`。

### 3. import 路径

示例位于 `examples/<dir>/`，引入源码需要 **两级回退**：

```js
import { askQianwen } from '../../src/qianwen/client.mjs';
```

不要从已发布包名 `@cengyi/toolkit` 引入——示例需要直接打到 src，避免编译/打包步骤。

### 4. 校验式测试（推荐）

凡是"测试用例"性质的示例（文件名带 `-test` 或 `modes-test` 等），应该：

- 用断言函数或正则验证回复内容
- 输出 ✅ / ❌ 标记和耗时
- 末尾打印通过率，用 `process.exit(pass === total ? 0 : 1)` 反映结果

参考：`examples/qianwen/modes-test.mjs`、`examples/grok/long-conversation.mjs`。

### 5. 烧额度的示例

千问 `task` (20/天)、`research` (10/天) 等有每日上限的示例，必须：

- 在文件头注释里**显式标注额度成本**
- 提供 `--skip-quota` / `--dry-run` 之类的开关让用户跳过烧额度的部分
- 测试 prompt 写**最简短任务**（"用 50 字内说今天日期"而非"帮我做一份 PPT"），避免单次跑就用掉一格

### 6. 截图 / 落盘文件

- 截图统一命名 `<client>-<mode>-<input|reply>.png`（如 `qianwen-task-input.png`）
- 持久化文件（会话 URL 缓存等）放在示例所在目录，文件名加 `.` 前缀
- 所有产物在 `.gitignore` 中显式忽略（PNG / JPG 已全局忽略；其他自行追加）

### 7. CLI 参数风格

参考 `bin/qianwen-ask.mjs`：

- 长参数 `--mode=<value>` / `--timeout=<ms>`
- 短开关 `-s` / `--screenshot`
- `--help` / `-h` 显示用法
- 不识别的参数视为消息内容拼接

### 8. 失败退出

示例脚本必须以**非 0 退出码**反映失败，方便接入 CI：

```js
try {
  // ...
} catch (err) {
  console.error(`❌ ${err.message}`);
  process.exit(1);
}
```

## 添加新示例的清单

1. [ ] 文件放在正确的子目录（按 client 分）
2. [ ] 文件头注释含用途 / 用法 / 注意事项
3. [ ] import 用 `../../src/...`
4. [ ] `chmod +x`
5. [ ] 烧额度的标注成本并提供跳过开关
6. [ ] 失败用 `process.exit(1)`
7. [ ] 在本 README 的「目录结构」与「运行方式」里加一条
8. [ ] 如果产物会落盘，更新根 `.gitignore`
