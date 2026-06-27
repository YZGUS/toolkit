#!/usr/bin/env node
/**
 * 示例：Grok 多轮对话
 */
import { createGrokChat } from '../src/grok/client.mjs';

const chat = await createGrokChat();

try {
  console.log('👤 我叫小明，喜欢编程');
  console.log('🤖', await chat.send('我叫小明，喜欢编程'));

  console.log('\n👤 我刚才说我叫什么？');
  console.log('🤖', await chat.send('我刚才说我叫什么？'));
} finally {
  await chat.close();
}
