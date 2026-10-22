#!/usr/bin/env bash
# Installs Playwright's Chromium and WebKit with their Ubuntu libraries.
# Ubuntu's package servers were very slow on 22 Oct 2026 (runs stuck 30
# minutes). Each try is cut off after 8 minutes; before the next try, the
# package installer's locks left by the cut-off try are cleared, so the retry
# can really run (the first version of this retry failed at once on the lock).
set -uo pipefail
echo 'Acquire::Retries "5"; Acquire::http::Timeout "60"; Acquire::https::Timeout "60";' | sudo tee /etc/apt/apt.conf.d/80-ci-retries >/dev/null
for try in 1 2 3; do
  if timeout 480 npx playwright install --with-deps chromium webkit; then
    echo "Browsers installed (try $try)"
    exit 0
  fi
  echo "Browser install try $try did not finish; clearing the installer and trying again"
  sudo pkill -9 -x apt-get 2>/dev/null || true
  sudo pkill -9 -x apt 2>/dev/null || true
  sudo pkill -9 -x dpkg 2>/dev/null || true
  sleep 3
  sudo rm -f /var/lib/dpkg/lock-frontend /var/lib/dpkg/lock /var/cache/apt/archives/lock /var/lib/apt/lists/lock
  sudo dpkg --configure -a || true
done
echo "Browsers could not be installed after 3 tries (Ubuntu's package servers)."
exit 1
