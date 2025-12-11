#!/usr/bin/env bash
set -euo pipefail

APP_NAME="migration-cli"
REPO="Janith-apst/migration-cli"
DEFAULT_VERSION="latest"
ASSET_EXT="tar.gz"

version="$DEFAULT_VERSION"
system_wide="false"
uninstall="false"

usage() {
  cat <<'EOF'
Usage: install.sh [options]

Options:
  -v, --version <tag>   Install a specific release tag (default: latest)
  -s, --system          Install system-wide (/usr/local or /opt/homebrew)
  -u, --uninstall       Remove the CLI and PATH shim
  -h, --help            Show this help

This installer expects GitHub release assets named:
  migration-cli-<os>-<arch>.tar.gz
where <os> is one of linux|macos and <arch> is x64|arm64.
EOF
}

log() { printf '%s\n' "$*"; }
err() { printf 'Error: %s\n' "$*" >&2; }

detect_platform() {
  local os arch
  case "$(uname -s)" in
    Linux) os="linux" ;;
    Darwin) os="macos" ;;
    *) err "Unsupported OS: $(uname -s)"; exit 1 ;;
  esac

  case "$(uname -m)" in
    x86_64|amd64) arch="x64" ;;
    arm64|aarch64) arch="arm64" ;;
    *) err "Unsupported architecture: $(uname -m)"; exit 1 ;;
  esac

  printf '%s %s' "$os" "$arch"
}

require_node() {
  if ! command -v node >/dev/null 2>&1; then
    err "Node.js is required (>=18). Please install Node first."; exit 1
  fi
  local ver major
  ver=$(node -v | sed 's/^v//')
  major=${ver%%.*}
  if [ "${major:-0}" -lt 18 ]; then
    err "Node.js >=18 required, found ${ver}."; exit 1
  fi
}

sha256_cmd() {
  if command -v sha256sum >/dev/null 2>&1; then
    printf 'sha256sum'
  elif command -v shasum >/dev/null 2>&1; then
    printf 'shasum -a 256'
  else
    printf ''
  fi
}

fetch_checksum_and_verify() {
  local file url checksum_cmd expected actual
  file="$1"
  url="$2"
  checksum_cmd=$(sha256_cmd)

  if [ -z "$checksum_cmd" ]; then
    log "Skipping checksum verification (no sha256 tool available)."
    return
  fi

  local tmp_checksum
  tmp_checksum=$(mktemp)
  if ! curl -fsSL "$url" -o "$tmp_checksum" >/dev/null 2>&1; then
    rm -f "$tmp_checksum"
    log "Checksum file not found; skipping verification."
    return
  fi

  expected=$(cut -d' ' -f1 "$tmp_checksum")
  actual=$($checksum_cmd "$file" | awk '{print $1}')
  rm -f "$tmp_checksum"

  if [ "$expected" != "$actual" ]; then
    err "Checksum mismatch for $(basename "$file")"; exit 1
  fi
  log "Checksum verified."
}

ensure_dirs_writable() {
  local path="$1"
  if [ ! -w "$path" ]; then
    err "No write permission for $path. Try running with sudo or use --system only when appropriate."
    exit 1
  fi
}

create_wrapper() {
  local install_dir="$1" bin_path="$2"
  mkdir -p "${install_dir}/bin"
  cat >"${install_dir}/bin/${APP_NAME}" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd -P)"
APP_HOME="$(cd "${SCRIPT_DIR}/.." && pwd -P)"
export NODE_PATH="${APP_HOME}/node_modules"
exec node "${APP_HOME}/dist/index.js" "$@"
EOF
  chmod +x "${install_dir}/bin/${APP_NAME}"
  ln -sf "${install_dir}/bin/${APP_NAME}" "$bin_path/${APP_NAME}"
}

print_path_hint() {
  local bin_dir="$1"
  if ! printf '%s' ":$PATH:" | grep -q ":${bin_dir}:"; then
    log "PATH update suggested: export PATH=\"${bin_dir}:\$PATH\""
  fi
}

uninstall_cli() {
  local install_dir="$1" bin_dir="$2"
  rm -rf "$install_dir"
  rm -f "$bin_dir/${APP_NAME}"
  log "Uninstalled ${APP_NAME} from $install_dir"
  log "Removed shim from $bin_dir"
  exit 0
}

# Parse args
while [ $# -gt 0 ]; do
  case "$1" in
    -v|--version) version="$2"; shift 2 ;;
    -s|--system) system_wide="true"; shift ;;
    -u|--uninstall) uninstall="true"; shift ;;
    -h|--help) usage; exit 0 ;;
    *) err "Unknown option: $1"; usage; exit 1 ;;
  esac
done

os_arch=$(detect_platform)
os=${os_arch%% *}
arch=${os_arch##* }

if [ "$system_wide" = "true" ]; then
  if [ "$os" = "macos" ] && [ "$(uname -m)" = "arm64" ] && [ -d "/opt/homebrew" ]; then
    prefix="/opt/homebrew"
  else
    prefix="/usr/local"
  fi
else
  prefix="${HOME}/.local"
fi

install_dir="${prefix}/lib/${APP_NAME}"
bin_dir="${prefix}/bin"

if [ "$uninstall" = "true" ]; then
  uninstall_cli "$install_dir" "$bin_dir"
fi

require_node

if [ ! -d "$prefix" ]; then
  mkdir -p "$prefix"
fi
ensure_dirs_writable "$prefix"
mkdir -p "$bin_dir"

asset="${APP_NAME}-${os}-${arch}.${ASSET_EXT}"
release_path="releases"
if [ "$version" = "latest" ]; then
  base_url="https://github.com/${REPO}/${release_path}/latest/download"
else
  base_url="https://github.com/${REPO}/${release_path}/download/${version}"
fi

tmpdir=$(mktemp -d)
trap 'rm -rf "$tmpdir"' EXIT

archive_path="${tmpdir}/${asset}"
log "Downloading ${asset} from ${base_url}..."
curl -fL "${base_url}/${asset}" -o "$archive_path"

fetch_checksum_and_verify "$archive_path" "${base_url}/${asset}.sha256"

rm -rf "$install_dir"
mkdir -p "$install_dir"

tar -xzf "$archive_path" -C "$install_dir" --strip-components=1

create_wrapper "$install_dir" "$bin_dir"

log "Installed to $install_dir"
log "Linked shim at $bin_dir/${APP_NAME}"
print_path_hint "$bin_dir"
log "Done. Run '${APP_NAME} --help' to get started."
