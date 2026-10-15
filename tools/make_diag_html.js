// make_diag_html.js — 生成 iOS diag.html（RS485/CAN 无线诊断页）
// datastreams/页面数据：车辆诊断数据整理（UDS 0x22 读 DID + 字节位置 + 解析表达式 + 显示格式）。
// 用法：node make_diag_html.js  （输出到 ../ios/App/Resources/diag.html）
const fs = require('fs');
const path = require('path');
const raw = JSON.parse(fs.readFileSync(path.join(__dirname, 'rs485_items.json'), 'utf8'));

// 紧凑数据
const compact = raw.items
  .filter(i => i.name && i.off != null)
  .map(i => {
    const o = { s: i.sys, n: i.name, o: i.off, f: i.fmt };
    if (i.unit) o.u = i.unit;
    if (i.script) {
      if (i.script.kind === 'value') { o.k = 'v'; o.e = i.script.expr; o.a = i.script.args; }
      else { o.k = 's'; o.j = i.script.js; o.a = i.script.args; }
    }
    return o;
  });

const VIN_FRAMES = [
  "434689402B22100C050F12501330001E0000006000001000CC6440750E00000000000080000000000000009000000000000000A000CC0000000000B0CCCCCCCC000000C0884544",
  "4346714000000000000004000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000B54544",
  "4346804000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000C04544"
];

// CAN 直连预设（ABS 排气命令，按维修资料整理）
const CAN_PRESETS = {
  abs: [
    ['进入扩展会话', '1003'],
    ['泵 开', '2FE0DA0301'],
    ['泵 关', '2FE0DA0300'],
    ['阀 开(前轮组)', '2FE0DB03000064640000FC'],
    ['阀 全关', '2FE0DB03000000000000FC'],
    ['读轮速(31 03 B071)', '3103B071'],
    ['清故障码', '14FFFFFF'],
    ['退会话', '1001'],
    ['ECU 复位', '1101']
  ]
};

// RS485 特殊功能（模块 016 [SPEFUNC] 完整帧，校验已验证）
const SPE_RS485 = {
  initMsgs: [
    "4346894015000000000020000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000FE4544",
    "4346714000000000000020000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000D14544",
    "4346714000000000000040000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000F14544"
  ],
  tpmsInitMsgs: [
    "4346894015000000000020000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000FE4544",
    "4346714000000000000024000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000D54544",
    "4346714000000000000040000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000F14544"
  ],
  tpmsFrame: "434617023808594544",
  // NFC 学卡/删卡为 SPEFUNC 短操作码（学卡 3900→0D0100→放卡→0D0103；删卡 3A00→0D010103）。
  // 关键修复：这些操作码此前是"裸发"的（不带 4346/校验/4544），车端根本收不到合法帧，
  // 所以页面提示只能写"若无响应属正常"。现在统一走 buildFrame() 成帧后发送。
  nfcLearn: ["3900", "0D0100", "0D0103"],
  nfcDelete: ["3A00", "0D010103"],
  nfcSys: "89",
  nfcTip: "操作码（学卡 3900→0D0100→放卡→0D0103；删卡 3A00→0D010103）已按 RS485 定长帧成帧发送：4346|系统码|40|64字节负载|校验|4544。若仍无响应，可点「原样发送」做对照，并把收发日志发给开发者。"
};

const DATA_JS = 'var SYS=' + JSON.stringify({ "49": "计量器/BMS", "51": "BMS 电池", "59": "MCU 电机", "81": "仪表/整车", "89": "TBOX/配置", "8B": "后雷达" }) + ';\n'
  + 'var ITEMS=' + JSON.stringify(compact) + ';\n'
  + 'var VIN_FRAMES=' + JSON.stringify(VIN_FRAMES) + ';\n'
  + 'var CAN_PRESETS=' + JSON.stringify(CAN_PRESETS) + ';\n'
  + 'var SPE_RS485=' + JSON.stringify(SPE_RS485) + ';';

const LOGIC_JS = `
// ============ 原生桥（双通道：Android JS 接口 / iOS WKWebView，不依赖注入脚本） ============
window.__r485Cb = window.__r485Cb || function (id, json) {
  try { var cb = (window.__r485Cbs || {})[id]; if (cb) { delete window.__r485Cbs[id]; cb(json); } } catch (e) {}
};
window.__r485Event = window.__r485Event || function (json) {
  try { if (window.onR485Event) window.onR485Event(json); } catch (e) {}
};
var r485 = window.r485 || function (cmd, data, cb) {
  var id = 'r485_' + Date.now() + '_' + Math.floor(Math.random() * 1e6);
  window.__r485Cbs = window.__r485Cbs || {};
  if (cb) window.__r485Cbs[id] = cb;
  var sent = false;
  if (typeof window.Android !== 'undefined' && window.Android && window.Android.postMessage) {
    try { window.Android.postMessage(JSON.stringify({ command: cmd, data: data || '', id: id })); sent = true; } catch (e) {}
  }
  if (!sent && window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.rs485) {
    try { window.webkit.messageHandlers.rs485.postMessage({ command: cmd, data: data || '', id: id }); sent = true; } catch (e) {}
  }
  if (!sent && cb) cb(null);
};

// ============ 状态 ============
var devices = {};
var connected = false;
var buffers = [];   // 最近响应 {hex, ts}
var MAXBUF = 30;

function $(id) { return document.getElementById(id); }
function logLine(dir, hex, extra) {
  var el = $('log');
  var t = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  var ascii = '';
  if ($('chkAscii').checked) {
    ascii = '  |' + hexToAscii(hex) + '|';
  }
  var color = dir === 'TX' ? '#007aff' : (dir === 'RX' ? '#34c759' : '#6e6e73');
  var div = document.createElement('div');
  div.style.color = color;
  div.textContent = '[' + t + '] ' + dir + ' ' + hex + ascii + (extra ? '  ' + extra : '');
  el.appendChild(div);
  el.scrollTop = el.scrollHeight;
  if (el.childNodes.length > 400) el.removeChild(el.firstChild);
  // 同一行也写入原生日志文件：排查时直接把文件导出发走即可，不用手抄屏幕日志
  try {
    if (typeof r485 === 'function') r485('log', dir + ' ' + hex + (extra ? '  ' + extra : ''), null);
  } catch (e) {}
}
function hexToAscii(hex) {
  var s = '';
  for (var i = 0; i + 1 < hex.length; i += 2) {
    var c = parseInt(hex.substr(i, 2), 16);
    s += (c >= 32 && c < 127) ? String.fromCharCode(c) : '.';
  }
  return s;
}
function hex2bytes(hex) {
  var a = [];
  for (var i = 0; i + 1 < hex.length; i += 2) a.push(parseInt(hex.substr(i, 2), 16));
  return a;
}
function bytes2hex(a) {
  var s = '';
  for (var i = 0; i < a.length; i++) s += (a[i] < 16 ? '0' : '') + a[i].toString(16);
  return s.toUpperCase();
}

// ============ BLE 分包重组 ============
// 透传模块的 BLE 通知受 MTU 限制通常被切成 20 字节一段，一个 71 字节的 RS485 帧会跨 4 段到达。
// 原实现每收到一段就单独 autoParse，越界字节被当成 0 → 数据流表现为"有反应但数值全 0/乱码"。
var rs485Rx = '';
var RS485_RX_MAX = 8192;

function pushBuffer(hex) {
  buffers.unshift({ hex: hex, ts: Date.now() });
  if (buffers.length > MAXBUF) buffers.pop();
}
function rs485CkOk(frame) {
  var b = hex2bytes(frame);
  if (b.length < 7) return false;
  if (b[0] !== 0x43 || b[1] !== 0x46) return false;
  if (b[b.length - 2] !== 0x45 || b[b.length - 1] !== 0x44) return false;
  var sum = 0;
  for (var i = 2; i < b.length - 3; i++) sum = (sum + b[i]) & 0xFF;
  return sum === b[b.length - 3];
}
// 原始接收统计：判断"到底有没有收到东西"的两个关键数字
var rxRawBytes = 0, rxRawChunks = 0, rxFrames = 0, modeWarned = false;
function rxStats() {
  var el = $('rxStat');
  if (el) el.textContent = '链路模式：' + (linkMode === 'can' ? 'CAN（ESP32 桥）' : 'RS485（I6328A 模块）')
    + ' · 原始 RX：' + rxRawBytes + ' 字节 / ' + rxRawChunks + ' 次通知'
    + ' · 成功组帧：' + rxFrames + ' 帧'
    + (rs485Rx.length ? ' · 待组帧缓冲 ' + (rs485Rx.length / 2) + 'B' : '');
}
function noteRaw(hex) {
  rxRawBytes += hex.length / 2;
  rxRawChunks++;
  rxStats();
}
function handleRs485Frame(frame) {
  rxFrames++;
  pushBuffer(frame);
  var ok = rs485CkOk(frame);
  logLine('SYS', '▶ 组帧成功 ' + (frame.length / 2) + 'B，校验' + (ok ? '正确' : '不符'));
  if (!ok) logLine('SYS', '⚠ 校验不符：帧边界可能仍不对，请把上面那行 RX 原文发给开发者');
  autoParse(frame);
}
function rs485Feed(hex) {
  var clean = String(hex || '').toUpperCase().replace(/[^0-9A-F]/g, '');
  if (!clean) return;
  // 任何到达的字节都立刻原样打印。这一步不能省：
  // 若只在"凑成完整帧"时才打印，那么帧头不符 / 帧尾缺失 / 分包没凑齐
  // 都会表现为"完全没有 RX"，会被误判成链路不通。
  logLine('RX', clean, '(' + (clean.length / 2) + 'B)');
  noteRaw(clean);
  rs485Rx += clean;
  if (rs485Rx.length > RS485_RX_MAX) rs485Rx = rs485Rx.slice(-RS485_RX_MAX);
  var guard = 0;
  while (guard++ < 64) {
    var s = rs485Rx.indexOf('4346');
    if (s < 0) {
      if (rs485Rx.length > 8) {
        logLine('SYS', '⚠ 收到 ' + (rs485Rx.length / 2) + 'B 但没有 4346 帧头，已丢弃（尾部保留 4B）：' + rs485Rx.slice(-24));
        rs485Rx = rs485Rx.slice(-8);
        rxStats();
      }
      return;
    }
    if (s > 0) {
      logLine('SYS', '⚠ 丢弃帧头之前的 ' + (s / 2) + 'B 杂散字节：' + rs485Rx.slice(0, s));
      rs485Rx = rs485Rx.slice(s);
      rxStats();
    }
    var frame = null;
    var flen = RS485_FRAME_LEN * 2;
    if (rs485Rx.length >= flen && rs485Rx.slice(flen - 4, flen) === '4544') {
      frame = rs485Rx.slice(0, flen);        // 定长 71 字节帧
    } else {
      var e = rs485Rx.indexOf('4544', 4);
      if (e < 0) {
        // 超过两个完整帧的十六进制长度还凑不出帧尾：帧头多半是脏数据（半截帧被遗弃），
        // 必须丢掉 2B 重新同步，否则它会一直占住位置、把后面每一帧都对齐错位。
        if (rs485Rx.length > RS485_FRAME_LEN * 4) {
          logLine('SYS', '⚠ 缓冲已超过一个完整帧仍无帧尾 4544，判定帧头为脏数据，丢弃 2B 重新同步');
          rs485Rx = rs485Rx.slice(2);
          rxStats();
          continue;
        }
        rxStats();
        return;
      }
      frame = rs485Rx.slice(0, e + 4);
    }
    rs485Rx = rs485Rx.slice(frame.length);
    handleRs485Frame(frame);
    rxStats();
  }
}

// CAN 透传帧固定 11 字节（ID_H ID_L DLC D0..D7），同样需要重组
var canRx = '';
function canFeed(hex) {
  var clean = String(hex || '').toUpperCase().replace(/[^0-9A-F]/g, '');
  if (!clean) return;
  logLine('RX', clean, '(' + (clean.length / 2) + 'B)');
  noteRaw(clean);
  canRx += clean;
  while (canRx.length >= 22) {
    var f = canRx.slice(0, 22);
    canRx = canRx.slice(22);
    pushBuffer(f);
    canOnData(f);
  }
  if (canRx.length > 88) { logLine('SYS', '⚠ CAN 接收缓冲异常，已重置'); canRx = ''; }
  rxStats();
}

// ============ BLE 事件 ============
// 原生事件既可能以 JSON 字符串字面量回推，也可能被直接注入成对象字面量
// （window.__r485Event({...})）。统一在这里容错，避免再被注入方式绑死。
//
// ⚠ 历史事故：这里原本写死 JSON.parse(json)。原生桥注入的是对象字面量，
// JSON.parse(对象) 会先把对象转成字符串 "[object Object]" 再抛 SyntaxError，
// 被 catch 吞掉后直接 return —— 结果是【所有原生事件被静默丢弃】：
// RX 日志、组帧解析、连接/服务/订阅状态、UDS 响应全部失效。
// 而 TX 走的是命令回调通道（window.__r485Cb），不经过这里，所以表现为"只有 TX"。
function parseEv(x) {
  if (x == null) return null;
  if (typeof x === 'object') return x;
  try { return JSON.parse(x); } catch (e) { return null; }
}
window.onR485Event = function (json) {
  var ev = parseEv(json);
  if (!ev || !ev.type) return;
  if (ev.type === 'state') {
    var pill = $('blePill');
    var m = { poweredOn: '蓝牙已就绪', poweredOff: '蓝牙未开启', unauthorized: '无蓝牙权限', unsupported: '不支持蓝牙' };
    pill.textContent = m[ev.state] || ('蓝牙 ' + ev.state);
    pill.className = 'pill ' + (ev.state === 'poweredOn' ? 'ok' : 'err');
    var stm = { poweredOn: '蓝牙已开启，点「扫描设备列表」搜索模块', poweredOff: '蓝牙未开启：请先打开系统蓝牙', unauthorized: '未授予蓝牙权限：请在系统设置中允许「附近的设备」', unsupported: '设备不支持蓝牙' };
    var dst0 = $('devStatus'); if (dst0) dst0.textContent = stm[ev.state] || ('蓝牙 ' + ev.state);
  } else if (ev.type === 'scanStarted') {
    var dst = $('devStatus'); if (dst) dst.textContent = '正在扫描附近 BLE 设备…（12 秒后自动停止；SPP 模块先在系统蓝牙配对即自动列出）';
  } else if (ev.type === 'scanStopped') {
    if (scanWatchdog) { clearTimeout(scanWatchdog); scanWatchdog = null; }
    var arr = Object.values(devices);
    var dst = $('devStatus');
    if (dst) dst.textContent = arr.length ? ('扫描完成，共 ' + arr.length + ' 台设备，点击设备连接') : '未发现设备：确认模块已上电后重新扫描';
  } else if (ev.type === 'scanStats') {
    var dst2 = $('devStatus');
    if (dst2) dst2.textContent = '扫描统计：BLE ' + (ev.ble || 0) + ' 台 / 经典蓝牙 ' + (ev.spp || 0) + ' 台 / 已配对 ' + (ev.bonded || 0) + ' 台（列表即全部结果，已配对的会直接显示）';
  } else if (ev.type === 'device') {
    devices[ev.id] = ev;
    renderDevices();
    var dstc = $('devStatus');
    if (dstc && dstc.textContent.indexOf('正在连接') !== 0) {
      dstc.textContent = '已发现 ' + Object.keys(devices).length + ' 台设备（点名称连接，扫描 12 秒后自动停止）';
    }
  } else if (ev.type === 'connected') {
    connected = true;
    var nm = (ev.name || '').toUpperCase();
    linkMode = (nm.indexOf('CAN') >= 0 || nm.indexOf('ESP32') >= 0) ? 'can' : 'rs485';
    applyMode();
    rxStats();
    $('blePill').textContent = '已连接' + (ev.name ? ' ' + ev.name : '') + '（' + (linkMode === 'can' ? 'CAN' : 'RS485') + '）';
    $('blePill').className = 'pill ok';
    logLine('SYS', '已连接 ' + (ev.name || '') + '，链路模式：' + (linkMode === 'can' ? 'CAN' : 'RS485'));
    var dst = $('devStatus'); if (dst) dst.textContent = '已连接 ' + (ev.name || ev.id) + '，可进入功能页使用';
    var dm0 = $('dashMsg'); if (dm0) dm0.textContent = '已连接' + (ev.name ? ' ' + ev.name : '') + '，点上排按钮读取数据';
  } else if (ev.type === 'ready') {
    $('svcInfo').textContent = ev.ok ? ('写: ' + ev.write + '  通知: ' + ev.notify) : '未找到可写/通知特征';
    $('svcInfo').className = 'hint ' + (ev.ok ? '' : 'err');
  } else if (ev.type === 'services') {
    var txt = (ev.list || []).map(function (s) { return s.uuid + '(' + (s.chars || []).length + ')'; }).join('  ');
    $('svcInfo').textContent = '服务: ' + txt;
  } else if (ev.type === 'data') {
    // 累计到完整帧再解析（详见 BLE 分包重组）
    if (linkMode === 'can') canFeed(ev.hex);
    else rs485Feed(ev.hex);
  } else if (ev.type === 'tx') {
    // 发送回显已在 sendFrame 记过，这里略
  } else if (ev.type === 'disconnected') {
    connected = false;
    $('blePill').textContent = '已断开';
    $('blePill').className = 'pill err';
    logLine('SYS', 'disconnected ' + (ev.error || ''));
    var dst = $('devStatus'); if (dst) dst.textContent = '已断开，可重新扫描连接';
  } else if (ev.type === 'error') {
    logLine('SYS', 'ERROR: ' + ev.error);
    var dste = $('devStatus');
    if (dste) { dste.textContent = '错误：' + ev.error; dste.style.color = '#ff3b30'; }
  } else if (ev.type === 'notifyState') {
    logLine('SYS', '通知订阅 ' + ev.uuid.slice(0, 8) + ' = ' + ev.on);
  }
};

var selectedId = null;
function renderDevices() {
  var box = $('devList');
  box.innerHTML = '';
  var arr = Object.values(devices);
  arr.forEach(function (d) {
    var el = document.createElement('div');
    el.className = 'dev' + (d.id === selectedId ? ' sel' : '');
    el.innerHTML = '<span class="nm">' + (d.name || '(未命名)') + '</span>' + (d.kind === 'spp' ? '<span class="tag spp">SPP</span>' : (d.kind === 'dual' ? '<span class="tag dual">双模</span>' : '<span class="tag">BLE</span>')) + '<span class="mac">' + shortId(d.id) + '</span><span class="rs">' + rssiIcon(d.rssi) + ' ' + d.rssi + ' dBm</span>';
    el.onclick = function () {
      selectedId = d.id;
      renderDevices();
      var st = $('devStatus'); if (st) st.textContent = '正在连接 ' + (d.name || d.id) + ' …';
      r485('connect', d.id, null);
    };
    box.appendChild(el);
  });
}
function shortId(id) { return (id && id.length > 14) ? (id.slice(0, 8) + '…') : (id || ''); }
function rssiIcon(r) { return r >= -60 ? '●●●' : (r >= -75 ? '●●○' : '●○○'); }

// ============ 按钮 ============
var bb = $('btnBack'); if (bb) bb.onclick = function () { r485('openPanel', '', null); };
var scanWatchdog = null;
$('btnScan').onclick = function () {
  devices = {}; selectedId = null; renderDevices();
  r485('scan', '', null);
  var st = $('devStatus'); if (st) st.textContent = '正在扫描…';
  if (scanWatchdog) clearTimeout(scanWatchdog);
  // 页面侧保险：15 秒后强制停止扫描；若 2.5 秒后状态仍未变化，提示事件通道异常
  scanWatchdog = setTimeout(function () {
    r485('stopScan', '', null);
    setTimeout(function () {
      var st2 = $('devStatus');
      if (st2 && st2.textContent.indexOf('正在扫描') === 0) {
        st2.textContent = '扫描已超时强制停止；若始终停在此状态，请截图发开发者（事件通道异常）';
      }
    }, 2500);
  }, 15000);
};
$('btnStop').onclick = function () { r485('stopScan', '', null); var st = $('devStatus'); if (st) st.textContent = '已发送停止扫描…'; };
$('btnDis').onclick = function () { r485('disconnect', '', null); var st = $('devStatus'); if (st) st.textContent = '已发送断开…'; };

$('btnBuild').onclick = function () {
  var sys = $('sysSel').value.trim().toUpperCase();
  var payload = $('payload').value.replace(/[^0-9a-fA-F]/g, '').toUpperCase();
  if (!/^[0-9A-F]{2}$/.test(sys)) { logLine('SYS', '系统码需为 2 位十六进制'); return; }
  $('frame').value = mkFrame(sys, payload);
};
// 车端 RS485 使用【定长完整帧】：4346 | 系统码 | 40 | 64字节负载(不足补0) | 校验 | 4544 = 71 字节。
// 依据：仓库内所有"校验已验证"的帧（VIN 三步、特殊功能 Cmd01/02/03）都是 71 字节，
// 连负载全 0 的请求也补满 64 字节；而 rs485_items.json 里最大 off=58，也正好装得下 64 字节负载。
// 此前数据流请求只发 8 字节（4346|sys|40|ck|4544），车端收不到定长完整帧就不应答，
// 所以安卓/iOS 表现一致：连接正常但一条 RX 都没有。
var RS485_PAYLOAD_LEN = 64;
var RS485_FRAME_LEN = 2 + 2 + RS485_PAYLOAD_LEN + 1 + 2;   // 71
function buildFrame(sysHex, payloadHex, bare) {
  var pay = (payloadHex || '').toUpperCase();
  if (!bare) {
    var want = RS485_PAYLOAD_LEN * 2;
    while (pay.length < want) pay += '0';
  }
  var body = sysHex + '40' + pay;
  var bytes = hex2bytes(body);
  var ck = 0;
  for (var i = 0; i < bytes.length; i++) ck = (ck + bytes[i]) & 0xFF;
  return '4346' + body + bytes2hex([ck]) + '4544';
}
function fixedLenOn() {
  var el = $('chkFixedLen');
  return !el || el.checked;
}
// 统一入口：按界面开关决定是否补足 64 字节负载
function mkFrame(sysHex, payloadHex) {
  return buildFrame(sysHex, payloadHex, !fixedLenOn());
}
$('btnSend').onclick = function () {
  var hex = $('frame').value.replace(/[^0-9a-fA-F]/g, '').toUpperCase();
  if (!hex) { logLine('SYS', '无帧可发'); return; }
  sendFrame(hex, true);
};
// isRaw=true 表示来自「原始帧」实验工具，不做链路模式告警
function sendFrame(hex, isRaw) {
  if (!isRaw && linkMode === 'can' && !modeWarned) {
    modeWarned = true;
    logLine('SYS', '⚠ 当前链路是 CAN（连的是 ESP32 ZEEHO-CAN 桥），却在发 RS485 帧——CAN 桥会把 4346 当成 CAN 报文 ID，车端不会应答。请到「更多功能」把链路模式切成 RS485，或改连 I6328A-485 模块。');
  }
  r485('send', hex, function (res) {
    if (res && res.ok) logLine('TX', hex, '(' + (hex.length / 2) + 'B)');
    else logLine('SYS', '发送失败（未连接？）');
  });
}

// 预置：读 VIN 三步
$('btnVin').onclick = function () {
  var i = 0;
  function next() {
    if (i >= VIN_FRAMES.length) { logLine('SYS', 'VIN 三步帧已发完，等待响应…'); return; }
    sendFrame(VIN_FRAMES[i]);
    i++;
    setTimeout(next, 400);
  }
  next();
};
// 数据类别 chip：一键生成读取帧并发送（自动解析）
Array.prototype.forEach.call(document.querySelectorAll('[data-sys]'), function (btn) {
  btn.onclick = function () {
    var sys = btn.getAttribute('data-sys');
    $('sysSel').value = sys;
    $('payload').value = '';
    $('btnBuild').onclick();
    $('pSys').value = sys;
    renderItems(sys);
    sendFrame($('frame').value);
    var st = $('dataStatus');
    if (st) st.textContent = '已发送读取命令（' + sys + ' ' + (SYS[sys] || '') + '），等待响应自动解析…';
  };
});

// ============ CAN 直连（ESP32 ZEEHO-CAN；BLE 帧格式: ID_H ID_L DLC D0..D7） ============
var linkMode = 'rs485';
var lastCanReqId = 0;
var canMulti = null;
var absFlowAbort = false;

function applyMode() {
  // 已改为分页结构；此处仅同步链路模式选择器
  var sel = document.getElementById('linkSel');
  if (sel) sel.value = linkMode;
}

// UDS -> ISO-TP 帧序列（每个 8 字节数据场 hex；>7 字节自动 FF+CF 多帧）
function isotpFrames(udsHex) {
  var b = hex2bytes(udsHex);
  if (!b.length || b.length > 4095) return [];
  if (b.length <= 7) {
    var d = [b.length].concat(b);
    while (d.length < 8) d.push(0);
    return [bytes2hex(d)];
  }
  var out = [];
  var ff = [0x10 | ((b.length >> 8) & 0x0F), b.length & 0xFF].concat(b.slice(0, 6));
  out.push(bytes2hex(ff));
  var idx = 6, seq = 1;
  while (idx < b.length) {
    var cf = [0x20 | (seq & 0x0F)].concat(b.slice(idx, idx + 7));
    while (cf.length < 8) cf.push(0);
    out.push(bytes2hex(cf));
    idx += 7; seq++;
  }
  return out;
}

function canFrameHex(id, data8hex) {
  var s = id.toString(16).toUpperCase();
  while (s.length < 4) s = '0' + s;
  return s + '08' + data8hex;
}

// ISO-TP 多帧发送状态：首帧发出后必须等 ECU 的流控帧(0x30)再发连续帧，
// 原实现按固定 30ms 连发 FF+CF，不符合 ISO-TP，稍长的写命令会被 ECU 直接丢弃。
var canTx = null;
var canTxTimer = null;

function txCanFrame(id, f8, label) {
  var frame = canFrameHex(id, f8);
  r485('send', frame, function (res) {
    if (res && res.ok) logLine('TX', frame, label ? ('[' + label + ']') : '');
    else logLine('SYS', '发送失败（未连接？）');
  });
}
function canTxFlush() {
  if (canTxTimer) { clearTimeout(canTxTimer); canTxTimer = null; }
}
function canTxContinue() {
  if (!canTx) return;
  canTxFlush();
  var job = canTx;
  var gap = Math.max(5, job.stmin || 20);
  function step() {
    if (canTx !== job) return;
    if (job.next >= job.frames.length) {
      logLine('SYS', 'CAN 多帧发送完成（共 ' + job.frames.length + ' 帧）');
      canTx = null;
      return;
    }
    txCanFrame(job.id, job.frames[job.next], job.label);
    job.next++;
    canTxTimer = setTimeout(step, gap);
  }
  step();
}
function canSend(id, udsHex, label) {
  var frames = isotpFrames(udsHex);
  if (!frames.length) { logLine('SYS', 'CAN: UDS 无效'); return; }
  lastCanReqId = id;
  canTx = null;
  canTxFlush();
  if (frames.length === 1) { txCanFrame(id, frames[0], label); return; }
  canTx = { id: id, frames: frames, next: 1, label: label, stmin: 20 };
  txCanFrame(id, frames[0], label);
  logLine('SYS', 'CAN 多帧：已发首帧，等待流控帧（0x30）…');
  canTxTimer = setTimeout(function () {
    if (!canTx) return;
    logLine('SYS', '⚠ 未收到流控帧，仍按 20ms 间隔发送连续帧（非标准，但比完全不发更可能成功）');
    canTxContinue();
  }, 400);
}

var NRC_TEXT = { 0x10: '通用拒绝', 0x11: '服务不支持', 0x12: '子功能不支持', 0x13: '长度错误', 0x22: '条件不满足', 0x31: '请求超出范围', 0x33: '安全拒绝(需先解锁)', 0x35: '无效密钥', 0x78: '响应挂起' };

function canUdsDecode(udsHex) {
  var b = hex2bytes(udsHex);
  var svc = b[0];
  var txt = '';
  if (svc === 0x7F) {
    txt = '负响应: 服务 ' + bytes2hex([b[1] || 0]) + '  NRC ' + (b[2] || 0).toString(16).toUpperCase() + ' ' + (NRC_TEXT[b[2]] || '');
  } else if (svc === 0x6F) {
    txt = '写 DID ' + bytes2hex([b[1], b[2]]) + ' 成功';
  } else if (svc === 0x62) {
    txt = '读 DID ' + bytes2hex([b[1], b[2]]) + ' = ' + bytes2hex(b.slice(3));
  } else if (svc === 0x50) {
    txt = '会话变更成功';
  } else if (svc === 0x54) {
    txt = '清码成功';
  } else if (svc === 0x71) {
    txt = '例程控制响应 ' + bytes2hex(b.slice(1));
  } else {
    txt = 'UDS 响应: ' + udsHex;
  }
  logLine('UDS', txt);
  var outs = document.querySelectorAll('.udsout');
  var t = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  for (var oi = 0; oi < outs.length; oi++) {
    outs[oi].textContent += '[' + t + '] ' + txt + '\\n';
    outs[oi].scrollTop = outs[oi].scrollHeight;
  }
  if (svc === 0x7F && b[2] === 0x33) logLine('SYS', '提示：被测 ECU 要求安全访问（27 01/27 02），需先解锁——把此处日志发我继续逆密钥算法');
}

function canOnData(hex) {
  if (hex.length < 6) return;
  var b = hex2bytes(hex);
  var id = (b[0] << 8) | b[1];
  var dlc = b[2] || 0;
  var data = b.slice(3, 3 + Math.min(dlc, 8));
  var dhex = bytes2hex(data);
  logLine('RX', 'ID ' + id.toString(16).toUpperCase() + '  ' + dhex, 'CAN');
  var pci = data[0] || 0;
  if ((pci & 0xF0) === 0x00) {
    canUdsDecode(bytes2hex(data.slice(1, 1 + (pci & 0x0F))));
    canMulti = null;
  } else if ((pci & 0xF0) === 0x10) {
    canMulti = { total: ((pci & 0x0F) << 8) | (data[1] || 0), buf: data.slice(2) };
    r485('send', canFrameHex(lastCanReqId, '3008140000000000'), null); // 流控 BS=8 STmin=20ms
  } else if ((pci & 0xF0) === 0x30) {
    // 收到 ECU 的流控帧：BS=data[1]，STmin=data[2]（bit7=0 时为毫秒）
    if (canTx) {
      canTx.stmin = (data[2] & 0x7F) || 20;
      logLine('SYS', '收到流控帧，继续发送连续帧（BS=' + (data[1] || 0) + '，STmin=' + canTx.stmin + 'ms）');
      canTxContinue();
    }
  } else if ((pci & 0xF0) === 0x20 && canMulti) {
    canMulti.buf = canMulti.buf.concat(data.slice(1));
    if (canMulti.buf.length >= canMulti.total) {
      canUdsDecode(bytes2hex(canMulti.buf.slice(0, canMulti.total)));
      canMulti = null;
    }
  }
}

// 一键排气流程（泵/阀控制序列 + 10 秒泵循环）
function absFlow() {
  var id = parseInt(document.getElementById('canIdSel').value, 16);
  var statusEl = document.getElementById('absStatus');
  function st(t) { if (statusEl) statusEl.textContent = t; logLine('SYS', t); }
  absFlowAbort = false;
  var seq = [
    ['进入扩展会话', '1003', 400],
    ['开前轮阀', '2FE0DB03000064640000FC', 500],
    ['开 ABS 泵', '2FE0DA0301', 400],
    ['__WAIT__', '', 0],
    ['关 ABS 泵', '2FE0DA0300', 300],
    ['关阀', '2FE0DB03000000000000FC', 300],
    ['清除故障码', '14FFFFFF', 300],
    ['退出会话', '1001', 200]
  ];
  var total = 8;
  var i = 0;
  st('开始一键排气（共 ' + total + ' 步）…请配合放气螺丝操作');
  function step() {
    if (absFlowAbort) { st('已停止（泵/阀保持当前状态，可到「手动控制」补发：关泵 / 关阀）'); absFlowAbort = false; return; }
    if (i >= seq.length) { st('✅ 排气流程完成：关闭放气螺丝 → 补足刹车油 → 低速路试刹车'); return; }
    var s = seq[i];
    i++;
    if (s[0] === '__WAIT__') {
      st('第 ' + i + '/' + total + ' 步：泵运行中 10 秒（可继续放气；可点「停止」）');
      setTimeout(step, 10000);
      return;
    }
    st('第 ' + i + '/' + total + ' 步：' + s[0]);
    canSend(id, s[1], s[0]);
    setTimeout(step, s[2]);
  }
  step();
}

// CAN 模式 UI 事件绑定
(function bindCanUI() {
  var linkSel = document.getElementById('linkSel');
  if (linkSel) linkSel.onchange = function () { linkMode = linkSel.value; applyMode(); };
  var btnSend = document.getElementById('btnCanSend');
  if (btnSend) btnSend.onclick = function () {
    var id = parseInt(document.getElementById('canIdSel').value, 16);
    var uds = document.getElementById('canUds').value.replace(/[^0-9a-fA-F]/g, '').toUpperCase();
    if (uds) canSend(id, uds, '手动');
  };
  var btnFlow = document.getElementById('btnAbsFlow');
  if (btnFlow) btnFlow.onclick = absFlow;
  var btnStop = document.getElementById('btnAbsStop');
  if (btnStop) btnStop.onclick = function () { absFlowAbort = true; };
  var panel = document.getElementById('absPanel');
  if (panel) {
    CAN_PRESETS.abs.forEach(function (it) {
      var b = document.createElement('button');
      b.className = 'ghost';
      b.textContent = it[0];
      b.onclick = function () {
        var id = parseInt(document.getElementById('canIdSel').value, 16);
        canSend(id, it[1], it[0]);
      };
      panel.appendChild(b);
    });
  }
})();

// RS485 特殊功能 + CAN 胎压匹配 UI 绑定
(function bindSpeUI() {
  function rs485SpeSeq(frames, label) {
    frames.forEach(function (f, i) {
      setTimeout(function () { sendFrame(f); }, i * 450);
    });
    logLine('SYS', '特殊功能序列发送（' + frames.length + ' 帧）：' + label);
  }
  var b = document.getElementById('btnSpeInit');
  if (b) b.onclick = function () { rs485SpeSeq(SPE_RS485.initMsgs, '初始化 Cmd01/02/03'); };
  var bt = document.getElementById('btnSpeTpms');
  if (bt) bt.onclick = function () {
    if (!confirm('胎压匹配为写操作，确认车辆已安全停放、且已完成传感器更换？')) return;
    rs485SpeSeq(SPE_RS485.tpmsInitMsgs, '胎压匹配-初始化');
    setTimeout(function () {
      sendFrame(SPE_RS485.tpmsFrame);
      logLine('SYS', '胎压匹配帧（4346 17 02 3808…）已发送');
    }, 1500);
  };
  var tip = document.getElementById('speTip');
  if (tip) tip.textContent = SPE_RS485.nfcTip;

  // CAN 胎压传感器匹配（目标 0x714）
  var c = document.getElementById('btnTpmsRead');
  if (c) c.onclick = function () { canSend(0x714, '220802', '读胎压传感器ID'); };
  var f1 = document.getElementById('btnTpmsFront');
  if (f1) f1.onclick = function () {
    canSend(0x714, '31015390', '前轮匹配-启动');
    setTimeout(function () { canSend(0x714, '31035390', '前轮匹配-查结果'); }, 3000);
  };
  var f2 = document.getElementById('btnTpmsRear');
  if (f2) f2.onclick = function () {
    canSend(0x714, '31015391', '后轮匹配-启动');
    setTimeout(function () { canSend(0x714, '31035391', '后轮匹配-查结果'); }, 3000);
  };
  var f3 = document.getElementById('btnTpmsStop');
  if (f3) f3.onclick = function () {
    canSend(0x714, '31025390', '停止例程5390');
    setTimeout(function () { canSend(0x714, '31025391', '停止例程5391'); }, 150);
  };
})();

// ============ 分页导航 / 一键连接 / NFC ============
function showPage(name) {
  var pages = document.querySelectorAll('.page');
  for (var i = 0; i < pages.length; i++) pages[i].hidden = (pages[i].id !== 'page-' + name);
  window.scrollTo(0, 0);
}
Array.prototype.forEach.call(document.querySelectorAll('[data-nav]'), function (el) {
  el.onclick = function () { showPage(el.getAttribute('data-nav')); };
});

var autoTimer = null;
function autoConnect() {
  if (scanWatchdog) { clearTimeout(scanWatchdog); scanWatchdog = null; }
  devices = {}; selectedId = null; renderDevices();
  r485('scan', '', null);
  logLine('SYS', '一键连接：搜索中（8 秒）…');
  var st = $('svcInfo');
  if (st) { st.textContent = '搜索中（8 秒）…'; st.className = 'hint'; }
  var dst = $('devStatus'); if (dst) dst.textContent = '一键连接：自动搜索中（8 秒）…';
  if (autoTimer) clearTimeout(autoTimer);
  autoTimer = setTimeout(function () {
    r485('stopScan', '', null);
    var arr = Object.values(devices);
    var pick = null;
    for (var i = 0; i < arr.length; i++) {
      var n = (arr[i].name || '').toUpperCase();
      if (n.indexOf('ZEEHO-CAN') >= 0 || n.indexOf('6328') >= 0 || n.indexOf('SPP') >= 0 || n.indexOf('JDY') >= 0 || n.indexOf('HC-0') >= 0 || n.indexOf('HC0') >= 0 || n.indexOf('BT05') >= 0 || n.indexOf('BT-0') >= 0 || n.indexOf('485') >= 0) { pick = arr[i]; break; }
    }
    if (!pick && arr.length) pick = arr.slice().sort(function (a, b) { return b.rssi - a.rssi; })[0];
    if (pick) {
      r485('connect', pick.id, null);
      logLine('SYS', '选中设备：' + (pick.name || pick.id));
      if (st) st.textContent = '正在连接 ' + (pick.name || '') + ' …';
      var dst2 = $('devStatus'); if (dst2) dst2.textContent = '已选中 ' + (pick.name || pick.id) + '，正在连接…';
    } else {
      logLine('SYS', '未发现设备：确认模块已上电，或用「扫描设备列表」手动连接');
      if (st) st.textContent = '未发现设备，点「扫描设备列表」重试';
      var dst2 = $('devStatus'); if (dst2) dst2.textContent = '未发现设备：确认模块已上电、定位已开启后重试';
    }
  }, 8000);
}
var ba = $('btnAuto'); if (ba) ba.onclick = autoConnect;

function speSendFrames(frames, label) {
  frames.forEach(function (f, i) { setTimeout(function () { sendFrame(f); }, i * 450); });
  logLine('SYS', '特殊功能序列发送（' + frames.length + ' 帧）：' + label);
}
var bn = $('btnNfcInit');
if (bn) bn.onclick = function () {
  speSendFrames(SPE_RS485.initMsgs, 'NFC 初始化');
  var st = $('nfcStatus'); if (st) st.textContent = '已发送初始化序列，接下来可发学卡命令…';
};
// ——— NFC 操作码发送：默认按 RS485 定长帧成帧 ———
// 原实现把 3900 这类短操作码【原样裸发】，既没有 4346 帧头也没有校验和 4544 帧尾，
// 车端收到的是两个孤立字节，必然无响应（页面提示只能写"若无响应属正常"）。
function nfcSysHex() {
  var el = $('nfcSys');
  var v = ((el && el.value) || SPE_RS485.nfcSys || '89').trim().toUpperCase();
  return /^[0-9A-F]{2}$/.test(v) ? v : '89';
}
function nfcSendOp(op, raw) {
  if (raw) { sendFrame(op); logLine('TX', op, '（原样发送，未成帧）'); return op; }
  var f = mkFrame(nfcSysHex(), op);
  sendFrame(f);
  return f;
}
var bc = $('btnNfcCmd');
if (bc) bc.onclick = function () {
  var v = ($('nfcRaw').value || '').replace(/[^0-9a-fA-F]/g, '').toUpperCase();
  if (!v) return;
  var rawEl = $('chkNfcRaw');
  var f = nfcSendOp(v, rawEl && rawEl.checked);
  var st = $('nfcStatus'); if (st) st.textContent = '已发送：' + f + '（看下方响应）';
};
// 一键学卡 / 删卡：按操作码顺序成帧发送；学卡在 0D0100 之后留 6 秒放卡时间
function nfcSeq(ops, label, placeCardAfter) {
  logLine('SYS', 'NFC ' + label + ' 流程开始（共 ' + ops.length + ' 步）');
  var i = 0;
  function step() {
    if (i >= ops.length) {
      logLine('SYS', 'NFC ' + label + ' 流程结束');
      var st = $('nfcStatus'); if (st) st.textContent = 'NFC ' + label + ' 流程已发完，请看下方响应。';
      return;
    }
    var op = ops[i];
    var f = nfcSendOp(op, false);
    logLine('SYS', 'NFC ' + label + ' 第 ' + (i + 1) + '/' + ops.length + ' 步：' + op + ' → ' + f);
    var needCard = (placeCardAfter === i);
    i++;
    if (needCard) {
      var st2 = $('nfcStatus'); if (st2) st2.textContent = '已发 ' + op + '，请现在把新卡贴近车辆 NFC 区域…（6 秒）';
    }
    setTimeout(step, needCard ? 6000 : 800);
  }
  step();
}
var bl = $('btnNfcLearn');
if (bl) bl.onclick = function () {
  if (!confirm('学卡会写入车辆，确认已按维修流程操作？')) return;
  nfcSeq(SPE_RS485.nfcLearn, '学卡', 1);
};
var bd = $('btnNfcDelete');
if (bd) bd.onclick = function () {
  if (!confirm('删卡会清除车辆已登记的全部卡片，确认继续？')) return;
  nfcSeq(SPE_RS485.nfcDelete, '删卡', -1);
};

// ============ 官方诊断仪（实验）检测 ============
function vciShow(t) {
  var o = document.getElementById('vciOut');
  if (!o) return;
  o.textContent = (typeof t === 'string') ? t : JSON.stringify(t, null, 2);
  o.scrollTop = 0;
}
var vp = $('btnVciProbe');
if (vp) vp.onclick = function () {
  if (typeof r485 !== 'function') { vciShow('需在 iOS App（TrollStore 安装）内运行'); return; }
  vciShow('探测中…');
  r485('vciProbe', '', function (json) { vciShow(json || 'null'); });
};
var vq = $('btnVciPaired');
if (vq) vq.onclick = function () {
  if (typeof r485 !== 'function') { vciShow('需在 iOS App（TrollStore 安装）内运行'); return; }
  vciShow('查询中…');
  r485('vciPaired', '', function (json) { vciShow(json || 'null'); });
};

// ============ WiFi 直连（DoIP 无线诊断 · 移植自桌面版 protocol.js） ============
var WD = { conn: false, rxBuf: [], pending: null, hbTimer: null, host: '192.168.49.1', port: 13400 };
function wBytes(hex) { var r = []; for (var i = 0; i + 1 < hex.length; i += 2) r.push(parseInt(hex.substr(i, 2), 16) & 255); return r; }
function wHexOf(a) { var s = ''; for (var i = 0; i < a.length; i++) s += (a[i] < 16 ? '0' : '') + a[i].toString(16).toUpperCase(); return s; }
function wU16(a, o, v) { a[o] = (v >> 8) & 255; a[o + 1] = v & 255; }
function wAscii(a, start) { var s = ''; for (var i = start; i < a.length; i++) s += String.fromCharCode(a[i] & 255); return s; }
function wDoip(pt, payload) {
  var len = payload.length;
  return [3, 252, (pt >> 8) & 255, pt & 255, (len >>> 24) & 255, (len >>> 16) & 255, (len >>> 8) & 255, len & 255].concat(payload);
}
function wRouteAct() { var p = new Array(12).fill(0); wU16(p, 0, 0x0E00); wU16(p, 2, 1); p[4] = 1; wU16(p, 10, 30); return wDoip(5, p); }
function wAlive() { var p = new Array(12).fill(0); wU16(p, 0, 0x0E00); wU16(p, 2, 1); p[4] = 1; wU16(p, 10, 30); return wDoip(7, p); }
function wDiagPdu(da, uds) { return wDoip(0x8001, [0x0E, 0x00, (da >> 8) & 255, da & 255].concat(uds)); }
var WU = {
  READ_VIN: [3, 34, 0xF1, 0x90],
  READ_SW: [3, 34, 0xF1, 0x95],
  READ_PART: [3, 34, 0xF1, 0x87],
  READ_SUPPLIER: [3, 34, 0xF1, 0x8A],
  READ_MILEAGE: [3, 34, 0xF2, 0x01],
  READ_IMEI: [3, 34, 7, 0],
  DTC: [3, 25, 2, 9],
  CLEAR: [4, 20, 255, 255, 255]
};
function wifiSt(t) { var el = $('wifiStatus'); if (el) el.textContent = t; }
function wLog(t) { logLine('WIFI', t); }
function wUdsOf(pdu) { return pdu.slice(16); }
window.onWifiEvent = function (ev) {
  ev = parseEv(ev);
  if (!ev || !ev.type) return;
  if (ev.type === 'connected') {
    WD.conn = true;
    wifiSt('TCP 已连接 ' + WD.host + ':' + WD.port + '，已发送路由激活');
    r485('wifiSend', wHexOf(wRouteAct()), null);
    if (WD.hbTimer) clearInterval(WD.hbTimer);
    WD.hbTimer = setInterval(function () { if (WD.conn) r485('wifiSend', wHexOf(wAlive()), null); }, 2000);
  } else if (ev.type === 'recv') {
    wFeed(wBytes(ev.data));
  } else if (ev.type === 'closed' || ev.type === 'error') {
    WD.conn = false;
    if (WD.hbTimer) { clearInterval(WD.hbTimer); WD.hbTimer = null; }
    wifiSt('连接断开' + (ev.data ? ('：' + ev.data) : ''));
  }
};
function wFeed(bytes) {
  WD.rxBuf = WD.rxBuf.concat(bytes);
  var off = 0;
  while (off + 8 <= WD.rxBuf.length) {
    var ver = WD.rxBuf[off];
    if (ver !== 3 && ver !== 255) { off += 1; continue; }
    var len = (WD.rxBuf[off + 4] * 16777216) + (WD.rxBuf[off + 5] << 16) + (WD.rxBuf[off + 6] << 8) + WD.rxBuf[off + 7];
    if (off + 8 + len > WD.rxBuf.length) break;
    var pdu = WD.rxBuf.slice(off, off + 8 + len);
    off += 8 + len;
    wDispatch(pdu);
  }
  WD.rxBuf = WD.rxBuf.slice(off);
}
function wDispatch(pdu) {
  var hex = wHexOf(pdu);
  if (hex.indexOf('03FC8001') === 0 || hex.indexOf('03FC8003') === 0 || hex.indexOf('03FC8002') === 0) {
    if (WD.pending) {
      var p = WD.pending; WD.pending = null;
      clearTimeout(p.timer);
      p.cb(pdu);
    }
  } else {
    wLog('← ' + hex.slice(0, 40));
  }
}
function wDiagReq(da, uds, cb, timeout) {
  if (!WD.conn) { cb(null); return; }
  if (WD.pending) { clearTimeout(WD.pending.timer); WD.pending = null; }
  var timer = setTimeout(function () { if (WD.pending) { WD.pending = null; cb(null); } }, timeout || 1500);
  WD.pending = { cb: cb, timer: timer };
  r485('wifiSend', wHexOf(wDiagPdu(da, uds)), null);
}
function wDidAscii(uds, hi, lo) {
  for (var i = 0; i + 2 < uds.length; i++) {
    if (uds[i] === 0x62 && uds[i + 1] === hi && uds[i + 2] === lo) return wAscii(uds, i + 3);
  }
  return '';
}
function wDidUint(uds, hi, lo) {
  for (var i = 0; i + 2 < uds.length; i++) {
    if (uds[i] === 0x62 && uds[i + 1] === hi && uds[i + 2] === lo) {
      var v = 0;
      for (var j = i + 3; j < uds.length; j++) v = (v << 8) | uds[j];
      return v;
    }
  }
  return -1;
}
function wifiRender(list) {
  var g = $('wifiGrid'); if (!g) return;
  var h = '';
  for (var i = 0; i < list.length; i++) {
    h += '<div style="background:var(--panel2);border:1px solid var(--border);border-radius:8px;padding:8px"><div style="font-size:11px;color:var(--muted)">' + list[i][0] + '</div><div style="font-size:14px;font-weight:600;margin-top:2px;word-break:break-all">' + (list[i][1] || '--') + '</div></div>';
  }
  g.innerHTML = h;
}
function wifiReadInfo() {
  if (typeof r485 !== 'function') { wifiSt('需在 iOS App 内运行'); return; }
  if (!WD.conn) { wifiSt('未连接：先把手机连上车辆热点，再点「连接」'); return; }
  wifiSt('读取车辆信息中…');
  var seq = [
    ['VIN', WU.READ_VIN, function (u) { var s = wDidAscii(u, 0xF1, 0x90); return s.length === 17 ? s : ''; }],
    ['软件版本', WU.READ_SW, function (u) { return wDidAscii(u, 0xF1, 0x95); }],
    ['零件号', WU.READ_PART, function (u) { return wDidAscii(u, 0xF1, 0x87).replace(/\s+$/, ''); }],
    ['供应商', WU.READ_SUPPLIER, function (u) { return wDidAscii(u, 0xF1, 0x8A); }],
    ['总里程(km)', WU.READ_MILEAGE, function (u) { var v = wDidUint(u, 0xF2, 0x01); return v < 0 ? '' : (v / 10).toFixed(1); }],
    ['IMEI', WU.READ_IMEI, function (u) { return wDidAscii(u, 0x07, 0x00); }]
  ];
  var out = [];
  var idx = 0;
  function next() {
    if (idx >= seq.length) { wifiRender(out); wifiSt('车辆信息读取完成'); return; }
    var it = seq[idx]; idx++;
    wDiagReq(1, it[1], function (pdu) {
      var val = '';
      if (pdu) {
        val = it[2](wUdsOf(pdu));
        wLog('← ' + it[0] + ': ' + wHexOf(wUdsOf(pdu)));
      } else wLog('← ' + it[0] + ': 超时');
      out.push([it[0], val]);
      setTimeout(next, 150);
    }, 1500);
  }
  next();
}
function wifiReadDtc() {
  if (!WD.conn) { wifiSt('未连接'); return; }
  wifiSt('读取故障码中…');
  wDiagReq(1, WU.DTC, function (pdu) {
    if (!pdu) { wifiSt('故障码读取超时'); return; }
    var u = wUdsOf(pdu);
    wLog('← DTC 原始: ' + wHexOf(u));
    var dtcs = [];
    if (u[0] === 0x59 && u[1] === 0x02) {
      for (var i = 3; i + 3 < u.length; i += 4) dtcs.push(wHexOf(u.slice(i, i + 3)) + ' [' + wHexOf([u[i + 3]]) + ']');
    }
    if (dtcs.length) wifiRender(dtcs.map(function (d, i) { return ['DTC' + (i + 1), d]; }));
    else wifiRender([['故障码', '无（' + wHexOf(u) + '）']]);
    wifiSt('故障码读取完成：' + (dtcs.length ? dtcs.length + ' 条' : '无'));
  }, 2500);
}
function wifiClearDtc() {
  if (!WD.conn) { wifiSt('未连接'); return; }
  if (!confirm('确认清除全部故障码？（请先确保故障已排除）')) return;
  wifiSt('清除故障码中…');
  wDiagReq(1, WU.CLEAR, function (pdu) {
    var r = pdu ? wHexOf(wUdsOf(pdu)) : '';
    wLog('← 清码: ' + (r || '超时'));
    wifiSt(pdu ? '清除完成：' + r : '清除超时（ECU 可能未放行）');
  }, 2500);
}
var wc = $('btnWifiConn');
if (wc) wc.onclick = function () {
  if (typeof r485 !== 'function') { wifiSt('需在 iOS App（TrollStore 安装）内运行；先连车辆热点'); return; }
  WD.host = ($('wifiHost').value || '192.168.49.1').trim();
  WD.port = parseInt($('wifiPort').value || '13400', 10) || 13400;
  wifiSt('连接中 ' + WD.host + ':' + WD.port + '…（首次会弹本地网络权限）');
  r485('wifiConnect', WD.host + ':' + WD.port, null);
};
var wd = $('btnWifiDisc');
if (wd) wd.onclick = function () { r485('wifiClose', '', null); wifiSt('已断开'); };
var wi = $('btnWifiInfo'); if (wi) wi.onclick = wifiReadInfo;
var wt = $('btnWifiDtc'); if (wt) wt.onclick = wifiReadDtc;
var wcl = $('btnWifiClear'); if (wcl) wcl.onclick = wifiClearDtc;
var ws = $('btnWifiScan');
if (ws) ws.onclick = function () {
  if (typeof r485 !== 'function') { wifiSt('需在 iOS App（TrollStore 安装）内运行'); return; }
  wifiSt('自检中：读取本机 IP 并探测候选网关…（约 2 秒）');
  var so = $('wifiScanOut');
  if (so) so.textContent = '自检中…';
  r485('wifiSelfCheck', ($('wifiPort').value || '13400'), null);
};
window.onWiFiSelfCheck = function (r) {
  r = parseEv(r);
  var so = $('wifiScanOut');
  if (!r) { if (so) so.textContent = '自检无响应'; return; }
  var lines = [];
  lines.push('本机 WiFi IP：' + (r.localIP || '无（未连接 WiFi！请先连车辆热点）'));
  lines.push('探测端口：' + r.port);
  (r.results || []).forEach(function (x) {
    lines.push('  ' + x.host + ' → ' + (x.status === 'open' ? '✅ 通' : '✖ ' + x.status));
  });
  if (r.found) {
    $('wifiHost').value = r.found;
    lines.push('');
    lines.push('✅ 发现可用诊断网关：' + r.found + '（已自动填入上方，点「连接」）');
    wifiSt('发现可用网关 ' + r.found + '，已填入，请点「连接」');
  } else {
    lines.push('');
    lines.push('✖ 未发现可用网关：① 确认手机已连车辆热点 ② 车辆需通电且诊断服务开启 ③ 也可试试把网关 IP 手动改为 192.168.0.1');
    wifiSt('未发现可用网关——请看下方自检详情');
  }
  if (so) so.textContent = lines.join('\\n');
};
var wps = $('btnWifiPortScan');
if (wps) wps.onclick = function () {
  if (typeof r485 !== 'function') { wifiSt('需在 iOS App（TrollStore 安装）内运行'); return; }
  var h = ($('wifiHost').value || '192.168.0.1').trim();
  wifiSt('端口扫描 ' + h + ' …（约 2 秒）');
  var so = $('wifiScanOut'); if (so) so.textContent = '端口扫描 ' + h + ' 中…';
  r485('wifiPortScan', h, null);
};
window.onWifiPortScan = function (r) {
  r = parseEv(r);
  var so = $('wifiScanOut');
  if (!r) { if (so) so.textContent = '端口扫描无响应'; return; }
  var open = r.open || [];
  var lines = ['端口扫描 ' + r.host + '：'];
  (r.results || []).forEach(function (x) {
    lines.push('  ' + x.port + ' → ' + (x.status === 'open' ? '✅ 开放' : (x.status === 'fail' ? '✖ 关闭' : '✖ 超时')));
  });
  lines.push(open.length ? ('✅ 开放端口：' + open.join(', ')) : '✖ 未发现开放端口');
  lines.push('（把结果截图发给开发者）');
  if (so) so.textContent = lines.join('\\n');
  wifiSt(open.length ? ('发现开放端口：' + open.join(', ')) : '未发现开放端口');
};

// ============ 数据流解析 ============
// base 指向响应帧里的【系统码】字节（findMarker 找到 sys|40 的位置），
// 其后还有 1 个字节的命令码 40，所以数据首字节在 base+2。
// rs485_items.json 的 off 是相对【数据首字节】的（如"电池电量" off=0，最大 off=58），
// 原实现用 buf[base+off] 少加了 2，等于把系统码/命令码当成数据在算。
var RS485_DATA_OFFSET = 2;
function evalItem(it, buf, base) {
  var off = it.o;
  if (off == null) return null;
  var args = [];
  var n = (it.a && it.a.length) || 1;
  for (var k = 0; k < n; k++) {
    var idx = base + RS485_DATA_OFFSET + off + k;
    args.push(buf[idx] != null ? buf[idx] : 0);
  }
  try {
    if (it.k === 'v') {
      var fn = new Function((it.a || []).join(','), 'return (' + it.e + ');');
      var v = fn.apply(null, args);
      return v;
    } else {
      var fn2 = new Function((it.a || []).join(','), it.j);
      return fn2.apply(null, args);
    }
  } catch (e) { return null; }
}

// 从响应 buffer 中找 sys+40 标记，返回标记起始下标（搜索从第 2 字节开始，跳过帧头 4346）
function findMarker(buf, sysHex) {
  var sys = parseInt(sysHex, 16);
  for (var i = 0; i + 1 < buf.length; i++) {
    if (buf[i] === sys && buf[i + 1] === 0x40) return i;
  }
  return -1;
}

var lastParsed = {};   // sys -> {name: value}
function parseBuffer(hex, sysHex) {
  var buf = hex2bytes(hex);
  var base = findMarker(buf, sysHex);
  if (base < 0) return null;
  var out = {};
  ITEMS.forEach(function (it) {
    if (it.s !== sysHex) return;
    out[it.n] = { v: evalItem(it, buf, base), u: it.u || '', f: it.f || '' };
  });
  return out;
}

function autoParse(hex) {
  // 命中标记的系统全部解析并缓存（仪表盘可跨系统取数）
  var buf = hex2bytes(hex);
  var found = [];
  Object.keys(SYS).forEach(function (sys) {
    if (findMarker(buf, sys) < 0) return;
    var r = parseBuffer(hex, sys);
    if (r) { DASH_DATA[sys] = r; found.push(sys); }
  });
  if (found.length) {
    // 列表展示：选内置项最多的系统
    var best = found[0];
    found.forEach(function (sys) {
      if (ITEMS.filter(function (i) { return i.s === sys; }).length > ITEMS.filter(function (i) { return i.s === best; }).length) best = sys;
    });
    $('pSys').value = best;
    lastParsed = DASH_DATA[best];
    renderItems(best, lastParsed);
    var dst = $('dataStatus');
    if (dst) dst.textContent = '已解析：' + best + ' ' + (SYS[best] || '') + ' · ' + Object.keys(lastParsed).length + ' 项数据';
    logLine('SYS', '已按系统 ' + best + ' 解析 ' + Object.keys(lastParsed).length + ' 项');
    renderDash();
    if (DASH[DASH_VIEW] && DASH[DASH_VIEW].syses.indexOf(best) >= 0) {
      var now = new Date();
      var hh = ('0' + now.getHours()).slice(-2), mm = ('0' + now.getMinutes()).slice(-2), ss = ('0' + now.getSeconds()).slice(-2);
      dashSt('已更新 · ' + hh + ':' + mm + ':' + ss + '（系统 ' + best + '）');
      var ts = $('dashTs'); if (ts) ts.textContent = '更新 ' + hh + ':' + mm + ':' + ss;
    }
  } else {
    // VIN 尝试
    var ascii = hexToAscii(hex).replace(/\\./g, '');
    var m = hexToAscii(hex).match(/[A-HJ-NPR-Z0-9]{17}/);
    if (m) logLine('SYS', '发现疑似 VIN: ' + m[0]);
  }
}

function renderItems(sysHex, parsed) {
  var grid = $('dsGrid');
  grid.innerHTML = '';
  var list = ITEMS.filter(function (i) { return i.s === sysHex; });
  if (!list.length) { grid.innerHTML = '<div class="hint">该系统暂无内置解析项</div>'; return; }
  list.forEach(function (it) {
    var entry = parsed ? parsed[it.n] : (lastParsed[it.n] != null ? lastParsed[it.n] : null);
    var val = entry && entry.v != null && entry.v !== undefined ? entry.v : null;
    if (typeof val === 'number') {
      val = (it.f && it.f.indexOf('.') >= 0) ? Number(val).toFixed(1) : Math.round(val);
    }
    var el = document.createElement('div');
    el.className = 'ds' + (val === null ? ' fail' : '');
    el.innerHTML = '<div class="n">' + it.n + '</div><div class="v">' + (val === null ? '—' : val) + '<small>' + (it.u || '') + '</small></div>';
    grid.appendChild(el);
  });
}

$('pSys').onchange = function () { renderItems($('pSys').value); };
$('btnParse').onclick = function () {
  if (!buffers.length) { logLine('SYS', '暂无响应数据'); return; }
  var sys = $('pSys').value;
  for (var i = 0; i < buffers.length; i++) {
    var r = parseBuffer(buffers[i].hex, sys);
    if (r) { lastParsed = r; renderItems(sys, r); logLine('SYS', '解析系统 ' + sys + '（' + r && Object.keys(r).length + ' 项）来自最近响应#' + (i + 1)); return; }
  }
  logLine('SYS', '未在最近 ' + buffers.length + ' 条响应中找到系统 ' + sys + ' 的标记（' + sys + '40）');
};

$('btnClr').onclick = function () { $('log').innerHTML = ''; buffers = []; };

// ============ 诊断日志文件（原生日志，可直接导出发给开发者） ============
function logRefresh() {
  var el = $('logInfo');
  if (typeof r485 !== 'function') { if (el) el.textContent = '原生日志不可用（需在 App 内运行）'; return; }
  r485('logInfo', '', function (json) {
    if (!el) return;
    var o = null;
    try { o = (typeof json === 'string') ? JSON.parse(json) : json; } catch (e) { o = null; }
    if (!o || !o.path) { el.textContent = '拿不到日志文件信息（可能是旧版本 App）'; return; }
    el.textContent = '文件：' + o.path
      + '\\n大小：' + o.size + ' 字节 · ' + o.lines + ' 行'
      + '\\n目录：' + o.dir;
  });
}
var bls = $('btnLogShare');
if (bls) bls.onclick = function () {
  var el = $('logInfo');
  if (typeof r485 !== 'function') { if (el) el.textContent = '需在 App 内运行'; return; }
  r485('logShare', '', function () { logRefresh(); });
};
var bli = $('btnLogInfo');
if (bli) bli.onclick = logRefresh;
var blc = $('btnLogClear');
if (blc) blc.onclick = function () {
  if (!confirm('清空当前日志文件？（会删掉已记录的收发数据）')) return;
  r485('logClear', '', function () { logRefresh(); });
};
setTimeout(logRefresh, 1500);

// ============ 仪表盘（横屏「看数据流」） ============
var DASH_DATA = {};   // sys -> { 名称: {v,u,f} }
var DASH_VIEW = 'car';
var DASH = {
  car: {
    syses: ['59', '51', '81'],
    gauge: { name: '显示车速', unit: 'km/h', max: 100, fixed: 0, scale: 1 },
    ticks: ['0', '20', '40', '60', '80', '100'],
    tiles: [
      { label: '电量', name: '电池电量百分比', fixed: 0, unit: '%' },
      { label: '电压', name: '电池总电压', fixed: 1, unit: 'V' },
      { label: '剩余能量', name: '电池剩余能量', fixed: 0, unit: 'Wh' },
      { label: '总里程', name: '里程', fixed: 1, unit: 'km' },
      { label: '实时功率', name: '实时功率', fixed: 0, unit: 'W' },
      { label: '速度模式', name: '电机速度模式', fixed: -1, unit: '' },
      { label: '电机温度', name: '电机温度', fixed: 0, unit: '℃' },
      { label: '控制器温度', name: '电机控制器温度', fixed: 0, unit: '℃' },
      { label: '电池最高温', name: '电池单体最高温度', fixed: 0, unit: '℃' }
    ]
  },
  batt: {
    syses: ['51'],
    gauge: { name: '电池电量百分比', unit: '%', max: 100, fixed: 0, scale: 1 },
    ticks: ['0', '20', '40', '60', '80', '100'],
    tiles: [
      { label: '总电压', name: '电池总电压', fixed: 1, unit: 'V' },
      { label: '总电流', name: '电池总电流', fixed: 1, unit: 'A' },
      { label: '剩余能量', name: '电池剩余能量', fixed: 0, unit: 'Wh' },
      { label: '健康度', name: '电池健康度', fixed: 0, unit: '%' },
      { label: '循环次数', name: '电池循环次数', fixed: 0, unit: '次' },
      { label: '单体最高温', name: '电池单体最高温度', fixed: 0, unit: '℃' },
      { label: '单体最低温', name: '电池单体最低温度', fixed: 0, unit: '℃' },
      { label: '充电状态', name: '电池充电状态', fixed: -1, unit: '' },
      { label: '故障等级', name: 'BMS系统故障等级', fixed: -1, unit: '' }
    ]
  },
  motor: {
    syses: ['59'],
    gauge: { name: '实时功率', unit: 'kW', max: 3, fixed: 1, scale: 0.001 },
    ticks: ['0', '0.6', '1.2', '1.8', '2.4', '3.0'],
    tiles: [
      { label: '母线电压', name: '母线电压', fixed: 1, unit: 'V' },
      { label: '母线电流', name: '母线电流', fixed: 1, unit: 'A' },
      { label: '转把电压', name: '转把电压', fixed: 2, unit: 'V' },
      { label: '控制器温度', name: '电机控制器温度', fixed: 0, unit: '℃' },
      { label: '电机温度', name: '电机温度', fixed: 0, unit: '℃' },
      { label: 'U相电流', name: 'U相电流', fixed: 1, unit: 'A' },
      { label: 'V相电流', name: 'V相电流', fixed: 1, unit: 'A' },
      { label: 'W相电流', name: 'W相电流', fixed: 1, unit: 'A' },
      { label: '能量回收', name: '能量回收状态', fixed: -1, unit: '' }
    ]
  }
};
var DASH_L = 460.8, DASH_CX = 180, DASH_CY = 190, DASH_R = 110;
function dashFind(name) {
  var view = DASH[DASH_VIEW];
  if (!view) return null;
  for (var i = 0; i < view.syses.length; i++) {
    var r = DASH_DATA[view.syses[i]];
    if (r && r[name] != null) return r[name];
  }
  return null;
}
function dashFmt(t, e) {
  if (!e || e.v === null || e.v === undefined) return '—';
  var v = e.v;
  if (typeof v !== 'number') return String(v);
  if (t.fixed < 0) return String(v);
  return v.toFixed(t.fixed);
}
function renderDash() {
  var view = DASH[DASH_VIEW];
  if (!view || !$('dashVal')) return;
  var g = dashFind(view.gauge.name);
  var gv = (g && typeof g.v === 'number') ? g.v * view.gauge.scale : null;
  $('dashVal').textContent = gv === null ? '—' : gv.toFixed(view.gauge.fixed);
  $('dashUnit').textContent = (g && g.u) ? g.u : view.gauge.unit;
  var pct = gv === null ? 0 : Math.max(0, Math.min(1, gv / view.gauge.max));
  $('dashProg').setAttribute('stroke-dashoffset', (DASH_L * (1 - pct)).toFixed(1));
  var ang = -120 + pct * 240, rad = ang * Math.PI / 180;
  $('dashPnt').setAttribute('cx', (DASH_CX + DASH_R * Math.sin(rad)).toFixed(1));
  $('dashPnt').setAttribute('cy', (DASH_CY - DASH_R * Math.cos(rad)).toFixed(1));
  for (var i = 0; i < 6; i++) { var tk = $('dtk' + i); if (tk) tk.textContent = view.ticks[i]; }
  var tl = $('dashTiles');
  tl.innerHTML = '';
  view.tiles.forEach(function (t) {
    var e = dashFind(t.name);
    var d = document.createElement('div');
    d.className = 'dtile' + (e ? '' : ' fail');
    d.innerHTML = '<div class="tn">' + t.label + '</div><div class="tv">' + dashFmt(t, e) + '<small>' + (t.unit || '') + '</small></div>';
    tl.appendChild(d);
  });
}
function dashSt(msg) { var el = $('dashMsg'); if (el) el.textContent = msg; }
function dashRead() {
  var view = DASH[DASH_VIEW];
  if (!view) return;
  if (typeof connected === 'undefined' || !connected) { dashSt('未连接模块——先到「蓝牙连接」页连接 485 模块'); return; }
  var i = 0;
  dashSt('读取中：' + view.syses.join(' / ') + ' …');
  function next() {
    if (i >= view.syses.length) { dashSt('读取命令已发送，等待响应…'); return; }
    sendFrame(mkFrame(view.syses[i], ''));
    i++;
    setTimeout(next, 400);
  }
  next();
}
Array.prototype.forEach.call(document.querySelectorAll('[data-dash]'), function (btn) {
  btn.onclick = function () {
    DASH_VIEW = btn.getAttribute('data-dash');
    Array.prototype.forEach.call(document.querySelectorAll('[data-dash]'), function (b) { b.className = 'dchip' + (b === btn ? ' on' : ''); });
    renderDash();
    dashRead();
  };
});
var bdr = $('btnDashRead'); if (bdr) bdr.onclick = dashRead;
renderDash();

// 初始化
Object.keys(SYS).forEach(function (s) {
  var opt = document.createElement('option');
  opt.value = s; opt.textContent = s + ' ' + SYS[s];
  $('pSys').appendChild(opt);
});
if (Object.keys(SYS).indexOf('51') >= 0) $('pSys').value = '51';
renderItems($('pSys').value);
applyMode();
showPage('home');
logLine('SYS', '无线诊断已就绪：先「一键连接」，再选择需要的功能');
if ((typeof window.Android === 'undefined' || !window.Android || !window.Android.postMessage) && (!window.webkit || !window.webkit.messageHandlers || !window.webkit.messageHandlers.rs485)) {
  var ds0 = $('devStatus'); if (ds0) ds0.textContent = '原生桥未就绪：请更新 App 后重试';
}
// 原生通道自检：发一条 state 命令，2 秒内无回包则提示
var pingDone = false;
r485('state', '', function (res) {
  pingDone = true;
  var d = $('devStatus');
  if (d) d.textContent = (res && res.type === 'state') ? ('原生通道 OK（蓝牙 ' + res.state + '），可以正常扫描') : '原生通道异常回包';
});
setTimeout(function () {
  if (!pingDone) {
    var d = $('devStatus');
    if (d) d.textContent = '原生通道无响应：请确认安装的是最新版 App';
  }
}, 2000);

// ============ 轮询式状态同步（命令回包通道，不依赖事件推送） ============
function pollState() {
  r485('scanState', '', function (res) {
    if (!res) return;
    if (res.devices) {
      var changed = false;
      var seen = {};
      for (var i = 0; i < res.devices.length; i++) {
        var d = res.devices[i];
        seen[d.id] = true;
        if (!devices[d.id] || devices[d.id].kind !== d.kind || devices[d.id].rssi !== d.rssi) changed = true;
        devices[d.id] = d;
      }
      for (var k in devices) { if (!seen[k]) { delete devices[k]; changed = true; } }
      if (changed) renderDevices();
    }
    if (res.connected && res.linkName) {
      var pill = $('blePill');
      if (pill) {
        pill.textContent = '已连接 ' + res.linkName + '（' + (res.linkKind === 'ble' ? 'BLE' : 'RS485') + '）';
        pill.className = 'pill ok';
      }
    }
    var active = res.scanning || res.discovering;
    var st = $('devStatus');
    if (st && st.textContent.indexOf('已连接') !== 0 && st.textContent.indexOf('错误') !== 0 && st.textContent.indexOf('正在连接') !== 0) {
      if (res.locGranted === false) {
        st.textContent = '⚠ 未授予定位权限：BLE 扫描需要它（不读你的位置）。请到系统设置允许定位后重试';
      } else if (res.locEnabled === false) {
        st.textContent = '⚠ 定位服务未开启：请打开系统「定位」开关后重试（仅用于蓝牙扫描）';
      } else if (active) {
        st.textContent = '原生扫描中…（BLE ' + res.bleSeen + ' / 经典 ' + res.sppSeen + ' / 已配对 ' + res.bonded + '）';
      } else if (st.textContent.indexOf('正在扫描') === 0 || st.textContent.indexOf('原生扫描中') === 0) {
        st.textContent = '扫描结束：BLE ' + res.bleSeen + ' 台 / 经典 ' + res.sppSeen + ' 台 / 已配对 ' + res.bonded + ' 台'
          + (res.bleSeen === 0 ? '（若无结果：确认模块已上电、手机「定位服务」已开启）' : '（点击设备连接）');
      }
    }
  });
}
setInterval(pollState, 1500);
pollState();
`;

// 校验 JS 语法
try {
  new Function('window', 'document', LOGIC_JS);
  new Function('var x=' + JSON.stringify(compact) + ';');
} catch (e) {
  console.error('JS 语法错误: ' + e.message);
  process.exit(1);
}

const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover,user-scalable=no"/>
<meta http-equiv="Content-Security-Policy" content="default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'"/>
<title>极核自主诊断</title>
<style>
:root{--bg:#f2f2f7;--panel:rgba(255,255,255,.78);--panel2:rgba(255,255,255,.85);--border:rgba(0,0,0,.08);--text:#1c1c1e;--muted:#6e6e73;--ok:#34c759;--acc:#007aff;--err:#ff3b30;}
*{box-sizing:border-box;margin:0;padding:0;-webkit-tap-highlight-color:transparent;}
body{background:var(--bg);color:var(--text);font:14px/1.5 -apple-system,"SF Pro Text","PingFang SC",system-ui,sans-serif;padding:env(safe-area-inset-top) 0 env(safe-area-inset-bottom);}
header{display:flex;align-items:center;gap:10px;padding:14px 16px;position:sticky;top:0;background:rgba(242,242,247,.82);-webkit-backdrop-filter:blur(20px) saturate(180%);backdrop-filter:blur(20px) saturate(180%);z-index:9;border-bottom:1px solid var(--border);}
.hbrand{font-size:22px;font-weight:700;flex:1;letter-spacing:-.3px;}
button{background:var(--acc);color:#fff;border:0;border-radius:12px;padding:8px 14px;font-size:14px;min-height:38px;font-weight:500;box-shadow:0 1px 2px rgba(0,0,0,.08);}
button:active{opacity:.8;}
button.ghost{background:rgba(118,118,128,.14);box-shadow:none;color:var(--text);}
button.green{background:var(--ok);}
.pill{padding:3px 10px;border-radius:999px;font-size:12px;background:rgba(118,118,128,.12);border:1px solid transparent;color:var(--muted);white-space:nowrap;}
.pill.ok{color:var(--ok);background:rgba(52,199,89,.15);}
.pill.err{color:var(--err);background:rgba(255,59,48,.12);}
main{padding:12px 14px;display:flex;flex-direction:column;gap:12px;}
.card{background:var(--panel);border:1px solid var(--border);border-radius:20px;padding:14px;-webkit-backdrop-filter:blur(20px) saturate(180%);backdrop-filter:blur(20px) saturate(180%);box-shadow:0 8px 24px rgba(0,0,0,.05);}
.card h2{font-size:13px;margin-bottom:10px;color:var(--muted);font-weight:600;}
.row{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:6px;}
input,select{background:#fff;border:1px solid var(--border);color:var(--text);border-radius:10px;padding:8px 10px;font-size:14px;outline:none;min-height:38px;}
input{flex:1;min-width:110px;}
.hint{color:var(--muted);font-size:12px;margin-top:8px;word-break:break-all;}
.hint.err{color:var(--err);}
.devlist{margin-top:8px;display:flex;flex-direction:column;gap:8px;max-height:220px;overflow:auto;}
.dev{background:rgba(255,255,255,.85);border:1px solid var(--border);border-radius:16px;padding:10px 12px;min-height:54px;display:flex;gap:8px;align-items:center;cursor:pointer;box-shadow:0 2px 8px rgba(0,0,0,.04);}
.dev:active{border-color:var(--acc);}
.dev.sel{border-color:var(--acc);background:rgba(0,122,255,.10);}
.dev .nm{font-weight:600;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.dev .mac{color:var(--muted);font-size:11px;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.dev .rs{margin-left:auto;color:var(--muted);font-size:12px;white-space:nowrap;}
.dev .tag{font-size:10px;font-weight:700;padding:1px 6px;border-radius:6px;background:rgba(0,122,255,.12);color:#007aff;white-space:nowrap;}
.dev .tag.spp{background:rgba(90,200,250,.18);color:#0376a8;}
.dev .tag.dual{background:rgba(175,82,222,.12);color:#8e3fc2;}
.devstatus{margin-top:6px;font-size:12px;color:var(--muted);min-height:16px;}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(46%,1fr));gap:8px;margin-top:8px;max-height:400px;overflow:auto;}
.ds{background:rgba(255,255,255,.85);border:1px solid var(--border);border-radius:14px;padding:9px 11px;}
.ds .n{color:var(--muted);font-size:12px;}
.ds .v{font-size:17px;font-family:ui-monospace,Menlo,Consolas,monospace;margin-top:2px;font-weight:600;}
.ds .v small{font-size:11px;color:var(--muted);margin-left:3px;font-weight:400;}
.dash{background:var(--panel);border:1px solid var(--border);border-radius:20px;padding:14px;display:flex;flex-direction:column;gap:10px;box-shadow:0 8px 24px rgba(0,0,0,.05);}
.dbar{display:flex;align-items:center;gap:8px;color:var(--muted);font-size:12px;}
.ddot{width:8px;height:8px;border-radius:999px;background:var(--ok);}
.dsp{flex:1;}
.dchips{display:flex;gap:8px;flex-wrap:wrap;}
.dchip{padding:7px 16px;border-radius:999px;border:1px solid var(--border);background:rgba(255,255,255,.7);color:var(--muted);font-size:13px;min-height:34px;}
.dchip.on{background:var(--ok);border-color:var(--ok);color:#fff;font-weight:600;}
.dchip.dghost{color:var(--text);background:rgba(118,118,128,.14);}
.dmain{display:flex;gap:12px;align-items:center;}
.dgauge{flex:0 1 320px;min-width:220px;}
.dgauge svg{display:block;width:100%;height:auto;}
.dtiles{flex:1 1 auto;display:grid;grid-template-columns:repeat(3,1fr);gap:8px;align-content:start;}
.dtile{background:rgba(255,255,255,.85);border:1px solid var(--border);border-radius:14px;padding:8px 10px;}
.dtile .tn{color:var(--muted);font-size:11px;}
.dtile .tv{font-size:16px;font-family:ui-monospace,Menlo,Consolas,monospace;margin-top:1px;font-weight:600;}
.dtile .tv small{font-size:11px;color:var(--muted);margin-left:3px;font-weight:400;}
.dtile.fail .tv{color:var(--muted);}
.drot{display:none;color:var(--muted);font-size:12px;text-align:center;}
.dstat{color:var(--muted);font-size:12px;word-break:break-all;}
.gtrk{fill:none;stroke:#e5e5ea;stroke-width:14;stroke-linecap:round;}
.gval{fill:none;stroke:var(--ok);stroke-width:14;stroke-linecap:round;transition:stroke-dashoffset .18s ease-out;}
.gpt{fill:var(--ok);stroke:#fff;stroke-width:3;transition:cx .18s ease-out,cy .18s ease-out;}
.gbig{fill:var(--text);font-size:22px;font-weight:700;font-family:ui-monospace,Menlo,Consolas,monospace;}
.gsm{fill:var(--muted);font-size:11px;}
.gtick{fill:var(--muted);font-size:11px;font-family:ui-monospace,Menlo,Consolas,monospace;}
details.card summary{cursor:pointer;font-size:13px;font-weight:600;color:var(--text);}
@media (orientation:portrait){.drot{display:block;}}
@media (max-width:560px){.dmain{flex-direction:column;align-items:stretch;}.dgauge{flex:none;width:100%;max-width:360px;margin:0 auto;}}
.ds.fail{opacity:.4;}
.log{background:rgba(255,255,255,.8);border:1px solid var(--border);border-radius:14px;padding:8px;height:200px;overflow:auto;font:11px/1.65 ui-monospace,Menlo,Consolas,monospace;white-space:pre-wrap;word-break:break-all;}
.presets button{padding:6px 10px;font-size:12px;}
label.hint{display:inline-flex;align-items:center;gap:4px;}
.page[hidden]{display:none;}
.back{width:40px;min-height:40px;padding:0;margin-bottom:8px;border-radius:999px;font-size:20px;line-height:1;}
.pageh{font-size:24px;font-weight:700;margin:0 0 14px;letter-spacing:-.3px;}
.tiles{display:grid;grid-template-columns:1fr 1fr;gap:12px;}
.tile{background:var(--panel);border:1px solid var(--border);border-radius:22px;padding:16px;cursor:pointer;box-shadow:0 4px 16px rgba(0,0,0,.05);transition:transform .12s ease;}
.tile:active{border-color:var(--acc);transform:scale(.97);}
.tile .tico{width:44px;height:44px;border-radius:12px;display:flex;align-items:center;justify-content:center;font-size:22px;background:rgba(0,122,255,.12);}
.tico.c-blue{background:rgba(0,122,255,.12);}
.tico.c-green{background:rgba(52,199,89,.14);}
.tico.c-orange{background:rgba(255,149,0,.14);}
.tico.c-red{background:rgba(255,59,48,.12);}
.tico.c-purple{background:rgba(175,82,222,.12);}
.tico.c-teal{background:rgba(90,200,250,.18);}
.tico.c-gray{background:rgba(118,118,128,.14);}
.tico.c-indigo{background:rgba(88,86,214,.12);}
.tile .tt{font-size:16px;font-weight:700;margin-top:10px;letter-spacing:-.2px;}
.tile .ts{font-size:11px;color:var(--muted);margin-top:2px;}
button.big{width:100%;min-height:48px;font-size:15px;font-weight:600;margin-top:8px;border-radius:14px;}
.chips{display:flex;gap:8px;flex-wrap:wrap;margin-top:4px;}
.chip{background:rgba(255,255,255,.8);border:1px solid var(--border);border-radius:999px;padding:9px 14px;font-size:13px;color:var(--text);}
.chip:active{border-color:var(--acc);}
.status{background:rgba(255,255,255,.8);border:1px solid var(--border);border-radius:12px;padding:10px;font-size:13px;margin-top:8px;}
.udsout{height:110px;margin-top:6px;}
</style>
</head>
<body>
<header>
  <span class="hbrand">极核自主诊断</span>
  <span id="blePill" class="pill">蓝牙未知</span>
</header>
<main>

  <!-- ===== 首页 ===== -->
  <div class="page" id="page-home">
    <section class="card">
      <h2>连接设备</h2>
      <button id="btnAuto" class="big green">一键连接（自动搜索 8 秒）</button>
      <div class="row">
        <button id="btnScan" class="ghost">扫描设备列表</button>
        <button id="btnStop" class="ghost">停止扫描</button>
        <button id="btnDis" class="ghost">断开</button>
        <input id="flt" placeholder="名称过滤" style="display:none"/>
      </div>
      <div id="devStatus" class="devstatus">未扫描：点「扫描设备列表」搜索 BLE / SPP 诊断模块</div>
      <div id="devList" class="devlist"></div>
      <div id="svcInfo" class="hint">未连接</div>
      <div class="hint">支持经典蓝牙 SPP 串口模块、BLE 透传模块（I6328A-485）与 ESP32-CAN 桥。SPP 模块先在系统蓝牙里配对（0000/1234），扫描时会自动出现在列表；点下方功能格进入对应功能。</div>
      <div class="hint">本项目由 cluck798 的 zeeho-diag 改编（GitHub），感谢原作者开源。</div>
    </section>
    <div class="tiles">
      <div class="tile" data-nav="data"><div class="tico c-blue">📊</div><div class="tt">看数据流</div><div class="ts">横屏仪表盘</div></div>
      <div class="tile" data-nav="abs"><div class="tico c-red">🛑</div><div class="tt">ABS 排气</div><div class="ts">换刹车油、排空气</div></div>
      <div class="tile" data-nav="tpms"><div class="tico c-orange">🛞</div><div class="tt">胎压传感器</div><div class="ts">匹配 / 读 ID</div></div>
      <div class="tile" data-nav="nfc"><div class="tico c-purple">🔑</div><div class="tt">NFC 卡</div><div class="ts">学卡 / 删卡</div></div>
      <div class="tile" data-nav="more"><div class="tico c-gray">🧰</div><div class="tt">更多功能</div><div class="ts">初始化 / 整车</div></div>
      <div class="tile" data-nav="wifi"><div class="tico c-teal">📶</div><div class="tt">WiFi 直连</div><div class="ts">车辆信息 / 故障码</div></div>
      <div class="tile" data-nav="adv"><div class="tico c-indigo">⚙️</div><div class="tt">高级工具</div><div class="ts">原始帧 / 日志</div></div>
    </div>
  </div>

  <!-- ===== 看数据流（横屏仪表盘） ===== -->
  <div class="page" id="page-data" hidden>
    <button class="back ghost" data-nav="home">‹</button>
    <h2 class="pageh">看数据流</h2>
    <div class="dash">
      <div class="dbar"><span class="ddot"></span>485 线路<span class="dsp"></span><span id="dashTs">等待数据</span></div>
      <div class="dchips">
        <button class="dchip on" data-dash="car">整车</button>
        <button class="dchip" data-dash="batt">电池</button>
        <button class="dchip" data-dash="motor">电机</button>
        <button class="dchip dghost" id="btnDashRead">↻ 读取</button>
      </div>
      <div class="dmain">
        <div class="dgauge">
          <svg viewBox="0 0 360 268" aria-label="数据仪表盘">
            <path class="gtrk" d="M 84.7 245 A 110 110 0 1 1 275.3 245"></path>
            <path class="gval" id="dashProg" d="M 84.7 245 A 110 110 0 1 1 275.3 245" stroke-dasharray="460.8" stroke-dashoffset="460.8"></path>
            <circle class="gpt" id="dashPnt" cx="84.7" cy="245" r="7"></circle>
            <text class="gbig" id="dashVal" x="180" y="176" text-anchor="middle">—</text>
            <text class="gsm" id="dashUnit" x="180" y="198" text-anchor="middle">km/h</text>
            <text class="gtick" id="dtk0" x="66" y="259" text-anchor="middle">0</text>
            <text class="gtick" id="dtk1" x="54.5" y="153" text-anchor="middle">20</text>
            <text class="gtick" id="dtk2" x="126.3" y="73" text-anchor="middle">40</text>
            <text class="gtick" id="dtk3" x="233.7" y="73" text-anchor="middle">60</text>
            <text class="gtick" id="dtk4" x="305.5" y="153" text-anchor="middle">80</text>
            <text class="gtick" id="dtk5" x="294.3" y="259" text-anchor="middle">100</text>
          </svg>
        </div>
        <div class="dtiles" id="dashTiles"></div>
      </div>
      <div class="drot">🔄 手机横屏查看，数据更齐全</div>
      <div class="dstat" id="dashMsg">点「整车 / 电池 / 电机」自动发送读取命令（需先在「蓝牙连接」页连好模块）</div>
    </div>
    <details class="card">
      <summary>全部数据项列表 / 手动读取（含读 VIN）</summary>
      <div class="chips" style="margin:8px 0">
        <button class="chip" data-sys="51">🔋 电池</button>
        <button class="chip" data-sys="59">⚡ 电机</button>
        <button class="chip" data-sys="81">🧭 仪表整车</button>
        <button class="chip" data-sys="49">📟 计量器</button>
        <button class="chip" data-sys="89">📡 TBOX</button>
        <button class="chip" data-sys="8B">📶 后雷达</button>
        <button class="chip" id="btnVin">🔍 读 VIN</button>
      </div>
      <label class="hint"><input type="checkbox" id="chkFixedLen" checked style="flex:none;min-width:auto"/> 定长帧 71 字节（4346|系统|40|64字节负载|校验|4544）——车端只认完整帧；取消勾选可发短帧做对照测试</label>
      <div class="status" id="dataStatus">若数值大多显示"—"，先确认已连接模块，再检查下面收发日志里有没有 RX 行。</div>
      <div class="status" id="rxStat">链路模式与接收统计显示在这里（连上模块后自动刷新）。</div>
      <div id="dsGrid" class="grid"></div>
      <div class="row">
        <select id="pSys" style="display:none"></select>
        <button id="btnParse" class="ghost">重新解析最近响应</button>
      </div>
    </details>
  </div>

  <!-- ===== ABS 排气 ===== -->
  <div class="page" id="page-abs" hidden>
    <button class="back ghost" data-nav="home">‹</button>
    <h2 class="pageh">ABS 排气</h2>
    <section class="card">
      <div class="status" id="absStatus">尚未开始。排气时请配合放气螺丝按维修流程操作。</div>
      <div class="row">
        <select id="canIdSel">
          <option value="7E1">ABS 控制器（0x7E1）</option>
          <option value="714">ABS 控制器（0x714）</option>
        </select>
      </div>
      <button id="btnAbsFlow" class="big green">▶ 开始一键排气（泵循环 10 秒）</button>
      <div class="row"><button id="btnAbsStop" class="ghost">停止</button></div>
      <div class="hint">流程：进入会话 → 开前轮阀 → 开泵（10 秒）→ 关泵 → 关阀 → 清码 → 退会话。结束后务必关闭放气螺丝、补足刹车油并低速路试刹车。</div>
    </section>
    <section class="card">
      <h2>手动控制（泵 / 阀 / 清码）</h2>
      <div class="row presets" id="absPanel"></div>
    </section>
    <section class="card">
      <h2>响应</h2>
      <div class="log udsout"></div>
    </section>
  </div>

  <!-- ===== 胎压传感器 ===== -->
  <div class="page" id="page-tpms" hidden>
    <button class="back ghost" data-nav="home">‹</button>
    <h2 class="pageh">胎压传感器</h2>
    <section class="card">
      <div class="row"><button id="btnTpmsRead" class="ghost">读取传感器 ID</button></div>
      <button id="btnTpmsFront" class="big">前轮：开始匹配</button>
      <button id="btnTpmsRear" class="big">后轮：开始匹配</button>
      <div class="row"><button id="btnTpmsStop" class="ghost">停止例程（异常时）</button></div>
      <div class="hint">更换胎压传感器后执行：点「开始匹配」→ 保持传感器处于激活状态 → 3 秒后自动查询结果。</div>
    </section>
    <section class="card">
      <h2>匹配结果</h2>
      <div class="log udsout"></div>
    </section>
  </div>

  <!-- ===== NFC 卡 ===== -->
  <div class="page" id="page-nfc" hidden>
    <button class="back ghost" data-nav="home">‹</button>
    <h2 class="pageh">NFC 钥匙卡</h2>
    <section class="card">
      <h2>操作</h2>
      <div class="row">
        <button id="btnNfcInit" class="ghost">① 初始化</button>
        <button id="btnNfcCmd" class="green">② 发送操作命令</button>
      </div>
      <input id="nfcRaw" placeholder="操作命令（默认学卡码 3900）" value="3900"/>
      <div class="row">
        <input id="nfcSys" placeholder="系统码" value="89" style="max-width:110px"/>
        <label class="hint"><input type="checkbox" id="chkNfcRaw" style="flex:none;min-width:auto"/> 原样发送（不成帧，仅用于对照）</label>
      </div>
      <div class="row">
        <button id="btnNfcLearn" class="big green">③ 一键学卡（3900 → 0D0100 → 放卡 → 0D0103）</button>
      </div>
      <div class="row"><button id="btnNfcDelete" class="ghost">一键删卡（3A00 → 0D010103，清除全部卡）</button></div>
      <div class="status" id="nfcStatus">流程：先点「初始化」，再点「一键学卡」，中途把新卡贴近车辆 NFC 区域。操作码现在会按定长帧成帧后发送。</div>
    </section>
    <section class="card">
      <h2>响应</h2>
      <div class="log udsout"></div>
    </section>
  </div>

  <!-- ===== 更多功能 ===== -->
  <div class="page" id="page-more" hidden>
    <button class="back ghost" data-nav="home">‹</button>
    <h2 class="pageh">更多功能</h2>
    <section class="card">
      <h2>RS485（I6328A 模块）</h2>
      <div class="row">
        <button id="btnSpeInit" class="ghost">初始化（Cmd01/02/03）</button>
        <button id="btnSpeTpms">胎压匹配（RS485 通道）</button>
      </div>
      <div class="hint" id="speTip"></div>
    </section>
  </div>

  <!-- ===== WiFi 直连 ===== -->
  <div class="page" id="page-wifi" hidden>
    <button class="back ghost" data-nav="home">‹</button>
    <h2 class="pageh">WiFi 直连（DoIP 无线诊断）</h2>
    <section class="card">
      <h2>连接车辆热点</h2>
      <div class="status" id="wifiStatus">① 先把手机连上车辆热点（ZEEHO- 开头；密码为 VIN 末 8 位）→ ② 点「连接」。连不上就先点「网络自检」。建议关闭「设置→蜂窝网络→无线局域网助理」，防止连接被切走。</div>
      <div class="row">
        <input id="wifiHost" value="192.168.49.1"/>
        <input id="wifiPort" value="13400" style="max-width:90px"/>
      </div>
      <div class="row">
        <button id="btnWifiConn" class="green">连接</button>
        <button id="btnWifiDisc" class="ghost">断开</button>
      </div>
      <div class="row">
        <button id="btnWifiScan" class="ghost">🔍 网络自检</button>
        <button id="btnWifiPortScan" class="ghost">🛰 端口扫描</button>
      </div>
      <div class="log" id="wifiScanOut" style="height:130px"></div>
    </section>
    <section class="card">
      <h2>车辆信息与故障码</h2>
      <button id="btnWifiInfo" class="big green">读取车辆信息</button>
      <div class="row">
        <button id="btnWifiDtc" class="ghost">读故障码</button>
        <button id="btnWifiClear" class="ghost">清除故障码</button>
      </div>
      <div class="hint">「清除故障码」为写操作——请先确认故障已排除再执行。</div>
      <div id="wifiGrid" class="grid"></div>
      <div class="log udsout"></div>
    </section>
  </div>

  <!-- ===== 高级工具 ===== -->
  <div class="page" id="page-adv" hidden>
    <button class="back ghost" data-nav="home">‹</button>
    <h2 class="pageh">高级工具</h2>
    <section class="card">
      <h2>链路模式</h2>
      <div class="row">
        <select id="linkSel">
          <option value="rs485">RS485（I6328A-485）</option>
          <option value="can">CAN（ESP32 ZEEHO-CAN）</option>
        </select>
        <span class="hint">连接时按设备名自动识别；如识别错误可在此手动切换</span>
      </div>
    </section>
    <section class="card">
      <h2>官方诊断仪（实验 · 巨魔私有 API）</h2>
      <div class="row">
        <button id="btnVciProbe" class="ghost">① 检测私有框架</button>
        <button id="btnVciPaired" class="ghost">② 列出已配对设备</button>
      </div>
      <div class="hint">官方诊断仪为蓝牙经典（SPP）设备。先点①：将检测 iOS 私有蓝牙框架能否加载、是否含 RFCOMM/通道相关方法；再点②列出系统已配对设备（诊断仪应出现在其中）。把结果发给开发者即可。<b>【实验版本 v2——若看不到 v2 字样说明 App 未更新】</b></div>
      <div class="log" id="vciOut" style="height:170px"></div>
    </section>
    <section class="card">
      <h2>RS485 原始帧</h2>
      <div class="row">
        <select id="sysSel">
          <option value="51">51 BMS 电池</option>
          <option value="59">59 MCU 电机</option>
          <option value="49">49 计量器</option>
          <option value="81">81 仪表/整车</option>
          <option value="89">89 TBOX/配置</option>
          <option value="8B">8B 后雷达</option>
          <option value="80">80 VIN直读</option>
        </select>
        <input id="payload" placeholder="payload hex（可空）"/>
        <button id="btnBuild" class="ghost">生成帧</button>
      </div>
      <div class="row">
        <input id="frame" placeholder="完整帧 hex"/>
        <button id="btnSend" class="green">发送</button>
      </div>
      <div class="hint">帧格式：4346 | 系统码 | 40 | 64字节负载（不足自动补0） | 校验 | 4544 —— 共 71 字节定长帧，校验自动计算</div>
    </section>
    <section class="card">
      <h2>CAN 手动 UDS</h2>
      <div class="row">
        <input id="canUds" placeholder="UDS hex（如 22F190 / 1003）"/>
        <button id="btnCanSend" class="green">发送</button>
      </div>
      <div class="hint">自动 ISO-TP 封装（单帧/多帧）；响应解读见各功能页</div>
    </section>
    <section class="card">
      <h2>诊断日志文件</h2>
      <div class="row">
        <button id="btnLogShare" class="big green">📄 分享 / 导出日志文件</button>
      </div>
      <div class="row">
        <button id="btnLogInfo" class="ghost">刷新日志信息</button>
        <button id="btnLogClear" class="ghost">清空日志</button>
      </div>
      <div class="status" id="logInfo">所有 TX / RX / 蓝牙事件 / 组帧与告警都已写入日志文件，出问题时点「分享 / 导出」把文件发出来即可，不用手抄屏幕。</div>
    </section>
    <section class="card">
      <h2>收发日志</h2>
      <div class="row">
        <button id="btnClr" class="ghost">清空</button>
        <label class="hint"><input type="checkbox" id="chkAscii" checked style="flex:none;min-width:auto"/> 显示ASCII</label>
      </div>
      <div id="log" class="log"></div>
    </section>
  </div>

</main>
<script>
${DATA_JS}
${LOGIC_JS}
</script>
</body>
</html>
`;

// 同时写入 iOS 与安卓两份，避免两边 diag.html 长期漂移
const outPaths = [
  path.join(__dirname, '..', 'ios', 'App', 'Resources', 'diag.html'),
  path.join(__dirname, '..', 'android', 'app', 'src', 'main', 'assets', 'diag.html')
];
outPaths.forEach(function (p) {
  fs.writeFileSync(p, html, 'utf8');
  console.log('written ' + p + ', size=' + html.length + ' bytes, items=' + compact.length);
});
