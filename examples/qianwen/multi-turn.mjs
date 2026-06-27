#!/usr/bin/env node
/**
 * 示例：千问多轮对话
 */
import { createQianwenChat } from '../../src/qianwen/client.mjs';

const chat = await createQianwenChat();

try {
  console.log('👤 我叫小明，喜欢编程');
  console.log('🤖', await chat.send('我叫小明，喜欢编程'));

  console.log('\n👤 我刚才说我叫什么？');
  console.log('🤖', await chat.send('我刚才说我叫什么？'));
} finally {
  await chat.close();
}
