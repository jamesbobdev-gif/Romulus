#!/usr/bin/env bash
# One-time setup of the mini PC as the Tasks app's local AI computer (Ubuntu 26.04).
# Run once with:  sudo bash setup.sh
# What it does: updates Ubuntu, keeps the machine awake, firewalls it so only SSH gets in (from your home network,
# for fixing things), installs Ollama listening on this machine only, and downloads the model.
# Nothing here is reachable from your other devices, and nothing needs to be: the app on this machine takes the
# local tasks itself through sync (Settings → Local model → "Run local tasks here for all my devices"), and your
# other computers watch its browser and get its downloads the same way. No Tailscale, no VPN, no address to type.
# After this script: install Romulus here (the Linux .deb from the releases page: the AppImage needs --no-sandbox on
# newer Ubuntu, which this machine's keys shouldn't run without), connect it to sync like a phone (Settings → Device
# sync → Add a device, on a computer that already has it), set the local model to http://localhost:11434, pick the
# model, and switch the worker on. Leave the app open.
set -euo pipefail
LAN="192.168.1.0/24"          # devices allowed to SSH in from home Wi-Fi (check yours: ip -4 addr)
MODEL="hf.co/Hcompany/Holo4-35B-A3B-GGUF"   # the model in use (needs 32 GB); qwen3:8b fits a 16 GB box
OLLAMA_VERSION="0.40.7"       # the Ollama release to install (pinned; empty = whatever is newest)
USER_NAME="${SUDO_USER:-$(whoami)}"
log() { echo; echo "=== $* ==="; }

log "1/5 Updating Ubuntu (a few minutes)"
export DEBIAN_FRONTEND=noninteractive
apt-get update -q
apt-get -y -q full-upgrade
apt-get -y -q install curl ufw unattended-upgrades
# security updates on their own from now on: this machine holds keys and stays on for weeks at a time
echo "unattended-upgrades unattended-upgrades/enable_auto_updates boolean true" | debconf-set-selections
dpkg-reconfigure -f noninteractive unattended-upgrades

log "2/5 Keeping the mini PC awake (no suspend or hibernate)"
systemctl mask sleep.target suspend.target hibernate.target hybrid-sleep.target >/dev/null
# the login screen's own idle-suspend too
sudo -u gdm dbus-run-session gsettings set org.gnome.settings-daemon.plugins.power sleep-inactive-ac-type 'nothing' 2>/dev/null || true
sudo -u "$USER_NAME" DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$(id -u "$USER_NAME")/bus" \
  gsettings set org.gnome.settings-daemon.plugins.power sleep-inactive-ac-type 'nothing' 2>/dev/null || true

log "3/5 Firewall: SSH only, from your home network; the model is never reached over the network"
ufw default deny incoming >/dev/null
ufw default allow outgoing >/dev/null
# "limit", not "allow": six tries a minute from one address, so a guessed password takes forever
ufw delete allow from "$LAN" to any port 22 proto tcp >/dev/null 2>&1 || true
ufw limit from "$LAN" to any port 22 proto tcp >/dev/null
# rules from earlier versions of this script (Ollama on the LAN, SSH over Tailscale), if it ran before
ufw delete allow from "$LAN" to any port 11434 proto tcp >/dev/null 2>&1 || true
ufw delete allow in on tailscale0 to any port 22 proto tcp >/dev/null 2>&1 || true
ufw --force enable
ufw status verbose | sed -n '1,20p'
# Tailscale from an earlier version of this script: no longer needed, nothing reaches this machine that way. An
# earlier version also published Ollama to the tailnet with "tailscale serve", which goes round ufw: turned off here.
if command -v tailscale >/dev/null; then
  if tailscale serve status 2>/dev/null | grep -q 11434; then tailscale serve --tcp 11434 off 2>/dev/null || true; fi
  echo "Tailscale is installed from before. The app doesn't use it any more; remove it when you like:"
  echo "   sudo tailscale down; sudo apt-get remove tailscale"
fi
# SSH, when it is installed: keys only, no root. Only once this user has a key in place, or the next login would
# be locked out; until then the script says so.
HOME_DIR="$(getent passwd "$USER_NAME" | cut -d: -f6)"
if systemctl is-enabled ssh >/dev/null 2>&1 || systemctl is-enabled sshd >/dev/null 2>&1; then
  if [ -s "$HOME_DIR/.ssh/authorized_keys" ]; then
    mkdir -p /etc/ssh/sshd_config.d
    cat > /etc/ssh/sshd_config.d/60-romulus.conf <<EOF
# written by minipc/setup.sh: this machine holds keys, so SSH takes a key, never a password
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin no
AllowUsers $USER_NAME
EOF
    sshd -t && (systemctl reload ssh 2>/dev/null || systemctl reload sshd 2>/dev/null || true)
    echo "SSH: keys only, for $USER_NAME"
  else
    echo "SSH is on and still takes passwords: put your laptop's public key in $HOME_DIR/.ssh/authorized_keys and run this again"
  fi
fi
# the app's folder here holds the sealed keys and the key that seals them: this user only
install -d -m 700 -o "$USER_NAME" -g "$USER_NAME" "$HOME_DIR/.config/Romulus"
chmod 600 "$HOME_DIR/.config/Romulus"/*.json "$HOME_DIR/.config/Romulus"/*.key 2>/dev/null || true

log "4/5 Installing Ollama (the program that runs the model)"
if ! command -v ollama >/dev/null; then
  # Ollama's official installer (https://ollama.com/download/linux). OLLAMA_VERSION pins the release it fetches
  # (https://github.com/ollama/ollama/releases); the script itself has no checksum to pin.
  curl -fsSL https://ollama.com/install.sh | OLLAMA_VERSION="$OLLAMA_VERSION" sh
fi
mkdir -p /etc/systemd/system/ollama.service.d
cat > /etc/systemd/system/ollama.service.d/override.conf <<'EOF'
[Service]
# this machine only: Ollama has no authentication, so it must not listen on the network. Only the Tasks app
# running on this same machine talks to it.
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

log "5/5 Downloading the model $MODEL (several GB; depends on your internet)"
ollama pull "$MODEL"
ollama list

echo
echo "ALL DONE. Ollama listens on 127.0.0.1:11434 here only; model: $MODEL"
echo "Next: install Romulus on this machine, connect it to sync, set Local model to http://localhost:11434,"
echo "pick $MODEL, and switch on 'Run local tasks here for all my devices'. Leave the app open."
echo "Optional: minipc/qwen-browser.service (a browser the model can drive) and minipc/searxng.sh (private web search)."
