#!/usr/bin/env bash
# One-time setup of the mini PC as the Tasks app's local AI server (Ubuntu 26.04).
# Run once with:  sudo bash setup.sh
# What it does: updates Ubuntu, keeps the machine awake, joins your Tailscale tailnet, firewalls it so only SSH gets
# in (from your home network and the tailnet), installs Ollama listening on this machine only, publishes it to the
# tailnet through `tailscale serve`, and downloads the model.
# In the app: Settings → Local model → address http://<this machine's Tailscale name or IP>:11434
set -euo pipefail
LAN="192.168.1.0/24"          # devices allowed to SSH in from home Wi-Fi (the tailnet always may)
MODEL="hf.co/Hcompany/Holo4-35B-A3B-GGUF"   # the model in use (needs 32 GB); qwen3:8b fits a 16 GB box
OLLAMA_VERSION="0.40.7"       # the Ollama release to install (pinned; empty = whatever is newest)
USER_NAME="${SUDO_USER:-$(whoami)}"
log() { echo; echo "=== $* ==="; }

log "1/6 Updating Ubuntu (a few minutes)"
export DEBIAN_FRONTEND=noninteractive
apt-get update -q
apt-get -y -q full-upgrade
apt-get -y -q install curl ufw

log "2/6 Keeping the mini PC awake (no suspend or hibernate)"
systemctl mask sleep.target suspend.target hibernate.target hybrid-sleep.target >/dev/null
# the login screen's own idle-suspend too
sudo -u gdm dbus-run-session gsettings set org.gnome.settings-daemon.plugins.power sleep-inactive-ac-type 'nothing' 2>/dev/null || true
sudo -u "$USER_NAME" DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$(id -u "$USER_NAME")/bus" \
  gsettings set org.gnome.settings-daemon.plugins.power sleep-inactive-ac-type 'nothing' 2>/dev/null || true

log "3/6 Tailscale (the laptop and the hub reach this machine over the tailnet, not the open network)"
if ! command -v tailscale >/dev/null; then
  # Tailscale's official installer (https://tailscale.com/download/linux): it adds Tailscale's signed apt
  # repository and installs the package from it; there is no versioned URL or checksum for the script itself.
  curl -fsSL https://tailscale.com/install.sh | sh
fi
systemctl enable --now tailscaled
if ! tailscale status >/dev/null 2>&1; then
  echo "Sign this mini PC in to your tailnet: open the link below on your phone or laptop."
  tailscale up --ssh=false
fi

log "4/6 Firewall: SSH only, from your home network and the tailnet; the model is reached through Tailscale"
ufw default deny incoming >/dev/null
ufw default allow outgoing >/dev/null
ufw allow from "$LAN" to any port 22 proto tcp >/dev/null
ufw allow in on tailscale0 to any port 22 proto tcp >/dev/null
ufw delete allow from "$LAN" to any port 11434 proto tcp >/dev/null 2>&1 || true   # the old rule, if this ran before
ufw --force enable
ufw status verbose | sed -n '1,20p'

log "5/6 Installing Ollama (the program that runs the model)"
if ! command -v ollama >/dev/null; then
  # Ollama's official installer (https://ollama.com/download/linux). OLLAMA_VERSION pins the release it fetches
  # (https://github.com/ollama/ollama/releases); the script itself has no checksum to pin.
  curl -fsSL https://ollama.com/install.sh | OLLAMA_VERSION="$OLLAMA_VERSION" sh
fi
mkdir -p /etc/systemd/system/ollama.service.d
cat > /etc/systemd/system/ollama.service.d/override.conf <<'EOF'
[Service]
# this machine only: Ollama has no authentication, so it must not listen on the network. Other devices reach it
# through `tailscale serve` below, which forwards tailnet connections to this address (and only those).
Environment="OLLAMA_HOST=127.0.0.1:11434"
# keep the model loaded so answers start fast
Environment="OLLAMA_KEEP_ALIVE=24h"
# room for task instructions + web pages
Environment="OLLAMA_CONTEXT_LENGTH=16384"
EOF
systemctl daemon-reload
systemctl enable --now ollama
systemctl restart ollama
sleep 3
systemctl is-active ollama
# publish port 11434 to the tailnet only (plain TCP forward; no Funnel, so never the public internet)
tailscale serve --bg --tcp 11434 tcp://127.0.0.1:11434
tailscale funnel status 2>/dev/null | grep -qi 'funnel on' && { echo "!! Funnel is on: turning it off"; tailscale funnel reset; } || true
tailscale serve status || true

log "6/6 Downloading the model $MODEL (several GB; depends on your internet)"
ollama pull "$MODEL"
ollama list

echo
echo "ALL DONE. Ollama listens on 127.0.0.1:11434 here and on port 11434 of this machine's Tailscale address"
echo "($(tailscale ip -4 2>/dev/null || echo '<tailscale ip>')) for your other devices; model: $MODEL"
