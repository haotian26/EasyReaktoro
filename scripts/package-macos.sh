#!/bin/bash
# Package the already-built app without modifying the installed application.
set -euo pipefail
project_dir="$(cd "$(dirname "$0")/.." && pwd)"
version="$(cat "$project_dir/VERSION")"
app="$project_dir/src-tauri/target/release/bundle/macos/EasyReaktoro.app"
output="$project_dir/release/EasyReaktoro-v$version.dmg"
app_version="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$app/Contents/Info.plist")"
if [ "$app_version" != "$version" ]; then
  printf 'App version %s does not match VERSION %s. Build the app first.\n' "$app_version" "$version" >&2
  exit 1
fi
if [ -e "$output" ]; then
  printf 'Package already exists: %s\n' "$output" >&2
  exit 1
fi
codesign --verify --deep --strict "$app"
staging="$(mktemp -d -t easyreaktoro-package)"
trap 'rm -rf "$staging"' EXIT
ditto "$app" "$staging/EasyReaktoro.app"
ln -s /Applications "$staging/Applications"
mkdir -p "$project_dir/release"
hdiutil create -volname "EasyReaktoro $version" -srcfolder "$staging" -format UDZO "$output"
hdiutil verify "$output"
shasum -a 256 "$output"
