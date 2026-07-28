#!/bin/sh
set -eu

if [ "$(id -u)" -ne 0 ]; then
  echo "Run this installer with root authority: sudo sh install-service.sh" >&2
  exit 1
fi

repo_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
chown -R root:root "$repo_dir/bridge"
chmod -R u+rwX,go-rwx "$repo_dir/bridge"
chown root:root "$repo_dir/bridge.config.json"
chmod 0600 "$repo_dir/bridge.config.json"
install -m 0644 "$repo_dir/codex-meta-bridge.service" /etc/systemd/system/codex-meta-bridge.service
systemctl daemon-reload
systemctl enable codex-meta-bridge.service
systemctl restart codex-meta-bridge.service
systemctl --no-pager --full status codex-meta-bridge.service
