#!/usr/bin/env bash
# Creates self-signed TLS certificates for local development.
# Production: use real certificates (Let's Encrypt / cert-manager).
set -euo pipefail

CERTS_DIR="$(dirname "$0")/../infra/docker/nginx/certs"
mkdir -p "$CERTS_DIR"

HOSTNAME="${MAIL_HOSTNAME:-mail.localhost}"

echo "→ Generating self-signed certificate for: $HOSTNAME"

openssl req -x509 -nodes -newkey rsa:4096 \
  -keyout "$CERTS_DIR/privkey.pem" \
  -out    "$CERTS_DIR/fullchain.pem" \
  -days   3650 \
  -subj   "/C=DE/ST=Bayern/L=Muenchen/O=CoreMail Dev/CN=$HOSTNAME" \
  -addext "subjectAltName=DNS:$HOSTNAME,DNS:localhost,IP:127.0.0.1"

chmod 600 "$CERTS_DIR/privkey.pem"
chmod 644 "$CERTS_DIR/fullchain.pem"

echo "✓ Certificates created:"
echo "  $CERTS_DIR/fullchain.pem"
echo "  $CERTS_DIR/privkey.pem"
echo ""
echo "⚠  Self-signed certificates — accept the browser warning or"
echo "   trust the CA certificate in the system keystore."
