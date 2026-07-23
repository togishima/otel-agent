// エントリポイント（`node src/cli.js` とSEA単一バイナリの共通入口）。
// 引数なしでサーバー起動、`merge-env` で ~/.claude/settings.json へのマージのみ実行。
import { mergeClaudeEnv } from './merge-env.js';

if (process.argv[2] === 'merge-env') {
  mergeClaudeEnv();
} else {
  import('./server.js');
}
