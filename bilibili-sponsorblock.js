/*
 * BilibiliSponsorBlock for Surge / Loon —— 把 bsbsb.top 的社区标注注入 B 站播放器接口
 *
 * 原理：
 *   浏览器插件靠 hook <video>.currentTime 跳段，iOS 原生 App 没有 JS 环境，钩不到。
 *   Surge 只能改网络响应，所以走「注入进度条章节标记」这条路：
 *   拦截 api.bilibili.com/x/player/v2（含 wbi 变体），用 $httpClient 拉 bsbsb.top 的
 *   skipSegments 数据，转成 B 站原生认识的 view_points 写回响应，播放器会在进度条
 *   上把这些片段画成分段标记；同时用 $notification 推送一条「本视频有 N 段推广」。
 *
 *   注入的 view_points 与官方章节并存，不会覆盖原有章节。
 *
 * 作者：Little Code Sauce
 * 数据来源：https://www.bsbsb.top （hanydd/BilibiliSponsorBlock）
 */

const SB_API = "https://www.bsbsb.top/api/skipSegments";

// bsbsb 的 category -> 显示文案
const CATEGORY_LABEL = {
  sponsor: "推广",
  selfpromo: "自我推广",
  interaction: "三连提示",
  intro: "开场",
  outro: "结尾",
  preview: "预览",
  music_offtopic: "非音乐部分",
  filler: "填充内容",
  poi_highlight: "看点",
};

// 只处理这些类别（想全都要就把数组留空）
const ALLOW_CATEGORIES = ["sponsor", "selfpromo", "interaction"];

// 只处理这些行为类型；"skip" 是自动跳，"poi" 是看点标注
const ALLOW_ACTIONS = ["skip"];

const CACHE_TTL = 1800; // 秒，同一 bvid 半小时内不重复打 API
const NOTIFY = true;    // 是否推通知

const TAG = "[BSB] ";

function log() {
  const args = Array.prototype.slice.call(arguments);
  console.log(TAG + args.map(a => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
}

function getQuery(url, key) {
  const m = url.match(new RegExp("[?&]" + key + "=([^&#]+)"));
  return m ? decodeURIComponent(m[1]) : "";
}

function fmtMs(ms) {
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = n => (n < 10 ? "0" + n : "" + n);
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

// ---------- 缓存 ----------
function cacheKey(bvid, cid) {
  return `bsb_cache_${bvid}_${cid || "all"}`;
}

function readCache(key) {
  try {
    const raw = $persistentStore.read(key);
    if (!raw) return null;
    const obj = JSON.parse(raw);
    if (!obj || !obj.t || Date.now() - obj.t > CACHE_TTL * 1000) return null;
    return obj.v;
  } catch (e) {
    return null;
  }
}

function writeCache(key, value) {
  try {
    $persistentStore.write(JSON.stringify({ t: Date.now(), v: value }), key);
  } catch (e) {
    /* ignore */
  }
}

// ---------- 主流程 ----------
(function main() {
  let body = $response.body;
  let obj;

  try {
    obj = JSON.parse(body);
  } catch (e) {
    log("响应不是 JSON，放行");
    return $done({});
  }

  if (!obj || typeof obj !== "object" || !obj.data) {
    return $done({});
  }

  const url = $request.url || "";
  const bvid = getQuery(url, "bvid");
  const cid = getQuery(url, "cid");

  if (!bvid) {
    log("URL 里没有 bvid，放行:", url);
    return $done({});
  }

  const existing = Array.isArray(obj.data.view_points) ? obj.data.view_points.slice() : [];
  const existingKey = new Set(existing.map(p => `${p.from}|${p.to}`));

  function inject(segments) {
    if (!Array.isArray(segments) || segments.length === 0) {
      log(`${bvid} 无标注片段`);
      return $done({});
    }

    const picked = segments.filter(s => {
      if (!s || !Array.isArray(s.segment) || s.segment.length < 2) return false;
      if (ALLOW_CATEGORIES.length && ALLOW_CATEGORIES.indexOf(s.category) === -1) return false;
      if (ALLOW_ACTIONS.length && ALLOW_ACTIONS.indexOf(s.actionType) === -1) return false;
      if (cid && s.cid && String(s.cid) !== String(cid)) return false;
      return true;
    });

    if (picked.length === 0) {
      log(`${bvid} 有 ${segments.length} 段，但被类别/行为过滤掉了`);
      return $done({});
    }

    const added = [];
    picked.forEach(s => {
      const from = Math.round(s.segment[0] * 1000);
      const to = Math.round(s.segment[1] * 1000);
      if (to <= from) return;
      if (existingKey.has(`${from}|${to}`)) return;
      const label = CATEGORY_LABEL[s.category] || s.category || "标注";
      added.push({
        type: 1,
        from: from,
        to: to,
        content: `[${label}] ${fmtMs(from)}-${fmtMs(to)}`,
        img_url: "",
        logo_url: "",
      });
    });

    if (added.length === 0) {
      log(`${bvid} 注入项为空（可能已有相同章节）`);
      return $done({});
    }

    obj.data.view_points = existing.concat(added);

    log(`${bvid} 注入 ${added.length} 段:`, added.map(p => p.content));

    if (NOTIFY) {
      try {
        const lines = added.map(p => `${p.content}`).slice(0, 4).join("\n");
        $notification.post(
          "小电视空降助手",
          `${bvid} 有 ${added.length} 个推广片段`,
          lines + (added.length > 4 ? `\n…共 ${added.length} 段` : "")
        );
      } catch (e) {
        /* 通知失败不影响注入 */
      }
    }

    return $done({ body: JSON.stringify(obj) });
  }

  const ck = cacheKey(bvid, cid);
  const cached = readCache(ck);
  if (cached) {
    log(`${bvid} 命中缓存`);
    return inject(cached);
  }

  const apiUrl = `${SB_API}?videoID=${encodeURIComponent(bvid)}`;
  log("请求", apiUrl);

  $httpClient.get({ url: apiUrl, timeout: 8 }, function (err, resp, data) {
    if (err) {
      log("API 请求失败:", String(err));
      return $done({});
    }
    let segs;
    try {
      segs = JSON.parse(data);
    } catch (e) {
      log("API 返回非 JSON:", String(data).slice(0, 120));
      return $done({});
    }
    if (!Array.isArray(segs)) {
      // 404 时 API 会返回 {error: ...}
      log("API 返回错误对象:", segs);
      return $done({});
    }
    writeCache(ck, segs);
    inject(segs);
  });
})();
