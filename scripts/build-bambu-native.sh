#!/bin/sh

# Build the optional adapter that calls Bambu's networking plug-in at runtime.
# The plug-in itself is not bundled here. Supported hosts: macOS and Linux.
# Usage: build-bambu-native.sh [--output PATH]
set -eu

case "$(uname -s)" in
  Darwin) default_cxx=clang++ ;;
  Linux) default_cxx=c++ ;;
  *)
    echo "The Bambu native helper supports macOS and Linux only." >&2
    exit 1
    ;;
esac

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
project_root=$(dirname -- "$script_dir")
source_file="$project_root/native/bambu-native-print.cpp"
output="$project_root/native/bambu-native-print"

while [ "$#" -gt 0 ]; do
  case "$1" in
    --output)
      [ "$#" -ge 2 ] && [ -n "$2" ] || { echo "--output requires a path" >&2; exit 2; }
      output=$2
      shift 2
      ;;
    *)
      echo "usage: $0 [--output PATH]" >&2
      exit 2
      ;;
  esac
done

cxx_bin=${CXX:-$default_cxx}
if ! command -v "$cxx_bin" >/dev/null 2>&1; then
  echo "C++ compiler not found: $cxx_bin (install clang++ or g++, or set CXX)" >&2
  exit 1
fi

mkdir -p "$(dirname -- "$output")"
# Compile beside the target and rename so a running server never executes a
# partially written helper.
temporary="$output.tmp.$$"
trap 'rm -f "$temporary"' EXIT
# dash skips EXIT traps on signals; clean up a killed build explicitly.
trap 'rm -f "$temporary"; exit 1' HUP INT TERM
"$cxx_bin" -std=c++17 -O2 -Wall -Wextra -pthread -o "$temporary" "$source_file" -ldl
chmod 755 "$temporary"
mv -f "$temporary" "$output"
trap - EXIT HUP INT TERM
echo "Built $output"
