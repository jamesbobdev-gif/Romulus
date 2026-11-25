const test = require('node:test');
const assert = require('node:assert');
const { themeColorHex, themeColorName, themeCssColors, themeMainColor, themeSaveCss } = require('../renderer/js/theme-colors');

const SAMPLE = `:root{
  --bg:#FBFBFA;      /* page background */
  --surface:#FFFFFF; /* cards */
  --ink:#161616;     /* main text */
  --muted:#71716C;
  --accent:#2742C8;  /* buttons + highlights */
  --late:#C03B2B;
}
.card{border:1px solid #fff;color:rgb(22, 22, 22);background:hsl(140 50% 40%)}`;

test('themeColorHex: hex, short hex, rgb and hsl all come out as #RRGGBB', () => {
  assert.strictEqual(themeColorHex('#abc'), '#AABBCC');
  assert.strictEqual(themeColorHex('#2742c8cc'), '#2742C8');
  assert.strictEqual(themeColorHex('rgba(39,66,200,.5)'), '#2742C8');
  assert.strictEqual(themeColorHex('rgb(100% 0% 0%)'), '#FF0000');
  assert.strictEqual(themeColorHex('hsl(0, 100%, 50%)'), '#FF0000');
  assert.strictEqual(themeColorHex('#12345'), null);
});

test('themeColorName: plain colour families', () => {
  assert.strictEqual(themeColorName('#2742C8'), 'Blue');
  assert.strictEqual(themeColorName('#C03B2B'), 'Red');
  assert.strictEqual(themeColorName('#161616'), 'Black');
  assert.strictEqual(themeColorName('#FFFFFF'), 'White');
  assert.strictEqual(themeColorName('#71716C'), 'Gray');
  assert.strictEqual(themeColorName('#3A2E12'), 'Brown');
  assert.strictEqual(themeColorName('#7BD69E'), 'Green');
  assert.strictEqual(themeColorName('#0B1F4D'), 'Dark blue');
  assert.strictEqual(themeColorName('#F7C6E0'), 'Light pink');
  assert.strictEqual(themeColorName('#8A2BE2'), 'Purple');
});

test('themeCssColors: each colour once, comments ignored, every place it is used kept', () => {
  const c = themeCssColors(SAMPLE);
  assert.deepStrictEqual(c.map(x => x.hex), ['#FBFBFA', '#FFFFFF', '#161616', '#71716C', '#2742C8', '#C03B2B', '#339955']);
  assert.deepStrictEqual(c[1].used, ['--surface', 'border']);
  assert.deepStrictEqual(c[2].used, ['--ink', 'color']);
  assert.strictEqual(themeMainColor(c).hex, '#2742C8');
  assert.deepStrictEqual(themeCssColors('/* #ff0000 */ a{color:#f00}').map(x => x.hex), ['#FF0000']);
});

test('themeCssColors: colour words count, and the same colour written two ways is one', () => {
  const c = themeCssColors(':root{--accent:navy;--late:Tomato} a{color:#000080;border:1px solid rebeccapurple;background:white}');
  assert.deepStrictEqual(c.map(x => [x.hex, x.name]), [['#000080', 'Dark blue'], ['#FF6347', 'Red'], ['#663399', 'Purple'], ['#FFFFFF', 'White']]);
  assert.deepStrictEqual(c[0].used, ['--accent', 'color']);
});

test('themeCssColors: words that only look like colours are left alone', () => {
  const css = `a{color:var(--red);background:url(red.png) no-repeat;font-family:Georgia, tan;content:"blue"}
    .x{animation:pink 1s;border-color:currentColor;outline:transparent;--redish:1;width:calc(100% - 2px)}
    .y{box-shadow:0 0 2px reddish}`;
  assert.deepStrictEqual(themeCssColors(css), []);
});

test('themeSaveCss: one entry per distinct CSS, named by its main colour', () => {
  let list = themeSaveCss([], SAMPLE, 1);
  assert.strictEqual(list[0].name, 'Blue');
  list = themeSaveCss(list, ':root{--accent:#1E40FF}', 2);
  assert.strictEqual(list[0].name, 'Blue 2');
  list = themeSaveCss(list, SAMPLE.replace(/\n/g, ' '), 3); // same CSS, spaced differently
  assert.strictEqual(list.length, 2);
  assert.strictEqual(list[0].name, 'Blue');
  assert.strictEqual(list[0].at, 3);
  assert.strictEqual(themeSaveCss(list, '   ', 4).length, 2);
  assert.strictEqual(themeSaveCss([], 'a{font-weight:bold}', 5)[0].name, 'No colour');
});

test('themeSaveCss: your own name, saving over it, and renaming', () => {
  let list = themeSaveCss([], SAMPLE, 1, '  Pink scrollbars ');
  assert.strictEqual(list[0].name, 'Pink scrollbars');
  list = themeSaveCss(list, ':root{--accent:#1E40FF}', 2);
  assert.strictEqual(list[0].name, 'Blue');
  list = themeSaveCss(list, ':root{--accent:#E8A2C0}', 3, 'Pink scrollbars'); // edited, same name: replaces it
  assert.strictEqual(list.length, 2);
  assert.strictEqual(list[0].name, 'Pink scrollbars');
  assert.strictEqual(list[0].hex, '#E8A2C0');
  list = themeSaveCss(list, ':root{--accent:#1E40FF}', 4, 'Work'); // same CSS, new name: renamed
  assert.deepStrictEqual(list.map(t => t.name), ['Work', 'Pink scrollbars']);
  list = themeSaveCss(list, ':root{--accent:#1E40FF}', 5, 'Pink scrollbars'); // that CSS moves under the other name
  assert.deepStrictEqual(list.map(t => [t.name, t.hex]), [['Pink scrollbars', '#1E40FF']]);
});
