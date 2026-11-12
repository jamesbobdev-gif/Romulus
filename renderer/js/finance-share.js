/* The SimpleFIN link's shared copy, on the phone: the same box a computer keeps in the <personal key>:finance sync
   row (main/finance.js shareBox / okShareBox / finance:setupShared), opened and made here with only the page's own
   crypto. The box is the link alone, sealed with AES-256-GCM (its own AAD) under a key made from his Finance
   passphrase with scrypt (N 2^17, r 8, p 1, about 128 MB per guess). The phone's web crypto has no scrypt, so it
   is written out below (RFC 7914) over PBKDF2-SHA256 from crypto.subtle; it gives way to the page every few
   thousand rounds so the screen can say what it's doing while it works (a few seconds on a phone).
   mobile/finance-phone.js calls it; the desktop never does (Node's own scrypt does it there). */
(function () {
  const FIN_SHARE_KDF = { N: 131072, r: 8, p: 1 }; // must be main/finance.js KDF: the computer refuses any other numbers
  const FIN_SHARE_AAD = 'tasks-finance-share-v1';
  const FIN_SHARE_MIN = 10; // main/finance.js MIN_PASSPHRASE

  const subtle = function () { return globalThis.crypto.subtle; };
  const b64 = function (bytes) { let s = ''; bytes = new Uint8Array(bytes); for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]); return btoa(s); };
  const unb64 = function (s) { const bin = atob(String(s)); const out = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i); return out; };

  async function pbkdf2(pass, salt, len) {
    const k = await subtle().importKey('raw', pass, 'PBKDF2', false, ['deriveBits']);
    return new Uint8Array(await subtle().deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: salt, iterations: 1 }, k, len * 8));
  }
  // Salsa20/8 on 16 words, in place
  function salsa8(B, x) {
    for (let i = 0; i < 16; i++) x[i] = B[i];
    const R = function (a, b) { return (a << b) | (a >>> (32 - b)); };
    for (let i = 0; i < 8; i += 2) {
      x[4] ^= R(x[0] + x[12], 7); x[8] ^= R(x[4] + x[0], 9); x[12] ^= R(x[8] + x[4], 13); x[0] ^= R(x[12] + x[8], 18);
      x[9] ^= R(x[5] + x[1], 7); x[13] ^= R(x[9] + x[5], 9); x[1] ^= R(x[13] + x[9], 13); x[5] ^= R(x[1] + x[13], 18);
      x[14] ^= R(x[10] + x[6], 7); x[2] ^= R(x[14] + x[10], 9); x[6] ^= R(x[2] + x[14], 13); x[10] ^= R(x[6] + x[2], 18);
      x[3] ^= R(x[15] + x[11], 7); x[7] ^= R(x[3] + x[15], 9); x[11] ^= R(x[7] + x[3], 13); x[15] ^= R(x[11] + x[7], 18);
      x[1] ^= R(x[0] + x[3], 7); x[2] ^= R(x[1] + x[0], 9); x[3] ^= R(x[2] + x[1], 13); x[0] ^= R(x[3] + x[2], 18);
      x[6] ^= R(x[5] + x[4], 7); x[7] ^= R(x[6] + x[5], 9); x[4] ^= R(x[7] + x[6], 13); x[5] ^= R(x[4] + x[7], 18);
      x[11] ^= R(x[10] + x[9], 7); x[8] ^= R(x[11] + x[10], 9); x[9] ^= R(x[8] + x[11], 13); x[10] ^= R(x[9] + x[8], 18);
      x[12] ^= R(x[15] + x[14], 7); x[13] ^= R(x[12] + x[15], 9); x[14] ^= R(x[13] + x[12], 13); x[15] ^= R(x[14] + x[13], 18);
    }
    for (let i = 0; i < 16; i++) B[i] = (B[i] + x[i]) | 0;
  }
  // BlockMix: X (32r words) → Y, with the even 16-word blocks first, then the odd ones
  function blockMix(X, Y, r, T, x) {
    for (let i = 0; i < 16; i++) T[i] = X[(2 * r - 1) * 16 + i];
    for (let b = 0; b < 2 * r; b++) {
      for (let i = 0; i < 16; i++) T[i] ^= X[b * 16 + i];
      salsa8(T, x);
      const at = ((b & 1) ? r + (b >> 1) : (b >> 1)) * 16;
      for (let i = 0; i < 16; i++) Y[at + i] = T[i];
    }
  }
  const pause = function () { return new Promise(function (res) { setTimeout(res, 0); }); };
  // scrypt(passphrase, salt) → 32 bytes; passphrase as typed (NFKC, as the computer does), salt as bytes
  async function finScrypt(passphrase, salt, o) {
    o = o || FIN_SHARE_KDF;
    const N = o.N, r = o.r, p = o.p, w = 32 * r;
    const pass = new TextEncoder().encode(String(passphrase).normalize('NFKC'));
    const B = await pbkdf2(pass, salt, p * 128 * r);
    const V = new Int32Array(w * N), X = new Int32Array(w), Y = new Int32Array(w), T = new Int32Array(16), x = new Int32Array(16);
    const view = new DataView(B.buffer, B.byteOffset, B.byteLength);
    for (let c = 0; c < p; c++) {
      const off = c * 128 * r;
      for (let i = 0; i < w; i++) X[i] = view.getInt32(off + i * 4, true);
      for (let i = 0; i < N; i++) {
        V.set(X, i * w);
        blockMix(X, Y, r, T, x); X.set(Y);
        if ((i & 4095) === 4095) await pause();
      }
      for (let i = 0; i < N; i++) {
        const j = (X[(2 * r - 1) * 16] >>> 0) & (N - 1); // N is a power of two
        for (let k = 0; k < w; k++) X[k] ^= V[j * w + k];
        blockMix(X, Y, r, T, x); X.set(Y);
        if ((i & 4095) === 4095) await pause();
      }
      for (let i = 0; i < w; i++) view.setInt32(off + i * 4, X[i], true);
    }
    V.fill(0);
    return pbkdf2(pass, B, 32);
  }

  // the same check the computer makes before any scrypt runs on what came down from the sync row
  function finShareOk(b) {
    return !!(b && b.v === 1 && b.kdf === 'scrypt' && b.N === FIN_SHARE_KDF.N && b.r === FIN_SHARE_KDF.r && b.p === FIN_SHARE_KDF.p &&
      [b.salt, b.iv, b.tag, b.data].every(function (x) { return typeof x === 'string' && x.length && x.length <= 4096; }));
  }
  async function aesKey(raw) { return subtle().importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']); }
  // box + passphrase → the link inside, or null on a wrong passphrase (the GCM tag doesn't match)
  async function finShareOpen(box, passphrase) {
    if (!finShareOk(box)) throw new Error('bad box');
    const raw = await finScrypt(passphrase, unb64(box.salt), box);
    const data = unb64(box.data), tag = unb64(box.tag), both = new Uint8Array(data.length + tag.length);
    both.set(data); both.set(tag, data.length);
    let plain;
    try { plain = await subtle().decrypt({ name: 'AES-GCM', iv: unb64(box.iv), additionalData: new TextEncoder().encode(FIN_SHARE_AAD) }, await aesKey(raw), both); }
    catch (e) { return null; } finally { raw.fill(0); }
    const o = JSON.parse(new TextDecoder().decode(plain));
    return o && typeof o.u === 'string' ? o.u : null;
  }
  // a new box around the link, under a passphrase he picks here (a phone that was paired with a code has none)
  async function finShareMake(accessUrl, passphrase) {
    if (String(passphrase || '').length < FIN_SHARE_MIN) throw new Error('Use a passphrase of at least ' + FIN_SHARE_MIN + ' characters.');
    const salt = globalThis.crypto.getRandomValues(new Uint8Array(16)), iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
    const raw = await finScrypt(passphrase, salt);
    let both;
    try { both = new Uint8Array(await subtle().encrypt({ name: 'AES-GCM', iv: iv, additionalData: new TextEncoder().encode(FIN_SHARE_AAD) }, await aesKey(raw), new TextEncoder().encode(JSON.stringify({ u: accessUrl })))); }
    finally { raw.fill(0); }
    return { v: 1, kdf: 'scrypt', N: FIN_SHARE_KDF.N, r: FIN_SHARE_KDF.r, p: FIN_SHARE_KDF.p, salt: b64(salt),
      iv: b64(iv), tag: b64(both.subarray(both.length - 16)), data: b64(both.subarray(0, both.length - 16)) };
  }

  const FinShare = { KDF: FIN_SHARE_KDF, MIN: FIN_SHARE_MIN, scrypt: finScrypt, ok: finShareOk, open: finShareOpen, make: finShareMake };
  if (typeof module !== 'undefined' && module.exports) module.exports = FinShare;
  else window.FinShare = FinShare;
})();
