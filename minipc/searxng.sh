#!/usr/bin/env bash
# Private web search for the mini PC's model: SearXNG (open source, asks several search engines at
# once, keeps no logs) in a Docker container, reachable only from the home network on port 8888.
# Run once with:  sudo bash searxng.sh
set -euo pipefail
LAN="192.168.1.0/24"
log() { echo; echo "=== $* ==="; }

log "1/4 Installing Docker"
export DEBIAN_FRONTEND=noninteractive
command -v docker >/dev/null || { apt-get update -q; apt-get -y -q install docker.io; }
systemctl enable --now docker

log "2/4 SearXNG settings (JSON answers on, no rate limiter: only the home network can reach it)"
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
docker run -d --name searxng --restart unless-stopped -p 8888:8080 \
  -v /opt/searxng:/etc/searxng:rw searxng/searxng:latest
ufw allow from "$LAN" to any port 8888 proto tcp >/dev/null

log "4/4 Testing"
for i in $(seq 1 30); do curl -fs "http://127.0.0.1:8888/search?q=test&format=json" >/dev/null && break; sleep 2; done
curl -fs "http://127.0.0.1:8888/search?q=3d+print+headphone+hook&format=json" | head -c 300; echo
echo
echo "ALL DONE. SearXNG: http://192.168.1.192:8888 (home network only)"
