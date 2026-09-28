#!/usr/bin/env bash
# The Scorecard — daily account-deletion completion job (spec: Change 7, D5).
#
# Finishes any "Delete my account" request that the app could not finish, for
# example because the phone was lost or the app was deleted halfway through.
#
# SAFEGUARD (mandatory, from the final review): a deletion request
# accountDeletions/{uid} is written by the person themselves, and this job runs
# with admin rights. So the request is treated as UNTRUSTED:
#   1. the account ID comes only from the document's path, never its contents;
#   2. groups owned by that account are looked up in Firestore; if any exist,
#      nothing is deleted and the request is marked "blocked";
#   3. memberships and linked golfers are found by querying Firestore, never
#      from lists inside the request;
#   4. an invitation claim is deleted only if its acceptedBy is that account,
#      and only if it hasn't changed since it was read;
#   5. a golfer link is cleared only if its linkedUid is that account, and only
#      if the golfer hasn't changed since it was read;
#   6. the request is deleted only after Firebase Authentication confirms the
#      account is gone.
# Nothing written inside the request is ever read, except to update its status.
#
# Settings (environment):
#   ACCESS_TOKEN      required. A Google access token (or "owner" for the emulators).
#   PROJECT           default scorecard-f41b8
#   FS_BASE           default https://firestore.googleapis.com/v1
#   AUTH_BASE         default https://identitytoolkit.googleapis.com/v1
#   MIN_AGE_SECONDS   default 3600 — requests younger than this are left for the app.

set -Eeuo pipefail

PROJECT="${PROJECT:-scorecard-f41b8}"
FS_BASE="${FS_BASE:-https://firestore.googleapis.com/v1}"
AUTH_BASE="${AUTH_BASE:-https://identitytoolkit.googleapis.com/v1}"
MIN_AGE_SECONDS="${MIN_AGE_SECONDS:-3600}"
: "${ACCESS_TOKEN:?ACCESS_TOKEN is required}"

DB="projects/${PROJECT}/databases/(default)/documents"
WORK="$(mktemp -d)"
trap 'rm -rf "${WORK}"' EXIT

log(){ printf '%s %s\n' "$(date -u +%H:%M:%S)" "$*"; }
mask(){ printf '%s…' "${1:0:4}"; }      # never print a full account ID

# One HTTP call. Prints the body. Fails (non-zero) on any HTTP error.
call(){ # method url [body-file]
  local method="$1" url="$2" body="${3:-}"
  if [[ -n "${body}" ]]; then
    curl -g --fail-with-body -sS -X "${method}" -H "Authorization: Bearer ${ACCESS_TOKEN}" \
      -H 'Content-Type: application/json' --data-binary "@${body}" "${url}"
  else
    curl -g --fail-with-body -sS -X "${method}" -H "Authorization: Bearer ${ACCESS_TOKEN}" "${url}"
  fi
}

# Every document of one collection, one JSON document per line, all pages.
list_docs(){ # collection path under ${DB}, e.g. associations or associations/G/invites
  local path="$1" token="" page
  while :; do
    page="$(call GET "${FS_BASE}/${DB}/${path}?pageSize=300${token:+&pageToken=${token}}")"
    jq -c '.documents[]?' <<<"${page}"
    token="$(jq -r '.nextPageToken // empty' <<<"${page}")"
    [[ -n "${token}" ]] || break
  done
}

# Does one document exist? Distinguishes "missing" (404) from a failed read.
doc_exists(){ # path under ${DB}
  local code
  code="$(curl -g -sS -o /dev/null -w '%{http_code}' -H "Authorization: Bearer ${ACCESS_TOKEN}" "${FS_BASE}/${DB}/$1")"
  case "${code}" in
    200) return 0 ;;
    404) return 1 ;;
    *) log "ERROR: reading $1 failed (HTTP ${code})"; exit 3 ;;   # never act on a failed read
  esac
}

# Atomic commit of a list of writes (a JSON array). Nothing is sent if empty.
commit(){ # writes-json
  local writes="$1"
  [[ "$(jq 'length' <<<"${writes}")" -gt 0 ]] || return 0
  jq -n --argjson w "${writes}" '{writes:$w}' > "${WORK}/commit.json"
  call POST "${FS_BASE}/${DB}:commit" "${WORK}/commit.json" >/dev/null
}

auth_exists(){ # uid  -> 0 exists, 1 gone
  jq -n --arg u "$1" '{localId:[$u]}' > "${WORK}/lookup.json"
  local out
  # A failed lookup must never be taken as "gone": stop instead.
  out="$(call POST "${AUTH_BASE}/projects/${PROJECT}/accounts:lookup" "${WORK}/lookup.json")" \
    || { log "ERROR: Firebase Authentication lookup failed."; exit 4; }
  jq -e '.' >/dev/null <<<"${out}" || { log "ERROR: unreadable lookup reply."; exit 4; }
  [[ "$(jq '(.users // []) | length' <<<"${out}")" -gt 0 ]]
}

auth_delete(){ # uid
  jq -n --arg u "$1" '{localId:$u}' > "${WORK}/delete.json"
  call POST "${AUTH_BASE}/projects/${PROJECT}/accounts:delete" "${WORK}/delete.json" >/dev/null
}

set_status(){ # uid status
  local name="${DB}/accountDeletions/$1" now
  now="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  commit "$(jq -nc --arg n "${name}" --arg s "$2" --arg t "${now}" \
    '[{update:{name:$n,fields:{jobStatus:{stringValue:$s},jobCheckedAt:{timestampValue:$t}}},
       updateMask:{fieldPaths:["jobStatus","jobCheckedAt"]},currentDocument:{exists:true}}]')"
}

# ---------------------------------------------------------------------------
process(){ # uid   (runs in a subshell; exit codes: 0 done, 10 blocked, 11 not confirmed)
  local uid="$1" m; m="$(mask "${uid}")"

  # 2. Ownership, straight from Firestore.
  list_docs associations > "${WORK}/assoc.jsonl"
  local owned
  owned="$(jq -r --arg u "${uid}" 'select(.fields.ownerUid.stringValue == $u) | .name' "${WORK}/assoc.jsonl" | wc -l)"
  if [[ "${owned}" -gt 0 ]]; then
    set_status "${uid}" "blocked-owns-groups"
    log "BLOCKED ${m}: owns ${owned} group(s). Nothing deleted. The owner must delete those groups first."
    return 10
  fi

  # 3 + 4. Per group: the membership (keyed by the account ID) and any
  # invitation claim whose acceptedBy is this account. One atomic commit per group.
  local group gid writes
  while IFS= read -r group; do
    gid="${group##*/}"
    writes='[]'
    if doc_exists "associations/${gid}/members/${uid}"; then
      writes="$(jq -c --arg n "${DB}/associations/${gid}/members/${uid}" \
        '. + [{delete:$n,currentDocument:{exists:true}}]' <<<"${writes}")"
    fi
    list_docs "associations/${gid}/invites" > "${WORK}/inv.jsonl"
    writes="$(jq -sc --arg u "${uid}" --argjson w "${writes}" \
      '$w + [ .[] | select(.fields.acceptedBy.stringValue == $u)
                  | {delete:.name, currentDocument:{updateTime:.updateTime}} ]' "${WORK}/inv.jsonl")"
    # The group pointer lives under the account's own path, so it is always safe.
    writes="$(jq -c --arg n "${DB}/userGroups/${uid}/groups/${gid}" '. + [{delete:$n}]' <<<"${writes}")"
    if [[ "$(jq 'map(select(.currentDocument)) | length' <<<"${writes}")" -gt 0 ]]; then
      commit "${writes}"
      log "OK ${m}: cleaned up group $(mask "${gid}") ($(jq 'length' <<<"${writes}") writes)."
    fi
  done < <(jq -r '.name' "${WORK}/assoc.jsonl")

  # Any group pointers left (for example pointing at groups that no longer exist).
  list_docs "userGroups/${uid}/groups" > "${WORK}/ptr.jsonl"
  commit "$(jq -sc '[ .[] | {delete:.name} ]' "${WORK}/ptr.jsonl")"

  # 5. Golfer links: found by query, cleared only if still linked to this account
  # and unchanged since read. The golfer, its name, rounds and handicap stay (D1).
  jq -n --arg u "${uid}" '{structuredQuery:{from:[{collectionId:"golfers"}],
      where:{fieldFilter:{field:{fieldPath:"linkedUid"},op:"EQUAL",value:{stringValue:$u}}}}}' > "${WORK}/q.json"
  call POST "${FS_BASE}/${DB}:runQuery" "${WORK}/q.json" > "${WORK}/golfers.json"
  commit "$(jq -c --arg u "${uid}" '[ .[] | .document? // empty
      | select(.fields.linkedUid.stringValue == $u)
      | {update:{name:.name,fields:{linkedUid:{nullValue:null}}},
         updateMask:{fieldPaths:["linkedUid"]},
         currentDocument:{updateTime:.updateTime}} ]' "${WORK}/golfers.json")"

  # Version 1 documents stored under the account's own path, if any.
  printf '{}' > "${WORK}/empty.json"
  call POST "${FS_BASE}/${DB}/users/${uid}:listCollectionIds" "${WORK}/empty.json" > "${WORK}/v1.json"
  local col
  while IFS= read -r col; do
    list_docs "users/${uid}/${col}" > "${WORK}/v1docs.jsonl"
    commit "$(jq -sc '[ .[] | {delete:.name} ]' "${WORK}/v1docs.jsonl")"
  done < <(jq -r '.collectionIds[]?' "${WORK}/v1.json")
  commit "$(jq -nc --arg n "${DB}/users/${uid}" '[{delete:$n}]')"

  # 6. The sign-in, then independent confirmation, then (only then) the request.
  if auth_exists "${uid}"; then auth_delete "${uid}" || { log "ERROR: delete refused."; exit 5; }; fi
  if auth_exists "${uid}"; then
    set_status "${uid}" "auth-not-confirmed"
    log "NOT CONFIRMED ${m}: Firebase still has the account. Request kept; it will be retried."
    return 11
  fi
  commit "$(jq -nc --arg n "${DB}/accountDeletions/${uid}" '[{delete:$n}]')"
  log "DONE ${m}: account confirmed gone; request removed."
}

# ---------------------------------------------------------------------------
log "Deletion completion job for ${PROJECT} (requests older than ${MIN_AGE_SECONDS}s)."
list_docs accountDeletions > "${WORK}/requests.jsonl"
total="$(wc -l < "${WORK}/requests.jsonl")"
log "Requests found: ${total}"

done_n=0; blocked_n=0; failed_n=0; young_n=0
now="$(date -u +%s)"
while IFS= read -r req; do
  name="$(jq -r '.name' <<<"${req}")"
  uid="${name##*/}"                                   # 1. from the path only
  if [[ ! "${uid}" =~ ^[A-Za-z0-9]{1,128}$ ]]; then
    log "SKIPPED: a request with an invalid account ID in its path."; failed_n=$((failed_n+1)); continue
  fi
  created="$(jq -r '.createTime | sub("\\.[0-9]+Z$";"Z") | fromdateiso8601' <<<"${req}")"   # server-set, not client-set
  if (( now - created < MIN_AGE_SECONDS )); then young_n=$((young_n+1)); continue; fi
  set +e; ( set -Eeuo pipefail; process "${uid}" ); rc=$?; set -e
  case "${rc}" in
    0) done_n=$((done_n+1)) ;;
    10) blocked_n=$((blocked_n+1)) ;;
    *) failed_n=$((failed_n+1)); log "FAILED $(mask "${uid}") (code ${rc}); it will be retried next run." ;;
  esac
done < "${WORK}/requests.jsonl"

log "Summary: done ${done_n}, blocked ${blocked_n}, waiting for the app ${young_n}, failed ${failed_n}."
[[ "${failed_n}" -eq 0 ]]
