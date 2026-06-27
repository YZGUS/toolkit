#!/usr/bin/env node
/**
 * 示例：ChatGPT Images 2.0 带参考图生图（image-to-image）
 *
 * 用法：
 *   node examples/chatgpt/image-to-image.mjs <参考图路径> "改图 prompt"
 *
 * 示例：
 *   node examples/chatgpt/image-to-image.mjs ./me.jpg "把人物变成宫崎骏吉卜力风格"
 *
 * 注意：
 * - 参考图支持 png/jpg/webp/gif/heic/avif，可传 1 张或多张（多张时第一个参数后所有非 prompt 文件都视为参考图）
 * - 输出保存到 ./examples/chatgpt/output/
 * - 必须已登录 chatgpt.com
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateChatGPTImage } from '../../src/chatgpt/image-client.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUTPUT_DIR = path.join(__dirname, 'output');

const args = process.argv.slice(2);
if (args.length < 2) {
  console.error('用法: image-to-image.mjs <参考图路径> [更多参考图...] "prompt"');
  process.exit(1);
}

// 把存在的文件视为参考图，其它拼成 prompt
const refImages = [];
const promptParts = [];
for (const a of args) {
  if (fs.existsSync(a) && fs.statSync(a).isFile()) {
    refImages.push(path.resolve(a));
  } else {
    promptParts.push(a);
  }
}

if (refImages.length === 0) {
  console.error('❌ 至少需要 1 个有效的参考图路径');
  process.exit(1);
}
const prompt = promptParts.join(' ').trim();
if (!prompt) {
  console.error('❌ 缺少改图 prompt');
  process.exit(1);
}

console.log(`🖼  参考图 (${refImages.length}): ${refImages.map(p => path.basename(p)).join(', ')}`);
console.log(`👤 ${prompt}`);
console.log(`📂 输出: ${OUTPUT_DIR}\n`);

const t0 = Date.now();
try {
  const result = await generateChatGPTImage(prompt, {
    refImages,
    outputDir: OUTPUT_DIR,
    filename: `img2img-${Date.now()}`,
  });

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`✅ PASS  (${elapsed}s)`);
  console.log(`   ${result.imagePath}`);
  console.log(`   ${result.width}×${result.height}  ${(result.size / 1024).toFixed(1)} KB`);
  process.exit(0);
} catch (err) {
  console.error(`❌ FAIL: ${err.message}`);
  process.exit(1);
}
