# xinyue-surge-adblock

心悦俱乐部（`com.tencent.tgclub`）6.5.4 的 Surge 模块合集。

## 怎么选

| 模块 | 用途 |
|---|---|
| **`xinyue-adblock-plus.sgmodule`** | **推荐**。增强版，定点 + 通用兜底，覆盖 11 个接口 |
| `xinyue-adblock.sgmodule` | 原版，只覆盖开屏 + 首页 + 游戏中心 + 我的 + 玩家俱乐部 5 个接口 |
| `xinyue-no-index.sgmodule` | 只处理首页，不动开屏 |
| `xinyue-splash-empty.sgmodule` | 把开屏接口响应置空，最激进 |
| `xinyue-splash-fast.sgmodule` | 加速开屏跳过 |

## 增强版做了什么

一套 `http-response` 脚本改写 `bgw.xinyue.qq.com` 的 protobuf 响应，把广告卡片摘掉。

**定点处理**（字段路径已实测，最安全）：

- `PageService/GetIndexPopFlash` → 开屏弹窗 `field3 → field2 → field2` 里带 `-algorithm_ad` 的卡片
- `PageService/IndexPage` → 首页 `field3 → field2 → 段[5]/[6]` 里的广告卡
- `PageService/GetGameCenterCardList` → `field3`
- `PageService/GetMyTab` → `field3 → field8` 的 banner
- `ShowService/GetPlayerclubDiscoverPage` → `field3 → field2 → field1`，含 `playerclub_topic_page_ad` 整块删、`field15` 里的 `playerclub_mall_banner_ad`

**通用兜底**（字段路径未逐个验证的接口）：

`IndexPageFeeds` `IndexPageDaily` `GetGameZoneBanner` `GetGameZonePage` `GetGameZoneFeeds` `MemberPage` `UpgradePop` `GetGiftCenterAD` `GScorePageNew` `GScoreSignWithAd` `GetBenefitRecordPage` `GetPrivilegeEntrance`

递归遍历 protobuf，只丢弃「直接子字段就是 `xxx_ad` 标记」的那张卡片，容器和正常卡片都不碰。

**四道防误伤**：超 8KB 的字段不动 / 解析不成 protobuf 原样返回 / 顶层永不整体丢弃 / `DEBUG` 开关可打日志核对。

## 测过

```
node test.js        # 11 个用例，全部通过
```

覆盖：定点删除、通用兜底、`download`/`header` 不误删、大字段保护、乱序数据不崩。

## 为什么开屏只能靠脚本拦

开屏不是原生广告 SDK 弹的。`GetIndexPopFlash` 只出现在 `App.framework`（Flutter Dart AOT）里，
配套的是 `BatchIndexPopFlashData` / `BatchIndexPopFlashResponse` 这些 Dart 侧 protobuf 类 —— 
服务端下发运营投放素材，Flutter 自己渲染，走 `dart:io` + Dart Widget 树，
完全不经过 `TGSplash` / `AMPSSplashAd` / `AdProfSplashManager` 那条原生联盟广告通道。

所以只能在网络层做，原生 hook 碰不到。

## 装法

Surge → 模块 → 安装新模块 → 粘贴 raw 地址，或者直接点：

```
https://raw.githubusercontent.com/ogbk666-prog/xinyue-surge-adblock/main/xinyue-adblock-plus.sgmodule
```

需要开 MITM，并信任 Surge 证书。

## 版权

模块版权归原作者所有（CC BY-NC-SA 4.0）。
