#!/usr/bin/env bash
# Push SMTP config + Dutch email templates to Supabase Auth via Management API.
#
# Requires in .env.local:
#   SUPABASE_ACCESS_TOKEN     (sbp_...)
#   MAILGUN_SMTP_HOST
#   MAILGUN_SMTP_PORT
#   MAILGUN_SMTP_USER
#   MAILGUN_SMTP_PASSWORD
#   MAILGUN_SENDER_EMAIL
#   MAILGUN_SENDER_NAME
#
# Usage: ./push-smtp.sh

set -euo pipefail

PROJECT_REF="bamjpsquhdzxvsymldpq"
ENV_FILE=".env.local"
TEMPLATES_DIR="supabase/email-templates"

cd "$(dirname "$0")"

if [ ! -f "$ENV_FILE" ]; then
  echo "❌ $ENV_FILE bestaat niet."
  exit 1
fi

# Load .env.local (export each line)
set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a

required=(SUPABASE_ACCESS_TOKEN MAILGUN_SMTP_HOST MAILGUN_SMTP_PORT MAILGUN_SMTP_USER MAILGUN_SMTP_PASSWORD MAILGUN_SENDER_EMAIL MAILGUN_SENDER_NAME)
missing=()
for k in "${required[@]}"; do
  v="${!k:-}"
  if [ -z "$v" ]; then missing+=("$k"); fi
done
if [ ${#missing[@]} -gt 0 ]; then
  echo "❌ Vul in $ENV_FILE eerst in: ${missing[*]}"
  exit 1
fi

if [ ! -d "$TEMPLATES_DIR" ]; then
  echo "❌ $TEMPLATES_DIR niet gevonden."
  exit 1
fi

API="https://api.supabase.com/v1/projects/$PROJECT_REF/config/auth"

# Read templates as JSON-escaped strings
esc() {
  python3 -c 'import json,sys; print(json.dumps(open(sys.argv[1]).read()))' "$1"
}

CONFIRM=$(esc "$TEMPLATES_DIR/confirm-signup.html")
RESET=$(esc "$TEMPLATES_DIR/reset-password.html")
MAGIC=$(esc "$TEMPLATES_DIR/magic-link.html")
INVITE=$(esc "$TEMPLATES_DIR/invite-user.html")

# Build JSON payload
PAYLOAD=$(cat <<EOF
{
  "external_email_enabled": true,
  "mailer_secure_email_change_enabled": true,
  "mailer_autoconfirm": false,
  "smtp_admin_email": "$MAILGUN_SENDER_EMAIL",
  "smtp_host": "$MAILGUN_SMTP_HOST",
  "smtp_port": "$MAILGUN_SMTP_PORT",
  "smtp_user": "$MAILGUN_SMTP_USER",
  "smtp_pass": "$MAILGUN_SMTP_PASSWORD",
  "smtp_sender_name": "$MAILGUN_SENDER_NAME",
  "smtp_max_frequency": 1,
  "mailer_subjects_confirmation": "Bevestig je e-mailadres voor Stagetimer",
  "mailer_subjects_recovery": "Reset je Stagetimer-wachtwoord",
  "mailer_subjects_magic_link": "Je Stagetimer login-link",
  "mailer_subjects_invite": "Je bent uitgenodigd voor Stagetimer",
  "mailer_subjects_email_change": "Bevestig je nieuwe e-mailadres",
  "mailer_templates_confirmation_content": $CONFIRM,
  "mailer_templates_recovery_content": $RESET,
  "mailer_templates_magic_link_content": $MAGIC,
  "mailer_templates_invite_content": $INVITE
}
EOF
)

echo "→ Pushing SMTP + templates naar Supabase project $PROJECT_REF..."

HTTP_CODE=$(curl -s -o /tmp/supabase-smtp-resp.json -w "%{http_code}" \
  -X PATCH "$API" \
  -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d "$PAYLOAD")

if [ "$HTTP_CODE" = "200" ] || [ "$HTTP_CODE" = "204" ]; then
  echo "✅ SMTP + templates gepusht (HTTP $HTTP_CODE)."
  echo ""
  echo "Volgende stap: test een signup via stagetimer.nl. Mail moet binnen 30s aankomen."
else
  echo "❌ Push mislukt (HTTP $HTTP_CODE). Response:"
  cat /tmp/supabase-smtp-resp.json
  exit 1
fi
