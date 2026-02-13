#!/usr/bin/env bash
# Setup Coqui TTS Python environment for OpenCode TTS plugin.
# Creates a venv, installs TTS + dependencies, and verifies the install.
#
# Usage: ./scripts/setup-coqui.sh [--force]
#   --force  Recreate venv even if it exists and TTS is already installed

set -euo pipefail

COQUI_DIR="$HOME/.config/opencode/opencode-helpers/coqui"
VENV_DIR="$COQUI_DIR/venv"
VENV_PYTHON="$VENV_DIR/bin/python"
VENV_PIP="$VENV_DIR/bin/pip"

FORCE=false
if [[ "${1:-}" == "--force" ]]; then
  FORCE=true
fi

echo "=== Coqui TTS Setup ==="
echo "Directory: $COQUI_DIR"

# Find system Python 3
find_python() {
  for cmd in python3.11 python3.10 python3.12 python3; do
    if command -v "$cmd" &>/dev/null; then
      local ver
      ver=$("$cmd" --version 2>&1 | grep -oE '[0-9]+\.[0-9]+')
      local major minor
      major=$(echo "$ver" | cut -d. -f1)
      minor=$(echo "$ver" | cut -d. -f2)
      if [[ "$major" -eq 3 && "$minor" -ge 10 && "$minor" -le 12 ]]; then
        echo "$cmd"
        return 0
      fi
    fi
  done
  return 1
}

# Check if TTS is already installed and working
if [[ "$FORCE" == "false" && -x "$VENV_PYTHON" ]]; then
  if "$VENV_PYTHON" -c "from TTS.api import TTS; print('ok')" 2>/dev/null | grep -q "ok"; then
    echo "Coqui TTS already installed and functional."
    "$VENV_PYTHON" -c "import TTS; print(f'  TTS version: {TTS.__version__}')"
    "$VENV_PYTHON" -c "import torch; print(f'  PyTorch device: mps={torch.backends.mps.is_available()}, cuda={torch.cuda.is_available()}')" 2>/dev/null || true
    echo "Done. Use --force to reinstall."
    exit 0
  fi
  echo "Existing venv found but TTS not functional. Recreating..."
fi

# Find Python
PYTHON=$(find_python) || {
  echo "ERROR: Python 3.10-3.12 required but not found."
  echo "Install with: brew install python@3.11"
  exit 1
}
echo "Using Python: $PYTHON ($($PYTHON --version))"

# Create directory
mkdir -p "$COQUI_DIR"

# Remove broken venv if exists
if [[ -d "$VENV_DIR" ]]; then
  echo "Removing existing venv..."
  rm -rf "$VENV_DIR"
fi

# Create fresh venv
echo "Creating virtual environment..."
"$PYTHON" -m venv "$VENV_DIR"

# Verify pip exists
if [[ ! -x "$VENV_PIP" ]]; then
  echo "ERROR: pip not found in venv. Trying ensurepip..."
  "$VENV_PYTHON" -m ensurepip --default-pip 2>/dev/null || {
    echo "ERROR: Could not install pip in venv."
    echo "Try: $PYTHON -m pip install --user virtualenv"
    exit 1
  }
fi

# Upgrade pip
echo "Upgrading pip..."
"$VENV_PIP" install --upgrade pip

# Install TTS (this takes a few minutes - downloads PyTorch + models)
echo "Installing Coqui TTS (this may take 5-10 minutes)..."
echo "  - TTS library"
echo "  - PyTorch (for MPS/CUDA acceleration)"
echo "  - transformers <4.50 (pinned for compatibility)"
"$VENV_PIP" install TTS "transformers<4.50"

# Verify installation
echo ""
echo "=== Verification ==="

"$VENV_PYTHON" -c "from TTS.api import TTS; print('  TTS import: OK')" || {
  echo "ERROR: TTS import failed after installation."
  exit 1
}

"$VENV_PYTHON" -c "import TTS; print(f'  TTS version: {TTS.__version__}')"

"$VENV_PYTHON" -c "
import torch
mps = torch.backends.mps.is_available()
cuda = torch.cuda.is_available()
device = 'mps' if mps else ('cuda' if cuda else 'cpu')
print(f'  PyTorch device: {device} (mps={mps}, cuda={cuda})')
" 2>/dev/null || echo "  PyTorch device check: skipped"

# Quick synthesis test
echo ""
echo "=== Quick Synthesis Test ==="
TEST_WAV="/tmp/opencode_coqui_test_$$.wav"
"$VENV_PYTHON" -c "
import torch
_orig = torch.load
def patched(*a, **kw):
    kw.setdefault('weights_only', False)
    return _orig(*a, **kw)
torch.load = patched

from TTS.api import TTS
device = 'mps' if torch.backends.mps.is_available() else ('cuda' if torch.cuda.is_available() else 'cpu')
tts = TTS('tts_models/en/vctk/vits').to(device)
tts.tts_to_file(text='Hello, this is a test.', file_path='$TEST_WAV', speaker='p226')
print('  Synthesis: OK')
" || {
  echo "ERROR: Synthesis test failed."
  exit 1
}

if [[ -f "$TEST_WAV" ]]; then
  SIZE=$(wc -c < "$TEST_WAV" | tr -d ' ')
  echo "  Output: $TEST_WAV ($SIZE bytes)"
  if [[ "$SIZE" -gt 1000 ]]; then
    echo "  Audio file looks valid."
  else
    echo "  WARNING: Audio file suspiciously small ($SIZE bytes)"
  fi
  # Play it on macOS
  if command -v afplay &>/dev/null; then
    echo "  Playing test audio..."
    afplay "$TEST_WAV" 2>/dev/null || true
  fi
  rm -f "$TEST_WAV"
else
  echo "  WARNING: No output file generated"
fi

echo ""
echo "=== Setup Complete ==="
echo "Coqui TTS is ready. Restart OpenCode for the plugin to use it."
