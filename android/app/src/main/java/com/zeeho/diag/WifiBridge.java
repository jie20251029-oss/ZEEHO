package com.zeeho.diag;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.Inet4Address;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.NetworkInterface;
import java.net.Socket;
import java.net.SocketException;
import java.net.SocketTimeoutException;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.Enumeration;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * WifiBridge — 车辆 WiFi（DoIP over TCP）原生传输桥。
 * 网页层负责 DoIP/UDS 协议逻辑，本桥只做 TCP 连接/收发/事件回传。
 * 命令：wifiConnect("host:port") / wifiSend(hex) / wifiClose
 * 事件：window.onWifiEvent({type:'connected'|'recv'|'closed'|'error', data:...})
 */
public class WifiBridge {

    private final MainActivity activity;
    private final ExecutorService pool = Executors.newCachedThreadPool();
    private volatile Socket socket;

    public WifiBridge(MainActivity activity) {
        this.activity = activity;
    }

    // ---------------- 连接 ----------------
    public void connect(String payload) {
        String host = "192.168.49.1";
        int port = 13400;
        if (payload != null && !payload.isEmpty()) {
            String[] parts = payload.split(":");
            if (parts.length >= 1 && !parts[0].trim().isEmpty()) host = parts[0].trim();
            if (parts.length >= 2) {
                try {
                    port = Integer.parseInt(parts[1].trim());
                } catch (NumberFormatException ignored) {
                }
            }
        }
        final String h = host;
        final int p = port;
        close();

        pool.execute(new Runnable() {
            @Override
            public void run() {
                Socket s = new Socket();
                try {
                    s.connect(new InetSocketAddress(h, p), 5000);
                    socket = s;
                    emit(evt("connected", h + ":" + p));
                    InputStream in = s.getInputStream();
                    byte[] buf = new byte[65536];
                    int n;
                    while ((n = in.read(buf)) != -1) {
                        emit(evt("recv", bytesToHex(buf, n)));
                    }
                    emit(evt("closed", ""));
                } catch (Exception e) {
                    emit(evt("error", humanError(e)));
                } finally {
                    if (socket == s) socket = null;
                    try {
                        s.close();
                    } catch (IOException ignored) {
                    }
                }
            }
        });
    }

    // ---------------- 发送 ----------------
    public boolean send(String hex) {
        Socket s = socket;
        if (s == null) return false;
        byte[] data = hexToBytes(hex);
        if (data.length == 0) return false;
        try {
            OutputStream out = s.getOutputStream();
            out.write(data);
            out.flush();
            return true;
        } catch (IOException e) {
            emit(evt("error", humanError(e)));
            return false;
        }
    }

    public void close() {
        Socket s = socket;
        socket = null;
        if (s != null) {
            try {
                s.close();
            } catch (IOException ignored) {
            }
        }
    }

    // ---------------- 网络自检（候选网关并发探测，1.2 秒超时） ----------------
    public void selfCheck(String portStr) {
        int port = 13400;
        if (portStr != null && !portStr.isEmpty()) {
            try {
                port = Integer.parseInt(portStr.trim());
            } catch (NumberFormatException ignored) {
            }
        }
        final int p = port;
        final String ip = localIP();

        List<String> candidates = new ArrayList<>();
        if (ip != null) {
            String[] seg = ip.split("\\.");
            if (seg.length == 4 && (ip.startsWith("192.168.") || ip.startsWith("10.") || ip.startsWith("172."))) {
                candidates.add(seg[0] + "." + seg[1] + "." + seg[2] + ".1");
            }
        }
        for (String c : new String[]{"192.168.49.1", "192.168.0.1", "192.168.1.1", "192.168.4.1", "10.0.0.1"}) {
            if (!candidates.contains(c)) candidates.add(c);
        }

        final List<String> hosts = candidates;
        pool.execute(new Runnable() {
            @Override
            public void run() {
                final JSONArray results = new JSONArray();
                final String[] found = new String[1];
                final CountDownLatch latch = new CountDownLatch(hosts.size());
                for (final String h : hosts) {
                    pool.execute(new Runnable() {
                        @Override
                        public void run() {
                            String status = probeOnce(h, p);
                            JSONObject o = new JSONObject();
                            try {
                                o.put("host", h);
                                o.put("status", status);
                            } catch (JSONException ignored) {
                            }
                            synchronized (results) {
                                results.put(o);
                                if ("open".equals(status) && found[0] == null) found[0] = h;
                            }
                            latch.countDown();
                        }
                    });
                }
                try {
                    latch.await();
                } catch (InterruptedException ignored) {
                }
                JSONObject out = new JSONObject();
                try {
                    out.put("localIP", ip == null ? "" : ip);
                    out.put("port", p);
                    out.put("results", results);
                    if (found[0] != null) out.put("found", found[0]);
                } catch (JSONException ignored) {
                }
                activity.eval("window.onWiFiSelfCheck&&window.onWiFiSelfCheck(" + out.toString() + ");");
            }
        });
    }

    // ---------------- 端口扫描（同一主机多端口并发探测） ----------------
    public void portScan(String host) {
        final String h = (host == null || host.isEmpty()) ? "192.168.0.1" : host;
        final List<Integer> ports = Arrays.asList(22, 23, 80, 443, 3000, 5000, 7000, 8000, 8080, 8443, 8888, 9000, 13400);

        pool.execute(new Runnable() {
            @Override
            public void run() {
                final JSONArray results = new JSONArray();
                final List<Integer> open = new ArrayList<>();
                final CountDownLatch latch = new CountDownLatch(ports.size());
                for (final int p : ports) {
                    pool.execute(new Runnable() {
                        @Override
                        public void run() {
                            String status = probeOnce(h, p);
                            JSONObject o = new JSONObject();
                            try {
                                o.put("port", String.valueOf(p));
                                o.put("status", status);
                            } catch (JSONException ignored) {
                            }
                            synchronized (results) {
                                results.put(o);
                                if ("open".equals(status)) open.add(p);
                            }
                            latch.countDown();
                        }
                    });
                }
                try {
                    latch.await();
                } catch (InterruptedException ignored) {
                }
                JSONObject out = new JSONObject();
                try {
                    out.put("host", h);
                    out.put("results", results);
                    JSONArray arr = new JSONArray();
                    for (Integer p : open) arr.put(p);
                    out.put("open", arr);
                } catch (JSONException ignored) {
                }
                activity.eval("window.onWifiPortScan&&window.onWifiPortScan(" + out.toString() + ");");
            }
        });
    }

    /** 单次 TCP 连接探测（1.2 秒超时）：open / fail / timeout / unreachable */
    private static String probeOnce(String host, int port) {
        Socket s = new Socket();
        try {
            s.connect(new InetSocketAddress(host, port), 1200);
            return "open";
        } catch (SocketTimeoutException e) {
            return "timeout";
        } catch (IOException e) {
            String m = String.valueOf(e.getMessage()).toLowerCase();
            if (m.contains("unreachable") || m.contains("network")) return "unreachable";
            if (m.contains("refused")) return "fail";
            return "fail";
        } finally {
            try {
                s.close();
            } catch (IOException ignored) {
            }
        }
    }

    // ---------------- 本机 WiFi IPv4 ----------------
    private static String localIP() {
        try {
            Enumeration<NetworkInterface> nis = NetworkInterface.getNetworkInterfaces();
            String fallback = null;
            while (nis.hasMoreElements()) {
                NetworkInterface ni = nis.nextElement();
                try {
                    if (!ni.isUp() || ni.isLoopback()) continue;
                } catch (SocketException e) {
                    continue;
                }
                Enumeration<InetAddress> addrs = ni.getInetAddresses();
                while (addrs.hasMoreElements()) {
                    InetAddress a = addrs.nextElement();
                    if (a instanceof Inet4Address && !a.isLoopbackAddress()) {
                        String ip = a.getHostAddress();
                        if (ni.getName().toLowerCase().contains("wlan")) return ip;
                        if (fallback == null && ip.startsWith("192.168.")) fallback = ip;
                    }
                }
            }
            return fallback;
        } catch (SocketException e) {
            return null;
        }
    }

    // ---------------- 工具 ----------------
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
            sb.append(String.format("%02X", data[i]));
        }
        return sb.toString();
    }

    private JSONObject evt(String type, String data) {
        JSONObject o = new JSONObject();
        try {
            o.put("type", type);
            o.put("data", data);
        } catch (JSONException ignored) {
        }
        return o;
    }

    private void emit(JSONObject o) {
        // 与 BLE 桥一致：按 JSON 字符串字面量回推（页面已两种形式都容错）
        activity.eval("window.onWifiEvent&&window.onWifiEvent(" + JSONObject.quote(o.toString()) + ");");
    }

    /** 错误翻译（对照 iOS 版 POSIX 错误码） */
    private static String humanError(Exception e) {
        String s = String.valueOf(e);
        if (e instanceof SocketTimeoutException) {
            return "连接超时：网关 IP 可能不对（试试 192.168.0.1，或先点「网络自检」）";
        }
        if (s.contains("ECONNREFUSED") || s.contains("Connection refused") || s.contains("refused")) {
            return "端口未开放：网关 IP 可能不对（试试 192.168.0.1，或先点「网络自检」）";
        }
        if (s.contains("ENETUNREACH") || s.contains("EHOSTUNREACH") || s.contains("unreachable")) {
            return "网络不可达：手机可能不在车辆热点网段（先点「网络自检」看本机 IP）";
        }
        if (s.contains("Socket closed") || s.contains("closed")) {
            return "连接已关闭";
        }
        return s;
    }

    public void destroy() {
        close();
        pool.shutdownNow();
    }
}
