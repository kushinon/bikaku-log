// 原種の解説（docs/js/species.js）のテスト
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const SP = require('../../docs/js/species.js');

test('原種は18種', () => { assert.equal(SP.LIST.length, 18); });

test('学名・カタカナ・園芸品種の名前から原種を見つける', () => {
  assert.equal(SP.find('P. ridleyi ‘Pakarang’').ja, 'リドレイ');
  assert.equal(SP.find('ジェイドガール（P. willinckii ‘Jade Girl’）').ja, 'ウィリンキー');
  assert.equal(SP.find('ネザーランド（P. bifurcatum ‘Netherlands’）').ja, 'ビフルカツム');
  assert.equal(SP.find('スパーバム').latin, 'superbum');
  assert.equal(SP.find('マセラティ（P. ‘Maserati’）'), null);
  assert.equal(SP.find(''), null);
});
