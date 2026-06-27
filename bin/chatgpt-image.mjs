#!/usr/bin/env node
/**
 * ChatGPT Images 2.0 命令行生图工具
 *
 * 用法：
 *   ./chatgpt-image.mjs "a cute cat in van gogh style"
 *   ./chatgpt-image.mjs -o ~/Pictures/ai "cyberpunk city"
 *   ./chatgpt-image.mjs --ref=./photo.jpg "把人物变成水彩风格"
 *   ./chatgpt-image.mjs --ref=./a.jpg --ref=./b.jpg "融合这两张图的风格"
 *   ./chatgpt-image.mjs --filename=my-cat "..."
 *   ./chatgpt-image.mjs --timeout=180000 -s "..."
 *
 * 前置：
 *   - 调试 Chrome 已启动（./bin/start-debug-chrome.sh）
 *   - chatgpt.com 已登录（node bin/login-helper.mjs chatgpt）
 */
import { generateChatGPTImage } from '../src/chatgpt/image-client.mjs';

const args = process.argv.slice(2);
let outputDir;
let filename;
let waitTimeoutMs;
let screenshot = false;
const refImages = [];
const promptParts = [];

for (const arg of args) {
  if (arg === '--screenshot' || arg === '-s') {
    screenshot = true;
  } else if (arg === '--help' || arg === '-h') {
    console.log(`用法: chatgpt-image.mjs [选项] "提示词"

选项:
  -o, --output=DIR     图片保存目录（默认 ./chatgpt-images）
      --filename=NAME  自定义文件名（不含扩展名）
      --ref=PATH       参考图路径（可多次指定）
      --timeout=MS     最大等待时间（默认 300000=5min）
  -s, --screenshot     生成调试截图
  -h, --help           显示帮助

示例:
  chatgpt-image.mjs "a dragon flying over mountains"
  chatgpt-image.mjs --ref=./me.jpg "把我画成宫崎骏风格"
`);
    process.exit(0);
  } else if (arg.startsWith('--output=')) {
    outputDir = arg.slice('--output='.length);
  } else if (arg.startsWith('-o=')) {
    outputDir = arg.slice('-o='.length);
  } else if (arg === '-o' || arg === '--output') {
    // 下一个参数是值
    continue;
  } else if (arg.startsWith('--filename=')) {
    filename = arg.slice('--filename='.length);
  } else if (arg.startsWith('--ref=')) {
    refImages.push(arg.slice('--ref='.length));
  } else if (arg.startsWith('--timeout=')) {
    waitTimeoutMs = Number(arg.slice('--timeout='.length));
  } else {
    promptParts.push(arg);
  }
}

// 处理 "-o ./dir" 这种空格风格
for (let i = 0; i < args.length; i++) {
  if ((args[i] === '-o' || args[i] === '--output') && args[i + 1] && !args[i + 1].startsWith('-')) {
    outputDir = args[i + 1];
    // 从 promptParts 移除这个值（之前被当作 prompt 拼进去了）
    const idx = promptParts.indexOf(args[i + 1]);
    if (idx >= 0) promptParts.splice(idx, 1);
  }
}

const prompt = promptParts.join(' ').trim();
if (!prompt) {
  console.error('❌ 缺少提示词。用 --help 查看用法。');
  process.exit(1);
}

console.log(`👤 ${prompt}`);
if (refImages.length > 0) {
  console.log(`🖼  参考图: ${refImages.join(', ')}`);
}
console.log(`⏳ 连接 ChatGPT Images 2.0... 超时上限 ${(waitTimeoutMs ?? 300_000) / 1000}s`);

try {
  const result = await generateChatGPTImage(prompt, {
    refImages,
    outputDir,
    filename,
    waitTimeoutMs,
    screenshot,
  });

  const elapsed = (result.elapsedMs / 1000).toFixed(1);
  console.log(`\n✅ 生成完成 (${elapsed}s)`);
  console.log(`   📁 ${result.imagePath}`);
  console.log(`   📐 ${result.width}×${result.height}  ${(result.size / 1024).toFixed(1)} KB  ${result.mime}`);
  console.log(`   💬 ${result.conversationUrl}`);
} catch (err) {
  console.error(`\n❌ 错误: ${err.message}`);
  process.exit(1);
}
