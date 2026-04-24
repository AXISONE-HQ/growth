#!/usr/bin/env bash
#
# jira.sh — Atlassian REST API wrapper for the AXISONE Jira instance.
#
# Auth:       token read from macOS Keychain (service: axisone-jira-token).
# Email:      $ATLASSIAN_EMAIL, or $JIRA_EMAIL as fallback.
# Cloud URL:  $ATLASSIAN_CLOUD_URL, defaults to https://axisone-team.atlassian.net.
#
# Subcommands:
#   get <KEY>                      Print the full issue JSON.
#   comment <KEY> <TEXT>           Post a comment (plain text → ADF).
#   transition <KEY> <STATE>       Move issue to <STATE> by name (e.g. "In Progress").
#                                  Lists available transitions if the name doesn't match.
#   search <JQL>                   Run a JQL query; prints JSON with up to 50 results.
#
# Pipe to jq for field extraction, e.g.:
#   scripts/jira.sh get KAN-658 | jq '.fields.summary'
#   scripts/jira.sh search 'project = KAN AND labels = claude-ready' | jq '.issues[].key'
#
# Dependencies: bash 4+, curl, jq, security (macOS Keychain).

set -euo pipefail

cmd="${1:-help}"

# Help / empty / -h / --help: print usage and exit without requiring auth.
case "$cmd" in
  ""|-h|--help|help)
    sed -n '2,20p' "$0" | sed -e 's/^# //' -e 's/^#$//'
    exit 0
    ;;
esac

: "${ATLASSIAN_CLOUD_URL:=https://axisone-team.atlassian.net}"

EMAIL="${ATLASSIAN_EMAIL:-${JIRA_EMAIL:-}}"
if [[ -z "$EMAIL" ]]; then
  cat >&2 <<'ERR'
error: ATLASSIAN_EMAIL (or JIRA_EMAIL) is not set.
       export ATLASSIAN_EMAIL in ~/.zshrc or pass via JIRA_EMAIL env var.
       example:  export ATLASSIAN_EMAIL=you@axisone.ca
ERR
  exit 2
fi

if ! command -v jq >/dev/null 2>&1; then
  echo "error: jq is required but not installed (brew install jq)." >&2
  exit 2
fi

TOKEN=$(security find-generic-password -s axisone-jira-token -w 2>/dev/null) || {
  cat >&2 <<'ERR'
error: no Jira token in Keychain under service "axisone-jira-token".
       create one with:
         security add-generic-password -s axisone-jira-token -a "$ATLASSIAN_EMAIL" -w
       then paste your API token from id.atlassian.com/manage-profile/security/api-tokens
ERR
  exit 2
}

API="${ATLASSIAN_CLOUD_URL%/}/rest/api/3"

_curl() {
  local method="$1" path="$2" body="${3:-}"
  local args=(-sS --fail-with-body -X "$method"
    -u "$EMAIL:$TOKEN"
    -H "Accept: application/json"
    -H "Content-Type: application/json")
  if [[ -n "$body" ]]; then
    args+=(--data "$body")
  fi
  curl "${args[@]}" "$API$path"
}

case "$cmd" in
  get)
    key="${2:-}"
    [[ -n "$key" ]] || { echo "usage: jira.sh get <ISSUE-KEY>" >&2; exit 2; }
    _curl GET "/issue/$key"
    ;;

  comment)
    key="${2:-}"
    text="${3:-}"
    [[ -n "$key" && -n "$text" ]] || { echo "usage: jira.sh comment <ISSUE-KEY> <TEXT>" >&2; exit 2; }
    body=$(jq -n --arg t "$text" '{body:{type:"doc",version:1,content:[{type:"paragraph",content:[{type:"text",text:$t}]}]}}')
    _curl POST "/issue/$key/comment" "$body"
    ;;

  transition)
    key="${2:-}"
    state="${3:-}"
    [[ -n "$key" && -n "$state" ]] || { echo "usage: jira.sh transition <ISSUE-KEY> <STATE-NAME>" >&2; exit 2; }
    transitions_json=$(_curl GET "/issue/$key/transitions")
    tid=$(echo "$transitions_json" | jq -r --arg s "$state" '.transitions[] | select(.name == $s) | .id' | head -1)
    if [[ -z "$tid" ]]; then
      {
        echo "error: no transition named '$state' available for $key."
        echo "       available transitions:"
        echo "$transitions_json" | jq -r '.transitions[].name' | sed 's/^/         /'
      } >&2
      exit 2
    fi
    body=$(jq -n --arg id "$tid" '{transition:{id:$id}}')
    _curl POST "/issue/$key/transitions" "$body" >/dev/null
    echo "transitioned $key → $state"
    ;;

  search)
    jql="${2:-}"
    [[ -n "$jql" ]] || { echo "usage: jira.sh search <JQL>" >&2; exit 2; }
    body=$(jq -n --arg q "$jql" '{jql:$q,maxResults:50}')
    _curl POST "/search" "$body"
    ;;

  *)
    echo "error: unknown subcommand: $cmd" >&2
    echo "       run: jira.sh help" >&2
    exit 2
    ;;
esac
