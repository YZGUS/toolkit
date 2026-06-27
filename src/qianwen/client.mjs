/**
 * 千问（qianwen.com）Web 自动化客户端
 *
 * 前置：调试 Chrome 已启动（建议通过 ensureDebugChrome 自动），
 *      并已登录 qianwen.com（任务助理 / 研究模式需要登录）。
 *
 * 实现要点：
 * - 输入框：[role="textbox"][contenteditable]
 * - 发送：page.keyboard.press('Enter') 或点击 button[aria-label="发送消息"]
 * - 模式按钮：[data-role="visible-capsule"] button[aria-label="任务助理|研究|思考|...']
 *   • 通过 aria-pressed 标识是否激活
 *   • 同一时刻只能激活一个模式
 *   • 必须用 visible-capsule 容器范围，避免点到 measure-capsule 副本
 * - 回复完成标记：.qk-markdown-complete 类出现在最后一条 .answer-common-card 内
 *   • 任务助理 / 研究模式回复时间长（可能几分钟），需把 waitTimeoutMs 调大
 * - 会话上下文：发送后 URL 跳到 /chat/<id>，复用 page 即可保持多轮
 */
import { connectChrome } from '../chrome/connect.mjs';
import { waitForDomStable, waitForSpa } from '../utils/wait.mjs';

const QIANWEN_URL = 'https://www.qianwen.com/chat';

const INPUT_SELECTOR = '[role="textbox"][contenteditable]';
const SEND_BTN_SELECTOR = 'button[aria-label="发送消息"]';
const ANSWER_CARD_SELECTOR = '.answer-common-card';
const COMPLETE_MARKDOWN_SELECTOR = '.qk-markdown-complete';
const VISIBLE_CAPSULE = '[data-role="visible-capsule"]';

/**
 * 已支持的对话模式与默认超时（毫秒）
 * - default  常规对话
 * - task     任务助理（每天 20 次）
 * - research 研究（每天 10 次，回复较慢且较长）
 * - think    思考（深度思考）
 *
 * 调用方可通过 options.mode 选择；默认 default。
 */
export const QIANWEN_MODES = Object.freeze({
  default: { label: null, defaultTimeoutMs: 120_000 },
  task: { label: '任务助理', defaultTimeoutMs: 600_000 },
  research: { label: '研究', defaultTimeoutMs: 900_000 },
  think: { label: '思考', defaultTimeoutMs: 240_000 },
});

/**
 * 切换/确保指定模式被激活
 *
 * 行为：
 * - mode='default'：取消所有激活的模式按钮
 * - 其他：先取消已激活的其他模式，再激活目标模式（点 visible-capsule 容器内的按钮）
 *
 * @param {import('puppeteer-core').Page} page
 * @param {keyof typeof QIANWEN_MODES} mode
 */
export async function setQianwenMode(page, mode = 'default') {
  if (!(mode in QIANWEN_MODES)) {
    throw new Error(`未知千问模式: ${mode}（支持：${Object.keys(QIANWEN_MODES).join(', ')}）`);
  }
  const targetLabel = QIANWEN_MODES[mode].label;

  // 等模式按钮区域出现
  await page
    .waitForSelector(`${VISIBLE_CAPSULE} button[aria-label]`, { timeout: 10000 })
    .catch(() => {});

  const result = await page.evaluate(
    ({ capsuleSel, targetLabel }) => {
      const visibleBtns = [...document.querySelectorAll(`${capsuleSel} button[aria-label]`)];
      const activated = visibleBtns.filter(b => b.getAttribute('aria-pressed') === 'true');
      const labels = visibleBtns.map(b => b.getAttribute('aria-label'));

      // 1) 取消其他激活模式
      for (const b of activated) {
        if (b.getAttribute('aria-label') !== targetLabel) b.click();
      }

      if (!targetLabel) {
        return { ok: true, switched: activated.map(b => b.getAttribute('aria-label')), available: labels };
      }

      // 2) 如果目标已激活，跳过
      const already = activated.find(b => b.getAttribute('aria-label') === targetLabel);
      if (already) return { ok: true, alreadyActive: true, available: labels };

      // 3) 激活目标
      const target = visibleBtns.find(b => b.getAttribute('aria-label') === targetLabel);
      if (!target) return { ok: false, reason: 'target-not-found', available: labels };
      if (target.getAttribute('aria-disabled') === 'true' || target.disabled) {
        return { ok: false, reason: 'target-disabled', available: labels };
      }
      target.click();
      return { ok: true, clicked: targetLabel, available: labels };
    },
    { capsuleSel: VISIBLE_CAPSULE, targetLabel },
  );

  if (!result.ok) {
    const reason =
      result.reason === 'target-not-found'
        ? `未找到模式按钮「${targetLabel}」（当前可见：${result.available.join(' / ') || '无'}），可能需要先登录千问`
        : `模式按钮「${targetLabel}」当前不可点击（aria-disabled），可能登录态丢失或额度耗尽`;
    throw new Error(reason);
  }

  // 等待状态稳定
  await new Promise(r => setTimeout(r, 600));

  // 验证：目标模式 aria-pressed 应为 true（仅在 targetLabel 存在时验证）
  if (targetLabel) {
    const verified = await page.evaluate(
      ({ capsuleSel, targetLabel }) => {
        const b = [...document.querySelectorAll(`${capsuleSel} button[aria-label]`)].find(
          x => x.getAttribute('aria-label') === targetLabel,
        );
        return b ? b.getAttribute('aria-pressed') === 'true' : false;
      },
      { capsuleSel: VISIBLE_CAPSULE, targetLabel },
    );
    if (!verified) {
      throw new Error(`激活模式「${targetLabel}」失败（aria-pressed 未变为 true）`);
    }
  }
}

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
    await new Promise(r => setTimeout(r, 1000));
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
 * @param {keyof typeof QIANWEN_MODES} options.mode  对话模式（default/task/research/think）
 * @param {number} options.waitTimeoutMs            最大等待回复时长（默认按模式取）
 * @param {number} options.stableMs                  DOM 稳定阈值
 * @param {boolean} options.screenshot              截图调试
 * @param {boolean} options.newChat                 是否新建会话（默认 true）
 * @param {string}  options.conversationUrl         newChat=false 时使用的会话 URL
 * @returns {Promise<{reply: string, url: string, mode: string}>}
 */
export async function askQianwen(message, options = {}) {
  const {
    mode = 'default',
    stableMs = 3000,
    screenshot = false,
    newChat = true,
    conversationUrl,
  } = options;

  const modeCfg = QIANWEN_MODES[mode];
  if (!modeCfg) throw new Error(`未知千问模式: ${mode}`);
  const waitTimeoutMs = options.waitTimeoutMs ?? modeCfg.defaultTimeoutMs;

  const { browser } = await connectChrome();
  const page = await browser.newPage();
  page.on('pageerror', err => console.error(`[PAGE ERROR] ${err.message}`));

  try {
    const targetUrl = newChat ? QIANWEN_URL : (conversationUrl || QIANWEN_URL);
    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await waitForSpa(page, { delayMs: 3000 });

    // 切换模式（default 会取消所有激活）
    await setQianwenMode(page, mode);

    await focusInput(page);
    const priorCount = await page.evaluate(sel => document.querySelectorAll(sel).length, ANSWER_CARD_SELECTOR);

    await page.keyboard.type(message);
    if (screenshot) await page.screenshot({ path: `qianwen-${mode}-input.png` });

    // 等发送按钮 enable
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

    if (screenshot) await page.screenshot({ path: `qianwen-${mode}-reply.png`, fullPage: true });

    const reply = await extractLastReply(page);
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
 * @param {keyof typeof QIANWEN_MODES} options.mode     初始模式（可在 send 时按需切换）
 * @param {string} options.conversationUrl  恢复已存在的会话（如 https://www.qianwen.com/chat/<id>）
 *
 * 用法：
 *   const chat = await createQianwenChat({ mode: 'research' });
 *   await chat.send('帮我研究 XX');                 // 沿用初始模式
 *   await chat.send('换个话题', { mode: 'default' }); // 单次切换
 *   const url = chat.getUrl();
 *   await chat.close();
 */
export async function createQianwenChat(options = {}) {
  const { conversationUrl, mode: initialMode = 'default' } = options;
  if (!(initialMode in QIANWEN_MODES)) {
    throw new Error(`未知千问模式: ${initialMode}`);
  }

  const { browser } = await connectChrome();
  const page = await browser.newPage();

  const target = conversationUrl || QIANWEN_URL;
  await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await waitForSpa(page, { delayMs: 3000 });

  // 首次激活初始模式
  await setQianwenMode(page, initialMode);
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
      await setQianwenMode(page, mode);
      currentMode = mode;
    },
    async send(message, sendOptions = {}) {
      const mode = sendOptions.mode ?? currentMode;
      if (mode !== currentMode) {
        await setQianwenMode(page, mode);
        currentMode = mode;
      }
      const modeCfg = QIANWEN_MODES[mode];
      const waitTimeoutMs = sendOptions.waitTimeoutMs ?? modeCfg.defaultTimeoutMs;
      const stableMs = sendOptions.stableMs ?? 3000;

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
