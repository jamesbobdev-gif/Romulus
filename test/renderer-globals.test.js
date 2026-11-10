// The page scripts in renderer/js have no bundler: index.html loads them in order
// and they all share one global scope. Two files declaring the same top-level name
// either crash the page (let/const/class) or silently replace each other (function/var).
// These tests catch that, and a script that exists but is never loaded (or the reverse),
// before anyone has to run the app to find out.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const RENDERER = path.join(__dirname, '..', 'renderer');
const JS_DIR = path.join(RENDERER, 'js');

function scriptTags(htmlFile) {
  const html = fs.readFileSync(htmlFile, 'utf8');
  return [...html.matchAll(/<script[^>]*\bsrc="([^"]+)"/g)].map((m) => m[1]);
}

// Words after which a "/" starts a regex rather than meaning divide.
const REGEX_AFTER_WORD = new Set(['return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw', 'case', 'do', 'else', 'yield', 'await']);

// Returns [{ name, kind, line }] for every declaration at the top level of a classic script.
function topLevelNames(src) {
  const out = [];
  let i = 0;
  let line = 1;
  let depth = 0;
  const templateDepths = []; // brace depth at which each open `${` resumes its template
  let lastSig = ''; // last significant token, to tell regex from divide
  const n = src.length;

  const isIdStart = (c) => /[A-Za-z_$]/.test(c);
  const isId = (c) => /[A-Za-z0-9_$]/.test(c);

  function skipString(q) {
    i++;
    while (i < n && src[i] !== q) {
      if (src[i] === '\\') i++;
      else if (src[i] === '\n') line++;
      i++;
    }
    i++;
  }
  // Scans template text from i; returns true if it stopped at `${` (still inside the template).
  function skipTemplateText() {
    while (i < n) {
      const c = src[i];
      if (c === '\\') { i += 2; continue; }
      if (c === '\n') line++;
      if (c === '`') { i++; return false; }
      if (c === '$' && src[i + 1] === '{') { i += 2; return true; }
      i++;
    }
    return false;
  }
  function skipRegex() {
    i++;
    let inClass = false;
    while (i < n) {
      const c = src[i];
      if (c === '\\') { i += 2; continue; }
      if (c === '\n') break;
      if (c === '[') inClass = true;
      else if (c === ']') inClass = false;
      else if (c === '/' && !inClass) { i++; break; }
      i++;
    }
    while (i < n && isId(src[i])) i++;
  }
  function skipSpace() {
    while (i < n) {
      const c = src[i];
      if (c === '\n') { line++; i++; }
      else if (/\s/.test(c)) i++;
      else if (c === '/' && src[i + 1] === '/') { while (i < n && src[i] !== '\n') i++; }
      else if (c === '/' && src[i + 1] === '*') {
        const end = src.indexOf('*/', i + 2);
        const stop = end < 0 ? n : end + 2;
        for (let k = i; k < stop; k++) if (src[k] === '\n') line++;
        i = stop;
      } else break;
    }
  }
  function readWord() {
    const s = i;
    while (i < n && isId(src[i])) i++;
    return src.slice(s, i);
  }
  // Binding names in a destructuring pattern starting at i ({ or [), e.g. { a, b: c, ...d } -> a, c, d
  function readPattern() {
    const names = [];
    const open = src[i];
    const close = open === '{' ? '}' : ']';
    let d = 0;
    let prevWord = '';
    const start = i;
    for (; i < n; i++) {
      const c = src[i];
      if (c === '\n') line++;
      if (c === '{' || c === '[') d++;
      else if (c === '}' || c === ']') { d--; if (d === 0 && c === close) { i++; break; } }
      if (isIdStart(c) && !isId(src[i - 1] || '')) {
        const s = i;
        while (i < n && isId(src[i])) i++;
        const w = src.slice(s, i);
        i--;
        // a word followed by ":" is a key, not a binding (unless inside an array pattern)
        let k = i + 1;
        while (k < n && /\s/.test(src[k])) k++;
        if (src[k] !== ':' || open === '[') names.push(w);
        prevWord = w;
      }
    }
    void prevWord; void start;
    return names;
  }

  while (i < n) {
    skipSpace();
    if (i >= n) break;
    const c = src[i];
    if (c === '"' || c === "'") { skipString(c); lastSig = 'str'; continue; }
    if (c === '`') {
      i++;
      if (skipTemplateText()) { templateDepths.push(depth); depth++; lastSig = '{'; }
      else lastSig = 'str';
      continue;
    }
    if (c === '/') {
      const regexOk = lastSig === '' || /^[(,=:[!&|?{};+\-*%<>~^]$/.test(lastSig) || REGEX_AFTER_WORD.has(lastSig);
      if (regexOk) { skipRegex(); lastSig = 'str'; continue; }
      i++; lastSig = '/'; continue;
    }
    if (c === '{' || c === '(' || c === '[') { depth++; i++; lastSig = c; continue; }
    if (c === '}' || c === ')' || c === ']') {
      depth--;
      i++;
      if (c === '}' && templateDepths.length && templateDepths[templateDepths.length - 1] === depth) {
        templateDepths.pop();
        if (skipTemplateText()) { templateDepths.push(depth); depth++; lastSig = '{'; }
        else lastSig = 'str';
        continue;
      }
      lastSig = c === '}' ? '}' : ')';
      continue;
    }
    if (isIdStart(c)) {
      const wordLine = line;
      const w = readWord();
      // ignore property names like obj.let or obj.function
      const prev = src[i - w.length - 1];
      if (depth === 0 && prev !== '.') {
        let kind = null;
        if (w === 'function' || w === 'class') kind = w;
        else if (w === 'let' || w === 'const' || w === 'var') kind = w;
        if (kind) {
          skipSpace();
          if (kind === 'function' && src[i] === '*') { i++; skipSpace(); }
          if ((kind === 'let' || kind === 'const' || kind === 'var') && (src[i] === '{' || src[i] === '[')) {
            for (const name of readPattern()) out.push({ name, kind, line: wordLine });
            lastSig = 'id';
            continue;
          }
          if (isIdStart(src[i] || '')) {
            const name = readWord();
            out.push({ name, kind, line: wordLine });
            lastSig = 'id';
            continue;
          }
        }
      }
      lastSig = w;
      continue;
    }
    lastSig = c;
    i++;
  }
  return out;
}

test('scanner finds top-level names and skips nested ones', () => {
  const src = [
    'const a = 1, notSeen = 2;',
    'let { b, c: d, ...e } = obj;',
    'function f() { const inner = 1; }',
    'async function g() {}',
    'class H {}',
    'var s = "const fake = 1", t = `x ${ { y: 1 }.y } const z`;',
    'const r = /\\/[}]{/g; const after = 1;',
    'if (x) { let blocked = 1; }',
    'obj.const = 1;',
  ].join('\n');
  assert.deepStrictEqual(topLevelNames(src).map((x) => x.name), ['a', 'b', 'd', 'e', 'f', 'g', 'H', 's', 'r', 'after']);
});

const pages = ['index.html', 'overlay.html'];

test('every renderer/js script is loaded by a page, and every script tag points at a file', () => {
  const loaded = new Set();
  for (const page of pages) {
    for (const src of scriptTags(path.join(RENDERER, page))) {
      if (/^https?:/.test(src)) continue;
      assert.ok(fs.existsSync(path.join(RENDERER, src)), `${page} loads ${src}, which does not exist`);
      loaded.add(path.normalize(src));
    }
  }
  const files = fs.readdirSync(JS_DIR).filter((f) => f.endsWith('.js'));
  const unloaded = files.filter((f) => !loaded.has(path.normalize('js/' + f)));
  assert.deepStrictEqual(unloaded, [], 'these files are never loaded by a page; add a <script> tag or delete them');
});

for (const page of pages) {
  test(`${page}: no two scripts declare the same top-level name`, () => {
    const seen = new Map();
    const clashes = [];
    for (const src of scriptTags(path.join(RENDERER, page))) {
      if (/^https?:/.test(src)) continue;
      const code = fs.readFileSync(path.join(RENDERER, src), 'utf8');
      for (const d of topLevelNames(code)) {
        const where = `${src}:${d.line} (${d.kind})`;
        if (seen.has(d.name)) clashes.push(`${d.name}: ${seen.get(d.name)} and ${where}`);
        else seen.set(d.name, where);
      }
    }
    assert.deepStrictEqual(clashes, [], 'rename one of each pair, or move the shared one into a single file');
  });
}

test('scripts load in an order where top-level code only uses names already declared', () => {
  // Cheap check for the most common mistake: a file calling another file's function at load
  // time before that file is loaded. Only looks at bare calls at the top level, e.g. `init();`.
  const declaredBy = new Map();
  const order = scriptTags(path.join(RENDERER, 'index.html')).filter((s) => !/^https?:/.test(s));
  order.forEach((src, idx) => {
    const code = fs.readFileSync(path.join(RENDERER, src), 'utf8');
    for (const d of topLevelNames(code)) if (!declaredBy.has(d.name)) declaredBy.set(d.name, idx);
  });
  const problems = [];
  order.forEach((src, idx) => {
    const code = fs.readFileSync(path.join(RENDERER, src), 'utf8');
    for (const m of code.matchAll(/^([A-Za-z_$][\w$]*)\s*\(/gm)) {
      const at = declaredBy.get(m[1]);
      if (at !== undefined && at > idx) problems.push(`${src} calls ${m[1]}() at load time, but ${order[at]} loads later`);
    }
  });
  assert.deepStrictEqual(problems, []);
});

module.exports = { topLevelNames };
