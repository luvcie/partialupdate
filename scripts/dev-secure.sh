#!/usr/bin/env bash
set -euo pipefail

tmp_dir="$(mktemp -d "${TMPDIR:-/tmp}/partialupdate-dev.XXXXXX")"
env_file="$tmp_dir/.dev.vars"

cleanup() {
	rm -rf "$tmp_dir"
}

trap cleanup EXIT INT TERM

keychain_value() {
	security find-generic-password -a "frontclaw" -s "$1" -w 2>/dev/null || true
}

quote_dotenv() {
	printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'
}

cat > "$env_file" <<EOF
CLOUDFLARE_API_TOKEN="$(quote_dotenv "$(keychain_value CLOUDFLARE_API_TOKEN)")"
CLOUDFLARE_AI_GATEWAY_ID="$(quote_dotenv "$(keychain_value CLOUDFLARE_AI_GATEWAY_ID)")"
CLOUDFLARE_ACCOUNT_ID="$(quote_dotenv "$(keychain_value CLOUDFLARE_ACCOUNT_ID)")"
GEMINI_API_KEY="$(quote_dotenv "$(keychain_value GEMINI_API_KEY)")"
EOF

chmod 600 "$env_file"

exec wrangler dev --local --env-file "$env_file" "$@"
