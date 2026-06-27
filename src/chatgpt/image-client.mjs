/**
 * ChatGPT Images 2.0 自动化生图客户端
 *
 * 通过 Puppeteer 操作 https://chatgpt.com/images/ 调用免费的 ChatGPT Images 2.0
 * 生图能力（所有 plan 都可用，包括 Free）。
 *
 * 前置：
 *   1. 调试 Chrome 已启动（bin/start-debug-chrome.sh）
 *   2. chatgpt.com 已登录（bin/login-helper.mjs chatgpt）
 *   3. 网络能访问 chatgpt.com（地理封锁区域需 VPN/代理）
 *
 * 实现要点（已通过 .tmp-explore-*.mjs 实地验证）：
 * - URL 必须用 `/images/` 带尾斜杠，否则 service worker 会中断 navigation
 * - 输入框：#prompt-textarea（contenteditable ProseMirror）
 * - 发送按钮：[data-testid="send-button"]
 * - 参考图上传：input[name="images-app-drop-container-input"]
 * - 完成信号：[data-testid="good-image-turn-action-button"] 出现 +
 *            [data-testid="send-button"] 重新可用
 * - 图片 URL：assistant 区域中 alt 以 "已生成图片" / "Generated" 开头的 <img>，
 *            src 形如 /backend-api/estuary/content?id=file_xxx...
 *            **下载需带浏览器 cookie**（用 page.evaluate fetch + blob → base64）
 *
 * 典型耗时：50-180s（视生图复杂度）
 */
import fs from 'node:fs';
import path from 'node:path';
import { connectChrome } from '../chrome/connect.mjs';
import { waitForSpa } from '../utils/wait.mjs';

const CHATGPT_IMAGES_URL = 'https://chatgpt.com/images/';

const INPUT_SELECTOR = '#prompt-textarea';
const SEND_BTN_SELECTOR = '[data-testid="send-button"]';
const FILE_INPUT_SELECTOR = 'input[name="images-app-drop-container-input"]';
const ASSISTANT_TURN_SELECTOR = '[data-testid^="conversation-turn-"]';
const COMPLETE_MARKER_SELECTOR = '[data-testid="good-image-turn-action-button"]';

/**
 * 上传参考图（可选）
 *
 * 实测：upload 调用后 composer 区域会出现「移除文件 N: <filename>」按钮，
 *      用这个作为附件就绪信号比固定 sleep 更可靠（实测渲染需 5-25s）。
 *
 * @param {import('puppeteer-core').Page} page
 * @param {string[]} refImagePaths  本地图片绝对路径
 */
async function attachReferenceImages(page, refImagePaths) {
  if (!refImagePaths?.length) return;

  for (const p of refImagePaths) {
    if (!fs.existsSync(p)) {
      throw new Error(`参考图不存在: ${p}`);
    }
  }

  // 等 file input 出现（页面初始化完成后即有）
  await page.waitForSelector(FILE_INPUT_SELECTOR, { timeout: 10000 });
  const input = await page.$(FILE_INPUT_SELECTOR);
  if (!input) throw new Error(`未找到参考图上传 input（${FILE_INPUT_SELECTOR}）`);

  await input.uploadFile(...refImagePaths);

  // 等所有附件 chip 出现（按"移除文件 N"按钮数量判断）
  const expectedCount = refImagePaths.length;
  await page.waitForFunction(
    n => {
      const removeBtns = [...document.querySelectorAll('button[aria-label]')]
        .filter(b => /移除文件|Remove file/i.test(b.getAttribute('aria-label') || ''));
      return removeBtns.length >= n;
    },
    { timeout: 60_000 },
    expectedCount,
  );

  // 额外等一拍让缩略图渲染完
  await new Promise(r => setTimeout(r, 1000));
}

/**
 * 聚焦输入框（contenteditable）
 */
async function focusInput(page) {
  await page.waitForSelector(INPUT_SELECTOR, { timeout: 15000 });
  const ok = await page.evaluate(sel => {
    const el = document.querySelector(sel);
    if (!el) return false;
    el.focus();
    return true;
  }, INPUT_SELECTOR);
  if (!ok) throw new Error('未找到 ChatGPT 输入框（可能未登录或页面结构已变）');
}

/**
 * 等发送按钮变可用并点击
 *
 * 注意：带参考图时服务端需要处理上传（约 15-30s），send 按钮才会解锁，
 *      所以默认给 60s 容忍。
 */
async function clickSend(page, { enableTimeoutMs = 60_000 } = {}) {
  await page.waitForFunction(
    sel => {
      const b = document.querySelector(sel);
      return b && !b.disabled;
    },
    { timeout: enableTimeoutMs },
    SEND_BTN_SELECTOR,
  );
  await page.click(SEND_BTN_SELECTOR);
}

/**
 * 等待图片生成完成
 *
 * 完成判据（按可靠性排序）：
 *   1. 出现 [data-testid="good-image-turn-action-button"]（"喜欢图片"反馈按钮）
 *      —— 只有图片完全生成完毕才会渲染
 *   2. send 按钮重新可用（disabled=false）
 *   3. 兜底：发现 alt 以"已生成图片"/"Generated" 开头的 <img> 且 src 是 estuary content
 *
 * @param {number} timeoutMs
 * @param {number} priorTurnCount 发送前的 turn 数量基线
 */
async function waitForImageReady(page, { timeoutMs = 300_000, priorTurnCount = 0 } = {}) {
  const start = Date.now();
  let lastStatus = '';

  while (Date.now() - start < timeoutMs) {
    const status = await page.evaluate(
      ({ turnSel, completeSel, sendSel }) => {
        const turns = document.querySelectorAll(turnSel);
        const last = turns[turns.length - 1];
        const completeBtn = last?.querySelector(completeSel);
        const sendBtn = document.querySelector(sendSel);

        // 在 last turn 中找已生成的图片
        let generatedImg = null;
        if (last) {
          generatedImg = [...last.querySelectorAll('img')]
            .find(i => /已生成图片|Generated/i.test(i.alt) || /estuary\/content/.test(i.src));
        }

        return {
          turnCount: turns.length,
          hasCompleteMarker: !!completeBtn,
          sendEnabled: sendBtn && !sendBtn.disabled,
          hasGeneratedImg: !!generatedImg,
          imgComplete: generatedImg ? generatedImg.complete && generatedImg.naturalWidth > 0 : false,
        };
      },
      { turnSel: ASSISTANT_TURN_SELECTOR, completeSel: COMPLETE_MARKER_SELECTOR, sendSel: SEND_BTN_SELECTOR },
    );

    const sig = JSON.stringify(status);
    if (sig !== lastStatus) {
      lastStatus = sig;
    }

    // 必须满足：新 turn 已出现 + 完成 marker 出现 + 图片加载完毕
    if (
      status.turnCount > priorTurnCount &&
      status.hasCompleteMarker &&
      status.hasGeneratedImg &&
      status.imgComplete
    ) {
      // 再等一小段让 URL 稳定（高分辨率版可能后到）
      await new Promise(r => setTimeout(r, 1500));
      return;
    }

    await new Promise(r => setTimeout(r, 1500));
  }

  throw new Error(`等待图片生成超时（${timeoutMs / 1000}s），可能配额耗尽或网络异常`);
}

/**
 * 从最后一个 turn 提取生成的图片 URL
 *
 * 策略：取该 turn 内 alt 含"已生成图片"或非空且 src 含 estuary content 的 img，
 * 选 naturalWidth 最大的（即高清原图，而非缩略图）。
 *
 * @returns {Promise<{src: string, alt: string, width: number, height: number}|null>}
 */
async function extractGeneratedImage(page) {
  return page.evaluate(turnSel => {
    const turns = document.querySelectorAll(turnSel);
    const last = turns[turns.length - 1];
    if (!last) return null;

    const candidates = [...last.querySelectorAll('img')]
      .filter(i => /estuary\/content/.test(i.src) && i.naturalWidth > 0)
      .map(i => ({
        src: i.src,
        alt: i.alt || '',
        width: i.naturalWidth,
        height: i.naturalHeight,
      }))
      .sort((a, b) => b.width - a.width);

    return candidates[0] || null;
  }, ASSISTANT_TURN_SELECTOR);
}

/**
 * 在浏览器上下文里下载图片（带 cookie）并返回 base64
 *
 * 因为 chatgpt.com/backend-api/estuary/content 需要登录 cookie，
 * 不能用 node fetch 下载，必须用 page.evaluate(fetch) 借浏览器上下文。
 */
async function downloadImageAsBase64(page, imgSrc) {
  return page.evaluate(async src => {
    const res = await fetch(src, { credentials: 'include' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const blob = await res.blob();
    const buf = await blob.arrayBuffer();
    const bytes = new Uint8Array(buf);
    let binary = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return { base64: btoa(binary), type: blob.type, size: blob.size };
  }, imgSrc);
}

/**
 * 推断图片扩展名（基于 MIME，回退 .png）
 */
function extFromMime(mime) {
  if (!mime) return '.png';
  if (/png/i.test(mime)) return '.png';
  if (/webp/i.test(mime)) return '.webp';
  if (/jpe?g/i.test(mime)) return '.jpg';
  if (/gif/i.test(mime)) return '.gif';
  return '.png';
}

/**
 * 生成图片
 *
 * @param {string} prompt           生图描述
 * @param {object} options
 * @param {string[]} options.refImages   参考图本地路径数组（可选）
 * @param {string}   options.outputDir   保存目录（默认 './chatgpt-images'）
 * @param {string}   options.filename    自定义文件名（不含扩展名；默认 chatgpt-image-<timestamp>）
 * @param {number}   options.waitTimeoutMs  图片生成最大等待（默认 300s）
 * @param {boolean}  options.screenshot  是否额外保存调试截图
 * @param {boolean}  options.savePrompt  是否把 prompt 写到同名 .txt（默认 true）
 * @returns {Promise<{imagePath: string, prompt: string, url: string, conversationUrl: string, elapsedMs: number}>}
 */
export async function generateChatGPTImage(prompt, options = {}) {
  if (!prompt || typeof prompt !== 'string') {
    throw new Error('prompt 必填且必须是字符串');
  }

  const {
    refImages = [],
    outputDir = './chatgpt-images',
    filename,
    waitTimeoutMs = 300_000,
    screenshot = false,
    savePrompt = true,
  } = options;

  // 准备输出目录
  fs.mkdirSync(outputDir, { recursive: true });

  const { browser } = await connectChrome();
  const page = await browser.newPage();
  page.on('pageerror', err => console.error(`[PAGE ERROR] ${err.message}`));

  const t0 = Date.now();
  try {
    await page.goto(CHATGPT_IMAGES_URL, { waitUntil: 'domcontentloaded', timeout: 120_000 });
    await waitForSpa(page, { delayMs: 4000 });

    // 1. 上传参考图（如有）
    if (refImages.length > 0) {
      const absPaths = refImages.map(p => path.resolve(p));
      await attachReferenceImages(page, absPaths);
    }

    // 2. 聚焦输入框 → 输入 prompt
    //    注意：上传附件后 ProseMirror 焦点可能丢失，必须重新聚焦
    await focusInput(page);
    await new Promise(r => setTimeout(r, 300));
    await page.keyboard.type(prompt);

    // 3. 等待 ProseMirror 真正写入了文本（容错于异步渲染）
    const typed = await page.waitForFunction(
      sel => {
        const el = document.querySelector(sel);
        return el && (el.innerText || el.textContent || '').trim().length > 0;
      },
      { timeout: 8000 },
      INPUT_SELECTOR,
    ).then(() => true).catch(() => false);

    // 兜底：直接通过 ProseMirror API 写入（焦点丢失时 keyboard.type 写不进去）
    if (!typed) {
      await page.evaluate(
        ({ sel, text }) => {
          const el = document.querySelector(sel);
          if (!el) return;
          el.focus();
          // 用 DataTransfer + InputEvent 模拟粘贴，ProseMirror 能正确接收
          const dt = new DataTransfer();
          dt.setData('text/plain', text);
          el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
        },
        { sel: INPUT_SELECTOR, text: prompt },
      );
      await new Promise(r => setTimeout(r, 800));
    }

    if (screenshot) await page.screenshot({ path: path.join(outputDir, '.chatgpt-input.png') });

    // 4. 记录基线 + 发送
    const priorTurnCount = await page.evaluate(
      sel => document.querySelectorAll(sel).length,
      ASSISTANT_TURN_SELECTOR,
    );
    await clickSend(page);

    // 5. 等待图片生成完成
    await waitForImageReady(page, { timeoutMs: waitTimeoutMs, priorTurnCount });

    if (screenshot) await page.screenshot({ path: path.join(outputDir, '.chatgpt-reply.png'), fullPage: true });

    // 6. 提取图片 URL
    const img = await extractGeneratedImage(page);
    if (!img) throw new Error('未能从页面中提取生成的图片 URL');

    // 7. 下载图片
    const { base64, type, size } = await downloadImageAsBase64(page, img.src);
    const ext = extFromMime(type);
    const baseName = filename || `chatgpt-image-${Date.now()}`;
    const imagePath = path.resolve(outputDir, `${baseName}${ext}`);
    fs.writeFileSync(imagePath, Buffer.from(base64, 'base64'));

    // 8. 落盘 prompt
    if (savePrompt) {
      const meta = [
        `Prompt: ${prompt}`,
        `Generated at: ${new Date().toISOString()}`,
        `Resolution: ${img.width}x${img.height}`,
        `Size: ${(size / 1024).toFixed(1)} KB`,
        `MIME: ${type}`,
        `Conversation: ${page.url()}`,
        refImages.length > 0 ? `Reference images: ${refImages.join(', ')}` : '',
      ].filter(Boolean).join('\n');
      fs.writeFileSync(path.resolve(outputDir, `${baseName}.txt`), meta);
    }

    return {
      imagePath,
      prompt,
      url: img.src,
      conversationUrl: page.url(),
      width: img.width,
      height: img.height,
      mime: type,
      size,
      elapsedMs: Date.now() - t0,
    };
  } finally {
    await page.close();
    await browser.disconnect();
  }
}
