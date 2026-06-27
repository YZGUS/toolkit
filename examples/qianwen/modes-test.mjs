#!/usr/bin/env node
/**
 * 完整测试：千问四种模式（default / think / task / research）
 *
 * 注意额度：
 * - task     消耗 1 次（每天上限 20 次）
 * - research 消耗 1 次（每天上限 10 次）
 * - default / think 不限
 *
 * 用法：
 *   node examples/qianwen/modes-test.mjs            # 全部 4 个模式
 *   node examples/qianwen/modes-test.mjs default    # 仅测 default
 *   node examples/qianwen/modes-test.mjs default think
 *   node examples/qianwen/modes-test.mjs --skip-quota  # 仅 default + think，跳过烧额度的
 */
import { askQianwen, QIANWEN_MODES } from '../../src/qianwen/client.mjs';

const SUITE = {
  default: {
    prompt: '请用一句话（30 字以内）介绍 JavaScript 中的 Promise',
    check: r => r.includes('Promise') && r.length < 200,
    expectAttachment: false,
  },
  think: {
    prompt: '推理：A 比 B 高，B 比 C 高，C 比 D 高。请只回答"A 与 D 哪个高"，不超过 20 字',
    check: r => /A.*高|A.*更高|A 比 D 高/.test(r),
    expectAttachment: false,
  },
  task: {
    prompt: '用 50 字以内简要列出今天是几月几日、星期几',
    check: r => /20\d{2}|月|日|星期/.test(r),
    expectAttachment: true,  // 任务助理通常会生成报告文件
  },
  research: {
    prompt: '简要介绍 1 个 2024 年最受关注的 AI 模型，控制在 100 字以内',
    check: r => r.length > 50 && /AI|模型|GPT|Claude|Gemini|Qwen|Llama/i.test(r),
    expectAttachment: true,
  },
};

const argv = process.argv.slice(2);
const skipQuota = argv.includes('--skip-quota');
let modes = argv.filter(a => !a.startsWith('--'));
if (modes.length === 0) {
  modes = skipQuota
    ? ['default', 'think']
    : Object.keys(SUITE);
}

for (const m of modes) {
  if (!SUITE[m]) {
    console.error(`❌ 未知模式: ${m}（支持：${Object.keys(SUITE).join(', ')}）`);
    process.exit(1);
  }
}

console.log(`将测试模式：${modes.join(' / ')}`);
console.log(`额度提醒：task=每天 20 次，research=每天 10 次\n`);

const results = [];
for (const mode of modes) {
  const { prompt, check, expectAttachment } = SUITE[mode];
  const timeoutMs = QIANWEN_MODES[mode].defaultTimeoutMs;
  const timeoutMin = (timeoutMs / 60000).toFixed(1);

  console.log(`\n========== [${mode}] ==========`);
  console.log(`👤 ${prompt}`);
  console.log(`⏳ 超时上限 ${timeoutMin} 分钟...`);

  const t0 = Date.now();
  try {
    const { reply, attachments, url } = await askQianwen(prompt, { mode });
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

    console.log(`🤖 (${elapsed}s)`);
    console.log(`   ${reply.replace(/\n/g, '\n   ').slice(0, 500)}${reply.length > 500 ? '…' : ''}`);

    if (attachments?.length > 0) {
      console.log(`   📎 附件 (${attachments.length}):`);
      for (const a of attachments) console.log(`      - ${a.name} (${a.size}, ${a.type})`);
    }
    console.log(`   🔗 ${url}`);

    const contentOk = check(reply);
    const attachmentOk = !expectAttachment || (attachments?.length > 0);
    const ok = contentOk && attachmentOk;
    console.log(`   ${ok ? '✅ 通过' : '⚠️ 校验未通过'} (content=${contentOk}, attachment=${attachmentOk})`);

    results.push({ mode, ok, elapsed: Number(elapsed), replyLen: reply.length, attachments: attachments?.length || 0 });
  } catch (err) {
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    console.error(`   ❌ (${elapsed}s) ${err.message}`);
    results.push({ mode, ok: false, elapsed: Number(elapsed), error: err.message });
  }
}

console.log('\n========== 测试汇总 ==========');
console.log('模式       | 通过 | 耗时(s) | 回复(字) | 附件数');
console.log('-----------|------|---------|----------|-------');
for (const r of results) {
  const cells = [
    r.mode.padEnd(10),
    (r.ok ? '✅' : '❌').padEnd(4),
    String(r.elapsed).padStart(7),
    String(r.replyLen ?? '-').padStart(8),
    String(r.attachments ?? '-').padStart(6),
  ];
  console.log(cells.join(' | '));
  if (r.error) console.log(`           错误：${r.error}`);
}

const passed = results.filter(r => r.ok).length;
console.log(`\n通过 ${passed}/${results.length}`);
process.exit(passed === results.length ? 0 : 1);
