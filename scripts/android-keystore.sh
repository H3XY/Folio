#!/bin/sh
# Creates Folio's Google Play *upload* key (Play App Signing holds the real app-signing key) and writes
# android/keystore.properties so `npm run android:bundle` signs the release bundle. Run once; keep the keystore
# and its password somewhere safe (a password manager) — Google can reset a lost upload key, but it takes days.
set -e
cd "$(dirname "$0")/.."
KS="${1:-$HOME/.folio/folio-upload.jks}"
if [ -e "$KS" ]; then echo "Keystore already exists: $KS" >&2; exit 1; fi
mkdir -p "$(dirname "$KS")"
printf "Choose a keystore password (input hidden): "; stty -echo; read -r PW; stty echo; echo
[ "${#PW}" -ge 8 ] || { echo "Use at least 8 characters." >&2; exit 1; }
keytool -genkeypair -v -keystore "$KS" -alias upload -keyalg RSA -keysize 4096 -validity 10000 \
  -storepass "$PW" -keypass "$PW" -dname "CN=Folio, O=Folio"
umask 077
cat > android/keystore.properties <<PROPS
storeFile=$KS
storePassword=$PW
keyAlias=upload
keyPassword=$PW
PROPS
echo "Wrote android/keystore.properties (git-ignored). Back up $KS and its password."
