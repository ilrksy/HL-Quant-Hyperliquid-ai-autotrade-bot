#!/usr/bin/env bash
# creates a release signing keystore OUTSIDE the repository plus a private env file holding its random password
# usage: mobile/scripts/create-keystore.sh [dir]        (default dir: $HOME/.hl-quant-keys)
# the password is never printed; back up both files, losing them means installed apps cannot be upgraded
set -euo pipefail

# repository root, used to refuse writing signing material inside it
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# absolute output folder for the keystore and its env file
dir="$(mkdir -p "${1:-$HOME/.hl-quant-keys}" && cd "${1:-$HOME/.hl-quant-keys}" && pwd)"
case "$dir/" in
  "$repo_root"/*) echo "refusing to create a keystore inside the repository ($dir)" >&2; exit 1 ;;
esac

# release signing keystore (PKCS12)
keystore="$dir/hl-quant-release.jks"
# env file build-apk.mjs and CI expect (ANDROID_KEYSTORE_PATH, passwords, alias)
envfile="$dir/keystore.env"
# key alias inside the keystore
alias_name="${ANDROID_KEY_ALIAS:-hlquant}"
if [ -e "$keystore" ]; then
  echo "$keystore already exists; delete it first if you really want a new signing key" >&2
  exit 1
fi

chmod 700 "$dir"
umask 077
# random 32-character password shared by store and key (PKCS12 uses one password), never echoed
HLQ_KEYSTORE_SECRET="$(openssl rand -base64 48 | tr -dc 'A-Za-z0-9' | cut -c1-32)"
export HLQ_KEYSTORE_SECRET
keytool -genkeypair -noprompt -storetype PKCS12 -keystore "$keystore" -alias "$alias_name" \
  -keyalg RSA -keysize 4096 -validity 10000 -dname "CN=HL Quant, O=HL Quant" \
  -storepass:env HLQ_KEYSTORE_SECRET -keypass:env HLQ_KEYSTORE_SECRET >/dev/null
printf 'ANDROID_KEYSTORE_PATH=%s\nANDROID_KEYSTORE_PASSWORD=%s\nANDROID_KEY_ALIAS=%s\nANDROID_KEY_PASSWORD=%s\n' \
  "$keystore" "$HLQ_KEYSTORE_SECRET" "$alias_name" "$HLQ_KEYSTORE_SECRET" >"$envfile"
chmod 600 "$keystore" "$envfile"

echo "keystore: $keystore"
echo "env file: $envfile (contains the password; keep it private)"
echo "build:    set -a; . \"$envfile\"; set +a; npm --prefix mobile run apk"
echo "CI:       store 'base64 -w0 $keystore' as secret ANDROID_KEYSTORE_BASE64 and the env file values as"
echo "          ANDROID_KEYSTORE_PASSWORD, ANDROID_KEY_ALIAS and ANDROID_KEY_PASSWORD"
