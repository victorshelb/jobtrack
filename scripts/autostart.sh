#!/bin/zsh
# Start JobTrack automatically when you log in (macOS LaunchAgent).
#   ./scripts/autostart.sh          install
#   ./scripts/autostart.sh remove   uninstall
set -e
LABEL=com.jobtrack.server
PLIST=~/Library/LaunchAgents/$LABEL.plist
DIR=$(cd "$(dirname "$0")/.." && pwd)
NODE=$(command -v node)

if [[ "$1" == "remove" ]]; then
  launchctl bootout gui/$(id -u) "$PLIST" 2>/dev/null || true
  rm -f "$PLIST"; echo "Autostart removed."; exit 0
fi

mkdir -p ~/Library/LaunchAgents "$DIR/data"
cat > "$PLIST" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array><string>$NODE</string><string>--no-warnings</string><string>$DIR/server/index.js</string></array>
  <key>WorkingDirectory</key><string>$DIR</string>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string></dict>
  <key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$DIR/data/server.log</string>
  <key>StandardErrorPath</key><string>$DIR/data/server.log</string>
</dict></plist>
PL
launchctl bootout gui/$(id -u) "$PLIST" 2>/dev/null || true
launchctl bootstrap gui/$(id -u) "$PLIST"
echo "JobTrack will now start at login → http://localhost:3005 (log: data/server.log)"
