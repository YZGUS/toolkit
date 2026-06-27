#!/usr/bin/env node
/**
 * Grok 命令行工具
 *
 * 用法：
 *   ./grok-ask.mjs "你的问题"
 *   ./grok-ask.mjs --screenshot "你的问题"
 */
import { askGrok } from '../src/grok/client.mjs';

const args = process.argv.slice(2);
let screenshot = false;
const messageParts = [];

for (const arg of args) {
  if (arg === '--screenshot' || arg === '-s') {
    screenshot = true;
  } else {
    messageParts.push(arg);
  }
}

const message = messageParts.join(' ') || '用一句话介绍你自己';

console.log(`👤 ${message}`);
console.log('⏳ 连接 Grok...');

try {
  const { reply, url } = await askGrok(message, { screenshot });
  console.log(`\n🤖 Grok:\n${reply}`);
  console.log(`\n📎 会话 URL: ${url}`);
} catch (err) {
  console.error(`\n❌ 错误: ${err.message}`);
  process.exit(1);
}
