/* 心悦俱乐部去广告：Surge http-response binary-body-mode */
(function () {
  "use strict";

  function readVarint(data, start) {
    var value = 0;
    var factor = 1;
    for (var i = start, n = 0; n < 10 && i < data.length; i++, n++) {
      var byte = data[i];
      value += (byte & 127) * factor;
      if (value > Number.MAX_SAFE_INTEGER) throw new Error("protobuf varint overflow");
      if (!(byte & 128)) return { value: value, end: i + 1 };
      factor *= 128;
    }
    throw new Error("invalid protobuf varint");
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
    throw new Error("invalid protobuf varint");
  }

  function fields(data) {
    var out = [];
    for (var pos = 0; pos < data.length;) {
      var start = pos;
      var tag = readVarint(data, pos);
      pos = tag.end;
      var number = Math.floor(tag.value / 8);
      var wire = tag.value % 8;
      if (!number) throw new Error("invalid protobuf field");
      var payloadStart = -1;
      var payloadEnd = -1;
      if (wire === 0) {
        pos = skipVarint(data, pos);
      } else if (wire === 1) {
        pos += 8;
      } else if (wire === 2) {
        var length = readVarint(data, pos);
        pos = length.end;
        payloadStart = pos;
        pos += length.value;
        payloadEnd = pos;
      } else if (wire === 5) {
        pos += 4;
      } else {
        throw new Error("unsupported protobuf wire type");
      }
      if (pos > data.length) throw new Error("truncated protobuf field");
      out.push({ number: number, wire: wire, start: start, end: pos,
        payloadStart: payloadStart, payloadEnd: payloadEnd });
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

  function payload(data, field) {
    return data.subarray(field.payloadStart, field.payloadEnd);
  }

  function edit(data, change) {
    var list = fields(data);
    var parts = [];
    var changed = false;
    for (var i = 0; i < list.length; i++) {
      var f = list[i];
      var oldPart = data.subarray(f.start, f.end);
      var next = change(f, data);
      if (next === null) {
        changed = true;
      } else if (next === undefined) {
        parts.push(oldPart);
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
    var list = fields(data);
    var count = 0;
    for (var i = 0; i < list.length; i++) if (list[i].number === number) count++;
    return count;
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

  function rewrite(url, body) {
    var endpoint = url.split("?")[0].split("/").pop();
    if (endpoint === "GetIndexPopFlash") {
      return at(body, [3, 2], function (data) {
        return removeAdCards(data, 2, "-algorithm_ad");
      });
    }
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
          var remainingBanners = firstPayload(updated, 5);
          return remainingBanners && !countField(remainingBanners, 2) ? null : updated;
        });
      });
    }
    if (endpoint === "GetGameCenterCardList") {
      return removeAdCards(body, 3, "-algorithm_ad");
    }
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
    if (endpoint === "GetMyTab") {
      return at(body, [3], function (data) {
        return removeAdCards(data, 8, "banner");
      });
    }
    return body;
  }

  if (typeof module !== "undefined" && module.exports) {
    module.exports = { rewrite: rewrite, fields: fields };
  }
  if (typeof $done === "function") {
    try {
      var original = $response.body;
      if (!(original instanceof Uint8Array)) {
        $done({});
        return;
      }
      var result = rewrite($request.url, original);
      $done(result === original ? {} : { body: result });
    } catch (error) {
      console.log("心悦去广告：跳过无法解析的响应：" + error.message);
      $done({});
    }
  }
})();
