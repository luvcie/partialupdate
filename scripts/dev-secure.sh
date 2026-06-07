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
BETTER_AUTH_SECRET="$(quote_dotenv "$(keychain_value BETTER_AUTH_SECRET)")"
GITHUB_CLIENT_ID="$(quote_dotenv "$(keychain_value GITHUB_CLIENT_ID)")"
GITHUB_CLIENT_SECRET="$(quote_dotenv "$(keychain_value GITHUB_CLIENT_SECRET)")"
GOOGLE_CLIENT_ID="$(quote_dotenv "$(keychain_value GOOGLE_CLIENT_ID)")"
GOOGLE_CLIENT_SECRET="$(quote_dotenv "$(keychain_value GOOGLE_CLIENT_SECRET)")"
EOF

chmod 600 "$env_file"

exec wrangler dev --local --env-file "$env_file" "$@"
