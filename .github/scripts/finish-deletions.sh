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
# Nothing written inside the request is trusted. Its stage and golfer list are
# read only as hints for the Public group (5b), and every hint is proven first.
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

# beta.9: the account's email, while the account still exists ("" if none).
auth_email(){ # uid
  jq -n --arg u "$1" '{localId:[$u]}' > "${WORK}/lookup.json"
  local out
  out="$(call POST "${AUTH_BASE}/projects/${PROJECT}/accounts:lookup" "${WORK}/lookup.json")" \
    || { log "ERROR: Firebase Authentication lookup failed."; exit 4; }
  jq -r '(.users // [])[0].email // ""' <<<"${out}"
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
# The Public group (Willy, 13 Nov 2026).
PUBLIC="PUBLIC"
BACKUP_DAYS=30

# One golfer's rounds in one group (a query, one JSON array).
rounds_of(){ # groupId golferId
  jq -n --arg g "$2" '{structuredQuery:{from:[{collectionId:"rounds"}],
      where:{fieldFilter:{field:{fieldPath:"golferId"},op:"EQUAL",value:{stringValue:$g}}}}}' > "${WORK}/rq.json"
  call POST "${FS_BASE}/${DB}/associations/$1:runQuery" "${WORK}/rq.json" | jq -c '[ .[] | .document? // empty ]'
}

# One document as JSON, or "null" if it does not exist. Stops on a failed read.
read_doc(){ # path under ${DB}
  local code
  code="$(curl -g -sS -o "${WORK}/doc.json" -w '%{http_code}' -H "Authorization: Bearer ${ACCESS_TOKEN}" "${FS_BASE}/${DB}/$1")"
  case "${code}" in
    200) cat "${WORK}/doc.json" ;;
    404) echo null ;;
    *) log "ERROR: reading $1 failed (HTTP ${code})"; exit 3 ;;
  esac
}

# A golfer of a deleted account, in the Public group:
#   - plays ONLY in the Public group: the golfer, its name, its Public rounds,
#     its place on the list and its name claim are deleted for good, in one
#     commit together with a backup (deletionBackups/, kept 30 days; no app
#     can read it; restored with rgf.txt);
#   - also plays in another group: only taken off the Public group's list.
#     The golfer and every round (the Public ones too) stay.
public_cleanup(){ # uid golferId
  local uid="$1" g="$2" m; m="$(mask "${uid}")"
  doc_exists "associations/${PUBLIC}/roster/${g}" || return 0
  local gid other="" there
  while IFS= read -r gid; do
    [[ -n "${gid}" && "${gid}" != "${PUBLIC}" ]] || continue
    if doc_exists "associations/${gid}/roster/${g}"; then other="on its list"; break; fi
    there="$(rounds_of "${gid}" "${g}")"          # a failed read stops the job here
    if jq -e 'length > 0' >/dev/null <<<"${there}"; then other="rounds there"; break; fi
  done < <(jq -r '.name | sub(".*/";"")' "${WORK}/assoc.jsonl")

  if [[ -n "${other}" ]]; then
    commit "$(jq -nc --arg r "${DB}/associations/${PUBLIC}/roster/${g}" --arg d "${DB}/associations/${PUBLIC}/directory/${g}" \
      '[{delete:$r},{delete:$d}]')"
    log "PUBLIC ${m}: golfer $(mask "${g}") taken off the Public group's list; golfer and rounds kept (also plays in another group)."
    return 0
  fi

  local golfer roster directory invitation rounds nk claim now expires
  golfer="$(read_doc "golfers/${g}")"
  [[ "${golfer}" != null ]] || return 0
  roster="$(read_doc "associations/${PUBLIC}/roster/${g}")"
  directory="$(read_doc "associations/${PUBLIC}/directory/${g}")"
  invitation="$(read_doc "associations/${PUBLIC}/invitations/${g}")"
  rounds="$(rounds_of "${PUBLIC}" "${g}")"
  nk="$(jq -r '.fields.nameKey.stringValue // empty' <<<"${golfer}")"
  claim=null
  if [[ -n "${nk}" && "${nk}" != */* ]]; then
    claim="$(read_doc "golferNames/${nk}")"
    [[ "$(jq -r '.fields.golferId.stringValue // empty' <<<"${claim}")" == "${g}" ]] || claim=null
  fi
  if [[ "$(jq 'length' <<<"${rounds}")" -gt 450 ]]; then
    log "PUBLIC ${m}: golfer $(mask "${g}") has more than 450 Public rounds; kept, for a person to look at."
    return 0
  fi
  now="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  expires="$(date -u -d "+${BACKUP_DAYS} days" +%Y-%m-%dT%H:%M:%SZ)"
  # The backup and every delete in ONE commit: all of it happens, or none.
  # Each delete requires the document to be unchanged since it was read.
  jq -nc --arg b "${DB}/deletionBackups/${g}-$(date -u +%s)" --arg g "${g}" --arg now "${now}" --arg exp "${expires}" \
     --argjson golfer "${golfer}" --argjson roster "${roster}" --argjson dir "${directory}" \
     --argjson inv "${invitation}" --argjson claim "${claim}" --argjson rounds "${rounds}" '
    def keep(d): if d == null then {nullValue:null}
      else {mapValue:{fields:{path:{stringValue:(d.name|sub(".*/documents/";""))},
                              data:{mapValue:{fields:(d.fields // {})}}}}} end;
    def gone(d): if d == null then [] else [{delete:d.name,currentDocument:{updateTime:d.updateTime}}] end;
    [ {update:{name:$b,fields:{
         golferId:{stringValue:$g}, groupId:{stringValue:"PUBLIC"},
         deletedAt:{timestampValue:$now}, expiresAt:{timestampValue:$exp},
         golfer:keep($golfer), roster:keep($roster), directory:keep($dir),
         invitation:keep($inv), nameClaim:keep($claim),
         rounds:{arrayValue:{values:[ $rounds[] | keep(.) ]}} }},
       currentDocument:{exists:false}} ]
    + gone($golfer) + gone($roster) + gone($dir) + gone($inv) + gone($claim)
    + [ $rounds[] | {delete:.name,currentDocument:{updateTime:.updateTime}} ]' > "${WORK}/pub.json"
  if [[ "$(wc -c < "${WORK}/pub.json")" -gt 900000 ]]; then
    log "PUBLIC ${m}: golfer $(mask "${g}") is too large to back up in one record; kept, for a person to look at."
    return 0
  fi
  commit "$(cat "${WORK}/pub.json")"
  log "PUBLIC ${m}: golfer $(mask "${g}") deleted from the Public group for good ($(jq 'length' <<<"${rounds}") rounds); backup kept ${BACKUP_DAYS} days."
}

# Backups older than 30 days are removed for good.
purge_backups(){
  local now; now="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  list_docs deletionBackups > "${WORK}/backups.jsonl"
  local old; old="$(jq -sc --arg now "${now}" '[ .[] | select((.fields.expiresAt.timestampValue // "") < $now) | {delete:.name} ]' "${WORK}/backups.jsonl")"
  if [[ "$(jq 'length' <<<"${old}")" -gt 0 ]]; then
    commit "${old}"
    log "Removed $(jq 'length' <<<"${old}") Public backup(s) older than ${BACKUP_DAYS} days."
  fi
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
  # and unchanged since read. The golfer, its name, rounds and handicap stay (D1),
  # except in the Public group (5b below).
  jq -n --arg u "${uid}" '{structuredQuery:{from:[{collectionId:"golfers"}],
      where:{fieldFilter:{field:{fieldPath:"linkedUid"},op:"EQUAL",value:{stringValue:$u}}}}}' > "${WORK}/q.json"
  call POST "${FS_BASE}/${DB}:runQuery" "${WORK}/q.json" > "${WORK}/golfers.json"
  commit "$(jq -c --arg u "${uid}" '[ .[] | .document? // empty
      | select(.fields.linkedUid.stringValue == $u)
      | {update:{name:.name,fields:{linkedUid:{nullValue:null}}},
         updateMask:{fieldPaths:["linkedUid"]},
         currentDocument:{updateTime:.updateTime}} ]' "${WORK}/golfers.json")"

  # 5b. The Public group (Willy, 13 Nov 2026): whoever deletes their account
  # is deleted from the Public group for good. Which golfers were this
  # account's is proven, never taken from the request:
  #   - the ones this job has just unlinked (found by linkedUid above), or
  #   - the ones the app unlinked: the app unlinks the golfer and sets the
  #     request to "auth-deleting" in ONE commit, so both carry the very same
  #     update time. The rules allow a deleting account no other golfer change
  #     (and refuse "auth-deleting" at the moment a request is created), so a
  #     golfer with that update time, unlinked, can only be its own. The
  #     request's golfer list is used only as the names to look at.
  local -a mine=()
  mapfile -t mine < <(jq -r '.[] | .document? // empty | .name | sub(".*/";"")' "${WORK}/golfers.json")
  if [[ "${REQ_STAGE}" == "auth-deleting" && -n "${REQ_UPDATED}" ]]; then
    local cand gj
    while IFS= read -r cand; do
      [[ "${cand}" =~ ^[A-Za-z0-9_-]{1,128}$ ]] || continue
      gj="$(curl -g -sS -H "Authorization: Bearer ${ACCESS_TOKEN}" "${FS_BASE}/${DB}/golfers/${cand}")"
      if [[ "$(jq -r '.updateTime // ""' <<<"${gj}")" == "${REQ_UPDATED}" \
         && "$(jq -r '.fields.linkedUid | if . == null or has("nullValue") then "none" else "linked" end' <<<"${gj}")" == "none" ]]; then
        mine+=("${cand}")
      fi
    done < <(jq -r '.fields.golferIds.arrayValue.values[]?.stringValue // empty' <<<"${REQ_JSON}")
  fi
  local g
  for g in $(printf '%s\n' "${mine[@]}" | sort -u); do
    public_cleanup "${uid}" "${g}"
  done

  # Version 1 documents stored under the account's own path, if any.
  printf '{}' > "${WORK}/empty.json"
  call POST "${FS_BASE}/${DB}/users/${uid}:listCollectionIds" "${WORK}/empty.json" > "${WORK}/v1.json"
  local col
  while IFS= read -r col; do
    list_docs "users/${uid}/${col}" > "${WORK}/v1docs.jsonl"
    commit "$(jq -sc '[ .[] | {delete:.name} ]' "${WORK}/v1docs.jsonl")"
  done < <(jq -r '.collectionIds[]?' "${WORK}/v1.json")
  commit "$(jq -nc --arg n "${DB}/users/${uid}" '[{delete:$n}]')"

  # beta.9: the account's entry in the email list goes with it, so the same
  # email can be used again (an application, or a new invitation). The email
  # comes from Firebase Authentication, never from the request.
  local email key
  email="$(auth_email "${uid}")"
  if [[ -n "${email}" ]]; then
    key="$(tr '[:upper:]' '[:lower:]' <<<"${email}" | sed 's/^[[:space:]]*//; s/[[:space:]]*$//')"
    commit "$(jq -nc --arg n "${DB}/accountEmails/${key}" '[{delete:$n}]')"
  fi

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
purge_backups
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
  REQ_JSON="${req}"
  REQ_STAGE="$(jq -r '.fields.stage.stringValue // ""' <<<"${req}")"
  REQ_UPDATED="$(jq -r '.updateTime // ""' <<<"${req}")"
  set +e; ( set -Eeuo pipefail; process "${uid}" ); rc=$?; set -e
  case "${rc}" in
    0) done_n=$((done_n+1)) ;;
    10) blocked_n=$((blocked_n+1)) ;;
    *) failed_n=$((failed_n+1)); log "FAILED $(mask "${uid}") (code ${rc}); it will be retried next run." ;;
  esac
done < "${WORK}/requests.jsonl"

log "Summary: done ${done_n}, blocked ${blocked_n}, waiting for the app ${young_n}, failed ${failed_n}."
[[ "${failed_n}" -eq 0 ]]
