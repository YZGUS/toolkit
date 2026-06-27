#!/bin/bash
# start-debug-chrome.sh
# 启动带远程调试端口的 Chrome，使用真实 profile 副本（保留所有登录态）
#
# 已验证：macOS + Chrome 149+

set -e

CHROME_PATH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
REAL_PROFILE="$HOME/Library/Application Support/Google/Chrome"
DEBUG_PROFILE="${TOOLKIT_DEBUG_PROFILE:-$HOME/chrome-debug-profile}"
DEBUG_PORT="${TOOLKIT_DEBUG_PORT:-9222}"

if [ ! -f "$CHROME_PATH" ]; then
  echo "❌ Chrome 未找到: $CHROME_PATH"
  exit 1
fi

# 已开则退出
if curl -s --max-time 1 "http://localhost:$DEBUG_PORT/json/version" > /dev/null 2>&1; then
  echo "✅ 调试端口 $DEBUG_PORT 已在线"
  exit 0
fi

echo "🔪 关闭现有 Chrome..."
pkill -9 -f "Google Chrome" 2>/dev/null || true
sleep 3

if [ ! -d "$DEBUG_PROFILE" ]; then
  echo "📦 首次复制真实 profile 到 $DEBUG_PROFILE（可能 1-3 分钟）..."
  rsync -a --exclude='Singleton*' "$REAL_PROFILE/" "$DEBUG_PROFILE/"
  echo "✅ 复制完成: $(du -sh "$DEBUG_PROFILE" | cut -f1)"
fi

rm -f "$DEBUG_PROFILE/Singleton"* 2>/dev/null || true

echo "🚀 启动 Chrome（调试端口 $DEBUG_PORT）..."
"$CHROME_PATH" \
  --remote-debugging-port=$DEBUG_PORT \
  --user-data-dir="$DEBUG_PROFILE" \
  --no-first-run \
  --no-default-browser-check \
  > /dev/null 2>&1 &

for i in $(seq 1 20); do
  sleep 1
  if curl -s --max-time 1 "http://localhost:$DEBUG_PORT/json/version" > /dev/null 2>&1; then
    BROWSER=$(curl -s "http://localhost:$DEBUG_PORT/json/version" | python3 -c "import sys,json; print(json.load(sys.stdin)['Browser'])")
    echo "✅ 调试端口就绪 (${i}s) | 🌐 $BROWSER"
    exit 0
  fi
  echo -n "."
done

echo ""
echo "❌ Chrome 启动超时"
exit 1
