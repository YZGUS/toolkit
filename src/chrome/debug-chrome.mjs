/**
 * Chrome 调试端口管理工具
 *
 * Chrome 安全策略：拒绝在默认 profile 目录上启用 --remote-debugging-port。
 * 本模块通过 rsync 复制真实 profile 到非默认目录的方式绕过限制，保留登录态。
 */
import http from 'node:http';
import { spawn, execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export const DEFAULT_CHROME_PATH = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
export const DEFAULT_REAL_PROFILE = path.join(os.homedir(), 'Library/Application Support/Google/Chrome');
export const DEFAULT_DEBUG_PROFILE = path.join(os.homedir(), 'chrome-debug-profile');
export const DEFAULT_DEBUG_PORT = 9222;

/**
 * 检查调试端口是否可用
 */
export async function isDebugPortOpen(port = DEFAULT_DEBUG_PORT) {
  return new Promise(resolve => {
    const req = http.get(`http://localhost:${port}/json/version`, res => {
      let data = '';
      res.on('data', d => (data += d));
      res.on('end', () => resolve(res.statusCode === 200));
    });
    req.on('error', () => resolve(false));
    req.setTimeout(2000, () => {
      req.destroy();
      resolve(false);
    });
  });
}

/**
 * 获取调试端口的 Chrome 信息
 */
export async function getBrowserInfo(port = DEFAULT_DEBUG_PORT) {
  return new Promise((resolve, reject) => {
    http
      .get(`http://localhost:${port}/json/version`, res => {
        let data = '';
        res.on('data', d => (data += d));
        res.on('end', () => {
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            reject(e);
          }
        });
      })
      .on('error', reject);
  });
}

/**
 * 仅杀掉使用指定 user-data-dir 的 Chrome 进程（默认副本目录）
 * 真实 Chrome 不会被影响
 */
export function killDebugChrome(debugProfile = DEFAULT_DEBUG_PROFILE) {
  try {
    execSync(`pkill -9 -f "user-data-dir=${debugProfile}"`, { stdio: 'ignore' });
  } catch {
    /* 没匹配进程也正常 */
  }
}

/**
 * 复制真实 profile 到调试副本目录
 */
export function copyProfile({
  realProfile = DEFAULT_REAL_PROFILE,
  debugProfile = DEFAULT_DEBUG_PROFILE,
  overwrite = false,
} = {}) {
  if (!overwrite && fs.existsSync(debugProfile)) {
    return { copied: false, path: debugProfile };
  }
  execSync(
    `rsync -a --exclude='Singleton*' "${realProfile}/" "${debugProfile}/"`,
    { stdio: 'inherit' }
  );
  return { copied: true, path: debugProfile };
}

/**
 * 清理副本目录的锁文件
 */
export function cleanLockFiles(debugProfile = DEFAULT_DEBUG_PROFILE) {
  try {
    execSync(`rm -f "${debugProfile}/Singleton"*`, { stdio: 'ignore' });
  } catch {}
}

/**
 * 启动带调试端口的 Chrome（使用副本 profile）
 *
 * 重要细节：
 * 1. Chrome 127+ App-Bound Encryption：Cookies 用绑定 profile 绝对路径的密钥加密。
 *    复制到副本后真实 profile 的 v20 cookie 解不开，因此登录必须在副本里完成一次
 *    （见 docs/chrome.md）。--disable-features=LockProfileCookieDatabase 让旧 v10
 *    cookie 仍可读，是尽力而为的兼容。
 * 2. 反自动化指纹：navigator.webdriver 等特征用 --disable-blink-features=
 *    AutomationControlled 关闭。注意「受自动测试软件控制」横幅由 --enable-automation
 *    触发，本模块用 spawn 直接启动 Chrome、从不加该开关，所以不会出现该横幅。
 */
export async function launchDebugChrome({
  chromePath = DEFAULT_CHROME_PATH,
  debugProfile = DEFAULT_DEBUG_PROFILE,
  port = DEFAULT_DEBUG_PORT,
  extraArgs = [],
  waitMs = 20000,
  disableAbe = true,
  hideAutomation = true,
} = {}) {
  cleanLockFiles(debugProfile);

  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${debugProfile}`,
    '--no-first-run',
    '--no-default-browser-check',
  ];

  if (hideAutomation) {
    args.push('--disable-blink-features=AutomationControlled');
  }

  if (disableAbe) {
    args.push('--disable-features=LockProfileCookieDatabase');
  }

  args.push(...extraArgs);

  spawn(chromePath, args, { detached: true, stdio: 'ignore' }).unref();

  const start = Date.now();
  while (Date.now() - start < waitMs) {
    await new Promise(r => setTimeout(r, 500));
    if (await isDebugPortOpen(port)) {
      return await getBrowserInfo(port);
    }
  }
  throw new Error(`Chrome 启动超时（${waitMs}ms）`);
}

/**
 * 一键确保调试 Chrome 可用：检测 → 选择性 kill 残留副本进程 → 首次复制 → 启动
 *
 * 重要：副本一旦在调试 Chrome 里登录过，登录态就持久保存在副本里
 * （见 docs/chrome.md）。因此这里**不再**从真实 profile 同步 cookie——
 * 同步只会用解不开的 v20 cookie 覆盖副本、把登录态冲掉。只有副本不存在时
 * 才首次复制一份做引导。
 *
 * @param {object} options
 * @param {string}  options.realProfile      真实 profile 路径
 * @param {string}  options.debugProfile     调试副本路径
 * @param {number}  options.port             调试端口
 */
export async function ensureDebugChrome(options = {}) {
  const port = options.port ?? DEFAULT_DEBUG_PORT;
  const realProfile = options.realProfile ?? DEFAULT_REAL_PROFILE;
  const debugProfile = options.debugProfile ?? DEFAULT_DEBUG_PROFILE;

  if (await isDebugPortOpen(port)) {
    return { reused: true, info: await getBrowserInfo(port) };
  }

  // 只杀使用该副本目录的残留进程，不影响用户真实 Chrome
  killDebugChrome(debugProfile);
  await new Promise(r => setTimeout(r, 1000));

  // 副本不存在才首次复制；已存在则原样复用，保住已登录的副本 cookie
  copyProfile({ realProfile, debugProfile });

  const info = await launchDebugChrome({ ...options, debugProfile, port });
  return { reused: false, info };
}
