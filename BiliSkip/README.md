# BiliSkip · 哔哩哔哩自动空降

接入 [bsbsb.top](https://www.bsbsb.top)（hanydd/BilibiliSponsorBlock）的社区标注，在 B 站 App 播放视频时**自动跳过推广片段**。

Surge 模块能做的只是「在进度条上标出广告段」，因为 iOS 原生播放器没有 JS 环境、钩不到 `currentTime`。这个 tweak 直接注入到 App 进程里，hook `AVPlayer` 的播放时钟，才能真正做到 seek。

## 三个版本

| 文件 | 用在 |
|---|---|
`BiliSkip-Troll.dylib` | **TrollStore / TrollFools**（免越狱，iOS 14–17） |
`BiliSkip_0.1.0_arm.deb` | 越狱 rootful（unc0ver / checkra1n / Taurine） |
`BiliSkip_0.1.0_arm64.deb` | 越狱 rootless（Dopamine / palera1n） |

Troll 版是 `-c generator=internal` 编的，**不引用 `MSHookMessageEx`**，纯 `method_setImplementation`，所以 TrollStore 环境不会因为缺 substrate 崩溃。

## 安装（TrollStore，推荐）

1. 装 [TrollFools](https://github.com/Lessica/TrollFools)（或在 TrollStore 里装）
2. 打开 TrollFools → 选「哔哩哔哩」→ 点「注入 dylib」→ 选 `BiliSkip-Troll.dylib`
3. 重启 B 站

## 安装（越狱）

```bash
# rootless（Dopamine / palera1n）
dpkg -i BiliSkip_0.1.0_arm64.deb
killall -9 SpringBoard

# rootful
dpkg -i BiliSkip_0.1.0_arm.deb
killall -9 SpringBoard
```

装完会在 `/Library/MobileSubstrate/DynamicLibraries/`（或 `/var/jb/...`）下生成：

```
BiliSkip.dylib
BiliSkip.plist      # Filter = { Bundles = ( "tv.danmaku.bilianime" ); }
```

## 工作原理

```
B 站 App 发请求
   └─ hook NSURLSession 的 6 个任务创建方法
        └─ 从 URL 里正则抠 bvid / cid（?bvid=BV...&cid=...）
             └─ 变了就去 https://www.bsbsb.top/api/skipSegments?videoID=<bvid>
                  └─ 结果进内存缓存（同 bvid 不重复请求）
                       └─ hook AVPlayer 的 addPeriodicTimeObserverForInterval:queue:usingBlock:
                            └─ 每帧回调里比对当前秒数
                                 └─ 落在标注段内 → seekToTime:段尾 + 弹 toast
```

几个防呆：

- **防递归**：请求 URL 里含 `bsbsb.top` 直接跳过，不会自己钩自己
- **防抖**：seek 后 2 秒内不再触发，避免段边界反复跳
- **段尾余量**：距段尾不足 1 秒就不跳了，防止抖
- **短段过滤**：< 1.5 秒的标忽略（多是误标）
- **类别白名单**：只跳 `sponsor` / `selfpromo` / `interaction`，开场结尾动画不碰
- **cid 对齐**：多 P 视频只取当前分 P 的标注
- **失败放行**：API 超时、返回非数组、JSON 坏了，全部静默退出，不影响播放

## 能调的地方

在 `Tweak.xm` 顶部：

```objc
static NSArray<NSString *> *kBiliSkipCategories(void) {
    return @[@"sponsor", @"selfpromo", @"interaction"];   // 想连开场结尾一起跳，加 @"intro", @"outro"
}

static NSArray<NSString *> *kBiliSkipActions(void) {
    return @[@"skip"];                                    // 想让"好看点"标记也参与，加 @"poi"
}

static const double kTailGuard = 1.0;      // 段尾余量（秒）
static const double kMinLength = 1.5;      // 最短段长
static const double kSeekCooldown = 2.0;   // seek 冷却（秒）
```

运行时开关：

```objc
[[NSUserDefaults standardUserDefaults] setBool:NO forKey:@"BiliSkip.enabled"];
```

关掉后 `noteURL:` 和 `tickTime:` 都直接 return，等于停用。

## 看日志

```bash
# TrollStore 环境
idevicesyslog | grep BiliSkip

# 越狱
tail -f /var/log/syslog | grep BiliSkip
```

正常应该是：

```
[BiliSkip] 载入 bundle=tv.danmaku.bilianime 是否B站=是
[BiliSkip] 已启用，等待播放器
[BiliSkip] 发现视频 bvid=BV13n4g6QEqx cid=43289676662
[BiliSkip] 请求 https://www.bsbsb.top/api/skipSegments?videoID=BV13n4g6QEqx
[BiliSkip] BV13n4g6QEqx 拿到 6 段
[BiliSkip] 当前视频生效 6 段
[BiliSkip] 跳过 [推广] 38.1 -> 41.3
```

## 编译

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File build.ps1
```

依赖：`toolchain/zig.exe`、`toolchain/sdks/iPhoneOS14.5.sdk`、`toolchain/logos/bin/logos.pl`、Strawberry Perl。

产物在 `build/`。

## 已知限制

- **只对 AVPlayer 生效**。B 站绝大部分视频走 AVPlayer，但直播、部分 HLS 老播放器可能不触发周期回调，那些场景不跳。
- **首次打开视频有 200–500ms 延迟**才拉到标注，如果广告就在开头 0–2 秒内，可能来不及跳。
- **数据靠社区标注**，没人标就没有。可以在 bsbsb.top 上自己提交。
- B 站不同版本改播放器实现时可能需要重新找 hook 点。

## 免责声明

数据来自 bsbsb.top 社区标注，版权归原作者。本工具仅用于个人学习与技术研究，请于测试后 24 小时内删除，禁止商业用途。使用风险自负。
