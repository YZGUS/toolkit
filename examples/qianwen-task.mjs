#!/usr/bin/env node
/**
 * 示例：千问"任务助理"模式（自动拆解+执行多步任务，每天 20 次）
 *
 * 用法：
 *   node examples/qianwen-task.mjs "帮我规划一次三天的杭州旅游"
 *
 * 注意：
 * - 任务助理通常耗时数分钟，且回复以多步任务输出形式呈现
 * - 必须已登录 qianwen.com
 */
import { askQianwen } from '../src/qianwen/client.mjs';

const task = process.argv.slice(2).join(' ') || '帮我规划一份本周的学习计划，覆盖前端、算法、英语';

console.log(`👤 [任务助理] ${task}`);
console.log('⏳ 千问任务助理执行中（可能 1-5 分钟）...');

const t0 = Date.now();
const { reply, url } = await askQianwen(task, {
  mode: 'task',
  screenshot: true,
});
const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

console.log(`\n🤖 任务助理结果 (${elapsed}s):\n`);
console.log(reply);
console.log(`\n📎 会话 URL: ${url}`);
console.log('💡 截图已保存：qianwen-task-input.png / qianwen-task-reply.png');
