#!/usr/bin/env bash
# Private web search for the mini PC's model: SearXNG (open source, asks several search engines at
# once, keeps no logs) in a Docker container. It listens on this machine only (127.0.0.1:8888) and is
# published to your Tailscale tailnet with `tailscale serve`, the same way setup.sh publishes Ollama;
# nothing on the open network or the internet can reach it. In the app: Settings → Local model → search
# address http://<this machine's Tailscale name or IP>:8888
# Run once with:  sudo bash searxng.sh   (after setup.sh, which installs Tailscale)
set -euo pipefail
log() { echo; echo "=== $* ==="; }

log "1/4 Installing Docker"
export DEBIAN_FRONTEND=noninteractive
command -v docker >/dev/null || { apt-get update -q; apt-get -y -q install docker.io; }
systemctl enable --now docker

log "2/4 SearXNG settings (JSON answers on, no rate limiter: only this machine and your tailnet can reach it)"
mkdir -p /opt/searxng
if [ ! -f /opt/searxng/settings.yml ]; then
  cat > /opt/searxng/settings.yml <<EOF
use_default_settings: true
server:
  secret_key: "$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')"
  limiter: false
  image_proxy: false
search:
  safe_search: 0
  formats:
    - html
    - json
EOF
fi

log "3/4 Starting SearXNG (restarts by itself after reboots)"
docker rm -f searxng >/dev/null 2>&1 || true
# 127.0.0.1 in -p matters: a bare "-p 8888:8080" binds every interface and Docker's own iptables rules let it
# through before ufw gets a say, so the firewall would not have protected it.
docker run -d --name searxng --restart unless-stopped -p 127.0.0.1:8888:8080 \
  -v /opt/searxng:/etc/searxng:rw searxng/searxng:latest
ufw delete allow from 192.168.1.0/24 to any port 8888 proto tcp >/dev/null 2>&1 || true   # the old rule, if this ran before
# the tailnet reaches it through Tailscale (plain TCP forward; no Funnel, so never the public internet)
if command -v tailscale >/dev/null && tailscale status >/dev/null 2>&1; then
  tailscale serve --bg --tcp 8888 tcp://127.0.0.1:8888
  tailscale funnel status 2>/dev/null | grep -qi 'funnel on' && { echo "!! Funnel is on: turning it off"; tailscale funnel reset; } || true
else
  echo "!! Tailscale isn't running here, so only this machine can use SearXNG. Run setup.sh (or: tailscale up), then:"
  echo "   sudo tailscale serve --bg --tcp 8888 tcp://127.0.0.1:8888"
fi

log "4/4 Testing"
for i in $(seq 1 30); do curl -fs "http://127.0.0.1:8888/search?q=test&format=json" >/dev/null && break; sleep 2; done
curl -fs "http://127.0.0.1:8888/search?q=3d+print+headphone+hook&format=json" | head -c 300; echo
echo
echo "ALL DONE. SearXNG: http://127.0.0.1:8888 here, http://$(tailscale ip -4 2>/dev/null || echo '<tailscale ip>'):8888 from your other devices (tailnet only)"
