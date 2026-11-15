#!/usr/bin/env bash
# Private web search for the mini PC's model: SearXNG (open source, asks several search engines at
# once, keeps no logs) in a Docker container. It listens on this machine only (127.0.0.1:8888): the app
# on this machine (the worker) is the only thing that asks it, so nothing on the network or the internet
# can reach it. In the app here: config.json → localModel.search = "http://127.0.0.1:8888"
# Run once with:  sudo bash searxng.sh   (after setup.sh)
set -euo pipefail
log() { echo; echo "=== $* ==="; }

log "1/4 Installing Docker"
export DEBIAN_FRONTEND=noninteractive
command -v docker >/dev/null || { apt-get update -q; apt-get -y -q install docker.io; }
systemctl enable --now docker

log "2/4 SearXNG settings (JSON answers on, no rate limiter: only this machine can reach it)"
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
chmod 600 /opt/searxng/settings.yml # the secret key inside: root only

log "3/4 Starting SearXNG (restarts by itself after reboots)"
docker rm -f searxng >/dev/null 2>&1 || true
# 127.0.0.1 in -p matters: a bare "-p 8888:8080" binds every interface and Docker's own iptables rules let it
# through before ufw gets a say, so the firewall would not have protected it.
# The container's log holds every search (a task's words): kept to 30 MB. No new privileges inside it. The image is
# the newest at the time (searxng publishes no fixed tags); to pin what runs, note "docker images --digests" and
# put searxng/searxng@sha256:... here.
docker run -d --name searxng --restart unless-stopped -p 127.0.0.1:8888:8080 \
  --log-opt max-size=10m --log-opt max-file=3 --security-opt no-new-privileges \
  -v /opt/searxng:/etc/searxng:rw searxng/searxng:latest
ufw delete allow from 192.168.1.0/24 to any port 8888 proto tcp >/dev/null 2>&1 || true   # the old rule, if this ran before
# an earlier version of this script published it to a Tailscale tailnet: not any more, this machine only
if command -v tailscale >/dev/null && tailscale serve status 2>/dev/null | grep -q 8888; then tailscale serve --tcp 8888 off 2>/dev/null || true; fi

log "4/4 Testing"
for i in $(seq 1 30); do curl -fs "http://127.0.0.1:8888/search?q=test&format=json" >/dev/null && break; sleep 2; done
curl -fs "http://127.0.0.1:8888/search?q=3d+print+headphone+hook&format=json" | head -c 300; echo
echo
echo "ALL DONE. SearXNG: http://127.0.0.1:8888, this machine only (localModel.search in the app's config.json here)"
