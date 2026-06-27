/**
 * 登录态检测工具
 *
 * 判断「调试 Chrome 中某个站点是否真的登录」的可靠方法：
 *   1) HTTP 探针：调站点的鉴权 API，看 401/200
 *      └ 决定性证据：服务端的回答最权威
 *   2) DOM 信号：看页面是否有「登录」按钮 / 用户头像
 *      └ 辅助证据：API 探针失败时的兜底
 *   3) Cookie 落盘检查：用 sqlite3 看副本里关键 session cookie 是否存在
 *      └ 用于区分「从未登录」与「登录过但 cookie 不工作」两种情况
 *
 * 设计原则：以 HTTP 探针为准，DOM/Cookie 仅作诊断补充信息。
 */
import { connectChrome } from '../chrome/connect.mjs';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const DEFAULT_DEBUG_PROFILE = path.join(os.homedir(), 'chrome-debug-profile');
const SQLITE = '/usr/bin/sqlite3';

/**
 * 站点登录探针配置
 *
 * - homepage:   先 goto 到这个 URL（保证同源 fetch 可工作）
 * - probeUrl:   登录态检测端点（200=登录 / 401|403=未登录）
 * - loginText:  "登录"按钮文本（用于 DOM 信号兜底）
 * - sessionCookies: 关键 session cookie 名（用于 SQLite 诊断）
 */
export const SITE_PROBES = Object.freeze({
  grok: {
    homepage: 'https://grok.com/',
    probeUrl: 'https://grok.com/rest/suggestions/profile',
    cookieHost: '.grok.com',
    loginText: /^(登录|sign\s*in|log\s*in)$/i,
    sessionCookies: ['sso', 'sso-rw'],
  },
  qianwen: {
    homepage: 'https://www.qianwen.com/chat',
    probeUrl: 'https://www.qianwen.com/api/v1/account/profile/info',
    cookieHost: '.qianwen.com',
    loginText: /^(登录|sign\s*in)$/i,
    sessionCookies: ['login_aliyunid_ticket', 'tongyi_sso_ticket', 'tongyi_guest_ticket'],
  },
  github: {
    homepage: 'https://github.com/',
    probeUrl: 'https://github.com/notifications',
    cookieHost: '.github.com',
    loginText: /^(sign\s*in|登录)$/i,
    sessionCookies: ['user_session', 'dotcom_user'],
    metaName: 'user-login',
  },
  chatgpt: {
    homepage: 'https://chatgpt.com/',
    probeUrl: 'https://chatgpt.com/api/auth/session',
    cookieHost: '.chatgpt.com',
    loginText: /^(log\s*in|登录)$/i,
    sessionCookies: ['__Secure-next-auth.session-token'],
  },
});

/**
 * 通过 sqlite3 读副本 Cookies 文件，看指定 cookie 是否存在
 *
 * 注意：这只能说明 cookie 落在了磁盘上，不代表运行时 Chrome 会发它。
 *      Chrome 可能因加密失败 / SameSite / Secure 校验而拒绝读取。
 */
export function checkCookiesOnDisk(host, names, debugProfile = DEFAULT_DEBUG_PROFILE) {
  const cookiesFile = path.join(debugProfile, 'Default', 'Cookies');
  if (!fs.existsSync(cookiesFile)) {
    return { available: false, reason: 'Cookies 文件不存在' };
  }
  if (!fs.existsSync(SQLITE)) {
    return { available: false, reason: 'sqlite3 不可用' };
  }

  const namesSql = names.map(n => `'${n.replace(/'/g, "''")}'`).join(',');
  // 注意 cookie 副本可能被 Chrome 锁定（独占），需用 readonly 打开
  const cmd = `${SQLITE} "file:${cookiesFile}?mode=ro&immutable=1" -separator '|' "select name, length(encrypted_value), datetime(expires_utc/1000000 - 11644473600, 'unixepoch') from cookies where host_key='${host}' and name in (${namesSql})"`;

  try {
    const out = execSync(cmd, { stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8' });
    const rows = out.trim().split('\n').filter(Boolean).map(line => {
      const [name, encLen, expires] = line.split('|');
      return { name, encLen: Number(encLen), expires };
    });
    const found = rows.map(r => r.name);
    const missing = names.filter(n => !found.includes(n));
    return { available: true, found: rows, missingNames: missing };
  } catch (err) {
    return { available: false, reason: `sqlite 查询失败: ${err.message}` };
  }
}

/**
 * 用浏览器内 fetch 探测 API 端点的 HTTP 状态码
 */
async function probeHttp(page, probeUrl) {
  return page.evaluate(async url => {
    try {
      const res = await fetch(url, { credentials: 'include', method: 'GET', redirect: 'manual' });
      return { ok: true, status: res.status, type: res.type };
    } catch (e) {
      return { ok: false, error: String(e?.message || e) };
    }
  }, probeUrl);
}

/**
 * 检测 DOM 中是否有"登录"按钮可见 / 是否有用户元素
 */
async function probeDom(page, loginPattern) {
  return page.evaluate(patternSrc => {
    const re = new RegExp(patternSrc.source, patternSrc.flags);
    const candidates = [...document.querySelectorAll('button, a')]
      .filter(e => e.offsetParent !== null);
    const loginBtn = candidates.find(e => re.test((e.textContent || '').trim()));
    const userHints = [...document.querySelectorAll('[class*="avatar"], img[alt*="avatar"], [aria-label*="account"], [aria-label*="profile"], [aria-label*="用户"]')]
      .filter(e => e.offsetParent !== null);
    return {
      loginBtnVisible: !!loginBtn,
      loginBtnText: loginBtn?.textContent?.trim()?.slice(0, 30),
      userHintCount: userHints.length,
    };
  }, { source: loginPattern.source, flags: loginPattern.flags });
}

/**
 * 检测单个站点的登录状态
 *
 * @param {string} siteKey  SITE_PROBES 中的 key（grok / qianwen / github / chatgpt）
 * @param {object} options
 * @param {boolean} options.includeCookieDiag  是否做 SQLite cookie 落盘诊断
 * @returns {Promise<LoginCheckResult>}
 */
export async function checkLogin(siteKey, options = {}) {
  const probe = SITE_PROBES[siteKey];
  if (!probe) {
    throw new Error(`未知站点：${siteKey}（支持：${Object.keys(SITE_PROBES).join(', ')}）`);
  }

  const { includeCookieDiag = true } = options;

  const { browser } = await connectChrome();
  const page = await browser.newPage();

  const result = {
    site: siteKey,
    loggedIn: null,
    confidence: 'unknown',
    httpStatus: null,
    domSignal: null,
    cookieDiag: null,
    url: probe.homepage,
    error: null,
  };

  try {
    await page.goto(probe.homepage, { waitUntil: 'domcontentloaded', timeout: 60000 });
    // 给 SPA 一点渲染时间
    await new Promise(r => setTimeout(r, 3000));

    // 1) HTTP 探针（决定性）
    const httpRes = await probeHttp(page, probe.probeUrl);
    if (httpRes.ok) {
      result.httpStatus = httpRes.status;
      if (httpRes.status === 200) {
        result.loggedIn = true;
        result.confidence = 'high';
      } else if (httpRes.status === 401 || httpRes.status === 403) {
        result.loggedIn = false;
        result.confidence = 'high';
      } else if (httpRes.status >= 300 && httpRes.status < 400) {
        // 重定向 → 通常重定向到登录页 → 未登录
        result.loggedIn = false;
        result.confidence = 'medium';
      } else {
        result.confidence = 'low';
      }
    } else {
      result.error = `fetch 失败: ${httpRes.error}`;
    }

    // 2) DOM 信号（辅助）
    result.domSignal = await probeDom(page, probe.loginText);
    // 如果 HTTP 探针没结论，用 DOM 兜底
    if (result.loggedIn === null && result.domSignal) {
      result.loggedIn = !result.domSignal.loginBtnVisible;
      result.confidence = 'low';
    }

    // 3) GitHub 特殊：直接看 meta[user-login]
    if (siteKey === 'github') {
      const userLogin = await page.evaluate(() => {
        return document.querySelector('meta[name="user-login"]')?.content || null;
      });
      if (userLogin) {
        result.loggedIn = true;
        result.confidence = 'high';
        result.user = userLogin;
      }
    }

    // 4) Cookie 落盘诊断
    if (includeCookieDiag) {
      result.cookieDiag = checkCookiesOnDisk(probe.cookieHost, probe.sessionCookies);
    }
  } catch (err) {
    result.error = err.message;
  } finally {
    await page.close();
    await browser.disconnect();
  }

  return result;
}

/**
 * 批量检测所有已配置站点的登录状态
 *
 * @param {string[]} sites  指定要检测的站点（默认全部）
 */
export async function checkAllLogins(sites = Object.keys(SITE_PROBES), options = {}) {
  const results = [];
  for (const s of sites) {
    try {
      results.push(await checkLogin(s, options));
    } catch (err) {
      results.push({ site: s, loggedIn: false, confidence: 'error', error: err.message });
    }
  }
  return results;
}

/**
 * 把检测结果格式化为可读的报告字符串
 */
export function formatReport(results) {
  const lines = [];
  lines.push('站点      | 登录 | 置信度 | HTTP | DOM 登录按钮 | Cookie 落盘 | 备注');
  lines.push('----------|------|--------|------|--------------|-------------|------');
  for (const r of results) {
    const cookieSummary = r.cookieDiag?.available
      ? (r.cookieDiag.found.length > 0
          ? `${r.cookieDiag.found.length}/${r.cookieDiag.found.length + (r.cookieDiag.missingNames?.length || 0)}`
          : '0')
      : '-';
    const userInfo = r.user ? `user=${r.user}` : '';
    const errInfo = r.error ? `ERR: ${r.error.slice(0, 50)}` : '';
    const cells = [
      r.site.padEnd(9),
      (r.loggedIn === true ? '✅' : r.loggedIn === false ? '❌' : '❓').padEnd(4),
      String(r.confidence ?? '-').padEnd(6),
      String(r.httpStatus ?? '-').padStart(4),
      String(r.domSignal?.loginBtnVisible ?? '-').padEnd(12),
      String(cookieSummary).padEnd(11),
      [userInfo, errInfo].filter(Boolean).join(' '),
    ];
    lines.push(cells.join(' | '));
  }
  return lines.join('\n');
}

/**
 * 判定调试 Chrome 是否"已登录正常工作"
 *
 * @param {string[]} requiredSites  必须登录的站点列表
 * @returns {Promise<{allOk: boolean, results, missing: string[]}>}
 */
export async function assertAllLoggedIn(requiredSites = ['grok', 'qianwen']) {
  const results = await checkAllLogins(requiredSites);
  const missing = results.filter(r => r.loggedIn !== true).map(r => r.site);
  return { allOk: missing.length === 0, results, missing };
}
