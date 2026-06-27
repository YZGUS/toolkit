#!/usr/bin/env node
/**
 * 示例：Grok 可恢复多轮对话
 *
 * - 首次运行：新建会话，记录 URL 到 .grok-session.json
 * - 后续运行：自动读取 URL 续接同一会话（Grok 服务端记忆仍在）
 *
 * 用法：
 *   node examples/grok-resume.mjs "我叫小明，喜欢编程"
 *   node examples/grok-resume.mjs "我刚才说我叫什么？"     # 应能答出"小明"
 *   node examples/grok-resume.mjs --reset "新话题"          # 丢弃旧会话重开
 */
import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createGrokChat } from '../src/grok/client.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SESSION_FILE = join(__dirname, '.grok-session.json');

const args = process.argv.slice(2);
const reset = args.includes('--reset');
const message = args.filter(a => a !== '--reset').join(' ') || '你好';

if (reset && existsSync(SESSION_FILE)) {
  unlinkSync(SESSION_FILE);
  console.log('🗑  已清除旧会话');
}

let conversationUrl = null;
if (existsSync(SESSION_FILE)) {
  try {
    conversationUrl = JSON.parse(readFileSync(SESSION_FILE, 'utf8')).url;
    console.log(`🔄 恢复会话: ${conversationUrl}`);
  } catch {
    console.warn('⚠️  会话文件损坏，将新建');
  }
} else {
  console.log('🆕 新建会话');
}

const chat = await createGrokChat(conversationUrl ? { conversationUrl } : {});

try {
  console.log(`\n👤 ${message}`);
  const reply = await chat.send(message);
  console.log(`🤖 ${reply}`);

  // 发送一次后 URL 才会确定为 /chat/<id>，写回文件
  const url = chat.getUrl();
  writeFileSync(SESSION_FILE, JSON.stringify({ url, updatedAt: new Date().toISOString() }, null, 2));
  console.log(`\n💾 会话已保存: ${url}`);
  console.log('   下次直接再运行本脚本即可续接');
} finally {
  await chat.close();
}