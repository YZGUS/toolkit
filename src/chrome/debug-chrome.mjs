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
 * @deprecated 旧 API，会无差别杀掉所有 Chrome（含真实 Chrome），新代码请用 killDebugChrome
 */
export function killAllChrome() {
  try {
    execSync('pkill -9 -f "Google Chrome"', { stdio: 'ignore' });
  } catch {
    /* 没进程也算正常 */
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
 */
export async function launchDebugChrome({
  chromePath = DEFAULT_CHROME_PATH,
  debugProfile = DEFAULT_DEBUG_PROFILE,
  port = DEFAULT_DEBUG_PORT,
  extraArgs = [],
  waitMs = 20000,
} = {}) {
  cleanLockFiles(debugProfile);

  spawn(
    chromePath,
    [
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${debugProfile}`,
      '--no-first-run',
      '--no-default-browser-check',
      ...extraArgs,
    ],
    { detached: true, stdio: 'ignore' }
  ).unref();

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
 * 一键确保调试 Chrome 可用：检测 → 选择性 kill 残留副本进程 → 复制/同步 → 启动
 *
 * @param {object} options
 * @param {string}  options.realProfile      真实 profile 路径
 * @param {string}  options.debugProfile     调试副本路径
 * @param {number}  options.port             调试端口
 * @param {'auto'|boolean} options.refreshCookies  复用已存在副本时是否刷新 cookie（默认 'auto'：副本存在就刷新）
 */
export async function ensureDebugChrome(options = {}) {
  const port = options.port ?? DEFAULT_DEBUG_PORT;
  const realProfile = options.realProfile ?? DEFAULT_REAL_PROFILE;
  const debugProfile = options.debugProfile ?? DEFAULT_DEBUG_PROFILE;
  const refreshCookies = options.refreshCookies ?? 'auto';

  if (await isDebugPortOpen(port)) {
    return { reused: true, info: await getBrowserInfo(port) };
  }

  // 只杀使用该副本目录的残留进程，不影响用户真实 Chrome
  killDebugChrome(debugProfile);
  await new Promise(r => setTimeout(r, 1000));

  const profileExisted = fs.existsSync(debugProfile);
  copyProfile({ realProfile, debugProfile });

  // 副本已存在时按需同步 Cookie（拿到真实 Chrome 最新登录态）
  if (profileExisted && refreshCookies !== false) {
    try {
      const result = syncCookies({ realProfile, debugProfile });
      if (result.synced.length > 0) {
        console.log(`[toolkit] Cookie 同步: ${result.synced.join(', ')}`);
      }
    } catch (err) {
      console.warn(`[toolkit] Cookie 同步失败（继续启动）: ${err.message}`);
    }
  }

  const info = await launchDebugChrome({ ...options, debugProfile, port });
  return { reused: false, info };
}

/**
 * 同步真实 profile 的 Cookie 到副本（差量 + SQLite 在线备份）
 *
 * 真实 Chrome 可以仍在运行：
 * - SQLite 文件用 `sqlite3 .backup` 拿事务一致快照
 * - 其他文件用 rsync 复制，接受最终一致
 *
 * @param {object} options
 * @param {boolean} options.includeLoginData  是否同步保存的密码（默认 false，加密 key 跨副本可能失效）
 * @returns {{synced: string[], skipped: string[]}}
 */
export function syncCookies({
  realProfile = DEFAULT_REAL_PROFILE,
  debugProfile = DEFAULT_DEBUG_PROFILE,
  includeLoginData = false,
} = {}) {
  const synced = [];
  const skipped = [];

  const realDefault = path.join(realProfile, 'Default');
  const debugDefault = path.join(debugProfile, 'Default');

  if (!fs.existsSync(realDefault)) {
    return { synced, skipped: ['real profile Default 不存在'] };
  }
  if (!fs.existsSync(debugDefault)) {
    fs.mkdirSync(debugDefault, { recursive: true });
  }

  // SQLite 文件：用 .backup 在线备份
  const sqliteFiles = ['Cookies'];
  if (includeLoginData) sqliteFiles.push('Login Data');

  for (const name of sqliteFiles) {
    const src = path.join(realDefault, name);
    const dest = path.join(debugDefault, name);
    if (!fs.existsSync(src)) {
      skipped.push(name);
      continue;
    }
    try {
      execSync(`sqlite3 "${src}" ".backup '${dest}'"`, { stdio: 'ignore' });
      synced.push(name);
    } catch (err) {
      // 兜底：sqlite3 不可用或 src 被独占 → 直接 rsync
      try {
        execSync(`rsync -a "${src}" "${dest}"`, { stdio: 'ignore' });
        synced.push(`${name} (rsync fallback)`);
      } catch {
        skipped.push(`${name}: ${err.message}`);
      }
    }
  }

  // 普通文件/目录：直接 rsync
  const plainPaths = [
    'Local Storage/',
    'IndexedDB/',
  ];
  for (const rel of plainPaths) {
    const src = path.join(realDefault, rel);
    if (!fs.existsSync(src)) {
      skipped.push(rel);
      continue;
    }
    try {
      execSync(`rsync -a "${src}" "${path.join(debugDefault, rel)}"`, { stdio: 'ignore' });
      synced.push(rel);
    } catch (err) {
      skipped.push(`${rel}: ${err.message}`);
    }
  }

  // Local State 在 profile 根目录，含 Cookie 加密 key
  const localStateSrc = path.join(realProfile, 'Local State');
  const localStateDest = path.join(debugProfile, 'Local State');
  if (fs.existsSync(localStateSrc)) {
    try {
      execSync(`rsync -a "${localStateSrc}" "${localStateDest}"`, { stdio: 'ignore' });
      synced.push('Local State');
    } catch (err) {
      skipped.push(`Local State: ${err.message}`);
    }
  }

  return { synced, skipped };
}
