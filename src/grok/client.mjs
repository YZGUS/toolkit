/**
 * Grok Web 自动化客户端
 *
 * 通过 Puppeteer 操作 https://grok.com/ 实现对话能力。
 * 前置：调试 Chrome 已启动且 grok.com 已登录。
 */
import { connectChrome } from '../chrome/connect.mjs';
import { waitForSpa } from '../utils/wait.mjs';

const GROK_URL = 'https://grok.com';

const MODEL_TRIGGER_SELECTOR = '#model-select-trigger';
const MENUITEM_SELECTOR = '[role="menuitem"]';

/**
 * 已支持的对话模式与默认超时（毫秒）
 *
 * - default  不主动切换，沿用 Grok 当前 trigger 状态
 * - fast     Fast：轻量任务，120s 足够
 * - expert   Expert：深度思考，给 300s
 *
 * Heavy 因可能需付费/置灰，且贴主明确只需要 Fast / Expert，暂不纳入。
 */
export const GROK_MODES = Object.freeze({
  default: { label: null, defaultTimeoutMs: 180_000 },
  fast: { label: 'Fast', defaultTimeoutMs: 120_000 },
  expert: { label: 'Expert', defaultTimeoutMs: 300_000 },
});

/**
 * 读取 trigger 按钮上显示的当前模式名（Auto / Fast / Expert / Heavy）
 *
 * Grok 的 Radix DropdownMenu 项不带 aria-checked / data-state=checked，
 * 但 trigger 按钮文本始终就是当前激活模式名（实测）。
 */
async function readActiveModeLabel(page) {
  return page.evaluate(sel => {
    const t = document.querySelector(sel);
    if (!t) return null;
    // trigger 内可能含图标 svg，文本节点只取 textContent 即可
    return (t.textContent || '').trim();
  }, MODEL_TRIGGER_SELECTOR);
}

/**
 * 切换/确保指定模式被激活
 *
 * 步骤：
 *  1) 读 trigger 文本，若已等于 targetLabel 则跳过
 *  2) 点击 trigger 打开 Radix DropdownMenu
 *  3) 在 [role="menuitem"] 列表里按 font-semibold 标签匹配并点击
 *  4) 兜底 Escape 关菜单，再校验 trigger 文本
 *
 * @param {import('puppeteer-core').Page} page
 * @param {keyof typeof GROK_MODES} mode
 */
export async function setGrokMode(page, mode = 'default') {
  if (!(mode in GROK_MODES)) {
    throw new Error(`未知 Grok 模式: ${mode}（支持：${Object.keys(GROK_MODES).join(', ')}）`);
  }
  const targetLabel = GROK_MODES[mode].label;
  if (!targetLabel) return; // default：不切换

  // 等 trigger 出现
  await page.waitForSelector(MODEL_TRIGGER_SELECTOR, { timeout: 10000 });

  const current = await readActiveModeLabel(page);
  if (current === targetLabel) return; // 已是目标模式

  // 打开菜单：Radix 监听 pointerdown 而非 click，必须用 puppeteer 的真实鼠标事件
  // （element.click() / evaluate 内 .click() 都不会触发 pointerdown，菜单不会展开）
  await page.click(MODEL_TRIGGER_SELECTOR);

  // 等 menuitem 渲染（Radix Portal 异步挂到 body）
  await page.waitForSelector(MENUITEM_SELECTOR, { timeout: 5000 });

  const result = await page.evaluate(
    ({ menuSel, label }) => {
      const items = [...document.querySelectorAll(menuSel)];
      const available = items.map(it => {
        const span = it.querySelector('span.font-semibold, .font-semibold');
        return (span?.textContent || it.textContent || '').trim();
      });
      // 按 font-semibold 标签匹配（避免 description 文字干扰，如 "FastQuick responses"）
      const target = items.find(it => {
        const span = it.querySelector('span.font-semibold, .font-semibold');
        return ((span?.textContent || '').trim() === label);
      });
      if (!target) return { ok: false, reason: 'not-found', available };
      if (target.getAttribute('aria-disabled') === 'true') {
        return { ok: false, reason: 'disabled', available };
      }
      // 给目标加 marker，由 puppeteer 用真实鼠标事件点击
      target.setAttribute('data-toolkit-mode-target', '1');
      return { ok: true, available };
    },
    { menuSel: MENUITEM_SELECTOR, label: targetLabel },
  );

  if (!result.ok) {
    // 兜底关菜单，免得后续操作被挡
    await page.keyboard.press('Escape').catch(() => {});
    const reason =
      result.reason === 'not-found'
        ? `未找到模式「${targetLabel}」（当前菜单项：${result.available.join(' / ') || '无'}）`
        : `模式「${targetLabel}」不可点击（aria-disabled，可能需付费订阅）`;
    throw new Error(reason);
  }

  // 真实点击目标 menuitem（同样要走 pointer 事件链）
  await page.click('[data-toolkit-mode-target="1"]');

  // 等菜单关闭 + trigger 文本更新
  await new Promise(r => setTimeout(r, 400));

  const after = await readActiveModeLabel(page);
  if (after !== targetLabel) {
    throw new Error(`切换 Grok 模式失败：期望「${targetLabel}」，实际「${after}」`);
  }
}

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
 * @param {keyof typeof GROK_MODES} options.mode  对话模式（default/fast/expert，默认 default 不切换）
 * @param {number} options.waitTimeoutMs    等待回复最大时长（默认按模式取）
 * @param {number} options.stableMs          DOM 稳定阈值（默认 3000ms）
 * @param {boolean} options.screenshot      是否截图（保存到当前目录）
 * @param {boolean} options.newChat          是否强制新建会话（默认 true）
 * @returns {Promise<{reply: string, url: string, mode: string}>}
 */
export async function askGrok(message, options = {}) {
  const {
    mode = 'default',
    stableMs = 3000,
    screenshot = false,
    newChat = true,
  } = options;

  const modeCfg = GROK_MODES[mode];
  if (!modeCfg) throw new Error(`未知 Grok 模式: ${mode}`);
  const waitTimeoutMs = options.waitTimeoutMs ?? modeCfg.defaultTimeoutMs;

  const { browser } = await connectChrome();
  const page = await browser.newPage();

  page.on('pageerror', err => console.error(`[PAGE ERROR] ${err.message}`));

  try {
    const targetUrl = newChat ? GROK_URL : (options.conversationUrl || GROK_URL);
    await page.goto(targetUrl, { waitUntil: 'networkidle2', timeout: 60000 });

    // SPA 等待
    await waitForSpa(page, { delayMs: 5000 });

    // 切换模式（default 跳过）
    await setGrokMode(page, mode);

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

    return { reply, url: page.url(), mode };
  } finally {
    await page.close();
    await browser.disconnect();
  }
}

/**
 * 多轮对话：在同一会话上下文中连续提问
 *
 * @param {object} options
 * @param {keyof typeof GROK_MODES} options.mode  初始模式（可在 send 时按需切换）
 * @param {string} options.conversationUrl  恢复已存在的会话（如 https://grok.com/chat/<id>）
 *
 * 用法：
 *   // 新建
 *   const chat = await createGrokChat({ mode: 'expert' });
 *   await chat.send('我叫小明');
 *   await chat.send('换个问题', { mode: 'fast' });    // 单次覆盖
 *   const url = chat.getUrl();           // 保存这个 URL
 *   await chat.close();
 *
 *   // 恢复
 *   const chat2 = await createGrokChat({ conversationUrl: url });
 *   await chat2.send('我刚才说我叫什么？');
 *   await chat2.close();
 */
export async function createGrokChat(options = {}) {
  const { conversationUrl, mode: initialMode = 'default' } = options;
  if (!(initialMode in GROK_MODES)) {
    throw new Error(`未知 Grok 模式: ${initialMode}`);
  }

  const { browser } = await connectChrome();
  const page = await browser.newPage();

  const target = conversationUrl || GROK_URL;
  await page.goto(target, { waitUntil: 'networkidle2', timeout: 60000 });
  await waitForSpa(page, { delayMs: 5000 });

  await setGrokMode(page, initialMode);
  let currentMode = initialMode;

  return {
    page,
    getUrl() {
      return page.url();
    },
    getMode() {
      return currentMode;
    },
    async setMode(mode) {
      await setGrokMode(page, mode);
      currentMode = mode;
    },
    async send(message, sendOptions = {}) {
      const mode = sendOptions.mode ?? currentMode;
      if (mode !== currentMode) {
        await setGrokMode(page, mode);
        currentMode = mode;
      }
      const modeCfg = GROK_MODES[mode];
      const waitTimeoutMs = sendOptions.waitTimeoutMs ?? modeCfg.defaultTimeoutMs;
      const stableMs = sendOptions.stableMs ?? 3000;

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
