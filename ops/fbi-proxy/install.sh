#!/usr/bin/env bash
# Proxy à adresse IP fixe pour l'accès à FBI (voir docs/FBI.md « Proxy à IP fixe »).
# À lancer UNE fois sur un VPS Ubuntu (22.04 / 24.04) :
#   curl -fsSL https://raw.githubusercontent.com/anisfut1/ball-manager-back/main/ops/fbi-proxy/install.sh | sudo bash
#
# - Squid avec mot de passe (généré ici, jamais transmis ailleurs que sur cet écran).
# - Destinations limitées aux sites FFBB (*.ffbb.com) en HTTPS : inutilisable pour autre chose.
# - Aucun journal des connexions, aucun en-tête révélant le proxy.
# - Pare-feu : SSH + port du proxy uniquement. Mises à jour de sécurité automatiques.
# Relancer le script régénère le mot de passe (il faudra alors mettre à jour Vercel).
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "Lance ce script avec sudo." >&2
  exit 1
fi

export DEBIAN_FRONTEND=noninteractive
echo "Installation (1 à 2 minutes)…"
apt-get update -qq
apt-get install -y -qq squid apache2-utils ufw unattended-upgrades curl openssl >/dev/null

PORT_FILE=/etc/squid/fbi-port
if [ -s "$PORT_FILE" ]; then PORT=$(cat "$PORT_FILE"); else PORT=$(shuf -i 20000-60000 -n 1); echo "$PORT" > "$PORT_FILE"; fi
USER_NAME=fbi
PASSWORD=$(openssl rand -hex 24)

htpasswd -bcB /etc/squid/fbi-passwd "$USER_NAME" "$PASSWORD" >/dev/null 2>&1
chown proxy:proxy /etc/squid/fbi-passwd
chmod 640 /etc/squid/fbi-passwd

cat > /etc/squid/squid.conf <<CONF
http_port ${PORT}

auth_param basic program /usr/lib/squid/basic_ncsa_auth /etc/squid/fbi-passwd
auth_param basic realm fbi-proxy
auth_param basic credentialsttl 2 hours
acl fbi_users proxy_auth REQUIRED

acl ffbb dstdomain .ffbb.com
acl SSL_ports port 443
acl Safe_ports port 80 443
acl CONNECT method CONNECT

http_access deny !Safe_ports
http_access deny CONNECT !SSL_ports
http_access deny !fbi_users
http_access allow fbi_users ffbb
http_access deny all

via off
forwarded_for delete
request_header_access X-Forwarded-For deny all
access_log none
cache_log /dev/null
cache deny all
cache_mem 16 MB
CONF

systemctl enable squid >/dev/null 2>&1
systemctl restart squid

ufw allow OpenSSH >/dev/null
ufw allow "${PORT}/tcp" >/dev/null
ufw --force enable >/dev/null

dpkg-reconfigure -f noninteractive unattended-upgrades >/dev/null 2>&1 || true

PUBLIC_IP=$(curl -4 -fsS --max-time 10 https://api.ipify.org || ip -4 route get 1.1.1.1 | awk '{for (i=1;i<=NF;i++) if ($i=="src") print $(i+1)}')
PROXY_URL="http://${USER_NAME}:${PASSWORD}@${PUBLIC_IP}:${PORT}"
umask 077
echo "$PROXY_URL" > /root/fbi-proxy-url.txt

sleep 2
FBI_TEST=$(curl -s -o /dev/null --max-time 30 -w "%{http_code} en %{time_total}s" -x "http://${USER_NAME}:${PASSWORD}@127.0.0.1:${PORT}" https://extranet.ffbb.com/fbi/connexion.fbi || echo "échec")
OTHER_TEST=$(curl -s -o /dev/null --max-time 15 -w "%{http_connect}" -x "http://${USER_NAME}:${PASSWORD}@127.0.0.1:${PORT}" https://www.google.com || true)

echo
echo "=================================================================="
echo " Proxy FBI installé."
echo " Test FBI via le proxy : HTTP ${FBI_TEST}   (attendu : 200)"
echo " Test d'un autre site  : HTTP ${OTHER_TEST}   (attendu : 403, bloqué)"
echo
echo " À ajouter dans Vercel (projet club-manager-api) :"
echo "   Nom    : FBI_PROXY_URL"
echo "   Valeur : ${PROXY_URL}"
echo
echo " Valeur gardée ici : sudo cat /root/fbi-proxy-url.txt"
echo " Ne la colle jamais dans un chat ni un message."
echo "=================================================================="
