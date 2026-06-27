#!/usr/bin/env node
/**
 * 一键检测调试 Chrome 中各站点的登录状态
 *
 * 用法：
 *   node bin/check-logins.mjs                       # 检测全部已配置站点
 *   node bin/check-logins.mjs grok qianwen          # 仅指定
 *   node bin/check-logins.mjs --json                # 输出 JSON
 *   node bin/check-logins.mjs --require=grok,qianwen # 必须登录的站点，否则退出码非 0
 *
 * 退出码：
 *   0 = 所有检测的站点都已登录
 *   1 = 至少一个站点未登录
 */
import { SITE_PROBES, checkAllLogins, formatReport } from '../src/utils/login-check.mjs';

const argv = process.argv.slice(2);
const flags = new Set(argv.filter(a => a.startsWith('--') && !a.includes('=')));
const kv = Object.fromEntries(
  argv
    .filter(a => a.startsWith('--') && a.includes('='))
    .map(a => a.slice(2).split('=')),
);
const positional = argv.filter(a => !a.startsWith('--'));

const sites = positional.length > 0 ? positional : Object.keys(SITE_PROBES);
const required = kv.require ? kv.require.split(',') : sites;

for (const s of sites) {
  if (!SITE_PROBES[s]) {
    console.error(`❌ 未知站点: ${s}（支持: ${Object.keys(SITE_PROBES).join(', ')}）`);
    process.exit(2);
  }
}

console.log(`⏳ 检测 ${sites.length} 个站点的登录态：${sites.join(' / ')}`);
const t0 = Date.now();
const results = await checkAllLogins(sites);
const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

if (flags.has('--json')) {
  console.log(JSON.stringify({ elapsed: Number(elapsed), results }, null, 2));
} else {
  console.log();
  console.log(formatReport(results));
  console.log();
  console.log(`耗时: ${elapsed}s`);

  // 详细信息
  for (const r of results) {
    if (r.error) {
      console.log(`\n[${r.site}] ⚠️ ${r.error}`);
    }
    if (r.cookieDiag?.available && r.cookieDiag.found.length > 0) {
      const summary = r.cookieDiag.found
        .map(c => `${c.name}(${c.encLen}B, exp ${c.expires})`)
        .join(', ');
      console.log(`[${r.site}] 已落盘 session cookie: ${summary}`);
    }
    if (r.cookieDiag?.missingNames?.length > 0) {
      console.log(`[${r.site}] 副本缺少 cookie: ${r.cookieDiag.missingNames.join(', ')}`);
    }
  }

  // 总结 + 修复提示
  const ok = results.filter(r => r.loggedIn === true).map(r => r.site);
  const bad = results.filter(r => r.loggedIn !== true).map(r => r.site);
  console.log(`\n✅ 已登录 (${ok.length}): ${ok.join(', ') || '无'}`);
  console.log(`❌ 未登录 (${bad.length}): ${bad.join(', ') || '无'}`);

  if (bad.length > 0) {
    console.log(`\n💡 修复：在调试 Chrome 里手动登录这些站点：`);
    console.log(`   node bin/login-helper.mjs ${bad.join(' ')}`);
  }
}

// 判定 require 列表里的站点是否全部已登录
const requiredResults = results.filter(r => required.includes(r.site));
const allRequiredOk = requiredResults.every(r => r.loggedIn === true);
process.exit(allRequiredOk ? 0 : 1);
