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
 * 杀掉所有 Chrome 进程
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
 * 一键确保调试 Chrome 可用：检测→关闭→复制→启动
 */
export async function ensureDebugChrome(options = {}) {
  const port = options.port ?? DEFAULT_DEBUG_PORT;

  if (await isDebugPortOpen(port)) {
    return { reused: true, info: await getBrowserInfo(port) };
  }

  killAllChrome();
  await new Promise(r => setTimeout(r, 3000));

  copyProfile({
    realProfile: options.realProfile ?? DEFAULT_REAL_PROFILE,
    debugProfile: options.debugProfile ?? DEFAULT_DEBUG_PROFILE,
  });

  const info = await launchDebugChrome(options);
  return { reused: false, info };
}

/**
 * 同步真实 profile 的 Cookie 到副本（差量）
 */
export function syncCookies({
  realProfile = DEFAULT_REAL_PROFILE,
  debugProfile = DEFAULT_DEBUG_PROFILE,
} = {}) {
  const sources = [
    `${realProfile}/Default/Cookies`,
    `${realProfile}/Default/Login Data`,
    `${realProfile}/Default/Local Storage/`,
  ];
  const dest = `${debugProfile}/Default/`;
  for (const src of sources) {
    if (fs.existsSync(src)) {
      try {
        execSync(`rsync -a "${src}" "${dest}"`, { stdio: 'ignore' });
      } catch {}
    }
  }
}
