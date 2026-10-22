#!/usr/bin/env bash
# One-time setup of the mini PC as the Tasks app's local AI server (Ubuntu 26.04).
# Run once with:  sudo bash setup.sh
# What it does: updates Ubuntu, keeps the machine awake, firewalls it to the home network,
# installs Ollama listening on the home network, and downloads the model.
set -euo pipefail
LAN="192.168.1.0/24"          # devices allowed in (your home network)
MODEL="qwen3.5:9b"            # fits 16 GB; switch to qwen3.6:35b-a3b once the second memory stick is in
USER_NAME="${SUDO_USER:-$(whoami)}"
log() { echo; echo "=== $* ==="; }

log "1/5 Updating Ubuntu (a few minutes)"
export DEBIAN_FRONTEND=noninteractive
apt-get update -q
apt-get -y -q full-upgrade
apt-get -y -q install curl ufw

log "2/5 Keeping the mini PC awake (no suspend or hibernate)"
systemctl mask sleep.target suspend.target hibernate.target hybrid-sleep.target >/dev/null
# the login screen's own idle-suspend too
sudo -u gdm dbus-run-session gsettings set org.gnome.settings-daemon.plugins.power sleep-inactive-ac-type 'nothing' 2>/dev/null || true
sudo -u "$USER_NAME" DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$(id -u "$USER_NAME")/bus" \
  gsettings set org.gnome.settings-daemon.plugins.power sleep-inactive-ac-type 'nothing' 2>/dev/null || true

log "3/5 Firewall: only your home network may connect (SSH + the AI)"
ufw default deny incoming >/dev/null
ufw default allow outgoing >/dev/null
ufw allow from "$LAN" to any port 22 proto tcp >/dev/null
ufw allow from "$LAN" to any port 11434 proto tcp >/dev/null
ufw --force enable
ufw status verbose | sed -n '1,20p'

log "4/5 Installing Ollama (the program that runs the model)"
if ! command -v ollama >/dev/null; then
  curl -fsSL https://ollama.com/install.sh | sh
fi
mkdir -p /etc/systemd/system/ollama.service.d
cat > /etc/systemd/system/ollama.service.d/override.conf <<'EOF'
[Service]
# reachable from the home network (the firewall keeps everyone else out)
Environment="OLLAMA_HOST=0.0.0.0:11434"
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

log "5/5 Downloading the model $MODEL (several GB; depends on your internet)"
ollama pull "$MODEL"
ollama list

echo
echo "ALL DONE. Ollama is listening on port 11434; model: $MODEL"
