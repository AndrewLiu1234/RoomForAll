#!/usr/bin/env bash
set -euo pipefail

# setup-rea.sh - Environment verification and setup helper for REA (Reverse Engineer Anything)

echo "=========================================="
echo " Reverse Engineer Anything (REA) Inspector"
echo "=========================================="

echo "[1/4] Checking Node.js environment..."
if command -v node >/dev/null 2>&1; then
    echo "  ✓ Node.js version: $(node -v)"
else
    echo "  ✗ Node.js is not installed (required for JS analysis and REA CLI)."
fi

echo "[2/4] Checking Java environment (for Ghidra / JADX)..."
if command -v java >/dev/null 2>&1; then
    echo "  ✓ Java version: $(java -version 2>&1 | head -n 1)"
else
    echo "  ! Java not found. Ghidra and JADX require Java 17+ or 21+."
fi

echo "[3/4] Checking native binary inspection tools..."
for tool in otool objdump nm strings file shasum; do
    if command -v "$tool" >/dev/null 2>&1; then
        echo "  ✓ Found: $tool"
    else
        echo "  ! Missing: $tool"
    fi
done

echo "[4/4] Checking REA CLI and providers..."
if npx -y rea-agents@latest --version >/dev/null 2>&1; then
    echo "  ✓ rea-agents package accessible via npx"
    echo "  Running 'npx rea-agents doctor'..."
    npx -y rea-agents@latest doctor || true
else
    echo "  ! rea-agents CLI not reachable or offline"
fi

echo "=========================================="
echo " Setup check complete."
echo "=========================================="

