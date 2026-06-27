/**
 * Grok Web 自动化客户端
 *
 * 通过 Puppeteer 操作 https://grok.com/ 实现对话能力。
 * 前置：调试 Chrome 已启动且 grok.com 已登录。
 */
import { connectChrome } from '../chrome/connect.mjs';
import { waitForDomStable, waitForSpa } from '../utils/wait.mjs';

const GROK_URL = 'https://grok.com';

/**
 * 向 Grok 发起单轮对话
 *
 * @param {string} message       用户消息
 * @param {object} options
 * @param {number} options.waitTimeoutMs    等待回复最大时长（默认 180s）
 * @param {number} options.stableMs          DOM 稳定阈值（默认 3000ms）
 * @param {boolean} options.screenshot      是否截图（保存到当前目录）
 * @param {boolean} options.newChat          是否强制新建会话（默认 true）
 * @returns {Promise<{reply: string, url: string}>}
 */
export async function askGrok(message, options = {}) {
  const {
    waitTimeoutMs = 180000,
    stableMs = 3000,
    screenshot = false,
    newChat = true,
  } = options;

  const { browser } = await connectChrome();
  const page = await browser.newPage();

  page.on('pageerror', err => console.error(`[PAGE ERROR] ${err.message}`));

  try {
    const targetUrl = newChat ? GROK_URL : (options.conversationUrl || GROK_URL);
    await page.goto(targetUrl, { waitUntil: 'networkidle2', timeout: 60000 });

    // SPA 等待
    await waitForSpa(page, { delayMs: 5000 });

    // 找可见输入框
    const inputFound = await page.evaluate(() => {
      const el = [...document.querySelectorAll('textarea, [contenteditable="true"]')]
        .find(e => e.offsetParent !== null);
      if (!el) return false;
      el.focus();
      return true;
    });

    if (!inputFound) {
      throw new Error('未找到对话输入框，可能未登录 Grok 或页面结构已变');
    }

    // 输入并发送
    await page.keyboard.type(message);
    if (screenshot) await page.screenshot({ path: 'grok-input.png' });

    await page.keyboard.press('Enter');

    // 等待回复（DOM 稳定）
    await waitForDomStable(page, {
      stableMs,
      timeoutMs: waitTimeoutMs,
    });

    if (screenshot) await page.screenshot({ path: 'grok-reply.png', fullPage: true });

    // 提取最新回复
    const reply = await page.evaluate(() => {
      // 优先策略：article 标签
      const articles = document.querySelectorAll('article');
      if (articles.length > 0) {
        return articles[articles.length - 1].textContent.trim();
      }
      // 兜底：role=assistant
      const msgs = document.querySelectorAll('[data-message-role="assistant"], [role="assistant"]');
      if (msgs.length > 0) {
        return msgs[msgs.length - 1].textContent.trim();
      }
      // 最终兜底
      return document.body.innerText.slice(-2000);
    });

    return { reply, url: page.url() };
  } finally {
    await page.close();
    await browser.disconnect();
  }
}

/**
 * 多轮对话：在同一会话上下文中连续提问
 *
 * @param {object} options
 * @param {string} options.conversationUrl  恢复已存在的会话（如 https://grok.com/chat/<id>）
 *
 * 用法：
 *   // 新建
 *   const chat = await createGrokChat();
 *   await chat.send('我叫小明');
 *   const url = chat.getUrl();           // 保存这个 URL
 *   await chat.close();
 *
 *   // 恢复
 *   const chat2 = await createGrokChat({ conversationUrl: url });
 *   await chat2.send('我刚才说我叫什么？');
 *   await chat2.close();
 */
export async function createGrokChat(options = {}) {
  const { conversationUrl } = options;
  const { browser } = await connectChrome();
  const page = await browser.newPage();

  const target = conversationUrl || GROK_URL;
  await page.goto(target, { waitUntil: 'networkidle2', timeout: 60000 });
  await waitForSpa(page, { delayMs: 5000 });

  return {
    page,
    getUrl() {
      return page.url();
    },
    async send(message, sendOptions = {}) {
      const {
        waitTimeoutMs = 180000,
        stableMs = 3000,
      } = sendOptions;

      const ok = await page.evaluate(() => {
        const el = [...document.querySelectorAll('textarea, [contenteditable="true"]')]
          .find(e => e.offsetParent !== null);
        if (!el) return false;
        el.focus();
        return true;
      });
      if (!ok) throw new Error('找不到输入框');

      await page.keyboard.type(message);
      await page.keyboard.press('Enter');

      await waitForDomStable(page, { stableMs, timeoutMs: waitTimeoutMs });

      return page.evaluate(() => {
        const articles = document.querySelectorAll('article');
        return articles[articles.length - 1]?.textContent?.trim() ?? '';
      });
    },
    async close() {
      await page.close();
      await browser.disconnect();
    },
  };
}
