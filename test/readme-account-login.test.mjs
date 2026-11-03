import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const locales = [
  { file: 'README.md', account: /You do not choose a Soul during account login/, local: /login only authenticates your account/i, faq: 'Login cannot select a valid active profile', obsolete: /During login, do not select|Select your website Soul in the browser/ },
  { file: 'README.zh-CN.md', account: /登录时不需要选定 Soul/, local: /login.*仅.*账号/, faq: '登录提示没有有效的活动档案', obsolete: /登录时不要选成另一个网站角色|在浏览器选择网站上的 Soul/ },
  { file: 'README.ja.md', account: /ログインはアカウント認証のみ/, local: /login.*アカウント認証のみ/, faq: '有効なローカルプロファイルを選択できない', obsolete: /既存の Soul を選択してからデバイスを承認|もう一度 `37soul login`|Soul を login で復元|ブラウザでサイトの Soul を選択|開始済みのセッションはその場で Soul を切り替えられません/ },
];
for (const { file, account, local, faq, obsolete } of locales) {
  const doc = readFileSync(new URL('../' + file, import.meta.url), 'utf8');
  const normalized = doc.replace(/\s+/g, ' ');
  test(`${file}: account login then owned directory and exact native-session connect`, () => {
    assert.match(normalized, account);
    assert.ok(doc.indexOf('37soul hosts') < doc.indexOf('37soul connect'), 'directory selection precedes connection');
    assert.match(doc, /37soul connect[^`\n]*--agent [^`\n]*--session /);
    assert.ok(doc.includes('connection.state: attached'));
    assert.doesNotMatch(doc, obsolete);
  });
  test(`${file}: local publication keeps account-only login, same UID select then authorize`, () => {
    const block = /```bash\n([^`]*37soul soul authorize[^`]*)```\n\n([^\n]+)/.exec(doc);
    assert.ok(block, 'local authorization example and explanation exist');
    assert.deepEqual(block[1].trim().split('\n'), [
      '37soul login',
      '37soul soul select "$SOUL_UID"',
      '37soul soul authorize "$SOUL_UID" --categories identity,relationship,experience',
      '37soul sync',
    ]);
    assert.match(block[2], local);
    assert.ok(block[2].includes('`37soul soul select "$SOUL_UID"`'));
    assert.ok(block[2].includes('`37soul soul authorize`'));
    assert.ok(block[2].includes('--categories'));
  });
  test(`${file}: profile recovery FAQ selects roles locally after account approval`, () => {
    const row = doc.split('\n').find(line => line.startsWith('|') && line.includes(faq));
    assert.ok(row);
    assert.ok(row.includes('37soul login'));
    assert.ok(row.includes('37soul hosts'));
    assert.ok(row.includes('37soul connect'));
    assert.doesNotMatch(row, obsolete);
  });
}
