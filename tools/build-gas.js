// gas/src/server.js と docs/js/shared.js をつなげて、貼り付け用の gas/Code.gs を作ります。
// 使い方: node tools/build-gas.js
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const header =
  '// ===== ビカクログ サーバー用コード（このファイルの中身をすべて Apps Script に貼り付けます） =====\n' +
  '// ※このファイルは tools/build-gas.js で自動生成しています。直接編集しないでください。\n\n';
const server = fs.readFileSync(path.join(root, 'gas/src/server.js'), 'utf8');
const shared = fs.readFileSync(path.join(root, 'docs/js/shared.js'), 'utf8');
fs.writeFileSync(path.join(root, 'gas/Code.gs'), header + server + '\n\n' + shared);
console.log('gas/Code.gs を作成しました');
