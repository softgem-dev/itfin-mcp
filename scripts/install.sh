#!/usr/bin/env bash
# Quick install for itfin-mcp: installs or updates the npm package in ~/.itfin-mcp and registers the
# MCP server with Claude Code, Codex and Claude Desktop. Usage:
#   npx itfin-mcp install [--company acme] [--clients claude,codex,desktop] [--browser chrome] [--work-start 10:00] [--timezone Europe/Kyiv]
#   curl -fsSL https://raw.githubusercontent.com/steven-tailor/itfin-mcp/main/scripts/install.sh | bash -s -- [same flags]
# The first install asks which apps to install for and the company name. Updates reuse the apps and
# settings of the previous install.
set -euo pipefail

DIR="${ITFIN_MCP_DIR:-$HOME/.itfin-mcp}"
# What npm installs. Override it to try a local build: ITFIN_MCP_PACKAGE=./itfin-mcp-0.1.0.tgz
PACKAGE="${ITFIN_MCP_PACKAGE:-itfin-mcp@latest}"
CODEX_CONFIG="${CODEX_HOME:-$HOME/.codex}/config.toml"
DESKTOP_CONFIG="$HOME/Library/Application Support/Claude/claude_desktop_config.json"
URL="" BROWSER="" WORK_START="" TIMEZONE="" CLIENTS=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --company) URL="https://$2.itfin.io"; shift 2 ;;
    --url) URL="$2"; shift 2 ;;
    --clients) CLIENTS="${2//,/ }"; shift 2 ;;
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
OLD_VERSION=""
if [[ -d "$DIR/.git" ]]; then
  # Installs before the npm package were a git clone of the repo, which npm can't install into.
  [[ "$(git -C "$DIR" remote get-url origin 2>/dev/null)" == *itfin-mcp* ]] || fail "$DIR is a git repo that isn't itfin-mcp. Pick another folder with --dir."
  echo "→ Replacing the git clone in $DIR with the npm package"
  OLD_VERSION="git"
  rm -rf "$DIR"
else
  OLD_VERSION="$(version)"
fi

echo "→ Installing $PACKAGE from npm"
mkdir -p "$DIR"
npm install --prefix "$DIR" --silent --no-audit --no-fund --omit=dev "$PACKAGE"
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

# Apps to register with: claude (Claude Code), codex, desktop (Claude Desktop).
# Updates keep the apps of the previous install. A first install asks, with every app found checked.
if [[ -z "$CLIENTS" ]]; then
  command -v claude >/dev/null && claude mcp get itfin >/dev/null 2>&1 && CLIENTS+="claude "
  [[ -f "$CODEX_CONFIG" ]] && grep -q '^\[mcp_servers\.itfin\]$' "$CODEX_CONFIG" && CLIENTS+="codex "
  [[ -f "$DESKTOP_CONFIG" ]] && grep -q '"itfin"' "$DESKTOP_CONFIG" && CLIENTS+="desktop "
fi
if [[ -z "$CLIENTS" ]]; then
  FOUND=()
  command -v claude >/dev/null && FOUND+=("claude=Claude Code")
  command -v codex >/dev/null && FOUND+=("codex=Codex")
  [[ -d /Applications/Claude.app || -f "$DESKTOP_CONFIG" ]] && FOUND+=("desktop=Claude Desktop")
  [[ ${#FOUND[@]} -gt 0 ]] || fail "Install Claude Code, Codex or Claude Desktop first."
  if (: </dev/tty) 2>/dev/null; then
    CLIENTS="$(node "$PKG/scripts/pick-clients.mjs" "${FOUND[@]}")" || fail "Cancelled."
  else
    for found in "${FOUND[@]}"; do CLIENTS+="${found%%=*} "; done
  fi
fi
CLIENTS=" $(echo $CLIENTS) "
for client in $CLIENTS; do
  [[ "$client" =~ ^(claude|codex|desktop)$ ]] || fail "Unknown app: $client. Use claude, codex or desktop."
done
wants() { [[ "$CLIENTS" == *" $1 "* ]]; }

# Settings of the previous install, from the Claude Code registration, the Codex config or the
# Claude Desktop config.
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

[[ -n "$URL" ]] || URL="$(prev ITFIN_URL)"
[[ -n "$BROWSER" ]] || BROWSER="$(prev ITFIN_BROWSER)"
[[ -n "$WORK_START" ]] || WORK_START="$(prev ITFIN_WORK_START)"
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

ENTRY="$PKG/dist/index.js"
# Absolute path, because Claude Desktop does not see version-manager shims on PATH.
NODE="$(command -v node)"
# Settings left empty are not passed, so the server uses its defaults (chrome, 10:00, system timezone).
ENV_PAIRS=()
for pair in "ITFIN_URL=$URL" "ITFIN_BROWSER=$BROWSER" "ITFIN_WORK_START=$WORK_START" "ITFIN_TIMEZONE=$TIMEZONE"; do
  [[ -n "${pair#*=}" ]] && ENV_PAIRS+=("$pair")
done
ENV_ARGS=()
for pair in "${ENV_PAIRS[@]}"; do ENV_ARGS+=(-e "$pair"); done

if wants claude; then
  command -v claude >/dev/null || fail "The claude CLI was not found."
  echo "→ Registering the MCP server with Claude Code (user scope)"
  claude mcp remove itfin --scope user >/dev/null 2>&1 || true
  claude mcp add itfin --scope user "${ENV_ARGS[@]}" -- "$NODE" "$ENTRY"
fi

if wants codex; then
  command -v codex >/dev/null || fail "The codex CLI was not found."
  echo "→ Registering the MCP server with Codex"
  codex mcp remove itfin >/dev/null 2>&1 || true
  codex mcp add itfin "${ENV_ARGS[@]/#-e/--env}" -- "$NODE" "$ENTRY"
  # itfin_login waits up to 3 minutes; Codex gives up on tool calls after 60 seconds by default.
  sed -i '' '/^\[mcp_servers\.itfin\]$/a\
tool_timeout_sec = 240
' "$CODEX_CONFIG"
fi

DESKTOP=""
if wants desktop; then
  echo "→ Registering the MCP server with Claude Desktop"
  # Replaces only mcpServers.itfin and keeps the rest of the file. The old file is kept as .bak.
  if node -e '
    const fs = require("fs");
    const [file, command, entry, ...pairs] = process.argv.slice(1);
    const text = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
    const config = text.trim() ? JSON.parse(text) : {};
    if (text) fs.writeFileSync(file + ".bak", text);
    const env = Object.fromEntries(pairs.map((p) => [p.slice(0, p.indexOf("=")), p.slice(p.indexOf("=") + 1)]));
    config.mcpServers = { ...config.mcpServers, itfin: { command, args: [entry], env } };
    fs.mkdirSync(require("path").dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(config, null, 2) + "\n");
  ' "$DESKTOP_CONFIG" "$NODE" "$ENTRY" "${ENV_PAIRS[@]}"; then
    DESKTOP=1
  else
    echo "! Could not update $DESKTOP_CONFIG (is it valid JSON?), so Claude Desktop was not registered."
  fi
fi

echo
echo "✓ itfin-mcp $NEW_VERSION is installed in $DIR"
# Claude Desktop reads its config only at startup. Not quit here: it may be running this script.
[[ -n "$DESKTOP" ]] && echo "Restart Claude Desktop (Cmd+Q, then open it) to load the server."
[[ -n "${STALE:-}" ]] && echo "Open sessions lost the ITFin tools: start a new session, or reconnect itfin with /mcp in Claude Code."
echo "Next: start a new session and ask it to \"log in to ITFin\"."
echo "Run npx itfin-mcp@latest install at any time to update."
