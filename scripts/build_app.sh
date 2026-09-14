#!/bin/bash
# Собирает ~/Applications/cyber_office.app — лаунчер, который запускает app.desktop из этой папки проекта.
# Пересобирать после переноса проекта в другое место. Код при запуске берётся из проекта — обновления без пересборки.
set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP="$HOME/Applications/cyber_office.app"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleName</key><string>cyber_office</string>
  <key>CFBundleDisplayName</key><string>cyber_office</string>
  <key>CFBundleIdentifier</key><string>local.agent-office</string>
  <key>CFBundleVersion</key><string>0.1</string>
  <key>CFBundleShortVersionString</key><string>0.1</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleExecutable</key><string>agent_office</string>
  <key>CFBundleIconFile</key><string>icon.icns</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>LSMinimumSystemVersion</key><string>11.0</string>
</dict></plist>
PLIST
cat > "$APP/Contents/MacOS/agent_office" <<LAUNCH
#!/bin/bash
cd "$ROOT"
export PATH="\$HOME/.local/bin:\$PATH"
exec "$ROOT/.venv/bin/python" -m app.desktop >> "$ROOT/workspace/logs/desktop.log" 2>&1
LAUNCH
chmod +x "$APP/Contents/MacOS/agent_office"
cp "$ROOT/assets/icon.icns" "$APP/Contents/Resources/icon.icns"
touch "$APP"
echo "собрано: $APP"
