#!/usr/bin/env node
/**
 * 示例：检测 Chrome 出口 IP（验证代理/虚拟网卡是否生效）
 */
import { withPage } from '../../src/chrome/connect.mjs';

const checkSites = [
  'https://api.ip.sb/geoip',
  'https://ifconfig.co/json',
];

for (const url of checkSites) {
  try {
    const data = await withPage(url, async page => {
      return await page.evaluate(() => {
        try { return JSON.parse(document.body.innerText); }
        catch { return { raw: document.body.innerText.slice(0, 300) }; }
      });
    });
    console.log(`📍 ${url}:`);
    console.log(JSON.stringify(data, null, 2));
    break;
  } catch (e) {
    console.log(`❌ ${url}: ${e.message}`);
  }
}
