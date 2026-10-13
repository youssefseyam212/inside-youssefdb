#!/usr/bin/env bash
# Builds the site into docs/:
#   index.html          the app: the published youssefdb (+ bson) bundled for the browser with
#                       in-memory stand-ins for fs, crypto and path, everything inlined
#   privacy/, terms/    the legal pages
#   favicons, robots.txt, and sitemap.xml when SITE_URL is set (see site/site.config)
# Run from the repo root:  bash site/build.sh
# With a domain:           SITE_URL=https://example.org bash site/build.sh
set -e
cd "$(dirname "$0")"

ENV_SITE_URL="${SITE_URL:-}"
# shellcheck source=/dev/null
[ -f site.config ] && . ./site.config
SITE_URL="${ENV_SITE_URL:-$SITE_URL}"
SITE_URL="${SITE_URL%/}"

npm install --no-save esbuild@0.23.1 path-browserify@1.0.1 youssefdb@latest >/dev/null
npx esbuild entry.js --bundle --platform=browser --format=iife --global-name=YDB --minify --keep-names \
  --alias:fs=./shims/fs.js --alias:crypto=./shims/crypto.js --alias:path=path-browserify \
  "--banner:js=var process=globalThis.process||{pid:1,cwd:function(){return '/'},env:{}};" \
  --outfile=ydb.bundle.js

OUT=../docs
mkdir -p "$OUT/privacy" "$OUT/terms"
cp assets/favicon.svg assets/favicon-32.png assets/apple-touch-icon.png "$OUT/"
[ -f assets/og-image.png ] && cp assets/og-image.png "$OUT/"

# head <title> <description> <path from site root, e.g. "" or "privacy/"> <relative root, e.g. "" or "../">
head() {
  echo '<!doctype html><html lang="en"><head><meta charset="utf-8">'
  echo '<meta name="viewport" content="width=device-width,initial-scale=1">'
  echo "<title>$1</title>"
  echo "<meta name=\"description\" content=\"$2\">"
  echo "<link rel=\"icon\" href=\"$4favicon.svg\" type=\"image/svg+xml\">"
  echo "<link rel=\"icon\" href=\"$4favicon-32.png\" type=\"image/png\" sizes=\"32x32\">"
  echo "<link rel=\"apple-touch-icon\" href=\"$4apple-touch-icon.png\">"
  echo '<meta name="theme-color" content="#1d5c63">'
  echo '<meta property="og:type" content="website"><meta property="og:site_name" content="Inside youssefdb">'
  echo "<meta property=\"og:title\" content=\"$1\"><meta property=\"og:description\" content=\"$2\">"
  if [ -n "$SITE_URL" ]; then
    echo "<link rel=\"canonical\" href=\"$SITE_URL/$3\"><meta property=\"og:url\" content=\"$SITE_URL/$3\">"
    if [ -f assets/og-image.png ]; then
      echo "<meta property=\"og:image\" content=\"$SITE_URL/og-image.png\"><meta property=\"og:image:width\" content=\"1200\"><meta property=\"og:image:height\" content=\"630\">"
      echo '<meta name="twitter:card" content="summary_large_image">'
    fi
  fi
  echo '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600&family=JetBrains+Mono:wght@400;500;700&display=swap">'
  echo '<style>'; cat app.css; echo '</style></head><body>'
}
footer() { sed "s|{{ROOT}}|$1|g" footer.html; }

{
  head 'Inside youssefdb' 'Watch a NoSQL database work: the real youssefdb running in your browser, from code to memory to BSON bytes to disk.' '' ''
  sed '/{{FOOTER}}/,$d' body.html
  footer ''
  sed '1,/{{FOOTER}}/d' body.html
  echo '<script>'; cat ydb.bundle.js; echo '</script>'
  echo '<script>'; cat app.js; echo '</script></body></html>'
} > "$OUT/index.html"

# legal <name> <title> <description>
legal() {
  {
    head "$2 · Inside youssefdb" "$3" "$1/" '../'
    echo '<div class="wrap">'
    echo '<header><a class="brand" href="../"><img src="../favicon.svg" width="36" height="36" alt=""><b>youssef<span>db</span></b></a></header>'
    cat "pages/$1.html"
    footer '../'
    echo '</div></body></html>'
  } > "$OUT/$1/index.html"
}
legal privacy 'Privacy Policy' 'What happens to your data on Inside youssefdb: it stays in your browser.'
legal terms 'Terms and Conditions' 'The terms for using Inside youssefdb, a free page for learning how youssefdb works.'

if [ -n "$SITE_URL" ]; then
  printf 'User-agent: *\nAllow: /\n\nSitemap: %s/sitemap.xml\n' "$SITE_URL" > "$OUT/robots.txt"
  today=$(date +%Y-%m-%d)
  {
    echo '<?xml version="1.0" encoding="UTF-8"?>'
    echo '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">'
    for p in '' privacy/ terms/; do echo "  <url><loc>$SITE_URL/$p</loc><lastmod>$today</lastmod></url>"; done
    echo '</urlset>'
  } > "$OUT/sitemap.xml"
else
  printf 'User-agent: *\nAllow: /\n' > "$OUT/robots.txt"
  rm -f "$OUT/sitemap.xml"
  echo "Note: SITE_URL is not set (site/site.config), so canonical, og:url, og:image and sitemap.xml were skipped."
fi

rm -f ydb.bundle.js
echo "Built docs/ (index.html, privacy/, terms/)"
