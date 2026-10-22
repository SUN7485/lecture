#!/usr/bin/env bash
# Provision a fresh Oracle Cloud "Always Free" Ampere A1 instance to run
# Lecture Studio. Ubuntu 22.04/24.04 ARM64. Run once, as a sudo-capable user.
#
#   curl -fsSL https://raw.githubusercontent.com/<you>/lecture-studio/main/deploy/oracle-setup.sh | bash
#
# Idempotent: safe to re-run.
set -euo pipefail

log() { printf '\n\033[1;36m==>\033[0m %s\n' "$*"; }
die() { printf '\n\033[1;31mERROR:\033[0m %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] && die "Run as a normal sudo user, not root."

log "Architecture: $(uname -m)  Kernel: $(uname -r)"

log "Updating packages"
sudo apt-get update -y
sudo apt-get upgrade -y

log "Installing Docker Engine + compose plugin"
if ! command -v docker >/dev/null 2>&1; then
  sudo apt-get install -y ca-certificates curl gnupg
  sudo install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg \
    | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
  sudo chmod a+r /etc/apt/keyrings/docker.gpg
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
    | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
  sudo apt-get update -y
  sudo apt-get install -y docker-ce docker-ce-cli containerd.io \
      docker-buildx-plugin docker-compose-plugin
fi
sudo usermod -aG docker "$USER" || true

# ---------------------------------------------------------------------------
# THE ORACLE GOTCHA. Oracle's Ubuntu images ship an iptables ruleset that
# REJECTs everything except SSH, and it survives reboots via netfilter-persistent.
# Opening 80/443 in the VCN security list is necessary and NOT sufficient — the
# request reaches the instance and is dropped there. Every "my Oracle VM won't
# serve traffic" thread is this. Both layers must be opened.
# ---------------------------------------------------------------------------
log "Opening ports 80/443 in the instance firewall"
if command -v iptables >/dev/null 2>&1; then
  for port in 80 443; do
    if ! sudo iptables -C INPUT -p tcp --dport "$port" -j ACCEPT 2>/dev/null; then
      # Insert ABOVE the catch-all REJECT rather than appending after it.
      sudo iptables -I INPUT 6 -p tcp --dport "$port" -m state --state NEW,ESTABLISHED -j ACCEPT
    fi
  done
  sudo apt-get install -y iptables-persistent >/dev/null 2>&1 || true
  sudo netfilter-persistent save || sudo sh -c 'iptables-save > /etc/iptables/rules.v4' || true
fi
# Some images use firewalld/ufw instead.
command -v firewall-cmd >/dev/null 2>&1 && {
  sudo firewall-cmd --permanent --add-service=http  || true
  sudo firewall-cmd --permanent --add-service=https || true
  sudo firewall-cmd --reload || true
}
command -v ufw >/dev/null 2>&1 && sudo ufw allow 80/tcp && sudo ufw allow 443/tcp || true

log "Adding swap (the free tier has plenty of RAM, but Chromium spikes)"
if [ ! -f /swapfile ]; then
  sudo fallocate -l 2G /swapfile
  sudo chmod 600 /swapfile
  sudo mkswap /swapfile
  sudo swapon /swapfile
  echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab > /dev/null
fi

log "Enabling automatic security updates"
sudo apt-get install -y unattended-upgrades >/dev/null 2>&1 || true

cat <<'NEXT'

============================================================
Host is ready. Remaining steps:

1. In the ORACLE CONSOLE, add ingress rules to your VCN security list:
      Source 0.0.0.0/0, TCP, destination port 80
      Source 0.0.0.0/0, TCP, destination port 443
   (This script opened the instance firewall; the VCN is the other layer.)

2. Point your domain's A record at this instance's public IP.

3. Deploy:
      git clone <YOUR_REPO_URL> lecture-studio
      cd lecture-studio
      cp .env.example .env
      nano .env            # set DOMAIN and SOURCE_URL
      docker compose up -d --build

4. Watch it come up:
      docker compose logs -f
      curl -sf https://<your-domain>/healthz

NOTE: log out and back in before running docker without sudo
      (the docker group membership only applies to new sessions).
============================================================
NEXT
