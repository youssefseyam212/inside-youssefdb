#!/usr/bin/env bash
# Builds docs/index.html: bundles the published youssefdb (+ bson) for the browser
# with in-memory stand-ins for fs, crypto and path, then inlines everything.
# Run from the repo root:  bash site/build.sh
set -e
cd "$(dirname "$0")"
npm install --no-save esbuild@0.23.1 path-browserify@1.0.1 youssefdb@latest >/dev/null
npx esbuild entry.js --bundle --platform=browser --format=iife --global-name=YDB --minify --keep-names \
  --alias:fs=./shims/fs.js --alias:crypto=./shims/crypto.js --alias:path=path-browserify \
  "--banner:js=var process=globalThis.process||{pid:1,cwd:function(){return '/'},env:{}};" \
  --outfile=ydb.bundle.js
mkdir -p ../docs
{
  echo '<!doctype html><html lang="en"><head><meta charset="utf-8">'
  echo '<meta name="viewport" content="width=device-width,initial-scale=1">'
  echo '<meta name="description" content="Watch a NoSQL database work: the real youssefdb running in your browser, from code to memory to BSON bytes to disk.">'
  echo '<title>Inside youssefdb</title>'
  echo '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600&family=JetBrains+Mono:wght@400;500;700&display=swap">'
  echo '<style>'; cat app.css; echo '</style></head><body>'
  cat body.html
  echo '<script>'; cat ydb.bundle.js; echo '</script>'
  echo '<script>'; cat app.js; echo '</script></body></html>'
} > ../docs/index.html
rm -f ydb.bundle.js
echo "Built docs/index.html"
