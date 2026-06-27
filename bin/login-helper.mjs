#!/usr/bin/env node
/**
 * 帮助在调试 Chrome 里登录指定网站（解决 ABE 跨路径加密失效问题）
 *
 * 背景：
 * Chrome 127+ 的 App-Bound Encryption 用 profile 绝对路径派生密钥加密 cookie。
 * 把真实 profile 复制到 ~/chrome-debug-profile/ 后，路径变 → 密钥变 → 老 cookie
 * 解密失败 → 登录态丢失。
 *
 * 解决：在调试 Chrome 里手动登录一次（cookie 用副本路径派生的新密钥加密），永久有效。
 *
 * 用法：
 *   node bin/login-helper.mjs                       # 默认打开所有常用站点
 *   node bin/login-helper.mjs qianwen               # 仅打开千问
 *   node bin/login-helper.mjs qianwen grok github   # 指定多个
 */
import { connectChrome } from '../src/chrome/connect.mjs';

const SITES = {
  qianwen: { url: 'https://www.qianwen.com/chat', name: '千问' },
  grok: { url: 'https://grok.com', name: 'Grok' },
  github: { url: 'https://github.com/login', name: 'GitHub' },
  chatgpt: { url: 'https://chatgpt.com', name: 'ChatGPT' },
};

const argv = process.argv.slice(2);
const targets = argv.length > 0 ? argv : Object.keys(SITES);

for (const t of targets) {
  if (!SITES[t]) {
    console.error(`❌ 未知站点：${t}（支持：${Object.keys(SITES).join(', ')}）`);
    process.exit(1);
  }
}

console.log('⏳ 连接调试 Chrome...');
const { browser } = await connectChrome();

for (const t of targets) {
  const { url, name } = SITES[t];
  const page = await browser.newPage();
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  console.log(`🌐 已打开 ${name}: ${url}`);
}

await browser.disconnect();

console.log(`
✅ 已在调试 Chrome 中打开 ${targets.length} 个登录页面

📋 接下来：
   1. 切到 Chrome 窗口（标题栏会显示「DevTools is debugging this browser」横幅）
   2. 在每个标签页完成登录（扫码 / 输入密码）
   3. 登录后 cookie 用副本路径派生的密钥加密 → 之后调用 toolkit API 永久保留登录态
   4. 完成后关闭这些标签页即可，调试 Chrome 进程保持运行

💡 提示：登录态保存在 ~/chrome-debug-profile/Default/Cookies，
       未来除非删除副本，否则不需要重复登录
`);
