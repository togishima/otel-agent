// 実行形態（通常のnode実行 / SEA単一バイナリ）の差を吸収する。
// SEAバイナリ内では import.meta.url が使えず、public/ はアセットとして埋め込まれる。
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sea from 'node:sea';

export const IS_SEA = sea.isSea();

export function packageRoot() {
  if (IS_SEA || !import.meta.url) return process.cwd();
  return path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
}

export function readSeaAsset(name) {
  return Buffer.from(sea.getAsset(name));
}
