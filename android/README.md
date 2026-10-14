# 极核诊断 · 安卓版（zeeho-diag/android）

与 iOS 版同架构：**WebView 加载 `app/src/main/assets/diag.html`（与 iOS 同一套 UI），
原生层提供 BLE GATT 桥 + WiFi TCP 桥**，页面通过 `window.r485(cmd, data, cb)` 调用原生能力。

## 构建

```
cd android
./gradlew assembleRelease
# 产物：app/build/outputs/apk/release/app-release.apk（debug 密钥签名，可直接安装）
```

或用 Android Studio 打开 `android/` 目录直接 Run。

## 权限

首次启动会申请：
- Android 11 及以下：蓝牙 + 定位（BLE 扫描必需）
- Android 12+：附近的设备（BLUETOOTH_SCAN / BLUETOOTH_CONNECT）
- WiFi DoIP 诊断使用网络权限，无需额外授权

## 硬件配合（与 iOS 版相同）

| 功能 | 硬件 |
| --- | --- |
| 数据流 / 整车诊断 | RS485 蓝牙透传模块（如 I6328A-485），A/B 接诊断口 7/15 脚 |
| ABS 排气 / 胎压匹配 / 清码 | ESP32 + SN65HVD230 桥（固件 `esp32/zeeho_can_bridge.ino`），BLE 名 `ZEEHO-CAN` |
| WiFi 诊断（DoIP） | 连接车辆热点后走 `wifiConnect` |

蓝牙设备 GATT 约定：Service `FFE0` / 写 `FFE1` / 通知 `FFE2`（与商用 6328 模块一致）。

## 与 iOS 版差异

- 官方诊断仪 VCI 探测（iOS 私有蓝牙框架）安卓不支持，页面该功能区会提示。
- 其余功能（扫描/连接/收发/数据流/ABS/胎压/WiFi 自检与端口扫描）与 iOS 一致。

## 文件结构

```
android/
  app/src/main/java/com/zeeho/diag/
    MainActivity.java   WebView 壳 + 权限申请
    Bridge.java         JS 命令分发（window.Android.postMessage）
    BleBridge.java      BLE GATT 桥（扫描/连接/FFE1 写/FFE2 通知，MTU 分片）
    WifiBridge.java     WiFi TCP 桥（连接/收发/网络自检/端口扫描）
  app/src/main/assets/diag.html   诊断页（由 tools/make_diag_html.js 生成后注入安卓桥脚本）
```

> 注意：`diag.html` 资产由 `tools/make_diag_html.js` 生成到 `ios/App/Resources/diag.html` 后，
> 再注入安卓桥接脚本（`<head>` 内 `window.r485`/`__r485Cb`/`__r485Event` 定义）复制而来。
> 更新 UI/数据后需重新生成并复制。
