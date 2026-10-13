#!/usr/bin/env bash
# Installe le worker de test FBI « session persistante » sur le VPS (Debian/Ubuntu).
# Voir ops/fbi-session-worker/README.md. À lancer en root :
#
#   curl -fsSL https://raw.githubusercontent.com/anisfut1/ball-manager-back/main/ops/fbi-session-worker/install.sh \
#     | sudo bash -s -- <SUPABASE_URL> <SUPABASE_ANON_KEY>
#
# - accès DIRECT à FBI : le proxy Squid installé précédemment est arrêté et
#   désactivé (plus aucun intermédiaire) ;
# - aucun identifiant FBI ni clé Supabase sensible sur la machine : la clé
#   anon est publique, le jeton du worker ne permet QUE d'ajouter des lignes
#   au journal `fbi_probe_events` ;
# - relançable sans risque (mise à jour du code, jeton conservé).
set -euo pipefail

SUPABASE_URL="${1:?usage : install.sh <SUPABASE_URL> <SUPABASE_ANON_KEY>}"
SUPABASE_ANON_KEY="${2:?usage : install.sh <SUPABASE_URL> <SUPABASE_ANON_KEY>}"
REPO_URL="https://github.com/anisfut1/ball-manager-back.git"
APP_DIR=/opt/club-manager-api
ENV_FILE=/etc/fbi-session-worker.env
BROWSERS_DIR=/opt/ms-playwright
SERVICE=fbi-session-worker

[ "$(id -u)" -eq 0 ] || { echo "À lancer en root (sudo)." >&2; exit 1; }

echo "== 1/7 Proxy Squid : arrêt (le worker accède à FBI en direct)"
if systemctl cat squid.service >/dev/null 2>&1; then
  SQUID_PORT=$(awk '/^http_port/ {print $2; exit}' /etc/squid/squid.conf 2>/dev/null || true)
  systemctl disable --now squid || true
  # Seule la règle du port Squid est retirée du pare-feu, rien d'autre.
  if [ -n "${SQUID_PORT:-}" ] && command -v ufw >/dev/null; then ufw delete allow "${SQUID_PORT}/tcp" >/dev/null 2>&1 || true; fi
  echo "   Squid arrêté et désactivé${SQUID_PORT:+ (port $SQUID_PORT fermé)}."
else
  echo "   Squid absent."
fi

echo "== 2/7 Paquets système et Node.js 22"
apt-get update -qq
apt-get install -y -qq git ca-certificates curl openssl >/dev/null
if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 20 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
fi
echo "   node $(node -v)"

echo "== 3/7 Utilisateur dédié"
id fbiworker >/dev/null 2>&1 || useradd --system --home-dir /var/lib/$SERVICE --create-home --shell /usr/sbin/nologin fbiworker

echo "== 4/7 Code (dépôt public, lecture seule)"
if [ -d "$APP_DIR/.git" ]; then
  git -C "$APP_DIR" fetch --depth 1 origin main && git -C "$APP_DIR" reset --hard origin/main
else
  git clone --depth 1 "$REPO_URL" "$APP_DIR"
fi
cd "$APP_DIR"
npm ci --no-audit --no-fund --loglevel=error

echo "== 5/7 Chromium (profil persistant du worker)"
PLAYWRIGHT_BROWSERS_PATH=$BROWSERS_DIR npx playwright-core install --with-deps chromium
chmod -R a+rX $BROWSERS_DIR

echo "== 6/7 Configuration"
if [ ! -f "$ENV_FILE" ]; then
  TOKEN=$(openssl rand -hex 32)
  cat > "$ENV_FILE" <<EOF
FBI_WORKER_ID=ovh-$(hostname -s)
SUPABASE_URL=$SUPABASE_URL
SUPABASE_ANON_KEY=$SUPABASE_ANON_KEY
FBI_PROBE_TOKEN=$TOKEN
FBI_WORKER_TICK_MINUTES=15
# Recherche e-Marque en lecture seule à chaque passage (saison 2026-2027 = 1037) ; vider pour désactiver.
FBI_WORKER_SEARCH_SEASON_ID=1037
FBI_WORKER_SEARCH_MATCH=6
PLAYWRIGHT_BROWSERS_PATH=$BROWSERS_DIR
EOF
else
  sed -i "s#^SUPABASE_URL=.*#SUPABASE_URL=$SUPABASE_URL#; s#^SUPABASE_ANON_KEY=.*#SUPABASE_ANON_KEY=$SUPABASE_ANON_KEY#" "$ENV_FILE"
fi
chown root:fbiworker "$ENV_FILE"
chmod 640 "$ENV_FILE"

cat > /etc/systemd/system/$SERVICE.service <<EOF
[Unit]
Description=Worker de test FBI (session persistante, accès direct)
After=network-online.target
Wants=network-online.target

[Service]
User=fbiworker
Group=fbiworker
WorkingDirectory=$APP_DIR
EnvironmentFile=$ENV_FILE
Environment=FBI_WORKER_PROFILE_DIR=/var/lib/$SERVICE/profile
Environment=FBI_WORKER_LOG=/var/lib/$SERVICE/events.jsonl
Environment=FBI_WORKER_SOCKET=/run/$SERVICE/ctl.sock
StateDirectory=$SERVICE
RuntimeDirectory=$SERVICE
RuntimeDirectoryMode=0700
ExecStart=$APP_DIR/node_modules/.bin/tsx ops/fbi-session-worker/worker.ts
# Un redémarrage perd la session (cookie de session) : il est journalisé, sans reconnexion automatique.
Restart=on-failure
RestartSec=60

[Install]
WantedBy=multi-user.target
EOF

cat > /usr/local/bin/fbi-worker-ctl <<EOF
#!/usr/bin/env bash
# fbi-worker-ctl status | tick | login
cd $APP_DIR && FBI_WORKER_SOCKET=/run/$SERVICE/ctl.sock exec $APP_DIR/node_modules/.bin/tsx ops/fbi-session-worker/ctl.ts "\$@"
EOF
chmod 755 /usr/local/bin/fbi-worker-ctl

echo "== 7/7 Démarrage"
systemctl daemon-reload
systemctl enable $SERVICE >/dev/null
systemctl restart $SERVICE
sleep 8
systemctl --no-pager --lines=5 status $SERVICE || true

# shellcheck disable=SC1090
. "$ENV_FILE"
echo
echo "=============================================================="
echo "Worker installé. À transmettre (ce n'est PAS un secret) :"
echo "  worker_id    : $FBI_WORKER_ID"
echo "  empreinte    : $(printf '%s' "$FBI_PROBE_TOKEN" | sha256sum | cut -d' ' -f1)"
echo
echo "Ensuite, UNE connexion FBI (identifiants saisis au clavier) :"
echo "  sudo fbi-worker-ctl login"
echo "Suivi : sudo fbi-worker-ctl status   |   journalctl -u $SERVICE -f"
echo "=============================================================="
