/**
 * 千问（qianwen.com）Web 自动化客户端
 *
 * 前置：调试 Chrome 已启动（建议通过 ensureDebugChrome 自动），
 *      并已登录 qianwen.com（未登录也可用，但无历史/同步）。
 *
 * 实现要点：
 * - 输入框：[role="textbox"][contenteditable]
 * - 发送：page.keyboard.press('Enter') 或点击 button[aria-label="发送消息"]
 * - 回复完成标记：.qk-markdown-complete 类出现在最后一条 .answer-common-card 内
 * - 会话上下文：发送后 URL 跳到 /chat/<id>，复用 page 即可保持多轮
 */
import { connectChrome } from '../chrome/connect.mjs';
import { waitForDomStable, waitForSpa } from '../utils/wait.mjs';

const QIANWEN_URL = 'https://www.qianwen.com/chat';

const INPUT_SELECTOR = '[role="textbox"][contenteditable]';
const SEND_BTN_SELECTOR = 'button[aria-label="发送消息"]';
const ANSWER_CARD_SELECTOR = '.answer-common-card';
const COMPLETE_MARKDOWN_SELECTOR = '.qk-markdown-complete';

/**
 * 等待最后一条助手回复完成（DOM 标记法 + 稳定法兜底）
 *
 * @param {import('puppeteer-core').Page} page
 * @param {object} options
 * @param {number} options.timeoutMs    最大等待
 * @param {number} options.stableMs     兜底稳定阈值
 * @param {number} options.priorCount   等待"新一条"出现时的旧条数
 */
async function waitForQianwenReply(page, { timeoutMs = 120000, stableMs = 3000, priorCount = 0 } = {}) {
  const start = Date.now();

  // 阶段 1：等待新答复 card 出现
  while (Date.now() - start < timeoutMs) {
    const count = await page.evaluate(sel => document.querySelectorAll(sel).length, ANSWER_CARD_SELECTOR);
    if (count > priorCount) break;
    await new Promise(r => setTimeout(r, 500));
  }

  // 阶段 2：等待该 card 内出现 qk-markdown-complete 类
  while (Date.now() - start < timeoutMs) {
    const completed = await page.evaluate(
      ([cardSel, completeSel]) => {
        const cards = document.querySelectorAll(cardSel);
        if (cards.length === 0) return false;
        const last = cards[cards.length - 1];
        return !!last.querySelector(completeSel);
      },
      [ANSWER_CARD_SELECTOR, COMPLETE_MARKDOWN_SELECTOR],
    );
    if (completed) {
      // 完成标记出现后再等一小段，让流式末尾稳定
      await new Promise(r => setTimeout(r, 800));
      return;
    }
    await new Promise(r => setTimeout(r, 500));
  }

  // 阶段 3：兜底 DOM 稳定
  await waitForDomStable(page, { stableMs, timeoutMs: Math.max(5000, timeoutMs - (Date.now() - start)) });
}

/**
 * 从最后一条助手 card 提取文本
 */
async function extractLastReply(page) {
  return page.evaluate(sel => {
    const cards = document.querySelectorAll(sel);
    if (cards.length === 0) return '';
    return (cards[cards.length - 1].innerText || cards[cards.length - 1].textContent || '').trim();
  }, ANSWER_CARD_SELECTOR);
}

async function focusInput(page) {
  const ok = await page.evaluate(sel => {
    const el = document.querySelector(sel);
    if (!el) return false;
    el.focus();
    return true;
  }, INPUT_SELECTOR);
  if (!ok) throw new Error('未找到千问输入框（可能页面结构已变或未加载完成）');
}

async function clickSend(page) {
  // 优先点按钮（更可靠），按钮 disabled 时回退 Enter
  const clicked = await page.evaluate(sel => {
    const btn = document.querySelector(sel);
    if (!btn || btn.disabled) return false;
    btn.click();
    return true;
  }, SEND_BTN_SELECTOR);
  if (!clicked) {
    await page.keyboard.press('Enter');
  }
}

/**
 * 向千问发起单轮对话
 *
 * @param {string} message
 * @param {object} options
 * @param {number} options.waitTimeoutMs
 * @param {number} options.stableMs
 * @param {boolean} options.screenshot
 * @param {boolean} options.newChat            是否新建会话（默认 true）
 * @param {string}  options.conversationUrl    newChat=false 时使用的会话 URL
 * @returns {Promise<{reply: string, url: string}>}
 */
export async function askQianwen(message, options = {}) {
  const {
    waitTimeoutMs = 120000,
    stableMs = 3000,
    screenshot = false,
    newChat = true,
    conversationUrl,
  } = options;

  const { browser } = await connectChrome();
  const page = await browser.newPage();
  page.on('pageerror', err => console.error(`[PAGE ERROR] ${err.message}`));

  try {
    const targetUrl = newChat ? QIANWEN_URL : (conversationUrl || QIANWEN_URL);
    await page.goto(targetUrl, { waitUntil: 'networkidle2', timeout: 60000 });
    await waitForSpa(page, { delayMs: 3000 });

    await focusInput(page);
    const priorCount = await page.evaluate(sel => document.querySelectorAll(sel).length, ANSWER_CARD_SELECTOR);

    await page.keyboard.type(message);
    if (screenshot) await page.screenshot({ path: 'qianwen-input.png' });

    // 等发送按钮 enable（React 状态更新有滞后）
    await page.waitForFunction(
      sel => {
        const b = document.querySelector(sel);
        return b && !b.disabled;
      },
      { timeout: 10000 },
      SEND_BTN_SELECTOR,
    ).catch(() => {});

    await clickSend(page);

    await waitForQianwenReply(page, { timeoutMs: waitTimeoutMs, stableMs, priorCount });

    if (screenshot) await page.screenshot({ path: 'qianwen-reply.png', fullPage: true });

    const reply = await extractLastReply(page);
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
 * @param {string} options.conversationUrl  恢复已存在的会话（如 https://www.qianwen.com/chat/<id>）
 *
 * 用法：
 *   const chat = await createQianwenChat();
 *   await chat.send('我叫小明');
 *   const url = chat.getUrl();
 *   await chat.close();
 *
 *   const chat2 = await createQianwenChat({ conversationUrl: url });
 *   await chat2.send('我刚才说我叫什么？');
 *   await chat2.close();
 */
export async function createQianwenChat(options = {}) {
  const { conversationUrl } = options;
  const { browser } = await connectChrome();
  const page = await browser.newPage();

  const target = conversationUrl || QIANWEN_URL;
  await page.goto(target, { waitUntil: 'networkidle2', timeout: 60000 });
  await waitForSpa(page, { delayMs: 3000 });

  return {
    page,
    getUrl() {
      return page.url();
    },
    async send(message, sendOptions = {}) {
      const { waitTimeoutMs = 120000, stableMs = 3000 } = sendOptions;

      await focusInput(page);
      const priorCount = await page.evaluate(sel => document.querySelectorAll(sel).length, ANSWER_CARD_SELECTOR);

      await page.keyboard.type(message);

      await page.waitForFunction(
        sel => {
          const b = document.querySelector(sel);
          return b && !b.disabled;
        },
        { timeout: 10000 },
        SEND_BTN_SELECTOR,
      ).catch(() => {});

      await clickSend(page);

      await waitForQianwenReply(page, { timeoutMs: waitTimeoutMs, stableMs, priorCount });

      return extractLastReply(page);
    },
    async close() {
      await page.close();
      await browser.disconnect();
    },
  };
}
