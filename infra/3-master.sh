#!/usr/bin/env bash
# Master VM. JMeter controller RMI settings + Node.js for the bench CLI.
# Usage: ssh azureuser@<master> "bash -s <master-public-ip>" < infra/3-master.sh
set -euo pipefail
PUBLIC_IP=$1
# Machine-level JMeter settings, picked up automatically by every jmeter run on this VM.
#   java.rmi.server.hostname: workers call back to the PUBLIC IP (no private network between VMs)
#   client.rmi.localport:     fixed callback ports 60000+ so the firewall can allow them
sudo sed -i '/^# bench-controller/,$d' /opt/jmeter/bin/system.properties /opt/jmeter/bin/user.properties
printf '# bench-controller\njava.rmi.server.hostname=%s\n' "$PUBLIC_IP" | sudo tee -a /opt/jmeter/bin/system.properties >/dev/null
printf '# bench-controller\nclient.rmi.localport=60000\nserver.rmi.ssl.disable=true\n' | sudo tee -a /opt/jmeter/bin/user.properties >/dev/null

# Node.js 22 LTS from nodejs.org (checksum verified)
if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 20 ]; then
  cd /tmp
  NODE=$(curl -fsSL https://nodejs.org/dist/latest-v22.x/SHASUMS256.txt | grep -o 'node-v22[0-9.]*-linux-x64.tar.xz' | head -1)
  curl -fsSL -o "$NODE" "https://nodejs.org/dist/latest-v22.x/$NODE"
  curl -fsSL https://nodejs.org/dist/latest-v22.x/SHASUMS256.txt | grep " $NODE\$" | sha256sum -c --status
  sudo tar -xJf "$NODE" -C /opt && rm -f "$NODE"
  sudo ln -sfn "/opt/${NODE%.tar.xz}" /opt/node
  for b in node npm npx; do sudo ln -sfn /opt/node/bin/$b /usr/local/bin/$b; done
fi
echo "$(hostname): node $(node -v), npm $(npm -v)"
tail -2 /opt/jmeter/bin/system.properties; tail -3 /opt/jmeter/bin/user.properties
