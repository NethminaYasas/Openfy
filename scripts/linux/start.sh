#!/bin/bash
# Start Openfy in the foreground for testing and manual use.
# Uses the installed virtualenv and the correct working directory.
# Does NOT fork to the background and does NOT manage the systemd service.
#
# Usage:
#   ./start.sh [--port 8000] [--host 0.0.0.0]
#   sudo -u openfy /opt/openfy/start.sh   (when installed bare-metal)

set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOST="0.0.0.0"
PORT="8000"

while [[ $# -gt 0 ]]; do
    case "$1" in
        --port) PORT="${2:?--port requires a value}"; shift 2 ;;
        --host) HOST="${2:?--host requires a value}"; shift 2 ;;
        -h|--help) sed -n '2,9p' "$0"; exit 0 ;;
        *) echo "ERROR: unknown option '$1'." >&2; exit 1 ;;
    esac
done

[[ "${PORT}" =~ ^[0-9]{1,5}$ ]] && [[ "${PORT}" -ge 1 && "${PORT}" -le 65535 ]] \
    || { echo "ERROR: invalid --port '${PORT}'." >&2; exit 1; }

VENV_PY="${APP_DIR}/venv/bin/python"
if [[ ! -x "${VENV_PY}" ]]; then
    echo "ERROR: virtualenv not found at ${APP_DIR}/venv." >&2
    echo "If this is a bare-metal install, run: sudo ./install.sh" >&2
    echo "For a source checkout, create one first:" >&2
    echo "  python3 -m venv venv && venv/bin/pip install -r ${APP_DIR}/requirements.txt" >&2
    exit 1
fi

# Load administrator-controlled config when present (installed service path
# first, then local .env for source checkouts). Values are only exported, never printed.
for candidate in "/etc/openfy/openfy.env" "${APP_DIR}/.env" "${APP_DIR}/../.env"; do
    if [[ -f "${candidate}" ]]; then
        echo "[openfy-start] Loading config from ${candidate}."
        set -a
        # shellcheck disable=SC1091
        source "${candidate}"
        set +a
        break
    fi
done

if command -v systemctl >/dev/null 2>&1 && systemctl is-active --quiet openfy 2>/dev/null; then
    echo "[openfy-start] NOTE: the 'openfy' systemd service is already running." >&2
    echo "[openfy-start] This foreground instance will conflict with it on port ${PORT}." >&2
    echo "[openfy-start] Stop the service first to test manually: sudo systemctl stop openfy" >&2
fi

[[ -f "${APP_DIR}/app/main.py" ]] || { echo "ERROR: ${APP_DIR}/app/main.py not found." >&2; exit 1; }

echo "[openfy-start] Starting Openfy in the foreground at http://${HOST}:${PORT} (Ctrl+C to stop)."
cd "${APP_DIR}"
exec "${APP_DIR}/venv/bin/python" -m uvicorn app.main:app --host "${HOST}" --port "${PORT}"
