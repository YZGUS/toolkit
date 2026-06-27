#!/usr/bin/env node
/**
 * 示例：千问"研究"模式（深度研究，每天 10 次）
 *
 * 用法：
 *   node examples/qianwen-research.mjs "近三年新能源车竞争格局与趋势"
 *
 * 注意：
 * - 研究模式返回内容可能很长、耗时可达几分钟
 * - 必须已登录 qianwen.com
 */
import { askQianwen } from '../src/qianwen/client.mjs';

const topic = process.argv.slice(2).join(' ') || '近三年中国新能源车竞争格局与趋势研究';

console.log(`👤 [研究] ${topic}`);
console.log('⏳ 千问研究中（可能 1-5 分钟）...');

const t0 = Date.now();
const { reply, url } = await askQianwen(topic, {
  mode: 'research',
  screenshot: true,
});
const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

console.log(`\n🤖 千问研究结果 (${elapsed}s):\n`);
console.log(reply);
console.log(`\n📎 会话 URL: ${url}`);
console.log('💡 截图已保存：qianwen-research-input.png / qianwen-research-reply.png');
