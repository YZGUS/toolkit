#!/usr/bin/env node
/**
 * 示例：ChatGPT Images 2.0 纯文本生图（无参考图）
 *
 * 用法：
 *   node examples/chatgpt/text-to-image.mjs
 *   node examples/chatgpt/text-to-image.mjs "你自己的 prompt"
 *
 * 注意：
 * - ChatGPT Images 2.0 在所有 plan 上可用（Free 也行），但有每日额度
 * - 单次生图通常耗时 30-180s，已自动等够
 * - 输出保存到 ./examples/chatgpt/output/
 * - 必须已登录 chatgpt.com（node bin/login-helper.mjs chatgpt）
 */
import { generateChatGPTImage } from '../../src/chatgpt/image-client.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUTPUT_DIR = path.join(__dirname, 'output');

const DEFAULT_PROMPT = 'A majestic Tang Dynasty noblewoman in a luxurious red and gold high-waisted Ruqun, adorned with a massive peony flower in her elaborate updo hairstyle. She is holding a round silk fan, standing in a grand imperial garden surrounded by blooming peonies. Golden hour sunlight filtering through palace eaves, warm and opulent atmosphere. Plump and dignified face typical of Tang Dynasty beauty standards, delicate flower-shaped Huadian between eyebrows, rich embroidered patterns on silk fabric. Museum-quality painting aesthetic.';

const prompt = process.argv.slice(2).join(' ').trim() || DEFAULT_PROMPT;

console.log(`👤 ${prompt.slice(0, 100)}${prompt.length > 100 ? '...' : ''}`);
console.log(`📂 输出目录: ${OUTPUT_DIR}\n`);

const t0 = Date.now();
try {
  const result = await generateChatGPTImage(prompt, {
    outputDir: OUTPUT_DIR,
    filename: `text2img-${Date.now()}`,
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
