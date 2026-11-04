/*
 * ビカクログ 原種の解説
 * 品種の名前に学名（例：P. ridleyi）かカタカナ名が入っていれば、その原種の解説を出します。
 * 一般的に知られている特徴をまとめたもので、株や環境によって違うことがあります。
 */
var BikakuSpecies = (function () {
  'use strict';

  var LIST = [
    { latin: 'alcicorne', ja: 'アルシコルネ', origin: 'アフリカ東部・マダガスカル',
      feature: '比較的小型で、胞子葉は立ち上がりぎみ。貯水葉は丸く株元を包みます。',
      care: '明るい場所と風通しを好みます。寒さにはやや弱いので、冬は室内で。' },
    { latin: 'andinum', ja: 'アンディナム', origin: '南米（ペルー・ボリビア）',
      feature: '南米に自生する唯一の原種。白い毛をまとった長い胞子葉が垂れ下がります。',
      care: '高温を好み、寒さに弱いほうです。乾かしぎみの水やりが向いています。' },
    { latin: 'bifurcatum', ja: 'ビフルカツム', origin: 'オーストラリア東部・ニューギニアなど',
      feature: 'もっとも広く出回っている原種。胞子葉は何度も二股に分かれます。ネザーランドなど園芸品種も多数。',
      care: '丈夫で育てやすく、寒さにも比較的強いので初めての1株に向いています。' },
    { latin: 'coronarium', ja: 'コロナリウム', origin: '東南アジア（マレー半島・フィリピンなど）',
      feature: '胞子葉が長く垂れ下がり、胞子は専用の小さな葉に付きます。',
      care: '高温多湿を好み、寒さに弱いほうです。冬の温度管理に注意。' },
    { latin: 'elephantotis', ja: 'エレファントティス', origin: 'アフリカ中部',
      feature: '胞子葉が切れ込みのない幅広い形で、象の耳のように見えることからの名前。',
      care: '寒さに弱く、冬は生長がゆっくりになります。冬の水やりは控えめに。' },
    { latin: 'ellisii', ja: 'エリシー', origin: 'マダガスカル',
      feature: '小型で、胞子葉は幅広くつややか。切れ込みは少なめです。',
      care: '明るい日陰と、湿度のある環境を好みます。' },
    { latin: 'grande', ja: 'グランデ', origin: 'フィリピン（ミンダナオ島など）',
      feature: '大型になる原種。大きな胞子葉が左右に広がります。スパーバムとよく似ています。',
      care: '高温多湿を好み、寒さに弱いほうです。大きくなるので重さの変化も大きめです。' },
    { latin: 'hillii', ja: 'ヒリー', origin: 'オーストラリア北東部',
      feature: '胞子葉が幅広く、切れ込みが浅め。濃い緑色で立ち上がります。ビフルカツムの仲間とされることも。',
      care: '比較的丈夫で育てやすい原種です。' },
    { latin: 'holttumii', ja: 'ホルタミー', origin: '東南アジア（タイ・カンボジア・ベトナムなど）',
      feature: '大型で、貯水葉が高く立ち上がります。胞子葉は二つに分かれて垂れ下がります。',
      care: '高温を好み、寒さに弱いほうです。' },
    { latin: 'madagascariense', ja: 'マダガスカリエンセ', origin: 'マダガスカル',
      feature: '小型で、貯水葉にワッフルのような網目状の凹凸ができます。',
      care: '高い湿度を好み、乾燥に弱く、やや育てるのが難しい原種です。' },
    { latin: 'quadridichotomum', ja: 'クアドリディコトマム', origin: 'マダガスカル',
      feature: '小型。乾季には胞子葉を丸めて休眠するのが特徴です。',
      care: '休眠中は水やりを控えめにします。' },
    { latin: 'ridleyi', ja: 'リドレイ', origin: 'マレー半島・ボルネオ島など',
      feature: '貯水葉に盛り上がった葉脈が浮き出し、胞子葉は上向きに伸びます。',
      care: '高温多湿と風通しを好みます。水切れと寒さに弱いので、乾き具合をこまめに見ましょう。' },
    { latin: 'stemaria', ja: 'ステマリア', origin: 'アフリカ西部・中部',
      feature: '幅広い胞子葉が垂れ下がり、裏側に白い毛が多くつきます。',
      care: '寒さに弱いほうです。冬は暖かい場所で。' },
    { latin: 'superbum', ja: 'スパーバム', origin: 'オーストラリア東部',
      feature: '大型になり、胞子葉が大きく垂れて広がります。グランデとよく似ています。',
      care: '大型種の中では寒さに比較的強く、育てやすいほうです。' },
    { latin: 'veitchii', ja: 'ビーチー', origin: 'オーストラリア東部の岩場など',
      feature: '胞子葉が立ち上がり、白い毛で白っぽく見えます。',
      care: '強めの光と乾燥に比較的強く、寒さにも強いほうです。' },
    { latin: 'wallichii', ja: 'ワリッキー', origin: 'インド東部〜ミャンマー・タイ',
      feature: '柔らかい胞子葉が垂れ下がります。乾季に休眠する性質があります。',
      care: '寒さと過湿に弱いほうです。休眠中は水やりを控えめに。' },
    { latin: 'wandae', ja: 'ワンダエ', origin: 'ニューギニア',
      feature: 'もっとも大型になる原種の一つ。貯水葉のふちにフリルのような突起ができます。',
      care: '高温多湿を好み、寒さに弱いほうです。' },
    { latin: 'willinckii', ja: 'ウィリンキー', origin: 'インドネシア（ジャワ島など）',
      feature: '細長い胞子葉が垂れ下がり、白い毛で白っぽく見えます。月光爪哇やジェイドガールなど園芸品種も多数。',
      care: '明るい場所を好みます。寒さにはやや弱いので、冬は室内で。' }
  ];

  /** 品種の名前から原種を探す（例：「P. ridleyi ‘Pakarang’」→ リドレイ） */
  function find(variety) {
    var v = String(variety || '').toLowerCase();
    if (!v) return null;
    for (var i = 0; i < LIST.length; i++) {
      if (v.indexOf(LIST[i].latin) >= 0 || v.indexOf(LIST[i].ja) >= 0) return LIST[i];
    }
    return null;
  }

  return { LIST: LIST, find: find };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = BikakuSpecies;
