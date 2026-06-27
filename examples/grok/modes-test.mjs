#!/usr/bin/env node
/**
 * 完整测试：Grok 模式（default / fast / expert）
 *
 * 用法：
 *   node examples/grok/modes-test.mjs              # 全部 3 个模式
 *   node examples/grok/modes-test.mjs fast         # 仅测 fast
 *   node examples/grok/modes-test.mjs fast expert
 *
 * 说明：
 * - Grok 模式切换免费，不烧额度，所以不分 --skip-quota
 * - default 不主动切模式，沿用页面当前 trigger 状态
 */
import { askGrok, GROK_MODES } from '../../src/grok/client.mjs';

const SUITE = {
  default: {
    prompt: '用一句话（20 字以内）介绍你自己',
    check: r => r.length > 0 && r.length < 200,
  },
  fast: {
    prompt: '用一句话（20 字以内）介绍 JavaScript 中的闭包',
    check: r => /闭包|closure/i.test(r) && r.length < 300,
  },
  expert: {
    prompt: '推理：A 比 B 高，B 比 C 高，C 比 D 高。请只回答"A 与 D 哪个高"，不超过 20 字',
    check: r => /A.*高|A.*更高/.test(r),
  },
};

const argv = process.argv.slice(2);
let modes = argv.filter(a => !a.startsWith('--'));
if (modes.length === 0) modes = Object.keys(SUITE);

for (const m of modes) {
  if (!SUITE[m]) {
    console.error(`❌ 未知模式: ${m}（支持：${Object.keys(SUITE).join(', ')}）`);
    process.exit(1);
  }
}

console.log(`将测试模式：${modes.join(' / ')}\n`);

const results = [];
for (const mode of modes) {
  const { prompt, check } = SUITE[mode];
  const timeoutMs = GROK_MODES[mode].defaultTimeoutMs;
  const timeoutMin = (timeoutMs / 60000).toFixed(1);

  console.log(`\n========== [${mode}] ==========`);
  console.log(`👤 ${prompt}`);
  console.log(`⏳ 超时上限 ${timeoutMin} 分钟...`);

  const t0 = Date.now();
  try {
    const { reply, url } = await askGrok(prompt, { mode });
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

    console.log(`🤖 (${elapsed}s)`);
    console.log(`   ${reply.replace(/\n/g, '\n   ').slice(0, 500)}${reply.length > 500 ? '…' : ''}`);
    console.log(`   🔗 ${url}`);

    const ok = check(reply);
    console.log(`   ${ok ? '✅ 通过' : '⚠️ 校验未通过'}`);

    results.push({ mode, ok, elapsed: Number(elapsed), replyLen: reply.length });
  } catch (err) {
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    console.error(`   ❌ (${elapsed}s) ${err.message}`);
    results.push({ mode, ok: false, elapsed: Number(elapsed), error: err.message });
  }
}

console.log('\n========== 测试汇总 ==========');
console.log('模式      | 通过 | 耗时(s) | 回复(字)');
console.log('----------|------|---------|--------');
for (const r of results) {
  const cells = [
    r.mode.padEnd(9),
    (r.ok ? '✅' : '❌').padEnd(4),
    String(r.elapsed).padStart(7),
    String(r.replyLen ?? '-').padStart(8),
  ];
  console.log(cells.join(' | '));
  if (r.error) console.log(`          错误：${r.error}`);
}

const passed = results.filter(r => r.ok).length;
console.log(`\n通过 ${passed}/${results.length}`);
process.exit(passed === results.length ? 0 : 1);
