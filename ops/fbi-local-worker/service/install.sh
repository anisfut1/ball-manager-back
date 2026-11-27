#!/usr/bin/env bash
# Installe le worker FBI/FFBB local comme service macOS (LaunchAgent) :
# il démarre à l'ouverture de session, redémarre seul s'il s'arrête en erreur,
# et empêche la mise en veille du Mac tant qu'il tourne (caffeinate, secteur
# branché ; capot fermé sur batterie, le Mac dort quand même).
#
# À lancer depuis la racine du dépôt cloné sur le Mac (ex. ~/fbi-test) :
#   bash ops/fbi-local-worker/service/install.sh
#
# Relancer le script met le service à jour (après un git pull par exemple).
# Désinstaller : bash ops/fbi-local-worker/service/uninstall.sh
set -euo pipefail

LABEL="fr.ballmanager.fbi-local-worker"
KEYCHAIN_SERVICE="ball-manager-fbi"
KEYCHAIN_ACCOUNT="fbi"

if [ "$(uname -s)" != "Darwin" ]; then
  echo "Ce script est prévu pour macOS (LaunchAgent)." >&2
  exit 1
fi

REPO_DIR="$(cd "$(dirname "$0")/../../.." && pwd)"
cd "$REPO_DIR"

if [ ! -f .env.fbi-local ]; then
  echo "Fichier .env.fbi-local introuvable dans $REPO_DIR : voir ops/fbi-local-worker/README.md." >&2
  exit 1
fi

NODE_BIN="$(command -v node || true)"
if [ -z "$NODE_BIN" ]; then
  echo "node introuvable dans le PATH : lance ce script depuis le Terminal où « npm run fbi:local-worker » fonctionne." >&2
  exit 1
fi
NODE_DIR="$(dirname "$NODE_BIN")"

if [ ! -x node_modules/.bin/tsx ]; then
  echo "Dépendances absentes : lance d'abord « npm ci »." >&2
  exit 1
fi

# Mot de passe FBI : inutile si la clé de chiffrement est dans .env.fbi-local.
# Sinon, rangé dans le trousseau macOS (saisi ici par toi, jamais écrit en clair).
if grep -Eq '^FBI_CREDENTIALS_ENCRYPTION_KEY=.+' .env.fbi-local; then
  echo "Clé de chiffrement présente dans .env.fbi-local : pas besoin du trousseau."
elif security find-generic-password -s "$KEYCHAIN_SERVICE" -a "$KEYCHAIN_ACCOUNT" >/dev/null 2>&1; then
  echo "Mot de passe FBI déjà présent dans le trousseau (entrée « $KEYCHAIN_SERVICE »)."
else
  echo "Le service n'a pas de terminal pour te demander le mot de passe FBI."
  echo "Il va être rangé dans ton trousseau macOS (entrée « $KEYCHAIN_SERVICE »)."
  security add-generic-password -U -s "$KEYCHAIN_SERVICE" -a "$KEYCHAIN_ACCOUNT" -l "Ball Manager — mot de passe FBI" -w
  echo "Mot de passe FBI enregistré dans le trousseau."
fi

PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG="$HOME/Library/Logs/ball-manager-fbi-worker.log"
mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs"

cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$LABEL</string>
  <key>WorkingDirectory</key>
  <string>$REPO_DIR</string>
  <key>ProgramArguments</key>
  <array>
    <string>$REPO_DIR/node_modules/.bin/tsx</string>
    <string>ops/fbi-local-worker/run.ts</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <!-- Empêche la veille du Mac tant que le worker tourne (caffeinate lancé par le worker). -->
    <key>FBI_LOCAL_CAFFEINATE</key>
    <string>1</string>
    <key>PATH</key>
    <string>$NODE_DIR:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <!-- Redémarre après un arrêt en erreur, pas après un arrêt demandé. -->
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <!-- Au plus un redémarrage toutes les 5 min (le worker n'enchaîne de toute façon pas deux connexions FBI à moins de 12 min). -->
  <key>ThrottleInterval</key>
  <integer>300</integer>
  <key>StandardOutPath</key>
  <string>$LOG</string>
  <key>StandardErrorPath</key>
  <string>$LOG</string>
</dict>
</plist>
PLIST

DOMAIN="gui/$(id -u)"
launchctl bootout "$DOMAIN/$LABEL" >/dev/null 2>&1 || true
launchctl bootstrap "$DOMAIN" "$PLIST"
launchctl enable "$DOMAIN/$LABEL"

echo
echo "Service installé et démarré : $LABEL"
echo "  Journal      : tail -f \"$LOG\""
echo "  État         : launchctl print $DOMAIN/$LABEL | grep -E 'state|pid|last exit'"
echo "  Redémarrer   : launchctl kickstart -k $DOMAIN/$LABEL"
echo "  Désinstaller : bash ops/fbi-local-worker/service/uninstall.sh"
