// End-to-end encrypted lists ("v2"), for the functions on the project that hold a list's sync key themselves
// (tasks-mcp, school-ingest, work-ics). The same derivation as the app's renderer/js/sync-crypto.js and
// agent/sync-crypto.js (read the first for the design): HKDF-SHA256 over the sync key, salt 'romulus-sync-v2',
// info 'lookup' → the row's id, info 'content' → the AES-256-GCM key. A sealed row is {e:1, iv, ct}, base64, the
// GCM tag at the end of ct. test/functions-sync-crypto.test.js holds this and the app's two together.
//
// What this does and doesn't keep private: the table, its backups and its logs hold only ciphertext under ids
// that lead nowhere. These functions can still read the lists whose keys they were given, because that is their
// job; so those lists are only as private as the place the keys are kept. A key set as a function secret
// (SYNC_KEY_PERSONAL, …) is outside the database; one in the app_secrets table is in every database backup.
//
// Plain JavaScript on WebCrypto, with no Deno in it, so the Node tests can load the very file the functions run.

export const SALT = "romulus-sync-v2";
const cache = new Map(); // base sync key → Promise<{lookup, key}>
const enc = new TextEncoder();

// 'tk_agent_abc:prefs' → {base: 'tk_agent_abc', sfx: ':prefs'}
export function splitKey(k) { const m = /^(.*?)(:[a-z-]+)?$/.exec(String(k || "")); return { base: m[1], sfx: m[2] || "" }; }
const keyPrefix = (base) => { const m = /^tk_(?:(?:work|agent|school)_)?/.exec(base); return m ? m[0] : "tk_"; };
const b64 = (bytes) => { let s = ""; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000)); return btoa(s); };
const unb64 = (s) => Uint8Array.from(atob(String(s)), (c) => c.charCodeAt(0));
const b64url = (bytes) => b64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

function keys(base) {
  if (!cache.has(base)) cache.set(base, (async () => {
    const pre = keyPrefix(base);
    const hk = (info) => ({ name: "HKDF", hash: "SHA-256", salt: enc.encode(SALT), info: enc.encode(info) });
    // the id from the key without its tk_[list_] prefix (one account per sync key); the cipher key from all of it
    const rawId = await crypto.subtle.importKey("raw", enc.encode(base.slice(pre.length)), "HKDF", false, ["deriveBits"]);
    const raw = await crypto.subtle.importKey("raw", enc.encode(base), "HKDF", false, ["deriveKey"]);
    const id = new Uint8Array(await crypto.subtle.deriveBits(hk("lookup"), rawId, 24 * 8));
    const key = await crypto.subtle.deriveKey(hk("content"), raw, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
    return { lookup: pre + b64url(id), key };
  })());
  return cache.get(base);
}
// the key the database knows a row by: lookup id + suffix
export async function rowKey(syncKey) { const s = splitKey(syncKey); return (await keys(s.base)).lookup + s.sfx; }
export const isSealed = (doc) => !!(doc && doc.e === 1 && doc.iv && doc.ct);
export async function seal(syncKey, doc) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, (await keys(splitKey(syncKey).base)).key, enc.encode(JSON.stringify(doc)));
  return { e: 1, iv: b64(iv), ct: b64(new Uint8Array(ct)) };
}
export async function open(syncKey, env) {
  const iv = unb64(env.iv), ct = unb64(env.ct);
  if (iv.length !== 12 || ct.length < 16) throw new Error("bad sealed row");
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, (await keys(splitKey(syncKey).base)).key, ct);
  return JSON.parse(new TextDecoder().decode(plain));
}

// A list or one of its side rows, read and written whichever way the app keeps it.
//   get(rowKey) → {doc, updated_at} | null      put(rowKey, doc, prev) → boolean (compare-and-swap on updated_at)
// A list the app moved to v2 has {moved: 'v2'} left under its plain key: from then on the row is found under its
// lookup id and its document is opened here and sealed again on the way back. Once a list is known to have moved
// that is remembered while the function stays warm; "not moved" is asked again each time, so the function follows
// the moment a device switches.
export function makeStore({ get, put }) {
  const moved = new Set(); // base sync keys
  const marked = async (key) => { const row = await get(key); return { row, yes: !!(row && row.doc && row.doc.moved === "v2") }; };
  // → {doc, updated_at, v2}; doc is null when there is no row yet
  async function read(syncKey) {
    const { base, sfx } = splitKey(syncKey);
    if (!moved.has(base)) {
      const own = await marked(syncKey);
      // a side row whose own marker is missing (it never existed in the clear) still follows its list
      if (!own.yes && !(sfx && (await marked(base)).yes)) return { doc: own.row ? own.row.doc : null, updated_at: own.row ? own.row.updated_at : null, v2: false };
      moved.add(base);
    }
    const row = await get(await rowKey(syncKey));
    if (!row) return { doc: null, updated_at: null, v2: true };
    // a plain row where a sealed one should be is not this list: refuse rather than read or overwrite something else's
    if (!isSealed(row.doc)) throw new Error("an unencrypted copy is where the encrypted list should be");
    return { doc: await open(syncKey, row.doc), updated_at: row.updated_at, v2: true };
  }
  // v2: what read() said about this row, so a write always goes back the way the read came
  async function write(syncKey, doc, prev, v2) {
    return v2 ? put(await rowKey(syncKey), await seal(syncKey, doc), prev) : put(syncKey, doc, prev);
  }
  return { read, write };
}
