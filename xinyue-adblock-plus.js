/* 心悦俱乐部去广告（增强版）
 * Surge: type=http-response, binary-body-mode
 *
 * 相比原版多做了三件事：
 *   1) 覆盖新增接口：IndexPageFeeds / IndexPageDaily / GetGameZoneBanner /
 *      GetGameZonePage / GetGameZoneFeeds / MemberPage / UpgradePop /
 *      GetGiftCenterAD / GScorePageNew / GetBenefitRecordPage / GetPrivilegeEntrance
 *   2) 未知接口走「通用 ad 卡片清除」：递归遍历 protobuf，凡是字段内容里带
 *      xxx_ad 标记（如 -algorithm_ad、playerclub_mall_banner_ad）就整块删掉
 *   3) 加 DEBUG 开关，打开后把删掉的卡片标记打到 Surge 日志，方便核对
 *
 * 需要精确字段路径的接口仍走原版的定点逻辑，通用逻辑只做兜底。
 */
(function () {
  "use strict";

  var DEBUG = false;          // true = 把删掉的标记打到 Surge 日志
  var MAX_CARD = 8192;        // 超过这个大小的字段不当「卡片」处理，避免误删
  var MAX_DEPTH = 6;          // 递归最大深度

  /* ---------------- protobuf 基础 ---------------- */
  function readVarint(data, start) {
    var value = 0, factor = 1;
    for (var i = start, n = 0; n < 10 && i < data.length; i++, n++) {
      var byte = data[i];
      value += (byte & 127) * factor;
      if (value > Number.MAX_SAFE_INTEGER) throw new Error("varint overflow");
      if (!(byte & 128)) return { value: value, end: i + 1 };
      factor *= 128;
    }
    throw new Error("invalid varint");
  }

  function writeVarint(value) {
    var out = [];
    do {
      var byte = value % 128;
      value = Math.floor(value / 128);
      out.push(value ? byte | 128 : byte);
    } while (value);
    return Uint8Array.from(out);
  }

  function skipVarint(data, start) {
    for (var i = start, n = 0; n < 10 && i < data.length; i++, n++) {
      if (!(data[i] & 128)) return i + 1;
    }
    throw new Error("invalid varint");
  }

  function fields(data) {
    var out = [];
    for (var pos = 0; pos < data.length;) {
      var start = pos;
      var tag = readVarint(data, pos);
      pos = tag.end;
      var number = Math.floor(tag.value / 8);
      var wire = tag.value % 8;
      if (!number) throw new Error("invalid field");
      var ps = -1, pe = -1;
      if (wire === 0) {
        pos = skipVarint(data, pos);
      } else if (wire === 1) {
        pos += 8;
      } else if (wire === 2) {
        var len = readVarint(data, pos);
        pos = len.end;
        ps = pos;
        pos += len.value;
        pe = pos;
      } else if (wire === 5) {
        pos += 4;
      } else {
        throw new Error("unsupported wire " + wire);
      }
      if (pos > data.length) throw new Error("truncated");
      out.push({ number: number, wire: wire, start: start, end: pos,
                 payloadStart: ps, payloadEnd: pe });
    }
    return out;
  }

  function join(parts) {
    var size = 0;
    for (var i = 0; i < parts.length; i++) size += parts[i].length;
    var out = new Uint8Array(size);
    for (var j = 0, pos = 0; j < parts.length; j++) {
      out.set(parts[j], pos);
      pos += parts[j].length;
    }
    return out;
  }

  function payload(data, f) {
    return data.subarray(f.payloadStart, f.payloadEnd);
  }

  function edit(data, change) {
    var list = fields(data);
    var parts = [];
    var changed = false;
    for (var i = 0; i < list.length; i++) {
      var f = list[i];
      var next = change(f, data);
      if (next === null) {
        changed = true;
      } else if (next === undefined) {
        parts.push(data.subarray(f.start, f.end));
      } else {
        changed = true;
        parts.push(writeVarint(f.number * 8 + 2), writeVarint(next.length), next);
      }
    }
    return changed ? join(parts) : data;
  }

  function at(data, path, change) {
    if (!path.length) return change(data);
    var wanted = path[0];
    return edit(data, function (f, source) {
      if (f.number !== wanted || f.wire !== 2) return undefined;
      var original = payload(source, f);
      var updated = at(original, path.slice(1), change);
      return updated === original ? undefined : updated;
    });
  }

  function hasAscii(data, text) {
    outer: for (var i = 0; i <= data.length - text.length; i++) {
      for (var j = 0; j < text.length; j++) {
        if (data[i + j] !== text.charCodeAt(j)) continue outer;
      }
      return true;
    }
    return false;
  }

  function countField(data, number) {
    var list = fields(data), c = 0;
    for (var i = 0; i < list.length; i++) if (list[i].number === number) c++;
    return c;
  }

  function firstPayload(data, number) {
    var list = fields(data);
    for (var i = 0; i < list.length; i++) {
      if (list[i].number === number && list[i].wire === 2) return payload(data, list[i]);
    }
    return null;
  }

  function removeAdCards(data, number, marker) {
    return edit(data, function (f, source) {
      return f.number === number && f.wire === 2 && hasAscii(payload(source, f), marker)
        ? null : undefined;
    });
  }

  /* ---------------- 通用 ad 卡片识别 ---------------- */

  function asciiOf(buf) {
    var s = "";
    for (var i = 0; i < buf.length; i++) {
      var c = buf[i];
      s += (c >= 32 && c < 127) ? String.fromCharCode(c) : "\u0000";
    }
    return s;
  }

  // 整个字段值就是一个广告位标记：-algorithm_ad / playerclub_mall_banner_ad / banner_ad
  function isMarkerSelf(buf) {
    if (buf.length > 48) return false;
    var s = asciiOf(buf).replace(/\u0000+$/, "");
    return /^-?[a-z0-9][a-z0-9_\-]{0,40}_ad$/i.test(s);
  }

  // 叶子串里是否嵌着广告位标记（只在解析不成 protobuf 的叶子上用）
  function containsMarker(buf) {
    if (buf.length > MAX_CARD) return false;
    return /(?:^|[\u0000\-_.])(-?[a-z0-9][a-z0-9_\-]{1,40}_ad)(?=[\u0000\-_."]|$)/i.test(asciiOf(buf));
  }

  /* 自底向上剥离，但只在「卡片粒度」下手：
   *   - 某个 length-delimited 字段的值整体是 ad 标记 → 它所在的那张卡片整体丢弃
   *   - 往下一层递归，只清理、不因为「子树里有广告」就把整段容器连锅端
   * 这样「容器 → 卡片A(广告) → 卡片B(正常)」只会删卡片A，卡片B 和容器都保留。
   */
  function hasDirectMarker(buf) {
    // 1) 本身就是一个标记串（叶子）
    if (isMarkerSelf(buf)) return true;
    // 2) 解析不出 protobuf 的叶子串里嵌着标记
    var list;
    try {
      list = fields(buf);
    } catch (e) {
      return containsMarker(buf);
    }
    // 3) 直接子字段里有标记
    for (var i = 0; i < list.length; i++) {
      if (list[i].wire !== 2) continue;
      if (isMarkerSelf(payload(buf, list[i]))) return true;
    }
    return false;
  }

  function cleanAd(buf, depth) {
    if (depth > MAX_DEPTH) return buf;

    var list;
    try {
      list = fields(buf);
    } catch (e) {
      return buf;   // 不是 protobuf，原样返回
    }

    var parts = [], changed = false;
    for (var i = 0; i < list.length; i++) {
      var f = list[i];
      if (f.wire !== 2) {
        parts.push(buf.subarray(f.start, f.end));
        continue;
      }
      var p = payload(buf, f);

      // 这张卡片自己带广告位标记 → 整张丢
      if (hasDirectMarker(p)) {
        if (DEBUG) console.log("xinyue: 丢弃广告卡片 #" + f.number +
                               " (" + p.length + "B) " + asciiOf(p).substring(0, 40).replace(/\u0000/g, "."));
        changed = true;
        continue;
      }

      var cleaned = cleanAd(p, depth + 1);
      if (cleaned !== p) {
        changed = true;
        parts.push(writeVarint(f.number * 8 + 2), writeVarint(cleaned.length), cleaned);
      } else {
        parts.push(buf.subarray(f.start, f.end));
      }
    }
    return changed ? join(parts) : buf;
  }

  function stripAd(data) {
    try {
      return cleanAd(data, 0);
    } catch (e) {
      return data;
    }
  }

  /* ---------------- 定点处理（字段路径已知，优先走这里） ---------------- */

  function rewrite(url, body) {
  try {
    var endpoint = url.split("?")[0].split("/").pop();

    // —— 开屏弹窗 ——
    if (endpoint === "GetIndexPopFlash") {
      return at(body, [3, 2], function (data) {
        return removeAdCards(data, 2, "-algorithm_ad");
      });
    }

    // —— 首页 ——
    if (endpoint === "IndexPage") {
      return at(body, [3], function (data) {
        return edit(data, function (f, source) {
          if (f.number !== 2 || f.wire !== 2) return undefined;
          var section = payload(source, f);
          var updated = section;
          if (firstPayload(section, 5)) {
            updated = at(updated, [5], function (cards) {
              return removeAdCards(cards, 2, "-algorithm_ad");
            });
          }
          if (firstPayload(updated, 6)) {
            updated = at(updated, [6], function (cards) {
              return removeAdCards(cards, 4, "-algorithm_ad");
            });
          }
          if (updated === section) return undefined;
          var rest = firstPayload(updated, 5);
          return rest && !countField(rest, 2) ? null : updated;
        });
      });
    }

    // —— 游戏中心 ——
    if (endpoint === "GetGameCenterCardList") {
      return removeAdCards(body, 3, "-algorithm_ad");
    }

    // —— 玩家俱乐部 ——
    if (endpoint === "GetPlayerclubDiscoverPage") {
      return at(body, [3, 2, 1], function (data) {
        return edit(data, function (f, source) {
          if (f.number !== 2 || f.wire !== 2) return undefined;
          var section = payload(source, f);
          if (hasAscii(section, "playerclub_topic_page_ad")) return null;
          var updated = at(section, [15], function (cards) {
            return removeAdCards(cards, 2, "playerclub_mall_banner_ad");
          });
          return updated === section ? undefined : updated;
        });
      });
    }

    // —— 我的 ——
    if (endpoint === "GetMyTab") {
      return at(body, [3], function (data) {
        return removeAdCards(data, 8, "banner");
      });
    }

    // —— 以下为新增：字段路径未逐个验证，走通用递归兜底 ——
    // IndexPageFeeds / IndexPageDaily / GetGameZoneBanner / GetGameZonePage /
    // GetGameZoneFeeds / MemberPage / UpgradePop / GetGiftCenterAD /
    // GScorePageNew / GetBenefitRecordPage / GetPrivilegeEntrance
    return stripAd(body);
  } catch (e) {
    return body;
  }
  }

  /* ---------------- 入口 ---------------- */
  if (typeof module !== "undefined" && module.exports) {
    module.exports = { rewrite: rewrite, fields: fields, stripAd: stripAd, cleanAd: cleanAd };
    return;
  }

  if (typeof $done === "function") {
    try {
      var original = $response.body;
      if (!(original instanceof Uint8Array)) {
        $done({});
        return;
      }
      var result = rewrite($request.url, original);
      if (result === original) {
        $done({});
      } else {
        if (DEBUG) console.log("xinyue: " + $request.url.split("?")[0].split("/").pop() +
                               " " + original.length + " -> " + result.length);
        $done({ body: result });
      }
    } catch (error) {
      console.log("xinyue: 跳过无法解析的响应 " + error.message);
      $done({});
    }
  }
})();
