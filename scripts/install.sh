#!/usr/bin/env bash
# Quick install for itfin-mcp: clones or updates the repo, builds it and registers the MCP server
# with Claude Code and Codex. Usage:
#   curl -fsSL https://raw.githubusercontent.com/softgem-dev/itfin-mcp/main/scripts/install.sh | bash
#   curl -fsSL .../install.sh | bash -s -- --url https://acme.itfin.io [--browser chrome] [--work-start 10:00] [--timezone Europe/Kyiv]
set -euo pipefail

REPO="https://github.com/softgem-dev/itfin-mcp.git"
DIR="${ITFIN_MCP_DIR:-$HOME/.itfin-mcp}"
URL="" BROWSER="" WORK_START="" TIMEZONE=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --url) URL="$2"; shift 2 ;;
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
command -v git >/dev/null || fail "git is required."
command -v node >/dev/null || fail "Node.js 22+ is required: https://nodejs.org"
[[ "$(node -p 'process.versions.node.split(".")[0]')" -ge 22 ]] || fail "Node.js 22+ is required (found $(node -v))."

if [[ -d "$DIR/.git" ]]; then
  echo "→ Updating $DIR"
  git -C "$DIR" pull --ff-only --quiet
else
  echo "→ Cloning into $DIR"
  git clone --quiet "$REPO" "$DIR"
fi

echo "→ Installing dependencies and building"
(cd "$DIR" && npm ci --silent --no-audit --no-fund && npm run --silent build)

[[ -n "$URL" ]] || URL="$(ask "ITFin workspace address (e.g. https://acme.itfin.io)")"
URL="${URL%/}"
[[ "$URL" =~ ^https?://[^/]+$ ]] || fail "Workspace address must look like https://acme.itfin.io"
[[ -n "$BROWSER" ]] || BROWSER="$(ask "Browser for login (chrome, edge, brave, arc, chromium)" chrome)"
[[ -n "$WORK_START" ]] || WORK_START="$(ask "Start of your working day (HH:mm)" 10:00)"
[[ -n "$TIMEZONE" ]] || TIMEZONE="$(ask "Timezone" "$(node -p 'Intl.DateTimeFormat().resolvedOptions().timeZone')")"

ENTRY="$DIR/dist/index.js"
# Absolute path, because Claude Desktop does not see version-manager shims on PATH.
NODE="$(command -v node)"
ENV_ARGS=(-e "ITFIN_URL=$URL" -e "ITFIN_BROWSER=$BROWSER" -e "ITFIN_WORK_START=$WORK_START" -e "ITFIN_TIMEZONE=$TIMEZONE")

if command -v claude >/dev/null; then
  echo "→ Registering the MCP server with Claude Code (user scope)"
  claude mcp remove itfin --scope user >/dev/null 2>&1 || true
  claude mcp add itfin --scope user "${ENV_ARGS[@]}" -- "$NODE" "$ENTRY"
fi

if command -v codex >/dev/null; then
  echo "→ Registering the MCP server with Codex"
  codex mcp remove itfin >/dev/null 2>&1 || true
  codex mcp add itfin "${ENV_ARGS[@]/#-e/--env}" -- "$NODE" "$ENTRY"
  # itfin_login waits up to 3 minutes; Codex gives up on tool calls after 60 seconds by default.
  sed -i '' '/^\[mcp_servers\.itfin\]$/a\
tool_timeout_sec = 240
' "${CODEX_HOME:-$HOME/.codex}/config.toml"
fi

command -v claude >/dev/null || command -v codex >/dev/null || echo "! Neither the Claude Code nor the Codex CLI was found, so nothing was registered."

cat <<EOF

✓ itfin-mcp is installed in $DIR

For Claude Desktop, add this to ~/Library/Application Support/Claude/claude_desktop_config.json under "mcpServers":

  "itfin": {
    "command": "$NODE",
    "args": ["$ENTRY"],
    "env": { "ITFIN_URL": "$URL", "ITFIN_BROWSER": "$BROWSER", "ITFIN_WORK_START": "$WORK_START", "ITFIN_TIMEZONE": "$TIMEZONE" }
  }

Next: start a new Claude session and ask it to "log in to ITFin".
Run this script again at any time to update.
EOF
