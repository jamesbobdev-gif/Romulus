# The local model's computer: a check-up

What to run on the mini PC now and then (as the user the app runs as; `sudo` where shown), and what a good answer
looks like. `minipc/setup.sh` sets most of this up; this is how to see that it held. Everything the app needs
listens on that computer alone, and your other devices reach it only through the sync server.

| Check | Command | Good answer |
| --- | --- | --- |
| What listens | `sudo ss -tulpn` | Only `127.0.0.1:11434` (Ollama), `127.0.0.1:8888` (search), `127.0.0.1:9334` and `127.0.0.1:9336` (the browser), and port 22 if you use SSH. Nothing on `0.0.0.0` or the computer's own address besides 22. |
| Firewall | `sudo ufw status verbose` | `Status: active`, `Default: deny (incoming)`, one rule for 22 from your home network (`LIMIT`), no 11434 or 8888 rules. |
| Docker's own holes | `sudo iptables -t nat -S DOCKER` | Only a line for 8888 with `-d 127.0.0.1`. |
| Tailscale left over | `command -v tailscale && tailscale serve status` | Not installed, or `serve` shows nothing. Else `sudo tailscale serve --tcp 11434 off; sudo tailscale down; sudo apt-get remove tailscale`. |
| SSH | `systemctl is-active ssh; sudo sshd -T \| grep -E 'passwordauth\|kbdinteractive\|permitrootlogin'` | Inactive, or `passwordauthentication no`, `kbdinteractiveauthentication no`, `permitrootlogin no`, and `~/.ssh/authorized_keys` holds only your own computer's key. |
| Services | `systemctl cat ollama \| grep -E 'User=\|OLLAMA_HOST'; systemctl --user list-units --all \| grep -iE 'qwen\|tasks\|romulus'` | `User=ollama` and `OLLAMA_HOST=127.0.0.1:11434`; only `qwen-browser.service` among your user units; no old `tasks-hub.service`. |
| Docker group | `id` | No `docker` group (being in it is the same as root). |
| The app's folder | `ls -la ~/.config/Romulus; stat -c '%a %n' ~/.config/Romulus/config.key` | The folder `700`, `config.key` `600`, `config.json` `600`. If not: `chmod 700 ~/.config/Romulus; chmod 600 ~/.config/Romulus/*`. |
| Keys really sealed | `grep -o '"enc:v[12]:' ~/.config/Romulus/config.json \| sort \| uniq -c; grep -c 'plain text' ~/.config/Romulus/agent-runner.log` | Only `enc:v2:` entries, and no "kept as plain text" line in the log. |
| The browser's profile | `stat -c '%a' ~/qwen-browser/profile` | `700`. |
| The browser's flags | `ps -o args= -C chromium \| head -1` | `--remote-debugging-address=127.0.0.1`, no `--no-sandbox`, no `--disable-web-security`, no `--load-extension`. |
| The app's sandbox | `dpkg -l romulus; ps -o args= -C romulus \| grep -c no-sandbox` | Installed from the `.deb`, and `0`. |
| Who can sit down at it | `grep -i automaticlogin /etc/gdm3/custom.conf; gsettings get org.gnome.desktop.screensaver lock-enabled` | Your choice, made knowingly: with automatic login on, anyone at the keyboard has every key on this computer, so keep it where nobody else sits. |
| The disk | `lsblk -f` | A `crypto_LUKS` root. Without it, the keys are readable from the drive; there is no way to add it later but a reinstall. |
| The firmware | At boot | A firmware (BIOS) password, booting from USB and the network off, "power on after power loss" on. |
| Updates | `systemctl is-enabled unattended-upgrades; cat /etc/apt/apt.conf.d/20auto-upgrades; snap refresh --list` | Enabled, `Unattended-Upgrade "1"`, nothing waiting for Chromium. |
| Search container | `docker inspect searxng --format '{{.HostConfig.LogConfig}}'; sudo stat -c '%a %U' /opt/searxng/settings.yml` | `max-size` set; `600 root`. |
| Logs | `tail -50 ~/.config/Romulus/agent-runner.log` | Status lines only: no keys, no task text. |

What this computer can't be protected from: someone with the disk, or at the keyboard while it is signed in, has
the sealed keys and the key that seals them (`config.key` sits next to `config.json` on purpose, so the app can start
with nobody signed in). The screen shows the browser's pages to anyone in the room, and the live view shows them to
every device holding the Agent key. Those are the trade-offs of a computer that works while you are away.
