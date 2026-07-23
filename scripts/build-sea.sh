#!/bin/bash
# Node SEA (Single Executable Application) で単一バイナリを生成する。
# 生成物: dist/otel-agent-<os>-<arch>（ビルドしたマシンと同じOS/CPU用。クロスビルドは未対応）
# ビルド時のみ npx で esbuild / postject を使う（実行時依存は増えない）。
set -euo pipefail
cd "$(dirname "$0")/.."

OS="$(uname -s | tr '[:upper:]' '[:lower:]')"
ARCH="$(uname -m)"
OUT="dist/otel-agent-${OS}-${ARCH}"

rm -rf dist
mkdir -p dist

# SEAのmainはCJS単一ファイルである必要があるためバンドルする
npx -y esbuild src/cli.js --bundle --platform=node --format=cjs \
  --outfile=dist/bundle.cjs --log-override:empty-import-meta=silent

cat > dist/sea-config.json <<'EOF'
{
  "main": "dist/bundle.cjs",
  "output": "dist/sea-prep.blob",
  "disableExperimentalSEAWarning": true,
  "assets": {
    "index.html": "public/index.html",
    "app.js": "public/app.js",
    "style.css": "public/style.css"
  }
}
EOF

node --experimental-sea-config dist/sea-config.json
cp "$(command -v node)" "$OUT"

if [ "$OS" = "darwin" ]; then
  codesign --remove-signature "$OUT"
  npx -y postject "$OUT" NODE_SEA_BLOB dist/sea-prep.blob \
    --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2 \
    --macho-segment-name NODE_SEA
  codesign --sign - "$OUT"
else
  npx -y postject "$OUT" NODE_SEA_BLOB dist/sea-prep.blob \
    --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2
fi

echo "built: $OUT ($(du -h "$OUT" | cut -f1))"
