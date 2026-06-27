#!/usr/bin/env node
/**
 * 千问命令行工具
 *
 * 用法：
 *   ./qianwen-ask.mjs "你的问题"
 *   ./qianwen-ask.mjs --mode=research "你的问题"        # 研究模式（每天 10 次）
 *   ./qianwen-ask.mjs --mode=task "帮我做计划"           # 任务助理（每天 20 次）
 *   ./qianwen-ask.mjs --mode=think "推理一下"            # 深度思考
 *   ./qianwen-ask.mjs --screenshot "你的问题"
 *   ./qianwen-ask.mjs --timeout=1200000 --mode=research "长任务"
 */
import { askQianwen, QIANWEN_MODES } from '../src/qianwen/client.mjs';

const args = process.argv.slice(2);
let screenshot = false;
let mode = 'default';
let waitTimeoutMs;
const messageParts = [];

for (const arg of args) {
  if (arg === '--screenshot' || arg === '-s') {
    screenshot = true;
  } else if (arg.startsWith('--mode=')) {
    mode = arg.slice('--mode='.length);
  } else if (arg.startsWith('--timeout=')) {
    waitTimeoutMs = Number(arg.slice('--timeout='.length));
  } else if (arg === '--help' || arg === '-h') {
    console.log(`用法: qianwen-ask.mjs [--mode=default|task|research|think] [--timeout=ms] [-s|--screenshot] "问题"`);
    process.exit(0);
  } else {
    messageParts.push(arg);
  }
}

if (!(mode in QIANWEN_MODES)) {
  console.error(`❌ 未知模式: ${mode}（支持: ${Object.keys(QIANWEN_MODES).join(', ')}）`);
  process.exit(1);
}

const message = messageParts.join(' ') || '用一句话介绍你自己';

const modeHint = mode === 'default' ? '' : `（模式: ${mode}）`;
console.log(`👤 ${message} ${modeHint}`);
console.log(`⏳ 连接千问... 超时上限 ${(waitTimeoutMs ?? QIANWEN_MODES[mode].defaultTimeoutMs) / 1000}s`);

try {
  const t0 = Date.now();
  const { reply, url, attachments } = await askQianwen(message, { mode, screenshot, waitTimeoutMs });
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`\n🤖 千问 (${elapsed}s):\n${reply}`);
  if (attachments && attachments.length > 0) {
    console.log(`\n📎 生成附件:`);
    for (const a of attachments) {
      console.log(`   - ${a.name} (${a.size}, ${a.type})`);
    }
  }
  console.log(`\n📎 会话 URL: ${url}`);
} catch (err) {
  console.error(`\n❌ 错误: ${err.message}`);
  process.exit(1);
}
