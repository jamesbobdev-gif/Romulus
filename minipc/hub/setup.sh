#!/usr/bin/env bash
# One-time setup of the NEW mini PC as the Tasks hub (not the model box: that one keeps running Ollama).
# The hub runs the Tasks app as a service: the agent and its browser, mail dates, calendar sync and the model box’s
# coordinator. The laptop and phone reach it over Tailscale only.
# Works on Ubuntu Server 24.04+ and AlmaLinux 9/10. Run once, on the mini PC, as your own user:
#   sudo bash setup.sh                  (or: sudo bash setup.sh 192.168.1.0/24  to also allow SSH from home Wi-Fi)
# What it does: updates the system, keeps it awake, firewall (nothing in except SSH + HTTPS from your tailnet),
# installs Tailscale, Node 22, Google Chrome, Xvfb, Claude Code and the Gemini CLI, and the auto-start service.
set -euo pipefail
LAN="${1:-}"                        # optional: home network allowed to SSH in (e.g. 192.168.1.0/24)
USER_NAME="${SUDO_USER:?run with sudo from your own account}"
HOME_DIR="$(getent passwd "$USER_NAME" | cut -d: -f6)"
APP_DIR="$HOME_DIR/tasks-app"
HUB_NAME="tasks-hub"                # its tailnet name: https://tasks-hub.<your-tailnet>.ts.net
log() { echo; echo "=== $* ==="; }
as_user() { sudo -u "$USER_NAME" -H env HOME="$HOME_DIR" PATH="$HOME_DIR/.local/bin:$HOME_DIR/.npm-global/bin:/usr/local/bin:/usr/bin:/bin" "$@"; }

if command -v apt-get >/dev/null; then OS=ubuntu; elif command -v dnf >/dev/null; then OS=alma; else echo "Ubuntu or AlmaLinux only"; exit 1; fi

log "1/8 Updating the system ($OS)"
if [ $OS = ubuntu ]; then
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -q && apt-get -y -q full-upgrade
  apt-get -y -q install curl ca-certificates gnupg ufw xvfb xauth git tar
else
  dnf -y -q upgrade
  dnf -y -q install epel-release || true
  dnf -y -q install curl ca-certificates firewalld xorg-x11-server-Xvfb xorg-x11-xauth git tar which
  systemctl enable --now firewalld
fi

log "2/8 Keeping it awake (no suspend or hibernate)"
systemctl mask sleep.target suspend.target hibernate.target hybrid-sleep.target >/dev/null

log "3/8 Tailscale"
# Tailscale's official installer (https://tailscale.com/download/linux): adds Tailscale's signed apt/dnf repository
# and installs the package from it. There is no versioned URL or checksum for the script itself.
if ! command -v tailscale >/dev/null; then curl -fsSL https://tailscale.com/install.sh | sh; fi
systemctl enable --now tailscaled
tailscale set --hostname="$HUB_NAME" 2>/dev/null || true
if ! tailscale status >/dev/null 2>&1; then
  echo "Sign this mini PC in to your tailnet: open the link below on your phone or laptop."
  tailscale up --hostname="$HUB_NAME" --ssh=false
fi

log "4/8 Firewall: only your tailnet gets in (SSH and the hub's HTTPS); nothing else, from anywhere"
if [ $OS = ubuntu ]; then
  ufw --force reset >/dev/null
  ufw default deny incoming >/dev/null
  ufw default allow outgoing >/dev/null
  ufw allow in on tailscale0 to any port 22 proto tcp >/dev/null
  ufw allow in on tailscale0 to any port 443 proto tcp >/dev/null
  [ -n "$LAN" ] && ufw allow from "$LAN" to any port 22 proto tcp >/dev/null
  ufw --force enable
  ufw status verbose | sed -n '1,20p'
else
  firewall-cmd -q --permanent --new-zone=tailnet 2>/dev/null || true
  firewall-cmd -q --permanent --zone=tailnet --add-interface=tailscale0
  firewall-cmd -q --permanent --zone=tailnet --add-service=ssh --add-service=https
  # the normal network: no SSH, no cockpit, nothing (dhcpv6-client only)
  for s in ssh cockpit; do firewall-cmd -q --permanent --zone=public --remove-service=$s 2>/dev/null || true; done
  [ -n "$LAN" ] && firewall-cmd -q --permanent --zone=public --add-rich-rule="rule family=ipv4 source address=$LAN service name=ssh accept"
  firewall-cmd -q --reload
  firewall-cmd --list-all-zones | grep -A8 -E '^(public|tailnet)'
fi
# SSH: keys only (the laptop's key must already be in ~/.ssh/authorized_keys: ssh-copy-id first)
if [ -s "$HOME_DIR/.ssh/authorized_keys" ]; then
  mkdir -p /etc/ssh/sshd_config.d
  printf 'PasswordAuthentication no\nKbdInteractiveAuthentication no\nPermitRootLogin no\n' > /etc/ssh/sshd_config.d/10-tasks-hub.conf
  systemctl reload ssh 2>/dev/null || systemctl reload sshd
else
  echo "!! No SSH key in ~/.ssh/authorized_keys yet: passwords still work. Run ssh-copy-id from the laptop, then this again."
fi

log "5/8 Node 22 and Google Chrome (the agent browser)"
if ! node -v 2>/dev/null | grep -qE '^v(2[2-9]|[3-9][0-9])'; then
  # NodeSource's official setup script (https://github.com/nodesource/distributions): adds their signed apt repository
  # for the Node 22 line; the script has no versioned URL or checksum. AlmaLinux uses the distribution's own module.
  if [ $OS = ubuntu ]; then curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt-get -y -q install nodejs
  else dnf -y -q module reset nodejs || true; dnf -y -q module enable nodejs:22 || true; dnf -y -q install nodejs npm; fi
fi
if [ ! -x /opt/google/chrome/chrome ]; then
  if [ $OS = ubuntu ]; then
    # Google's official package (https://www.google.com/chrome/): Google publishes only this "current" URL, no
    # versioned one or checksum; the package itself is signed and installs Google's signed apt repository for updates.
    curl -fsSLo /tmp/chrome.deb https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb
    apt-get -y -q install /tmp/chrome.deb && rm -f /tmp/chrome.deb
  else dnf -y -q install https://dl.google.com/linux/direct/google-chrome-stable_current_x86_64.rpm; fi
fi
node -v; /opt/google/chrome/chrome --version

log "6/8 Claude Code and the Gemini CLI (for your user)"
as_user mkdir -p "$HOME_DIR/.npm-global"
as_user npm config set prefix "$HOME_DIR/.npm-global"
# Anthropic's official Claude Code installer (https://docs.anthropic.com/en/docs/claude-code/setup): no versioned
# URL or checksum for the script; it fetches the current release and verifies that download itself.
[ -x "$HOME_DIR/.local/bin/claude" ] || as_user bash -c 'curl -fsSL https://claude.ai/install.sh | bash'
as_user npm install -g --no-audit --no-fund @google/gemini-cli >/dev/null || echo "!! Gemini CLI install failed (the Gemini API key still works without it)"

log "7/8 The Tasks service (starts at boot, even before you log in)"
as_user mkdir -p "$APP_DIR" "$HOME_DIR/.config/systemd/user" "$HOME_DIR/.config/Romulus"
chmod 700 "$HOME_DIR/.config/Romulus"
# this computer is the hub; the token is made on first start (~/.config/Romulus/hub-token.txt)
if [ ! -s "$HOME_DIR/.config/Romulus/config.json" ]; then
  echo '{"hub":{"role":"server","port":8790}}' > "$HOME_DIR/.config/Romulus/config.json"
  chown "$USER_NAME:" "$HOME_DIR/.config/Romulus/config.json"; chmod 600 "$HOME_DIR/.config/Romulus/config.json"
fi
cat > "$HOME_DIR/.config/systemd/user/tasks-hub.service" <<EOF
[Unit]
Description=Tasks hub (agent, agent browser, mail and calendar sync)
After=network-online.target

[Service]
Environment=PATH=$HOME_DIR/.local/bin:$HOME_DIR/.npm-global/bin:/usr/local/bin:/usr/bin:/bin
Environment=ELECTRON_ENABLE_LOGGING=1
WorkingDirectory=$APP_DIR
# a virtual screen: the app's window and its tray live there, nobody sees them. Its saved secrets use
# Chromium's basic store (no desktop keyring here); ~/.config/Romulus is readable by you only.
ExecStart=/usr/bin/xvfb-run -a -s "-screen 0 1280x900x24" $APP_DIR/node_modules/electron/dist/electron $APP_DIR --password-store=basic
Restart=always
RestartSec=10

[Install]
WantedBy=default.target
EOF
chown -R "$USER_NAME:" "$HOME_DIR/.config/systemd"
loginctl enable-linger "$USER_NAME"   # user services run from boot, without logging in
# Ubuntu 24.04+ (kernel.apparmor_restrict_unprivileged_userns=1) lets a program create the user namespace Electron's
# sandbox needs only when its binary has an AppArmor profile with the "userns" permission. This is Ubuntu's own
# recipe, the same as the profile Ubuntu ships for Chrome (/etc/apparmor.d/chrome): flags=(unconfined) keeps the
# profile from mediating anything else, so the only effect is to grant userns to this one binary (an enforced
# profile with just "userns," would deny Electron every file and network access). Writing a confining profile for
# Electron is the follow-up; in the meantime the sandbox stays on, which is the point.
if [ $OS = ubuntu ] && [ -d /etc/apparmor.d ]; then
  cat > /etc/apparmor.d/tasks-hub-electron <<EOF
abi <abi/4.0>,
include <tunables/global>
profile tasks-hub-electron $APP_DIR/node_modules/electron/dist/electron flags=(unconfined) {
  userns,
  include if exists <local/tasks-hub-electron>
}
EOF
  apparmor_parser -r /etc/apparmor.d/tasks-hub-electron || true
fi

log "8/8 Publishing the hub to your tailnet only (tailscale serve: HTTPS, no Funnel)"
tailscale serve --bg --https=443 http://127.0.0.1:8790 || echo "!! Turn on MagicDNS and HTTPS certificates in the Tailscale admin console (DNS page), then run: sudo tailscale serve --bg --https=443 http://127.0.0.1:8790"
tailscale funnel status 2>/dev/null | grep -qi 'funnel on' && { echo "!! Funnel is on: turning it off"; tailscale funnel reset; } || true
tailscale serve status || true

echo
echo "Done. Next, from the laptop: minipc\\hub\\deploy.ps1 (copies the app here and starts it)."
echo "Then sign in once over SSH:  claude   (type /login)."
