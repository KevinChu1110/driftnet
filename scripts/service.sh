#!/usr/bin/env bash
# Run driftnet in the background whenever you're logged in, on your own machine.
#   scripts/service.sh install     macOS: launchd agent · Linux: systemd --user unit
#   scripts/service.sh uninstall
#   scripts/service.sh status
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
HOME_DIR="${DRIFTNET_HOME:-$HOME/.driftnet}"
NODE="$(command -v node)"
TSX="$ROOT/node_modules/.bin/tsx"
LABEL="io.github.driftnet"
mkdir -p "$HOME_DIR"

[ -x "$TSX" ] || { echo "Run 'pnpm install' in $ROOT first."; exit 1; }

xml_escape() { sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'; }

case "$(uname -s)-${1:-}" in
  Darwin-install)
    PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
    mkdir -p "$(dirname "$PLIST")"
    # PATH is kept so the claude-cli / gemini-cli providers can find their CLIs.
    cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array>
    <string>$(printf %s "$NODE" | xml_escape)</string>
    <string>$(printf %s "$TSX" | xml_escape)</string>
    <string>src/main.ts</string>
  </array>
  <key>WorkingDirectory</key><string>$(printf %s "$ROOT/apps/server" | xml_escape)</string>
  <key>EnvironmentVariables</key><dict>
    <key>PATH</key><string>$(printf %s "$PATH" | xml_escape)</string>
    <key>DRIFTNET_HOME</key><string>$(printf %s "$HOME_DIR" | xml_escape)</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>StandardOutPath</key><string>$(printf %s "$HOME_DIR/driftnet.log" | xml_escape)</string>
  <key>StandardErrorPath</key><string>$(printf %s "$HOME_DIR/driftnet.log" | xml_escape)</string>
</dict></plist>
PLIST
    launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
    launchctl bootstrap "gui/$(id -u)" "$PLIST"
    echo "Installed. driftnet starts at login. Log: $HOME_DIR/driftnet.log"
    ;;
  Darwin-uninstall)
    launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
    rm -f "$HOME/Library/LaunchAgents/$LABEL.plist"
    echo "Removed. Your data in $HOME_DIR is untouched."
    ;;
  Darwin-status)
    launchctl print "gui/$(id -u)/$LABEL" 2>/dev/null | grep -E "state|pid|last exit" || echo "not installed"
    ;;
  Linux-install)
    UNIT="$HOME/.config/systemd/user/driftnet.service"
    mkdir -p "$(dirname "$UNIT")"
    cat > "$UNIT" <<UNIT
[Unit]
Description=driftnet link catalogue
After=network-online.target

[Service]
WorkingDirectory=$ROOT/apps/server
Environment=PATH=$PATH
Environment=DRIFTNET_HOME=$HOME_DIR
ExecStart=$NODE $TSX src/main.ts
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
UNIT
    systemctl --user daemon-reload
    systemctl --user enable --now driftnet.service
    echo "Installed. Logs: journalctl --user -u driftnet -f"
    echo "To keep it running after logout: loginctl enable-linger $USER"
    ;;
  Linux-uninstall)
    systemctl --user disable --now driftnet.service 2>/dev/null || true
    rm -f "$HOME/.config/systemd/user/driftnet.service"
    systemctl --user daemon-reload
    echo "Removed. Your data in $HOME_DIR is untouched."
    ;;
  Linux-status)
    systemctl --user status driftnet.service --no-pager 2>/dev/null | head -5 || echo "not installed"
    ;;
  *)
    echo "usage: $0 install | uninstall | status   (macOS or Linux; on Windows run 'pnpm start' at login)"
    exit 1
    ;;
esac
