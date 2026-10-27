/* 心悦俱乐部 6.5.4.34：仅移除 GetIndexPopFlash 的广告记录。 */
(function () {
  'use strict';
  function varint(b, p) {
    var n = 0, factor = 1, i = p;
    for (var steps = 0; steps < 10 && i < b.length; steps++, i++) {
      var x = b[i];
      n += (x & 127) * factor;
      if (n > Number.MAX_SAFE_INTEGER) throw new Error('varint overflow');
      if (!(x & 128)) return { value: n, end: i + 1 };
      factor *= 128;
    }
    throw new Error('invalid varint');
  }
  function encode(n) {
    var a = [];
    do { var x = n % 128; n = Math.floor(n / 128); a.push(n ? x | 128 : x); } while (n);
    return Uint8Array.from(a);
  }
  function fields(b) {
    var a = [];
    for (var p = 0; p < b.length;) {
      var start = p, t = varint(b, p); p = t.end;
      var number = Math.floor(t.value / 8), wire = t.value % 8;
      if (!number) throw new Error('invalid field');
      var begin = -1, end = -1;
      if (wire === 0) p = varint(b, p).end;
      else if (wire === 1) p += 8;
      else if (wire === 2) { var len = varint(b, p); begin = len.end; end = begin + len.value; p = end; }
      else if (wire === 5) p += 4;
      else throw new Error('unsupported wire type');
      if (p > b.length) throw new Error('truncated field');
      a.push({ number: number, wire: wire, start: start, tagEnd: t.end, end: p, begin: begin, payloadEnd: end });
    }
    return a;
  }
  function join(a) {
    var n = 0, p = 0, i;
    for (i = 0; i < a.length; i++) n += a[i].length;
    var out = new Uint8Array(n);
    for (i = 0; i < a.length; i++) { out.set(a[i], p); p += a[i].length; }
    return out;
  }
  function contains(b, text) {
    outer: for (var i = 0; i <= b.length - text.length; i++) {
      for (var j = 0; j < text.length; j++) if (b[i + j] !== text.charCodeAt(j)) continue outer;
      return true;
    }
    return false;
  }
  function clearAds(b) {
    var f = fields(b), marked = false, count = 0, i;
    for (i = 0; i < f.length; i++) {
      if (f[i].number === 1 && f[i].wire === 2 &&
          contains(b.subarray(f[i].begin, f[i].payloadEnd), 'flash_screen_v6-')) marked = true;
      if (f[i].number === 2 && f[i].wire === 2) count++;
    }
    if (!marked || !count) return b;
    var parts = [];
    for (i = 0; i < f.length; i++)
      if (!(f[i].number === 2 && f[i].wire === 2)) parts.push(b.subarray(f[i].start, f[i].end));
    return join(parts);
  }
  function rewriteAt(b, path) {
    if (!path.length) return clearAds(b);
    var f = fields(b), parts = [], changed = false;
    for (var i = 0; i < f.length; i++) {
      var item = f[i];
      if (item.number !== path[0] || item.wire !== 2) {
        parts.push(b.subarray(item.start, item.end));
        continue;
      }
      var before = b.subarray(item.begin, item.payloadEnd);
      var after = rewriteAt(before, path.slice(1));
      if (after === before) parts.push(b.subarray(item.start, item.end));
      else {
        changed = true;
        parts.push(b.subarray(item.start, item.tagEnd), encode(after.length), after);
      }
    }
    return changed ? join(parts) : b;
  }
  function rewrite(b) { return rewriteAt(b, [3, 2]); }
  if (typeof module !== 'undefined' && module.exports) module.exports = { rewrite: rewrite, fields: fields };
  if (typeof $done === 'function') {
    try {
      var input = $response.body;
      if (!(input instanceof Uint8Array)) { $done({}); return; }
      var output = rewrite(input);
      $done(output === input ? {} : { body: output });
    } catch (e) { console.log('心悦开屏：跳过未知响应：' + e.message); $done({}); }
  }
})();
