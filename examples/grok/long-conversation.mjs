#!/usr/bin/env node
/**
 * 示例：Grok 长时间多轮对话记忆测试
 *
 * 验证 createGrokChat() 在同一 page 上连续 send() 时，
 * Grok 能否记住前几轮注入的信息（上下文保持）。
 *
 * 用法：
 *   node examples/grok/long-conversation.mjs
 */
import { createGrokChat } from '../../src/grok/client.mjs';

const TURNS = [
  {
    send: '我们来玩个记忆游戏。请记住这三个词：苹果、椅子、银河。回复"记住了"即可。',
    check: reply => /记住/.test(reply),
    label: '注入记忆',
  },
  {
    send: '请把刚才那三个词倒序输出，用顿号分隔。',
    check: reply => /银河[、,]椅子[、,]苹果/.test(reply.replace(/\s/g, '')),
    label: '倒序回忆',
  },
  {
    send: '在第 2 个词前面加上"木质"，第 3 个词前面加上"仙女座"，重新输出这三个词。',
    check: reply => /木质椅子/.test(reply) && /仙女座银河/.test(reply),
    label: '复合改写',
  },
  {
    send: '现在用这三个词（含修饰语）造一个通顺的中文句子。',
    check: reply => reply.includes('苹果') && reply.includes('木质椅子') && reply.includes('仙女座银河'),
    label: '造句整合',
  },
];

console.log('⏳ 连接 Grok 并新建会话...');
const chat = await createGrokChat();

const results = [];
try {
  for (let i = 0; i < TURNS.length; i++) {
    const { send, check, label } = TURNS[i];
    console.log(`\n[第 ${i + 1} 轮 / ${TURNS.length}] ${label}`);
    console.log(`👤 ${send}`);

    const t0 = Date.now();
    let reply;
    try {
      reply = await chat.send(send, { waitTimeoutMs: 120000, stableMs: 3000 });
    } catch (err) {
      console.error(`   ❌ 发送/等待失败: ${err.message}`);
      results.push({ label, ok: false, reason: err.message });
      break;
    }
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`🤖 (${elapsed}s) ${reply.slice(0, 200)}${reply.length > 200 ? '…' : ''}`);

    const ok = check(reply);
    console.log(`   ${ok ? '✅ 通过' : '⚠️ 校验未通过'}`);
    results.push({ label, ok });
  }
} finally {
  await chat.close();
}

console.log('\n========== 测试汇总 ==========');
let pass = 0;
for (const r of results) {
  console.log(`${r.ok ? '✅' : '❌'} ${r.label}${r.reason ? ` — ${r.reason}` : ''}`);
  if (r.ok) pass++;
}
console.log(`通过 ${pass}/${results.length} 轮`);
process.exit(pass === results.length ? 0 : 1);