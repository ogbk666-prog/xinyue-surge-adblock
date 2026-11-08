# Wren 弹窗屏蔽（LSPosed 模块）

屏蔽 Wren（`top.haif.xposed`）在微信里弹出的「支持一下?❤️ / 去赞助 / 先不考虑」赞助弹窗。

不改原包，签名和加固校验都不受影响。

## 装法

1. 安装 `WrenNoDialog.apk`
2. 打开 LSPosed → 模块 → 启用「Wren 弹窗屏蔽」
3. 作用域勾选 **微信**（`com.tencent.mm`）—— **不是** `top.haif.xposed`
4. 强停微信再打开

## 为什么作用域是微信

Wren 没有独立界面。翻它的 APK 可以看到：

```
META-INF/xposed/scope.list  →  com.tencent.mm
minApiVersion=101
targetApiVersion=102
```

`am start -n top.haif.xposed/...` 会直接报 `Invalid packageName` —— 它把界面全注入到微信进程里，赞助弹窗也在那儿。

## 拦截原理

实测抓到的弹窗身份：

```
SHOW cls=ᛱᛲᛳᛴᛵᛶᛷᤝᲀᛸᲁᤞᲈᲇ  alert=false  activity=false
```

类名是 Wren 混淆后的名字（无包名前缀，14 个字符），所以在 `Dialog.show()` 上做**精确类名匹配**：

```java
private static final String SPONSOR_DIALOG_CLASS =
    "\u16F1\u16F2\u16F3\u16F4\u16F5\u16F6\u16F7\u191D\u1C80\u16F8\u1C81\u191E\u1C88\u1C87";

if (SPONSOR_DIALOG_CLASS.equals(cls)) {
    param.setValue(null);   // 吞掉
}
```

微信自己的弹窗、Wren 的其他界面一律放过。

## 排查记录（踩过的坑）

| # | 错误 | 现象 | 修正 |
|---|---|---|---|
1 | 作用域写成 `top.haif.xposed` | LSPosed 找不到模块 / 钩不到东西 | 改成 `com.tencent.mm` |
2 | `<application />` 自闭合，`<meta-data>` 掉到 manifest 根下 | LSPosed 完全认不出模块 | meta-data 移进 application 内 |
3 | 没写 `versionCode` | `versionCode=0`，包管理器可能跳过 | manifest 加 `android:versionCode="1"` |
4 | Xposed API stub 的 `findAndHookMethod` 返回 `void` | 运行时 `NoSuchMethodError`，hook 没挂上 | 改为返回 `XC_MethodHook.Unhook` |
5 | `d8` 只传了 `HookEntry.class`，漏了 `HookEntry$1.class` | 运行时 `NoClassDefFoundError` | 先打 jar 再交 d8 |
6 | 靠调用栈判断来源（找 `top.haif.`） | 永远 false（类名全混淆） | 弃用 |
7 | 靠 `getContext() instanceof Activity` 过滤 | `activity=false`，唯一候选被排除 | 弃用 |
8 | 前缀 `ᛱ` 全拦 | 可能误伤 Wren 其他弹窗 | 改精确类名匹配 |

## 日志

```bash
adb logcat -s LSPosedFramework:* | grep WrenNoDialog
```

正常应该看到：

```
[WrenNoDialog] 进入 com.tencent.mm
[WrenNoDialog] 已挂上 Dialog.show（精确匹配赞助弹窗）
[WrenNoDialog] 拦住赞助弹窗 -> ᛱᛲᛳᛴᛵᛶᛷᤝᲀᛸᲁᤞᲈᲇ
```

## 如果 Wren 以后改版换了类名

日志里会看到「放过 Wren 其他弹窗 -> ᛱ...」，把新类名按上面格式转成 `\uXXXX` 转义，替换 `SPONSOR_DIALOG_CLASS` 重新编译即可。

## 编译

```powershell
# 需要 JDK 17 + Android build-tools + platform android.jar
cd module
.\build.bat
```

产物 `WrenNoDialog.apk`。

## 源码结构

```
module/
  src/com/lcs/wrennodialog/HookEntry.java   主逻辑
  stub/de/robv/android/xposed/              Xposed API 编译桩（不进 dex 更好，但目前会进）
  res/values/arrays.xml                     作用域数组
  assets/xposed_init                        入口类名
  AndroidManifest.xml                       含 xposed meta-data
  build.bat                                 javac -> d8 -> aapt2 -> zipalign -> apksigner
```