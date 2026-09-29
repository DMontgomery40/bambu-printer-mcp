#!/bin/zsh

# Build the optional macOS adapter that calls Bambu Studio's installed
# networking plug-in at runtime. The plug-in itself is not bundled here.
set -euo pipefail

if [[ "$(uname -s)" != "Darwin" ]]; then
  print -u2 "The Bambu native helper currently supports macOS only."
  exit 1
fi

SCRIPT_DIR="${0:A:h}"
PROJECT_ROOT="${SCRIPT_DIR:h}"
CXX_BIN="${CXX:-clang++}"
OUTPUT="${PROJECT_ROOT}/native/bambu-native-print"
SOURCE="${PROJECT_ROOT}/native/bambu-native-print.cpp"

if ! command -v "$CXX_BIN" >/dev/null 2>&1; then
  print -u2 "C++ compiler not found: $CXX_BIN"
  exit 1
fi

"$CXX_BIN" \
  -std=c++17 \
  -O2 \
  -Wall \
  -Wextra \
  -o "$OUTPUT" \
  "$SOURCE" \
  -ldl

chmod 755 "$OUTPUT"
print "Built $OUTPUT"
