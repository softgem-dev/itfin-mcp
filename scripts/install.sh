#!/usr/bin/env bash
# Quick install for itfin-mcp: installs or updates the npm package in ~/.itfin-mcp and sets up
# Claude Code, Codex and Claude Desktop, each in one mode: MCP (the app runs the MCP server) or CLI
# (the agent runs the `itfin` command, guided by an `itfin` skill). Claude Desktop is always MCP. Usage:
#   npx itfin-mcp install [--company acme] [--clients claude,codex,desktop] [--mode claude=cli,codex=mcp]
#                         [--no-permissions] [--browser chrome] [--work-start 10:00] [--timezone Europe/Kyiv]
#   curl -fsSL https://raw.githubusercontent.com/steven-tailor/itfin-mcp/main/scripts/install.sh | bash -s -- [same flags]
# The first install asks which apps to install for, in which mode, and the company name. Updates
# reuse the apps, modes and settings of the previous install, kept in <dir>/config.json.
set -euo pipefail

DIR="${ITFIN_MCP_DIR:-$HOME/.itfin-mcp}"
# What npm installs. Override it to try a local build: ITFIN_MCP_PACKAGE=./itfin-mcp-0.1.0.tgz
PACKAGE="${ITFIN_MCP_PACKAGE:-itfin-mcp@latest}"
CODEX_CONFIG="${CODEX_HOME:-$HOME/.codex}/config.toml"
DESKTOP_CONFIG="$HOME/Library/Application Support/Claude/claude_desktop_config.json"
CLAUDE_SETTINGS="$HOME/.claude/settings.json"
CLAUDE_SKILL="$HOME/.claude/skills/itfin"
CODEX_SKILL="$HOME/.agents/skills/itfin"
CODEX_RULES="${CODEX_HOME:-$HOME/.codex}/rules/itfin.rules"
BIN="$HOME/.local/bin/itfin"
URL="" BROWSER="" WORK_START="" TIMEZONE="" CLIENTS="" MODES="" NO_PERMISSIONS=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --company) URL="https://$2.itfin.io"; shift 2 ;;
    --url) URL="$2"; shift 2 ;;
    --clients) CLIENTS="${2//,/ }"; shift 2 ;;
    --mode) MODES="${2//,/ }"; shift 2 ;;
    --no-permissions) NO_PERMISSIONS=1; shift ;;
    --browser) BROWSER="$2"; shift 2 ;;
    --work-start) WORK_START="$2"; shift 2 ;;
    --timezone) TIMEZONE="$2"; shift 2 ;;
    --dir) DIR="$2"; shift 2 ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

fail() { echo "✗ $*" >&2; exit 1; }
# Read answers from the terminal even when the script itself comes from a pipe.
ask() { local prompt="$1" default="${2:-}" answer; read -r -p "$prompt${default:+ [$default]}: " answer </dev/tty || true; echo "${answer:-$default}"; }

[[ "$(uname)" == "Darwin" ]] || fail "itfin-mcp needs macOS (Keychain, launchd and notifications)."
command -v node >/dev/null || fail "Node.js 22+ is required: https://nodejs.org"
[[ "$(node -p 'process.versions.node.split(".")[0]')" -ge 22 ]] || fail "Node.js 22+ is required (found $(node -v))."
command -v npm >/dev/null || fail "npm is required. It comes with Node.js: https://nodejs.org"

PKG="$DIR/node_modules/itfin-mcp"
version() { node -p 'require(process.argv[1]).version' "$PKG/package.json" 2>/dev/null || true; }
OLD_VERSION="$(version)"
# Installs before the npm package were a git clone of the repo, which npm can't install into. Only
# a clean clone made by the old installer is replaced, never a checkout someone works in.
LEGACY=""
if [[ -d "$DIR/.git" ]]; then
  ORIGIN="$(git -C "$DIR" remote get-url origin 2>/dev/null || true)"
  [[ "$ORIGIN" =~ ^https://github\.com/(softgem-dev|steven-tailor)/itfin-mcp(\.git)?$ && -z "$(git -C "$DIR" status --porcelain 2>/dev/null)" ]] \
    || fail "$DIR is a git repo other than an itfin-mcp install, or has local changes. Pick another folder with --dir."
  LEGACY=1
  OLD_VERSION="git"
fi

# A git install is replaced only after npm succeeds, so a failed update leaves it working.
TARGET="$DIR"
[[ -n "$LEGACY" ]] && TARGET="$DIR.npm-$$"
echo "→ Installing $PACKAGE from npm"
mkdir -p "$TARGET"
if ! npm install --prefix "$TARGET" --silent --no-audit --no-fund --omit=dev "$PACKAGE"; then
  [[ -n "$LEGACY" ]] && rm -rf "$TARGET"
  fail "npm could not install $PACKAGE."
fi
if [[ -n "$LEGACY" ]]; then
  echo "→ Replacing the git clone in $DIR with the npm package"
  rm -rf "$DIR"
  mv "$TARGET" "$DIR"
fi
NEW_VERSION="$(version)"
[[ -n "$NEW_VERSION" ]] || fail "npm did not install itfin-mcp into $DIR."

# Servers that apps started before this update keep running the old code until they exit. Stop them,
# matching only the node processes (not the wrappers apps launch them with), so no app keeps using
# stale tools. Each app starts a fresh server for its next session, or after a restart.
# The pattern also matches the dist/index.js of a replaced git clone.
STALE=""
[[ -n "$OLD_VERSION" && "$OLD_VERSION" != "$NEW_VERSION" ]] && STALE="$(pgrep -f "^[^ ]*node $DIR/(node_modules/itfin-mcp/)?dist/index\.js\$" || true)"
if [[ -n "$STALE" ]]; then
  echo "→ Stopping $(echo "$STALE" | wc -l | tr -d ' ') running itfin-mcp server(s) with the old code"
  kill $STALE 2>/dev/null || true
fi

CONFIG="$DIR/config.json"
HELPERS="$PKG/scripts/install-helpers.mjs"
SAVED=""
if [[ -f "$CONFIG" ]]; then SAVED="$(node "$HELPERS" read-config "$CONFIG")" || fail "$CONFIG is not valid JSON. Fix or delete it, then run the install again."; fi
saved() { printf '%s\n' "$SAVED" | sed -n "s/^$1=//p" | head -1; }
# Mode of app $2 in a list like "claude=cli desktop=mcp".
mode_in() { local pair; for pair in $1; do [[ "${pair%%=*}" == "$2" ]] && echo "${pair#*=}"; done; return 0; }
# Sets app $1 to mode $2 in APPS.
set_mode() { local pair out=""; for pair in $APPS; do [[ "${pair%%=*}" == "$1" ]] || out+="$pair "; done; APPS="$out$1=$2"; }

# Apps and their modes: claude (Claude Code), codex, desktop (Claude Desktop); mcp or cli.
# Updates keep the apps and modes of the previous install. Installs from before config.json are MCP.
PREV_APPS="$(saved apps)"
if [[ -z "$PREV_APPS" ]]; then
  command -v claude >/dev/null && claude mcp get itfin >/dev/null 2>&1 && PREV_APPS+="claude=mcp "
  [[ -f "$CODEX_CONFIG" ]] && grep -q '^\[mcp_servers\.itfin\]$' "$CODEX_CONFIG" && PREV_APPS+="codex=mcp "
  [[ -f "$DESKTOP_CONFIG" ]] && grep -q '"itfin"' "$DESKTOP_CONFIG" && PREV_APPS+="desktop=mcp "
fi
APPS=""
if [[ -n "$CLIENTS$MODES" ]]; then
  for client in $CLIENTS; do mode="$(mode_in "$PREV_APPS" "$client")"; set_mode "$client" "${mode:-mcp}"; done
  for pair in $MODES; do [[ "$pair" == *=* ]] || fail "Use --mode app=mode, e.g. --mode claude=cli."; set_mode "${pair%%=*}" "${pair#*=}"; done
else
  APPS="$PREV_APPS"
fi
if [[ -z "$APPS" ]]; then
  FOUND=()
  command -v claude >/dev/null && FOUND+=("claude=Claude Code=mcp,cli")
  command -v codex >/dev/null && FOUND+=("codex=Codex=mcp,cli")
  [[ -d /Applications/Claude.app || -f "$DESKTOP_CONFIG" ]] && FOUND+=("desktop=Claude Desktop=mcp")
  [[ ${#FOUND[@]} -gt 0 ]] || fail "Install Claude Code, Codex or Claude Desktop first."
  if (: </dev/tty) 2>/dev/null; then
    APPS="$(node "$PKG/scripts/pick-clients.mjs" "${FOUND[@]}")" || fail "Cancelled."
  else
    for found in "${FOUND[@]}"; do APPS+="${found%%=*}=mcp "; done
  fi
fi
APPS="$(echo $APPS)"
for pair in $APPS; do
  app="${pair%%=*}" mode="${pair#*=}"
  [[ "$app" =~ ^(claude|codex|desktop)$ ]] || fail "Unknown app: $app. Use claude, codex or desktop."
  [[ "$mode" =~ ^(mcp|cli)$ ]] || fail "Unknown mode for $app: $mode. Use mcp or cli."
  [[ "$pair" != "desktop=cli" ]] || fail "Claude Desktop has no shell, so it can only use MCP mode."
done
mode_of() { mode_in "$APPS" "$1"; }
# Apps of the previous install that this run doesn't touch keep their mode.
ALL_APPS="$APPS"
for pair in $PREV_APPS; do [[ -n "$(mode_of "${pair%%=*}")" ]] || ALL_APPS+=" $pair"; done
uses_cli() { [[ " $ALL_APPS " == *"=cli "* ]]; }

# The itfin command for CLI mode. Never replace an itfin command that isn't ours.
WRAPPER_MARK="# itfin-mcp CLI wrapper"
if uses_cli && [[ -e "$BIN" ]] && ! grep -qF "$WRAPPER_MARK" "$BIN"; then
  fail "$BIN already exists and is not the itfin-mcp CLI. Remove or rename it, or keep every app in MCP mode."
fi

# Settings: flags, then config.json, then (for installs from before config.json) the env of the
# previous MCP registrations in Claude Code, Codex or Claude Desktop.
PREV=""
if command -v claude >/dev/null; then PREV+="$(claude mcp get itfin 2>/dev/null || true)"$'\n'; fi
if [[ -f "$CODEX_CONFIG" ]]; then PREV+="$(cat "$CODEX_CONFIG")"$'\n'; fi
if [[ -f "$DESKTOP_CONFIG" ]]; then
  PREV+="$(node -e 'const env = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).mcpServers?.itfin?.env ?? {};
    for (const [k, v] of Object.entries(env)) console.log(`${k}=${v}`)' "$DESKTOP_CONFIG" 2>/dev/null || true)"
fi
# Prints the value of KEY from lines like `KEY=value` or `KEY = "value"`.
prev() {
  printf '%s\n' "$PREV" | awk -v k="$1" '{
    sub(/^[ \t]+/, "")
    if (index($0, k) != 1) next
    rest = substr($0, length(k) + 1)
    if (rest !~ /^[ \t]*=/) next
    sub(/^[ \t]*=[ \t]*/, "", rest); gsub(/"/, "", rest); sub(/[ \t]+$/, "", rest)
    print rest; exit
  }'
}

[[ -n "$URL" ]] || URL="$(saved url)"
[[ -n "$URL" ]] || URL="$(prev ITFIN_URL)"
[[ -n "$BROWSER" ]] || BROWSER="$(saved browser)"
[[ -n "$BROWSER" ]] || BROWSER="$(prev ITFIN_BROWSER)"
[[ -n "$WORK_START" ]] || WORK_START="$(saved workStart)"
[[ -n "$WORK_START" ]] || WORK_START="$(prev ITFIN_WORK_START)"
[[ -n "$TIMEZONE" ]] || TIMEZONE="$(saved timezone)"
[[ -n "$TIMEZONE" ]] || TIMEZONE="$(prev ITFIN_TIMEZONE)"

if [[ -z "$URL" ]]; then
  COMPANY="$(ask "Company name in ITFin (acme for https://acme.itfin.io)")"
  COMPANY="$(printf '%s' "$COMPANY" | tr '[:upper:]' '[:lower:]' | tr -d '[:space:]')"
  # Also accept a pasted address like https://acme.itfin.io.
  COMPANY="${COMPANY#*://}"; COMPANY="${COMPANY%%.itfin.io*}"
  [[ "$COMPANY" =~ ^[a-z0-9-]+$ ]] || fail "Company name must be letters, digits or dashes, like acme."
  URL="https://$COMPANY.itfin.io"
fi
URL="${URL%/}"
[[ "$URL" =~ ^https?://[^/]+$ ]] || fail "Workspace address must look like https://acme.itfin.io"
echo "→ Workspace: $URL"

# Both modes read the settings from config.json. Settings left empty use the defaults (chrome,
# 10:00, system timezone).
node "$HELPERS" write-config "$CONFIG" "$URL" "$BROWSER" "$WORK_START" "$TIMEZONE" $ALL_APPS

ENTRY="$PKG/dist/index.js"
# Absolute path, because Claude Desktop does not see version-manager shims on PATH.
NODE="$(command -v node)"
ENV_PAIRS=("ITFIN_CONFIG=$CONFIG")
ENV_ARGS=(-e "ITFIN_CONFIG=$CONFIG")
cli() { ITFIN_CONFIG="$CONFIG" "$NODE" "$ENTRY" cli "$@"; }

SKILL_MARK="Generated by itfin-mcp install"
# The CLI skill in folder $1. Only a skill this installer wrote is ever removed.
install_skill() { mkdir -p "$1"; cli __skill >"$1/SKILL.md"; }
remove_skill() { [[ -f "$1/SKILL.md" ]] && grep -qF "$SKILL_MARK" "$1/SKILL.md" && rm -rf "$1"; return 0; }
READ_ONLY=()
if uses_cli && [[ -z "$NO_PERMISSIONS" ]]; then
  while IFS= read -r command; do [[ -n "$command" ]] && READ_ONLY+=("$command"); done < <(cli __read-only)
fi

if [[ -n "$(mode_of claude)" ]]; then
  command -v claude >/dev/null || fail "The claude CLI was not found."
  claude mcp remove itfin --scope user >/dev/null 2>&1 || true
  if [[ "$(mode_of claude)" == cli ]]; then
    echo "→ Setting up Claude Code in CLI mode (skill $CLAUDE_SKILL)"
    install_skill "$CLAUDE_SKILL"
    PERMS="$(node "$HELPERS" claude-permissions "$CLAUDE_SETTINGS" "$CONFIG" ${READ_ONLY[@]+"${READ_ONLY[@]}"})" \
      || echo "! Could not update $CLAUDE_SETTINGS (is it valid JSON?), so Claude Code will ask before every itfin command."
    [[ -n "$PERMS" ]] && echo "→ Allowed read-only itfin commands in $CLAUDE_SETTINGS: $(echo $PERMS)"
  else
    echo "→ Registering the MCP server with Claude Code (user scope)"
    remove_skill "$CLAUDE_SKILL"
    node "$HELPERS" claude-permissions "$CLAUDE_SETTINGS" "$CONFIG" >/dev/null || true
    claude mcp add itfin --scope user "${ENV_ARGS[@]}" -- "$NODE" "$ENTRY"
  fi
fi

if [[ -n "$(mode_of codex)" ]]; then
  command -v codex >/dev/null || fail "The codex CLI was not found."
  codex mcp remove itfin >/dev/null 2>&1 || true
  if [[ "$(mode_of codex)" == cli ]]; then
    echo "→ Setting up Codex in CLI mode (skill $CODEX_SKILL)"
    install_skill "$CODEX_SKILL"
    rm -f "$CODEX_RULES"
    if [[ ${#READ_ONLY[@]} -gt 0 ]]; then
      # Allowed commands run outside the Codex sandbox, which blocks the network and the Keychain.
      mkdir -p "$(dirname "$CODEX_RULES")"
      { echo "# Written by itfin-mcp install: read-only itfin commands. Rewritten on every update."
        for command in "${READ_ONLY[@]}"; do echo "prefix_rule(pattern=[\"itfin\", \"$command\"], decision=\"allow\")"; done
      } >"$CODEX_RULES"
      echo "→ Allowed read-only itfin commands in $CODEX_RULES"
    fi
  else
    echo "→ Registering the MCP server with Codex"
    remove_skill "$CODEX_SKILL"
    rm -f "$CODEX_RULES"
    codex mcp add itfin "${ENV_ARGS[@]/#-e/--env}" -- "$NODE" "$ENTRY"
    # itfin_login waits up to 3 minutes; Codex gives up on tool calls after 60 seconds by default.
    sed -i '' '/^\[mcp_servers\.itfin\]$/a\
tool_timeout_sec = 240
' "$CODEX_CONFIG"
  fi
fi

DESKTOP=""
if [[ -n "$(mode_of desktop)" ]]; then
  echo "→ Registering the MCP server with Claude Desktop"
  # Replaces only mcpServers.itfin and keeps the rest of the file. The old file is kept as .bak.
  if node "$HELPERS" desktop-register "$DESKTOP_CONFIG" "$NODE" "$ENTRY" "${ENV_PAIRS[@]}"; then
    DESKTOP=1
  else
    echo "! Could not update $DESKTOP_CONFIG (is it valid JSON?), so Claude Desktop was not registered."
  fi
fi

PATH_HINT=""
if uses_cli; then
  echo "→ Installing the itfin command in $BIN"
  mkdir -p "$(dirname "$BIN")"
  printf '#!/bin/sh\n%s, written by npx itfin-mcp install.\nITFIN_CONFIG="${ITFIN_CONFIG:-%s}" exec "%s" "%s" cli "$@"\n' "$WRAPPER_MARK" "$CONFIG" "$NODE" "$ENTRY" >"$BIN"
  chmod +x "$BIN"
  [[ ":$PATH:" == *":$(dirname "$BIN"):"* ]] || PATH_HINT=1
elif [[ -f "$BIN" ]] && grep -qF "$WRAPPER_MARK" "$BIN"; then
  rm -f "$BIN"
fi

echo
SUMMARY=""
for pair in $ALL_APPS; do
  case "${pair%%=*}" in claude) name="Claude Code" ;; codex) name="Codex" ;; desktop) name="Claude Desktop" ;; esac
  SUMMARY+="${SUMMARY:+, }$name: $(echo "${pair#*=}" | tr '[:lower:]' '[:upper:]')"
done
echo "✓ itfin-mcp $NEW_VERSION is installed in $DIR ($SUMMARY)"
[[ -n "$PATH_HINT" ]] && echo "! $(dirname "$BIN") is not on your PATH. Add it: echo 'export PATH=\"\$HOME/.local/bin:\$PATH\"' >> ~/.zshrc"
# Claude Desktop reads its config only at startup. Not quit here: it may be running this script.
[[ -n "$DESKTOP" ]] && echo "Restart Claude Desktop (Cmd+Q, then open it) to load the server."
[[ -n "${STALE:-}" ]] && echo "Open sessions lost the ITFin tools: start a new session, or reconnect itfin with /mcp in Claude Code."
echo "Next: start a new session and ask it to \"log in to ITFin\"."
echo "Run npx itfin-mcp@latest install at any time to update."
