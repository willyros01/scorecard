#!/usr/bin/env bash
# Archive audit A1–A7 (spec: Build pipeline, red issue 6).
# Inspects the finished, distribution-signed app — what Apple receives — and
# fails (non-zero) on any problem, which stops the upload.
# Usage: audit-archive.sh <App.ipa> <work-dir>   (macOS)
set -Euo pipefail

IPA="$1"; WORK="$2"
rm -rf "$WORK"; mkdir -p "$WORK"
unzip -q "$IPA" -d "$WORK" || { echo "FAIL  could not unpack $IPA"; exit 1; }
APP="$(find "$WORK/Payload" -maxdepth 1 -name '*.app' | head -1)"
[[ -d "$APP" ]] || { echo "FAIL  no app inside $IPA"; exit 1; }
PLIST="$APP/Info.plist"
problems=0
ok(){ echo "OK    $*"; }
bad(){ echo "FAIL  $*"; problems=$((problems+1)); }
note(){ echo "      $*"; }

echo "Audit of $(basename "$APP") — $(/usr/libexec/PlistBuddy -c 'Print CFBundleShortVersionString' "$PLIST") ($(/usr/libexec/PlistBuddy -c 'Print CFBundleVersion' "$PLIST"))"

# ---- A1 privacy manifests ----
MANIFESTS=()
while IFS= read -r f; do MANIFESTS+=("$f"); done < <(find "$APP" -name PrivacyInfo.xcprivacy | sort)
note "privacy manifests found: ${#MANIFESTS[@]}"
for m in "${MANIFESTS[@]}"; do note "  ${m#"$APP"/}"; done
if [[ -f "$APP/PrivacyInfo.xcprivacy" ]]; then
  tracking="$(plutil -extract NSPrivacyTracking raw -o - "$APP/PrivacyInfo.xcprivacy" 2>/dev/null || echo missing)"
  domains="$(plutil -extract NSPrivacyTrackingDomains raw -o - "$APP/PrivacyInfo.xcprivacy" 2>/dev/null || echo 0)"
  [[ "$tracking" == "false" && "$domains" == "0" ]] && ok "A1 the app's own manifest: no tracking, no tracking domains" \
    || bad "A1 the app's own manifest must say NSPrivacyTracking false with no tracking domains (got $tracking / $domains)"
else
  bad "A1 the app's own PrivacyInfo.xcprivacy is missing from the app"
fi

# ---- A2 required-reason APIs ----
BINARIES=("$APP/$(/usr/libexec/PlistBuddy -c 'Print CFBundleExecutable' "$PLIST")")
while IFS= read -r fw; do
  exe="$(/usr/libexec/PlistBuddy -c 'Print CFBundleExecutable' "$fw/Info.plist" 2>/dev/null || basename "$fw" .framework)"
  [[ -f "$fw/$exe" ]] && BINARIES+=("$fw/$exe")
done < <(find "$APP/Frameworks" -maxdepth 1 -name '*.framework' 2>/dev/null | sort)
declared="$(for m in "${MANIFESTS[@]}"; do plutil -convert xml1 -o - "$m" 2>/dev/null; done | grep -oE 'NSPrivacyAccessedAPICategory[A-Za-z]+' | sort -u)"
note "categories declared across all manifests: $(echo $declared)"
found=""
for b in "${BINARIES[@]}"; do
  imports="$(nm -u "$b" 2>/dev/null)"          # C functions the binary calls
  text="$(strings -a "$b" 2>/dev/null)"         # Foundation names used by Swift/Objective-C
  cats=""
  grep -qE '^_(stat|fstat|lstat|fstatat|getattrlist|fgetattrlist|getattrlistbulk)$' <<<"$imports" \
    || grep -qE 'NSFileCreationDate|NSFileModificationDate|NSURLContentModificationDateKey|NSURLCreationDateKey' <<<"$text" \
    && cats+=" NSPrivacyAccessedAPICategoryFileTimestamp"
  grep -qE '^_mach_absolute_time$' <<<"$imports" || grep -qE 'systemUptime' <<<"$text" \
    && cats+=" NSPrivacyAccessedAPICategorySystemBootTime"
  grep -qE '^_(statfs|fstatfs|statvfs|fstatvfs)$' <<<"$imports" \
    || grep -qE 'NSFileSystemFreeSize|NSFileSystemSize|NSURLVolumeAvailableCapacity' <<<"$text" \
    && cats+=" NSPrivacyAccessedAPICategoryDiskSpace"
  grep -qE 'activeInputModes' <<<"$text" && cats+=" NSPrivacyAccessedAPICategoryActiveKeyboards"
  grep -qE 'NSUserDefaults' <<<"$imports$text" && cats+=" NSPrivacyAccessedAPICategoryUserDefaults"
  note "$(basename "$b"):${cats:- none}"
  found+="$cats"
done
missing=""
for c in $(echo $found | tr ' ' '\n' | sort -u); do grep -qx "$c" <<<"$declared" || missing+=" $c"; done
[[ -z "$missing" ]] && ok "A2 every required-reason API category used is declared" \
  || bad "A2 used but not declared in any manifest:$missing"

# ---- A3 third-party SDKs ----
note "frameworks and resource bundles in the app:"
find "$APP/Frameworks" -maxdepth 1 \( -name '*.framework' -o -name '*.dylib' \) 2>/dev/null | sed "s#$APP/#        #"
find "$APP" -maxdepth 1 -name '*.bundle' | sed "s#$APP/#        #"
if find "$APP" \( -ipath '*capacitor*' \) -name PrivacyInfo.xcprivacy | grep -q .; then ok "A3 Capacitor (on Apple's commonly used SDK list) ships its own privacy manifest"
else bad "A3 Capacitor is on Apple's commonly used SDK list but no Capacitor privacy manifest is in the app"; fi
sigbad=0
while IFS= read -r fw; do codesign -dv "$fw" >/dev/null 2>&1 || { bad "A3 unsigned framework: $(basename "$fw")"; sigbad=1; }; done < <(find "$APP/Frameworks" -maxdepth 1 -name '*.framework' 2>/dev/null)
[[ $sigbad -eq 0 ]] && ok "A3 every embedded framework carries a valid signature"

# ---- A4 usage descriptions ----
usage="$(plutil -convert xml1 -o - "$PLIST" | grep -oE 'NS[A-Za-z]+UsageDescription' | sort -u)"
[[ -z "$usage" ]] && ok "A4 no NS…UsageDescription keys (no camera, photos, location or contacts)" \
  || bad "A4 unexpected usage descriptions: $(echo $usage)"

# ---- A5 entitlements ----
codesign -d --entitlements - --xml "$APP" > "$WORK/entitlements.plist" 2>/dev/null \
  || codesign -d --entitlements :- "$APP" > "$WORK/entitlements.plist" 2>/dev/null
keys="$(plutil -convert json -o - "$WORK/entitlements.plist" | python3 -c 'import json,sys; print("\n".join(sorted(json.load(sys.stdin).keys())))')"
note "entitlements: $(echo $keys)"
allowed='^(application-identifier|com\.apple\.developer\.team-identifier|get-task-allow|beta-reports-active|keychain-access-groups|com\.apple\.developer\.associated-domains)$'
extra="$(grep -vE "$allowed" <<<"$keys" || true)"
[[ -z "$extra" ]] && ok "A5 no unexpected entitlements" || bad "A5 unexpected entitlements: $(echo $extra)"
gta="$(plutil -extract get-task-allow raw -o - "$WORK/entitlements.plist" 2>/dev/null || echo false)"
[[ "$gta" == "false" ]] && ok "A5 get-task-allow is false" || bad "A5 get-task-allow is $gta"
domains="$(plutil -extract com.apple.developer.associated-domains json -o - "$WORK/entitlements.plist" 2>/dev/null || echo none)"
[[ "$domains" == '["applinks:www.cuberoot-systems.com"]' ]] && ok "A5 associated domains: applinks:www.cuberoot-systems.com only" \
  || bad "A5 associated domains are $domains"

# ---- A6 App Transport Security ----
ats="$(plutil -extract NSAppTransportSecurity json -o - "$PLIST" 2>/dev/null || echo none)"
if [[ "$ats" == "none" ]] || ! grep -qE 'NSAllowsArbitraryLoads"?:\s*true|NSExceptionDomains' <<<"$ats"; then ok "A6 no App Transport Security exceptions"
else bad "A6 App Transport Security exceptions present: $ats"; fi

# ---- A7 export compliance ----
enc="$(plutil -extract ITSAppUsesNonExemptEncryption raw -o - "$PLIST" 2>/dev/null || echo missing)"
[[ "$enc" == "false" ]] && ok "A7 ITSAppUsesNonExemptEncryption is NO" || bad "A7 ITSAppUsesNonExemptEncryption is $enc (must be NO)"
libs=""
for b in "${BINARIES[@]}"; do
  nm "$b" 2>/dev/null | grep -qiE 'sqlcipher|_SSL_CTX_new|_EVP_EncryptInit|boringssl' && libs+=" $(basename "$b")"
done
[[ -z "$libs" ]] && ok "A7 no bundled encryption library (SQLCipher, OpenSSL, BoringSSL)" \
  || bad "A7 a bundled encryption library was found in:$libs"

echo
if [[ $problems -eq 0 ]]; then echo "AUDIT PASSED (A1-A7)"; exit 0; fi
echo "AUDIT FAILED: $problems problem(s). Nothing was uploaded."; exit 1
