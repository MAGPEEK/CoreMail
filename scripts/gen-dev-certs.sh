#!/usr/bin/env bash
# Erstellt selbstsignierte TLS-Zertifikate für die lokale Entwicklung.
# Produktiv: echte Zertifikate (Let's Encrypt / cert-manager) verwenden.
set -euo pipefail

CERTS_DIR="$(dirname "$0")/../infra/docker/nginx/certs"
mkdir -p "$CERTS_DIR"

HOSTNAME="${MAIL_HOSTNAME:-mail.localhost}"

echo "→ Generiere selbstsigniertes Zertifikat für: $HOSTNAME"

openssl req -x509 -nodes -newkey rsa:4096 \
  -keyout "$CERTS_DIR/privkey.pem" \
  -out    "$CERTS_DIR/fullchain.pem" \
  -days   3650 \
  -subj   "/C=DE/ST=Bayern/L=Muenchen/O=CoreMail Dev/CN=$HOSTNAME" \
  -addext "subjectAltName=DNS:$HOSTNAME,DNS:localhost,IP:127.0.0.1"

chmod 600 "$CERTS_DIR/privkey.pem"
chmod 644 "$CERTS_DIR/fullchain.pem"

echo "✓ Zertifikate erstellt:"
echo "  $CERTS_DIR/fullchain.pem"
echo "  $CERTS_DIR/privkey.pem"
echo ""
echo "⚠  Selbstsignierte Zertifikate — Browser-Warnung akzeptieren oder"
echo "   das CA-Zertifikat im System-Keystore vertrauen."
