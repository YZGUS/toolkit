#!/usr/bin/env node
/**
 * Grok 命令行工具
 *
 * 用法：
 *   ./grok-ask.mjs "你的问题"
 *   ./grok-ask.mjs --mode=fast "你的问题"
 *   ./grok-ask.mjs --mode=expert "深度推理一下..."
 *   ./grok-ask.mjs --timeout=600000 --mode=expert "复杂问题"
 *   ./grok-ask.mjs --screenshot "你的问题"
 */
import { askGrok, GROK_MODES } from '../src/grok/client.mjs';

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
    console.log(`用法: grok-ask.mjs [--mode=default|fast|expert] [--timeout=ms] [-s|--screenshot] "问题"`);
    process.exit(0);
  } else {
    messageParts.push(arg);
  }
}

if (!(mode in GROK_MODES)) {
  console.error(`❌ 未知模式: ${mode}（支持: ${Object.keys(GROK_MODES).join(', ')}）`);
  process.exit(1);
}

const message = messageParts.join(' ') || '用一句话介绍你自己';

const modeHint = mode === 'default' ? '' : `（模式: ${mode}）`;
console.log(`👤 ${message} ${modeHint}`);
console.log(`⏳ 连接 Grok... 超时上限 ${(waitTimeoutMs ?? GROK_MODES[mode].defaultTimeoutMs) / 1000}s`);

try {
  const t0 = Date.now();
  const { reply, url } = await askGrok(message, { mode, screenshot, waitTimeoutMs });
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`\n🤖 Grok (${elapsed}s):\n${reply}`);
  console.log(`\n📎 会话 URL: ${url}`);
} catch (err) {
  console.error(`\n❌ 错误: ${err.message}`);
  process.exit(1);
}
