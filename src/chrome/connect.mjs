/**
 * 浏览器连接工具
 */
import puppeteer from 'puppeteer-core';
import { ensureDebugChrome, DEFAULT_DEBUG_PORT } from './debug-chrome.mjs';

/**
 * 反自动化指纹的运行时补丁
 * 在每个 page 创建时通过 evaluateOnNewDocument 注入，覆盖 navigator.webdriver 等检测点。
 * 必须在 page.goto() 之前注入。
 */
const STEALTH_INIT_SCRIPT = `
(() => {
  // 1. navigator.webdriver = undefined
  Object.defineProperty(Navigator.prototype, 'webdriver', {
    get: () => undefined,
    configurable: true,
  });

  // 2. window.chrome 存在（headless 模式下默认没有）
  if (!window.chrome) {
    window.chrome = { runtime: {} };
  }

  // 3. 修复 navigator.plugins / languages 长度
  const origPlugins = Object.getOwnPropertyDescriptor(Navigator.prototype, 'plugins');
  if (origPlugins && origPlugins.get && navigator.plugins.length === 0) {
    Object.defineProperty(Navigator.prototype, 'plugins', {
      get: () => [1, 2, 3, 4, 5],
      configurable: true,
    });
  }

  // 4. permissions.query 修复（自动化下 notifications 永远 prompt）
  if (navigator.permissions?.query) {
    const origQuery = navigator.permissions.query.bind(navigator.permissions);
    navigator.permissions.query = (params) => {
      if (params && params.name === 'notifications') {
        return Promise.resolve({ state: Notification.permission, onchange: null });
      }
      return origQuery(params);
    };
  }
})();
`;

/**
 * 给单个 page 应用 stealth 补丁
 */
export async function applyStealth(page) {
  try {
    await page.evaluateOnNewDocument(STEALTH_INIT_SCRIPT);
  } catch (err) {
    // 某些已 attach 的 target 不支持 evaluateOnNewDocument，忽略
  }
}

/**
 * 连接到调试 Chrome，如端口未开则自动启动
 *
 * @param {object} options
 * @param {number} options.port            调试端口
 * @param {object} options.viewport        视口尺寸
 * @param {boolean} options.autoStart      端口未开时是否自动启动 Chrome
 * @param {boolean} options.stealth        是否给新 page 自动注入 stealth 补丁（默认 true）
 * @returns {Promise<{browser, info, newPage}>}
 *   newPage(): 自动 stealth 化的 page 工厂
 */
export async function connectChrome({
  port = DEFAULT_DEBUG_PORT,
  viewport = { width: 1440, height: 900 },
  autoStart = true,
  stealth = true,
} = {}) {
  let info;
  if (autoStart) {
    const result = await ensureDebugChrome({ port });
    info = result.info;
  }

  const browser = await puppeteer.connect({
    browserURL: `http://localhost:${port}`,
    defaultViewport: viewport,
  });

  // 包装 newPage 自动应用 stealth
  const origNewPage = browser.newPage.bind(browser);
  if (stealth) {
    browser.newPage = async () => {
      const page = await origNewPage();
      await applyStealth(page);
      return page;
    };
  }

  return { browser, info };
}

/**
 * 便捷的"打开页面 + 自动断开"包装器
 *
 * @param {string} url
 * @param {(page: import('puppeteer-core').Page) => Promise<T>} fn
 * @returns {Promise<T>}
 */
export async function withPage(url, fn, options = {}) {
  const { browser } = await connectChrome(options);
  const page = await browser.newPage();
  try {
    if (options.gotoOptions !== null) {
      await page.goto(url, {
        waitUntil: 'networkidle2',
        timeout: 60000,
        ...options.gotoOptions,
      });
    }
    return await fn(page);
  } finally {
    if (options.keepPage !== true) await page.close();
    await browser.disconnect();
  }
}
