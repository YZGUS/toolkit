/**
 * Grok Web 自动化客户端
 *
 * 通过 Puppeteer 操作 https://grok.com/ 实现对话能力。
 * 前置：调试 Chrome 已启动且 grok.com 已登录。
 */
import { connectChrome } from '../chrome/connect.mjs';
import { waitForSpa } from '../utils/wait.mjs';

const GROK_URL = 'https://grok.com';

/**
 * 在浏览器上下文里读取助手回复状态
 *
 * Grok 当前 DOM：
 * - 用户气泡 [data-testid="user-message"]，助手气泡 [data-testid="assistant-message"]
 * - 正文在助手气泡内的 .response-content-markdown（用户气泡也用同名 class，所以必须先定位助手气泡）
 * - 思考中会出现 [data-testid="thinking-indicator"]
 */
function readAssistantState() {
  const thinking = !!document.querySelector('[data-testid="thinking-indicator"]');
  const nodes = [...document.querySelectorAll('[data-testid="assistant-message"]')];
  const node = nodes[nodes.length - 1];
  let text = '';
  if (node) {
    const md = node.querySelector('.response-content-markdown');
    text = ((md || node).textContent || '').trim();
  }
  return { thinking, text, count: nodes.length };
}

/** 当前助手气泡数量（发送前作为基线，避免多轮时读到上一轮回复） */
function countAssistantMessages(page) {
  return page.evaluate(() => document.querySelectorAll('[data-testid="assistant-message"]').length);
}

/**
 * 等待 Grok 助手回复完成：出现新助手气泡 + 思考指示器消失 + 正文非空且连续稳定
 *
 * @param {number} baselineCount  发送前的助手气泡数，必须等到数量增加才算新回复
 * @returns {Promise<string>} 助手回复纯文本
 */
async function waitForGrokReply(page, { timeoutMs = 180000, stableMs = 3000, pollMs = 1000, baselineCount = 0 } = {}) {
  const start = Date.now();
  let lastText = null;
  let stableStart = null;

  while (Date.now() - start < timeoutMs) {
    const { thinking, text, count } = await page.evaluate(readAssistantState);
    const settled = count > baselineCount && !thinking && text.length > 0;

    if (settled && text === lastText) {
      if (stableStart === null) stableStart = Date.now();
      if (Date.now() - stableStart >= stableMs) return text;
    } else {
      stableStart = null;
      lastText = settled ? text : null;
    }
    await new Promise(r => setTimeout(r, pollMs));
  }
  return lastText ?? '';
}

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

    const baselineCount = await countAssistantMessages(page);
    await page.keyboard.press('Enter');

    // 等待助手回复完成并提取
    const reply = await waitForGrokReply(page, { timeoutMs: waitTimeoutMs, stableMs, baselineCount });

    if (screenshot) await page.screenshot({ path: 'grok-reply.png', fullPage: true });

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

      const baselineCount = await countAssistantMessages(page);
      await page.keyboard.type(message);
      await page.keyboard.press('Enter');

      return waitForGrokReply(page, { timeoutMs: waitTimeoutMs, stableMs, baselineCount });
    },
    async close() {
      await page.close();
      await browser.disconnect();
    },
  };
}
