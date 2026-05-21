#!/usr/bin/env bash
# Push secrets from .env.local to the Stagetimer Supabase project.
# Usage: ./push-secrets.sh

set -euo pipefail

PROJECT_REF="bamjpsquhdzxvsymldpq"
ENV_FILE=".env.local"

cd "$(dirname "$0")"

if [ ! -f "$ENV_FILE" ]; then
  echo "❌ $ENV_FILE bestaat niet."
  exit 1
fi

# Verify required keys are filled in
missing=()
for key in STRIPE_SECRET_KEY STRIPE_WEBHOOK_SECRET; do
  val=$(grep "^$key=" "$ENV_FILE" | head -1 | cut -d= -f2- || true)
  if [ -z "$val" ]; then
    missing+=("$key")
  fi
done
if [ ${#missing[@]} -gt 0 ]; then
  echo "❌ Vul eerst deze keys in $ENV_FILE in: ${missing[*]}"
  exit 1
fi

echo "→ Pushing secrets to Supabase project $PROJECT_REF..."
supabase secrets set --env-file "$ENV_FILE" --project-ref "$PROJECT_REF"

echo ""
echo "✅ Secrets gepusht. Controleer met:"
echo "   supabase secrets list --project-ref $PROJECT_REF"
