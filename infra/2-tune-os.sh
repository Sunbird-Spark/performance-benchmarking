#!/usr/bin/env bash
# All VMs. Load-generator OS tuning: more ephemeral ports, fast socket reuse, high file limits.
# Usage: ssh azureuser@<vm> "bash -s" < infra/2-tune-os.sh
set -euo pipefail
sudo tee /etc/sysctl.d/90-jmeter.conf >/dev/null <<'CONF'
net.ipv4.ip_local_port_range = 1024 65535
net.ipv4.tcp_tw_reuse = 1
net.ipv4.tcp_fin_timeout = 15
net.core.somaxconn = 4096
fs.file-max = 1048576
CONF
sudo sysctl -q --system
sudo tee /etc/security/limits.d/90-jmeter.conf >/dev/null <<'CONF'
azureuser soft nofile 65535
azureuser hard nofile 65535
CONF
echo "$(hostname): tuned"
