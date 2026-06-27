/**
 * 浏览器连接工具
 */
import puppeteer from 'puppeteer-core';
import { ensureDebugChrome, DEFAULT_DEBUG_PORT } from './debug-chrome.mjs';

/**
 * 连接到调试 Chrome，如端口未开则自动启动
 *
 * @param {object} options
 * @param {number} options.port            调试端口
 * @param {object} options.viewport        视口尺寸
 * @param {boolean} options.autoStart      端口未开时是否自动启动 Chrome
 * @returns {Promise<{browser, info}>}
 */
export async function connectChrome({
  port = DEFAULT_DEBUG_PORT,
  viewport = { width: 1440, height: 900 },
  autoStart = true,
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
