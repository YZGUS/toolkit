/**
 * 通用工具：等待 DOM 稳定（判断流式输出/异步加载完成）
 */

/**
 * 等待页面 innerText 长度连续 N 秒不变化
 *
 * @param {import('puppeteer-core').Page} page
 * @param {object} options
 * @param {number} options.stableMs   稳定多少毫秒视为完成（默认 3000）
 * @param {number} options.timeoutMs  总超时（默认 60000）
 * @param {number} options.pollMs     轮询间隔（默认 1000）
 * @param {number} options.minLength  最小内容长度（小于则继续等）
 * @returns {Promise<{stable: boolean, length: number}>}
 */
export async function waitForDomStable(page, options = {}) {
  const {
    stableMs = 3000,
    timeoutMs = 60000,
    pollMs = 1000,
    minLength = 0,
  } = options;

  let lastLen = -1;
  let stableStart = null;
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    const len = await page.evaluate(() => document.body.innerText.length);

    if (len === lastLen && len >= minLength) {
      if (stableStart === null) stableStart = Date.now();
      if (Date.now() - stableStart >= stableMs) {
        return { stable: true, length: len };
      }
    } else {
      stableStart = null;
      lastLen = len;
    }
    await new Promise(r => setTimeout(r, pollMs));
  }
  return { stable: false, length: lastLen };
}

/**
 * 等待 SPA JS 渲染（fixed delay 或自定义判断）
 */
export async function waitForSpa(page, options = {}) {
  const { delayMs = 5000, predicate = null } = options;

  if (predicate) {
    await page.waitForFunction(predicate, { timeout: 30000 });
  } else {
    await new Promise(r => setTimeout(r, delayMs));
  }
}
