#!/usr/bin/env bash
# Arrête et retire le service macOS du worker FBI/FFBB local.
# Le worker libère ses baux à l'arrêt : Vercel reprend la main aussitôt.
# Le mot de passe FBI éventuellement rangé dans le trousseau est conservé
# (le retirer : security delete-generic-password -s ball-manager-fbi -a fbi).
set -euo pipefail

LABEL="fr.ballmanager.fbi-local-worker"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

launchctl bootout "gui/$(id -u)/$LABEL" >/dev/null 2>&1 || true
rm -f "$PLIST"
echo "Service $LABEL arrêté et retiré."
