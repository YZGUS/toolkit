#!/usr/bin/env node
/**
 * 示例：多站点登录态验证
 */
import { connectChrome } from '../src/chrome/connect.mjs';

const { browser } = await connectChrome();
const page = await browser.newPage();

console.log('🌐 GitHub...');
await page.goto('https://github.com', { waitUntil: 'networkidle2' });
const gh = await page.evaluate(() => ({
  user: document.querySelector('meta[name="user-login"]')?.content,
}));
console.log('  ', gh.user ? `✅ 已登录: ${gh.user}` : '❌ 未登录');

console.log('🌐 Grok...');
await page.goto('https://grok.com', { waitUntil: 'networkidle2' });
await new Promise(r => setTimeout(r, 5000));
const grok = await page.evaluate(() => ({
  hasInput: !!document.querySelector('textarea'),
  text: document.body.innerText.match(/[\w.+-]+@[\w-]+\.[\w.-]+/)?.[0],
}));
console.log('  ', grok.hasInput ? `✅ 已登录: ${grok.text ?? '(无邮箱)'}` : '❌ 未登录');

await page.close();
await browser.disconnect();
