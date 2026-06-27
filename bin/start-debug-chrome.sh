#!/bin/bash
# start-debug-chrome.sh
# 启动带远程调试端口的 Chrome，使用真实 profile 副本（保留所有登录态）
#
# 已验证：macOS + Chrome 149+
#
# 用法：
#   ./start-debug-chrome.sh              # 启动；副本已存在则同步 cookie
#   ./start-debug-chrome.sh --no-sync    # 启动但跳过 cookie 同步
#   ./start-debug-chrome.sh --rebuild    # 删除副本并重建（适合副本损坏）

set -e

CHROME_PATH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
REAL_PROFILE="$HOME/Library/Application Support/Google/Chrome"
DEBUG_PROFILE="${TOOLKIT_DEBUG_PROFILE:-$HOME/chrome-debug-profile}"
DEBUG_PORT="${TOOLKIT_DEBUG_PORT:-9222}"

NO_SYNC=0
REBUILD=0
for arg in "$@"; do
  case "$arg" in
    --no-sync) NO_SYNC=1 ;;
    --rebuild) REBUILD=1 ;;
  esac
done

if [ ! -f "$CHROME_PATH" ]; then
  echo "❌ Chrome 未找到: $CHROME_PATH"
  exit 1
fi

# 已开则退出
if curl -s --max-time 1 "http://localhost:$DEBUG_PORT/json/version" > /dev/null 2>&1; then
  echo "✅ 调试端口 $DEBUG_PORT 已在线"
  exit 0
fi

echo "🔪 只关闭使用副本目录的残留 Chrome（真实 Chrome 保留）..."
pkill -9 -f "user-data-dir=$DEBUG_PROFILE" 2>/dev/null || true
sleep 1

if [ $REBUILD -eq 1 ] && [ -d "$DEBUG_PROFILE" ]; then
  echo "♻️  --rebuild：删除旧副本 $DEBUG_PROFILE"
  rm -rf "$DEBUG_PROFILE"
fi

if [ ! -d "$DEBUG_PROFILE" ]; then
  echo "📦 首次复制真实 profile 到 $DEBUG_PROFILE（可能 1-3 分钟）..."
  rsync -a --exclude='Singleton*' "$REAL_PROFILE/" "$DEBUG_PROFILE/"
  echo "✅ 复制完成: $(du -sh "$DEBUG_PROFILE" | cut -f1)"
elif [ $NO_SYNC -eq 0 ]; then
  echo "🔄 副本已存在，同步真实 profile 的 Cookie / Local Storage..."
  # SQLite 在线备份：真实 Chrome 在跑也能拿到一致快照
  if [ -f "$REAL_PROFILE/Default/Cookies" ]; then
    sqlite3 "$REAL_PROFILE/Default/Cookies" ".backup '$DEBUG_PROFILE/Default/Cookies'" 2>/dev/null \
      || rsync -a "$REAL_PROFILE/Default/Cookies" "$DEBUG_PROFILE/Default/" 2>/dev/null \
      || true
  fi
  [ -d "$REAL_PROFILE/Default/Local Storage" ] && \
    rsync -a "$REAL_PROFILE/Default/Local Storage/" "$DEBUG_PROFILE/Default/Local Storage/" 2>/dev/null || true
  [ -d "$REAL_PROFILE/Default/IndexedDB" ] && \
    rsync -a "$REAL_PROFILE/Default/IndexedDB/" "$DEBUG_PROFILE/Default/IndexedDB/" 2>/dev/null || true
  [ -f "$REAL_PROFILE/Local State" ] && \
    rsync -a "$REAL_PROFILE/Local State" "$DEBUG_PROFILE/Local State" 2>/dev/null || true
  echo "✅ Cookie 同步完成"
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
