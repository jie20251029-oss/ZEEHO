package com.zeeho.diag;

import android.Manifest;
import android.bluetooth.BluetoothAdapter;
import android.bluetooth.BluetoothDevice;
import android.bluetooth.BluetoothGatt;
import android.bluetooth.BluetoothGattCallback;
import android.bluetooth.BluetoothGattCharacteristic;
import android.bluetooth.BluetoothGattDescriptor;
import android.bluetooth.BluetoothGattService;
import android.bluetooth.BluetoothManager;
import android.bluetooth.BluetoothProfile;
import android.bluetooth.BluetoothSocket;
import android.bluetooth.le.BluetoothLeScanner;
import android.bluetooth.le.ScanCallback;
import android.bluetooth.le.ScanRecord;
import android.bluetooth.le.ScanResult;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.pm.PackageManager;
import android.location.LocationManager;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.bluetooth.le.ScanSettings;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * BleBridge — 双链路蓝牙桥（连接方案参照 APT Dash 官方 App 的成功实践）：
 * ① BLE GATT（FFE0 服务，写通道 FFE1/FF01/FF00/FFE5，通知 FFE2/FF01…）：
 *    3 次重试（第 3 次 autoConnect）、20s 超时、MTU 协商 3s 兜底订阅、
 *    写入遇配对要求（status 19/137）自动 createBond；
 * ② 经典蓝牙 SPP（RFCOMM 串口）：HC-05/JDY/6328 等透传模块。
 * 事件推页面 window.__r485Event；页面轮询 scanState 获取完整状态（不依赖事件）。
 */
public class BleBridge {

    private static final UUID CCCD_UUID = UUID.fromString("00002902-0000-1000-8000-00805f9b34fb");
    private static final UUID SPP_UUID = UUID.fromString("00001101-0000-1000-8000-00805f9b34fb");
    private static final long CONNECT_TIMEOUT_MS = 20000;
    private static final int MAX_ATTEMPTS = 3;
    private static final String[] WRITE_PREF = {"ffe1", "ff01", "ff00", "ffe5"};
    private static final String[] NOTIFY_PREF = {"ffe2", "ff01", "ff00", "ffe5"};

    private final MainActivity activity;
    private final BluetoothManager manager;
    private final BluetoothAdapter adapter;
    private final Handler main = new Handler(Looper.getMainLooper());
    private final ExecutorService pool = Executors.newSingleThreadExecutor();

    private BluetoothGatt gatt;
    private BluetoothGattCharacteristic writeChar;
    private BluetoothGattCharacteristic notifyChar;
    private int mtu = 0;
    private String scanFilter = null;
    private volatile boolean scanning = false;
    private volatile boolean discovering = false;
    private Runnable gattWatchdogTask;
    private volatile boolean linkConnected = false;
    private volatile String linkName = "";
    private volatile String linkKind = "";

    // APT 式连接状态机
    private int connectAttempts = 0;
    private boolean everConnected = false;
    private boolean wantGattConnect = false;
    private boolean subscribed = false;
    private BluetoothDevice pendingGattDevice;
    private boolean pendingFallbackSpp = false;
    private Runnable connectTimeoutTask;
    private Runnable retryTask;
    private Runnable mtuFallbackTask;
    private byte[] lastWriteBytes;

    private volatile BluetoothSocket classicSocket;

    private final Map<String, JSONObject> discovered = new HashMap<>();
    private final List<String> discoveredOrder = new ArrayList<>();
    private final Map<String, Long> lastEmitAt = new HashMap<>();
    private final Map<String, String> lastKind = new HashMap<>();
    private final Set<String> bleSeen = new HashSet<>();
    private final Set<String> sppSeen = new HashSet<>();
    private int bondedCount = 0;

    /** 扫描 12 秒自动停止（避免列表无限刷新） */
    private final Runnable scanAutoStop = new Runnable() {
        @Override
        public void run() {
            stopScan();
            main.postDelayed(new Runnable() {
                @Override
                public void run() {
                    stopScan();
                }
            }, 500);
        }
    };

    public BleBridge(MainActivity activity) {
        this.activity = activity;
        this.manager = (BluetoothManager) activity.getSystemService(Context.BLUETOOTH_SERVICE);
        this.adapter = manager != null ? manager.getAdapter() : null;

        IntentFilter f = new IntentFilter(BluetoothAdapter.ACTION_STATE_CHANGED);
        activity.registerReceiver(stateReceiver, f);
        IntentFilter f2 = new IntentFilter();
        f2.addAction(BluetoothDevice.ACTION_FOUND);
        f2.addAction(BluetoothAdapter.ACTION_DISCOVERY_FINISHED);
        activity.registerReceiver(discoveryReceiver, f2);
    }

    // ---------------- 蓝牙开关状态 ----------------
    private final BroadcastReceiver stateReceiver = new BroadcastReceiver() {
        @Override
        public void onReceive(Context context, Intent intent) {
            if (BluetoothAdapter.ACTION_STATE_CHANGED.equals(intent.getAction())) {
                int st = intent.getIntExtra(BluetoothAdapter.EXTRA_STATE, BluetoothAdapter.ERROR);
                String name = stateName(st);
                if (name != null) {
                    emit(put(evt("state"), "state", name));
                }
            }
        }
    };

    private static String stateName(int st) {
        switch (st) {
            case BluetoothAdapter.STATE_ON: return "poweredOn";
            case BluetoothAdapter.STATE_OFF: return "poweredOff";
            case BluetoothAdapter.STATE_TURNING_ON:
            case BluetoothAdapter.STATE_TURNING_OFF: return "resetting";
            default: return null;
        }
    }

    public JSONObject state() {
        String st = "unknown";
        if (adapter != null) {
            String n = stateName(adapter.getState());
            if (n != null) st = n;
        }
        return put(evt("state"), "state", st);
    }

    /** 页面加载后自检：推送蓝牙状态 + 权限/开关问题 */
    public void announceState() {
        emit(state());
        if (adapter == null) {
            emitError("设备不支持蓝牙");
            return;
        }
        if (!adapter.isEnabled()) {
            emitError("蓝牙未开启：请先打开系统蓝牙");
            return;
        }
        if (!hasScanPermission()) {
            emitError("未授予蓝牙权限：请在系统设置中允许「附近的设备」");
            return;
        }
        if (!hasLocPermission()) {
            emitError("未授予定位权限：BLE 扫描需要定位权限（不会读取你的位置），请在系统设置中允许");
            return;
        }
        if (!isLocationEnabled()) {
            emitError("定位服务未开启：请在系统设置中打开「定位」开关后重试（仅用于蓝牙扫描）");
        }
    }

    /** 轮询用完整状态快照（走命令回包通道，不依赖事件推送） */
    public JSONObject scanState() {
        JSONObject o = new JSONObject();
        try {
            o.put("scanning", scanning);
            o.put("discovering", discovering);
            o.put("bleSeen", bleSeen.size());
            o.put("sppSeen", sppSeen.size());
            o.put("bonded", bondedCount);
            o.put("connected", linkConnected);
            o.put("linkName", linkName == null ? "" : linkName);
            o.put("linkKind", linkKind == null ? "" : linkKind);
            o.put("locGranted", hasLocPermission());
            o.put("locEnabled", isLocationEnabled());
            JSONArray arr = new JSONArray();
            synchronized (discovered) {
                for (String addr : discoveredOrder) {
                    JSONObject d = discovered.get(addr);
                    if (d != null) arr.put(d);
                }
            }
            o.put("devices", arr);
        } catch (JSONException ignored) {
        }
        return o;
    }

    // ---------------- 扫描（BLE + 经典蓝牙 SPP 同时扫） ----------------
    public void scan(String filter) {
        if (!hasScanPermission()) {
            emitError("缺少蓝牙权限，请在系统设置中授权后重试");
            return;
        }
        if (!hasLocPermission()) {
            emitError("未授予定位权限：BLE 扫描需要定位权限（不会读取你的位置），请在系统设置中允许");
            return;
        }
        if (!isLocationEnabled()) {
            emitError("定位服务未开启：请在系统设置中打开「定位」开关后重试（仅用于蓝牙扫描）");
            return;
        }
        if (adapter == null || !adapter.isEnabled()) {
            emitError("蓝牙不可用：" + (adapter == null ? "unsupported" : "未开启"));
            return;
        }
        scanFilter = (filter == null || filter.isEmpty()) ? null : filter;
        discovered.clear();
        discoveredOrder.clear();
        lastEmitAt.clear();
        lastKind.clear();
        bleSeen.clear();
        sppSeen.clear();

        // ① 已配对设备直接列出
        bondedCount = 0;
        try {
            Set<BluetoothDevice> bonded = adapter.getBondedDevices();
            if (bonded != null) {
                for (BluetoothDevice d : bonded) {
                    String addr = d.getAddress();
                    sppSeen.add(addr);
                    bondedCount++;
                    emitDevice(addr, safeName(d), -80);
                }
            }
        } catch (SecurityException ignored) {
        }

        // ② BLE 扫描 —— 主线程启动 + 低延迟扫描模式（提高发现率）
        try {
            BluetoothLeScanner sc = adapter.getBluetoothLeScanner();
            if (sc == null) {
                emitError("设备不支持 BLE 扫描");
            } else {
                ScanSettings settings = new ScanSettings.Builder()
                        .setScanMode(ScanSettings.SCAN_MODE_LOW_LATENCY)
                        .build();
                sc.startScan(null, settings, scanCallback);
                scanning = true;
            }
        } catch (SecurityException e) {
            emitError("BLE 扫描失败：权限被拒");
        }

        main.removeCallbacks(scanAutoStop);
        main.postDelayed(scanAutoStop, 12000);
        emit(evt("scanStarted"));
    }

    public void stopScan() {
        main.removeCallbacks(scanAutoStop);
        if (discovering) {
            discovering = false;
            try {
                adapter.cancelDiscovery();
            } catch (Exception ignored) {
            }
        }
        if (scanning) {
            scanning = false;
            try {
                adapter.getBluetoothLeScanner().stopScan(scanCallback);
            } catch (Exception ignored) {
            }
        }
        emitScanStopped();
    }

    private long lastStopEmitAt = 0;

    private void emitScanStopped() {
        long now = System.currentTimeMillis();
        if (now - lastStopEmitAt < 1000) return;
        lastStopEmitAt = now;
        emit(evt("scanStopped"));
        JSONObject stats = put(evt("scanStats"), "ble", bleSeen.size());
        put(stats, "spp", sppSeen.size());
        put(stats, "bonded", bondedCount);
        emit(stats);
    }

    private final BroadcastReceiver discoveryReceiver = new BroadcastReceiver() {
        @Override
        public void onReceive(Context context, Intent intent) {
            String action = intent.getAction();
            if (BluetoothDevice.ACTION_FOUND.equals(action)) {
                BluetoothDevice d = intent.getParcelableExtra(BluetoothDevice.EXTRA_DEVICE);
                if (d == null) return;
                String name = safeName(d);
                if (scanFilter != null && !scanFilter.isEmpty()
                        && !name.toLowerCase().contains(scanFilter.toLowerCase())) {
                    return;
                }
                String addr = d.getAddress();
                sppSeen.add(addr);
                int rssi = intent.getShortExtra(BluetoothDevice.EXTRA_RSSI, Short.MIN_VALUE);
                emitDevice(addr, name, rssi == Short.MIN_VALUE ? -100 : rssi);
            } else if (BluetoothAdapter.ACTION_DISCOVERY_FINISHED.equals(action)) {
                if (discovering) {
                    discovering = false;
                    emitScanStopped();
                }
            }
        }
    };

    private final ScanCallback scanCallback = new ScanCallback() {
        @Override
        public void onScanResult(int callbackType, ScanResult result) {
            BluetoothDevice d = result.getDevice();
            if (d == null) return;
            String name = d.getName();
            if (name == null || name.isEmpty()) {
                ScanRecord rec = result.getScanRecord();
                if (rec != null && rec.getDeviceName() != null) name = rec.getDeviceName();
            }
            if (name == null || name.isEmpty()) name = "(未命名)";
            if (scanFilter != null && !scanFilter.isEmpty() && !name.toLowerCase().contains(scanFilter.toLowerCase())) {
                return;
            }
            String addr = d.getAddress();
            bleSeen.add(addr);
            emitDevice(addr, name, result.getRssi());
        }

        @Override
        public void onScanFailed(int errorCode) {
            scanning = false;
            emitError("BLE 扫描失败（code=" + errorCode + "），经典蓝牙扫描仍可能可用");
        }
    };

    private void emitDevice(String addr, String name, int rssi) {
        String kind = kindOf(addr);
        JSONObject info = put(evt("device"), "id", addr);
        put(info, "name", name);
        put(info, "rssi", rssi);
        put(info, "kind", kind);
        if (!discovered.containsKey(addr)) discoveredOrder.add(addr);
        discovered.put(addr, info);
        String prev = lastKind.get(addr);
        long now = System.currentTimeMillis();
        Long last = lastEmitAt.get(addr);
        if (kind.equals(prev) && last != null && now - last < 2000) {
            return;
        }
        lastKind.put(addr, kind);
        lastEmitAt.put(addr, now);
        emit(info);
    }

    private String kindOf(String addr) {
        boolean ble = bleSeen.contains(addr);
        boolean spp = sppSeen.contains(addr);
        if (ble && spp) return "dual";
        if (spp) return "spp";
        return "ble";
    }

    private String safeName(BluetoothDevice d) {
        try {
            String n = d.getName();
            if (n != null && !n.isEmpty()) return n;
        } catch (SecurityException ignored) {
        }
        return "(未命名)";
    }

    // ---------------- 连接（双模 BLE 优先，超时回退 SPP；APT 式重试） ----------------
    public void connect(String address) {
        stopScanQuiet();
        if (adapter == null || !adapter.isEnabled()) {
            emitError("蓝牙不可用：" + (adapter == null ? "unsupported" : "未开启"));
            return;
        }
        final BluetoothDevice d = adapter.getRemoteDevice(address);
        if (d == null) {
            emitError("找不到设备（请先扫描）");
            return;
        }
        final String kind = kindOf(address);
        // 扫描停止后稍等 450ms 再连（官方 App 同款做法，避免扫描/连接竞争）
        main.postDelayed(new Runnable() {
            @Override
            public void run() {
                if ("spp".equals(kind)) {
                    connectSpp(d);
                } else {
                    connectGatt(d, "dual".equals(kind));
                }
            }
        }, 450);
    }

    // ---- 经典蓝牙 SPP ----
    private void connectSpp(final BluetoothDevice d) {
        cancelGattState();
        final String addr = d.getAddress();
        final String name = safeName(d);
        JSONObject o = put(evt("connecting"), "id", addr);
        put(o, "name", name);
        emit(o);

        pool.execute(new Runnable() {
            @Override
            public void run() {
                BluetoothSocket sock = trySppSocket(d);
                if (sock == null) {
                    emitError("SPP 连接失败：请先到系统蓝牙设置里配对该模块（密码常为 0000/1234），并确认模块未被其他设备占用");
                    return;
                }
                final BluetoothSocket s = sock;
                classicSocket = s;
                linkConnected = true;
                linkName = name;
                linkKind = "spp";
                JSONObject oc = put(evt("connected"), "id", addr);
                put(oc, "name", name);
                emit(oc);
                JSONObject r = put(evt("ready"), "write", "RFCOMM");
                put(r, "notify", "RFCOMM");
                put(r, "ok", true);
                emit(r);

                try {
                    InputStream in = s.getInputStream();
                    byte[] buf = new byte[4096];
                    int n;
                    while ((n = in.read(buf)) != -1) {
                        JSONObject od = put(evt("data"), "hex", bytesToHex(buf, n));
                        put(od, "len", n);
                        emit(od);
                    }
                } catch (IOException ignored) {
                }
                if (classicSocket == s) {
                    classicSocket = null;
                    linkConnected = false;
                    linkName = "";
                    linkKind = "";
                    emit(evt("disconnected"));
                }
                closeQuiet(s);
            }
        });
    }

    private BluetoothSocket trySppSocket(BluetoothDevice d) {
        BluetoothSocket sock = null;
        try {
            sock = d.createRfcommSocketToServiceRecord(SPP_UUID);
            sock.connect();
            return sock;
        } catch (Exception e) {
            closeQuiet(sock);
        }
        try {
            java.lang.reflect.Method m = d.getClass().getMethod("createRfcommSocket", int.class);
            sock = (BluetoothSocket) m.invoke(d, 1);
            sock.connect();
            return sock;
        } catch (Exception e) {
            closeQuiet(sock);
        }
        return null;
    }

    // ---- BLE GATT（APT 式：3 次重试 / 20s 超时 / 第 3 次 autoConnect） ----
    private void connectGatt(BluetoothDevice d, boolean fallbackSpp) {
        wantGattConnect = true;
        pendingGattDevice = d;
        pendingFallbackSpp = fallbackSpp;
        connectAttempts = 0;
        everConnected = false;
        subscribed = false;
        connectGattNow(d, fallbackSpp);
    }

    private void connectGattNow(BluetoothDevice d, final boolean fallbackSpp) {
        cancelConnectTimeout();
        if (gatt != null) {
            try {
                gatt.disconnect();
                gatt.close();
            } catch (Exception ignored) {
            }
            gatt = null;
        }
        String name = safeName(d);
        JSONObject o = put(evt("connecting"), "id", d.getAddress());
        put(o, "name", name);
        put(o, "attempt", connectAttempts + 1);
        emit(o);
        try {
            boolean auto = connectAttempts >= 2; // 第 3 次用后台自动连接（官方 App 同款）
            final BluetoothGatt g = d.connectGatt(activity, auto, gattCallback, BluetoothDevice.TRANSPORT_LE);
            gatt = g;
            if (g == null) {
                emitError("connectGatt 返回 null，连接失败");
                return;
            }
            connectAttempts++;
            connectTimeoutTask = new Runnable() {
                @Override
                public void run() {
                    if (gatt != g || everConnected || isGattConnected()) return;
                    maybeRetry(0);
                }
            };
            main.postDelayed(connectTimeoutTask, CONNECT_TIMEOUT_MS);
        } catch (SecurityException e) {
            emitError("连接失败：缺少蓝牙权限");
        }
    }

    private boolean isGattConnected() {
        try {
            return gatt != null && gatt.getDevice() != null
                    && gatt.getConnectionState(gatt.getDevice()) == BluetoothProfile.STATE_CONNECTED;
        } catch (Exception e) {
            return false;
        }
    }

    private void maybeRetry(int status) {
        if (!wantGattConnect) return;
        if (connectAttempts < MAX_ATTEMPTS) {
            emitError("连接未成功(" + statusText(status) + ")，1.5 秒后重试（第 " + (connectAttempts + 1) + "/3 次）…");
            retryTask = new Runnable() {
                @Override
                public void run() {
                    if (pendingGattDevice != null) {
                        connectGattNow(pendingGattDevice, pendingFallbackSpp);
                    }
                }
            };
            main.postDelayed(retryTask, 1500);
            return;
        }
        wantGattConnect = false;
        cancelConnectTimeout();
        if (pendingFallbackSpp) {
            emitError("BLE 多次连接失败，自动尝试 SPP 通道…");
            connectSpp(pendingGattDevice);
        } else {
            emitError("连接失败:" + statusText(status) + "。可能原因:设备被其他 App 占用(先关掉其他诊断 App)、超出范围、或需要配对");
        }
    }

    private static String statusText(int s) {
        switch (s) {
            case 0: return "超时";
            case 19: return "需要配对加密(status 19)";
            case 22: return "设备无响应,可能已关机/超范围(status 22)";
            case 62: return "建立连接失败(status 62)";
            case 133: return "GATT 错误(status 133)";
            case 137: return "认证失败(status 137)";
            default: return "status " + s;
        }
    }

    private void cancelConnectTimeout() {
        if (connectTimeoutTask != null) {
            main.removeCallbacks(connectTimeoutTask);
            connectTimeoutTask = null;
        }
        if (retryTask != null) {
            main.removeCallbacks(retryTask);
            retryTask = null;
        }
        if (mtuFallbackTask != null) {
            main.removeCallbacks(mtuFallbackTask);
            mtuFallbackTask = null;
        }
    }

    private void cancelGattState() {
        wantGattConnect = false;
        cancelConnectTimeout();
        if (gatt != null) {
            try {
                gatt.disconnect();
                gatt.close();
            } catch (Exception ignored) {
            }
            gatt = null;
        }
        writeChar = null;
        notifyChar = null;
    }

    public void disconnect() {
        cancelGattState();
        linkConnected = false;
        linkName = "";
        linkKind = "";
        if (classicSocket != null) {
            BluetoothSocket s = classicSocket;
            classicSocket = null;
            closeQuiet(s);
            emit(evt("disconnected"));
        }
    }

    private final BluetoothGattCallback gattCallback = new BluetoothGattCallback() {

        @Override
        public void onConnectionStateChange(BluetoothGatt g, int status, int newState) {
            if (newState == BluetoothProfile.STATE_CONNECTED) {
                everConnected = true;
                cancelConnectTimeout();
                BluetoothDevice d = g.getDevice();
                linkConnected = true;
                linkName = d.getName() == null ? "" : d.getName();
                linkKind = "ble";
                JSONObject o = put(evt("connected"), "id", d.getAddress());
                put(o, "name", linkName);
                emit(o);
                g.discoverServices();
            } else if (newState == BluetoothProfile.STATE_DISCONNECTED) {
                if (!everConnected) {
                    maybeRetry(status);
                    return;
                }
                cancelConnectTimeout();
                linkConnected = false;
                linkName = "";
                linkKind = "";
                writeChar = null;
                notifyChar = null;
                subscribed = false;
                JSONObject o = evt("disconnected");
                put(o, "error", status == BluetoothGatt.GATT_SUCCESS ? "" : statusText(status));
                emit(o);
                try {
                    g.close();
                } catch (Exception ignored) {
                }
            }
        }

        @Override
        public void onServicesDiscovered(BluetoothGatt g, int status) {
            if (status != BluetoothGatt.GATT_SUCCESS) {
                emitError("服务发现失败：code=" + status);
                return;
            }
            pickCharacteristics(g);
            // 官方 App 做法：先请求 MTU，3 秒内无回调也照样订阅
            try {
                g.requestMtu(247);
            } catch (Exception ignored) {
            }
            mtuFallbackTask = new Runnable() {
                @Override
                public void run() {
                    subscribeNow();
                }
            };
            main.postDelayed(mtuFallbackTask, 3000);
        }

        @Override
        public void onMtuChanged(BluetoothGatt g, int m, int status) {
            if (status == BluetoothGatt.GATT_SUCCESS) {
                mtu = m;
            }
            subscribeNow();
        }

        @Override
        public void onDescriptorWrite(BluetoothGatt g, BluetoothGattDescriptor descriptor, int status) {
            emitReady();
        }

        @Override
        public void onCharacteristicChanged(BluetoothGatt g, BluetoothGattCharacteristic c) {
            byte[] v = c.getValue();
            if (v == null || v.length == 0) return;
            JSONObject o = put(evt("data"), "hex", bytesToHex(v));
            put(o, "len", v.length);
            emit(o);
        }

        @Override
        public void onCharacteristicWrite(BluetoothGatt g, BluetoothGattCharacteristic c, int status) {
            if (status == BluetoothGatt.GATT_SUCCESS) return;
            if (status == 19 || status == 137) {
                // 设备要求配对：自动发起配对（官方 App 同款）
                emitError("设备需要配对，正在发起配对…（若弹出配对框请输入 0000 或 1234）");
                try {
                    BluetoothDevice d = g.getDevice();
                    if (d != null && d.getBondState() != BluetoothDevice.BOND_BONDED) {
                        d.createBond();
                    }
                } catch (Exception ignored) {
                }
                if (lastWriteBytes != null) {
                    final byte[] retry = lastWriteBytes;
                    main.postDelayed(new Runnable() {
                        @Override
                        public void run() {
                            if (isGattConnected()) {
                                writeGatt(retry);
                            }
                        }
                    }, 5000);
                }
                return;
            }
            emitError("写入失败(" + statusText(status) + ")");
        }
    };

    /** 特征选择：优先 FFE1/FF01/FF00/FFE5（写）、FFE2/FF01…（通知），再回退第一个可用 */
    private void pickCharacteristics(BluetoothGatt g) {
        BluetoothGattCharacteristic w = null;
        BluetoothGattCharacteristic n = null;
        List<BluetoothGattService> services = g.getServices();
        for (String pref : WRITE_PREF) {
            if (w != null) break;
            for (BluetoothGattService s : services) {
                for (BluetoothGattCharacteristic c : s.getCharacteristics()) {
                    int props = c.getProperties();
                    boolean writable = (props & (BluetoothGattCharacteristic.PROPERTY_WRITE
                            | BluetoothGattCharacteristic.PROPERTY_WRITE_NO_RESPONSE)) != 0;
                    if (writable && c.getUuid().toString().toLowerCase().contains(pref)) {
                        w = c;
                        break;
                    }
                }
            }
        }
        for (String pref : NOTIFY_PREF) {
            if (n != null) break;
            for (BluetoothGattService s : services) {
                for (BluetoothGattCharacteristic c : s.getCharacteristics()) {
                    int props = c.getProperties();
                    boolean notifiable = (props & (BluetoothGattCharacteristic.PROPERTY_NOTIFY
                            | BluetoothGattCharacteristic.PROPERTY_INDICATE)) != 0;
                    if (notifiable && c.getUuid().toString().toLowerCase().contains(pref)) {
                        n = c;
                        break;
                    }
                }
            }
        }
        if (w == null || n == null) {
            for (BluetoothGattService s : services) {
                for (BluetoothGattCharacteristic c : s.getCharacteristics()) {
                    int props = c.getProperties();
                    boolean writable = (props & (BluetoothGattCharacteristic.PROPERTY_WRITE
                            | BluetoothGattCharacteristic.PROPERTY_WRITE_NO_RESPONSE)) != 0;
                    boolean notifiable = (props & (BluetoothGattCharacteristic.PROPERTY_NOTIFY
                            | BluetoothGattCharacteristic.PROPERTY_INDICATE)) != 0;
                    if (w == null && writable) w = c;
                    if (n == null && notifiable) n = c;
                }
            }
        }
        writeChar = w;
        notifyChar = n;
    }

    private void subscribeNow() {
        if (subscribed || !isGattConnected()) return;
        subscribed = true;
        if (mtuFallbackTask != null) {
            main.removeCallbacks(mtuFallbackTask);
            mtuFallbackTask = null;
        }
        if (notifyChar != null && gatt != null) {
            try {
                gatt.setCharacteristicNotification(notifyChar, true);
                BluetoothGattDescriptor d = notifyChar.getDescriptor(CCCD_UUID);
                if (d != null) {
                    boolean notify = (notifyChar.getProperties() & BluetoothGattCharacteristic.PROPERTY_NOTIFY) != 0;
                    d.setValue(notify
                            ? BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE
                            : BluetoothGattDescriptor.ENABLE_INDICATION_VALUE);
                    gatt.writeDescriptor(d);
                    return;
                }
            } catch (Exception ignored) {
            }
        }
        emitReady();
    }

    private void emitReady() {
        JSONObject o = evt("ready");
        put(o, "write", writeChar != null ? writeChar.getUuid().toString() : "");
        put(o, "notify", notifyChar != null ? notifyChar.getUuid().toString() : "");
        put(o, "ok", writeChar != null && notifyChar != null);
        emit(o);
    }

    // ---------------- 发送 ----------------
    public boolean send(String hex) {
        BluetoothSocket cs = classicSocket;
        if (cs != null) {
            byte[] data = hexToBytes(hex);
            if (data.length == 0) return false;
            try {
                OutputStream out = cs.getOutputStream();
                out.write(data);
                out.flush();
            } catch (IOException e) {
                emitError("SPP 发送失败：" + String.valueOf(e));
                return false;
            }
            JSONObject o = put(evt("tx"), "hex", bytesToHex(data));
            put(o, "len", data.length);
            emit(o);
            return true;
        }
        if (gatt == null || writeChar == null) {
            emitError("未连接设备或未找到可写特征");
            return false;
        }
        byte[] data = hexToBytes(hex);
        if (data.length == 0) return false;
        lastWriteBytes = data;
        return writeGatt(data);
    }

    private boolean writeGatt(byte[] data) {
        if (gatt == null || writeChar == null) return false;
        int props = writeChar.getProperties();
        // 官方 App 同款写类型选择
        if ((props & BluetoothGattCharacteristic.PROPERTY_WRITE_NO_RESPONSE) != 0
                && (props & BluetoothGattCharacteristic.PROPERTY_WRITE) == 0) {
            // 修正：该特征只声明 WriteWithoutResponse，必须用 NO_RESPONSE 写。
            // 原先误设为 WRITE_TYPE_DEFAULT，协议栈会以 GATT_WRITE_NOT_PERMITTED 拒绝，
            // 表现为连接、订阅都正常但一条数据也发不出去（数据流/NFC/胎压全无响应）。
            writeChar.setWriteType(BluetoothGattCharacteristic.WRITE_TYPE_NO_RESPONSE);
            writeChar.setValue(data);
            try {
                if (!gatt.writeCharacteristic(writeChar)) {
                    emitError("写入失败");
                    return false;
                }
            } catch (SecurityException e) {
                emitError("写入失败：权限被拒");
                return false;
            }
        } else {
            writeChar.setWriteType(BluetoothGattCharacteristic.WRITE_TYPE_NO_RESPONSE);
            int max = mtu > 0 ? Math.min(mtu - 3, 180) : 20;
            if (data.length <= max) {
                writeChar.setValue(data);
                try {
                    if (!gatt.writeCharacteristic(writeChar)) {
                        emitError("写入失败");
                        return false;
                    }
                } catch (SecurityException e) {
                    emitError("写入失败：权限被拒");
                    return false;
                }
            } else {
                writeChunks(data, 0, max);
            }
        }
        // 记录真实写入路径：MTU / 是否分包。分包过多时透传模块会把一整帧拆成几段发出，
        // 车端收到的就是残缺帧，这是"有 TX 无 RX"的重要嫌疑点，必须落进日志。
        int maxInfo = mtu > 0 ? Math.min(mtu - 3, 180) : 20;
        DiagLog.get(activity).write("TX", bytesToHex(data) + " (" + data.length + "B)"
                + " | props=0x" + Integer.toHexString(props)
                + " | mtu=" + mtu + " max=" + maxInfo
                + (data.length > maxInfo
                ? " | 分包 " + ((data.length + maxInfo - 1) / maxInfo) + " 次"
                : " | 单次写入"));
        JSONObject o = put(evt("tx"), "hex", bytesToHex(data));
        put(o, "len", data.length);
        emit(o);
        return true;
    }

    private void writeChunks(final byte[] data, final int off, final int max) {
        int len = Math.min(max, data.length - off);
        byte[] part = Arrays.copyOfRange(data, off, off + len);
        writeChar.setWriteType(BluetoothGattCharacteristic.WRITE_TYPE_NO_RESPONSE);
        writeChar.setValue(part);
        try {
            if (!gatt.writeCharacteristic(writeChar)) {
                emitError("写入失败");
                return;
            }
        } catch (SecurityException e) {
            emitError("写入失败：权限被拒");
            return;
        }
        if (off + len < data.length) {
            final int next = off + len;
            main.postDelayed(new Runnable() {
                @Override
                public void run() {
                    writeChunks(data, next, max);
                }
            }, 30);
        }
    }

    // ---------------- 工具 ----------------
    private boolean hasLocPermission() {
        try {
            return activity.checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION)
                    == PackageManager.PERMISSION_GRANTED
                    || activity.checkSelfPermission(Manifest.permission.ACCESS_COARSE_LOCATION)
                    == PackageManager.PERMISSION_GRANTED;
        } catch (Exception e) {
            return false;
        }
    }

    private boolean isLocationEnabled() {
        try {
            LocationManager lm = (LocationManager) activity.getSystemService(Context.LOCATION_SERVICE);
            if (lm == null) return false;
            return lm.isProviderEnabled(LocationManager.GPS_PROVIDER)
                    || lm.isProviderEnabled(LocationManager.NETWORK_PROVIDER);
        } catch (Exception e) {
            return false;
        }
    }

    private boolean hasScanPermission() {
        try {
            if (Build.VERSION.SDK_INT >= 31) {
                return activity.checkSelfPermission(Manifest.permission.BLUETOOTH_SCAN)
                        == PackageManager.PERMISSION_GRANTED;
            }
            return activity.checkSelfPermission(Manifest.permission.BLUETOOTH) == PackageManager.PERMISSION_GRANTED
                    && activity.checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION)
                    == PackageManager.PERMISSION_GRANTED;
        } catch (Exception e) {
            return false;
        }
    }

    private void stopScanQuiet() {
        main.removeCallbacks(scanAutoStop);
        if (discovering) {
            discovering = false;
            try {
                adapter.cancelDiscovery();
            } catch (Exception ignored) {
            }
        }
        if (scanning) {
            scanning = false;
            try {
                adapter.getBluetoothLeScanner().stopScan(scanCallback);
            } catch (Exception ignored) {
            }
        }
    }

    private static void closeQuiet(BluetoothSocket s) {
        if (s == null) return;
        try {
            s.close();
        } catch (Exception ignored) {
        }
    }

    private static byte[] hexToBytes(String hex) {
        String clean = hex.replaceAll("[^0-9a-fA-F]", "");
        if (clean.length() < 2 || clean.length() % 2 != 0) return new byte[0];
        byte[] out = new byte[clean.length() / 2];
        for (int i = 0; i < out.length; i++) {
            out[i] = (byte) Integer.parseInt(clean.substring(i * 2, i * 2 + 2), 16);
        }
        return out;
    }

    private static String bytesToHex(byte[] data, int len) {
        StringBuilder sb = new StringBuilder(len * 2);
        for (int i = 0; i < len; i++) {
            sb.append(String.format("%02X", data[i] & 0xFF));
        }
        return sb.toString();
    }

    private static String bytesToHex(byte[] data) {
        return bytesToHex(data, data.length);
    }

    private JSONObject evt(String type) {
        return put(new JSONObject(), "type", type);
    }

    private static JSONObject put(JSONObject o, String k, Object v) {
        try {
            o.put(k, v);
        } catch (JSONException ignored) {
        }
        return o;
    }

    private void emitError(String msg) {
        emit(put(evt("error"), "error", msg));
    }

    private void emit(JSONObject o) {
        String s = o.toString().replace("\u2028", "\\u2028").replace("\u2029", "\\u2029");
        // 所有原生事件（含每一次 RX 原始字节、连接/服务/订阅结果、错误）同步写入日志文件
        DiagLog.get(activity).write("EV", s);
        activity.eval("window.__r485Event&&window.__r485Event(" + s + ");");
    }

    public void destroy() {
        cancelGattState();
        try {
            activity.unregisterReceiver(stateReceiver);
        } catch (Exception ignored) {
        }
        try {
            activity.unregisterReceiver(discoveryReceiver);
        } catch (Exception ignored) {
        }
        stopScanQuiet();
        if (classicSocket != null) {
            closeQuiet(classicSocket);
            classicSocket = null;
        }
        pool.shutdownNow();
    }
}
