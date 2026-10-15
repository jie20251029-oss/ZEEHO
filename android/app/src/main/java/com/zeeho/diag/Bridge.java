package com.zeeho.diag;

import android.content.ClipData;
import android.content.Intent;
import android.net.Uri;
import android.webkit.JavascriptInterface;

import org.json.JSONException;
import org.json.JSONObject;

import java.io.File;

/**
 * Bridge — 页面层 window.Android.postMessage(json) 的原生分发器。
 * 命令集与 iOS 版 ViewController 保持一致：
 *   scan / stopScan / connect / disconnect / send / state / vciProbe / vciPaired
 *   wifiConnect / wifiSend / wifiClose / wifiSelfCheck / wifiPortScan
 * 回调经 window.__r485Cb(id, json) 回传；事件由各桥自己 push。
 */
public class Bridge {

    private final MainActivity activity;
    public final BleBridge ble;
    public final WifiBridge wifi;

    public Bridge(MainActivity activity) {
        this.activity = activity;
        this.ble = new BleBridge(activity);
        this.wifi = new WifiBridge(activity);
    }

    @JavascriptInterface
    public void postMessage(final String json) {
        // JavascriptInterface 在非主线程调用，蓝牙操作需要主线程
        activity.runOnUiThread(new Runnable() {
            @Override
            public void run() {
                dispatch(json);
            }
        });
    }

    private void dispatch(String json) {
        String cmd = "";
        String data = "";
        String id = "";
        try {
            JSONObject o = new JSONObject(json);
            cmd = o.optString("command", "");
            data = o.optString("data", "");
            id = o.optString("id", "");
        } catch (JSONException e) {
            return;
        }

        JSONObject reply = null;
        switch (cmd) {
            case "scan":
                ble.scan(data);
                break;
            case "stopScan":
                ble.stopScan();
                break;
            case "connect":
                ble.connect(data);
                break;
            case "disconnect":
                ble.disconnect();
                break;
            case "send":
                reply = obj("ok", ble.send(data));
                break;
            // ---- 诊断日志文件 ----
            case "log":
                // 页面侧的诊断行（组帧成功 / 校验不符 / 脏字节丢弃…）也落到同一个文件
                DiagLog.get(activity).write("JS", data);
                break;
            case "logInfo":
                reply = safeJson(DiagLog.get(activity).infoJson());
                break;
            case "logShare":
                reply = obj("ok", shareLog());
                break;
            case "logClear":
                reply = obj("ok", DiagLog.get(activity).clear());
                break;
            case "state":
                reply = ble.state();
                break;
            case "scanState":
                reply = ble.scanState();
                break;
            case "vciProbe":
                reply = obj("error", "安卓版不支持官方诊断仪 VCI 探测（该功能依赖 iOS 私有蓝牙框架）");
                break;
            case "vciPaired":
                reply = obj("error", "安卓版不支持官方诊断仪 VCI 探测");
                break;
            case "wifiConnect":
                wifi.connect(data);
                break;
            case "wifiSend":
                reply = obj("ok", wifi.send(data));
                break;
            case "wifiClose":
                wifi.close();
                break;
            case "wifiSelfCheck":
                wifi.selfCheck(data);
                break;
            case "wifiPortScan":
                wifi.portScan(data);
                break;
            default:
                break;
        }

        if (reply != null && !id.isEmpty()) {
            final String cbId = id;
            final String arg = reply.toString();
            activity.eval("window.__r485Cb&&window.__r485Cb('" + cbId + "', " + arg + ");");
        }
    }

    private static JSONObject obj(String k, Object v) {
        JSONObject o = new JSONObject();
        try {
            o.put(k, v);
        } catch (JSONException ignored) {
        }
        return o;
    }

    private static JSONObject safeJson(String s) {
        try {
            return new JSONObject(s);
        } catch (JSONException e) {
            return new JSONObject();
        }
    }

    /** 走系统分享面板把当前日志文件发出去 */
    private boolean shareLog() {
        DiagLog log = DiagLog.get(activity);
        File f = log.current();
        if (f == null || !f.exists()) {
            notifyError("日志文件尚未就绪，请稍等 1 秒后重试");
            return false;
        }
        Uri uri = LogProvider.uriFor(f.getName());
        Intent i = new Intent(Intent.ACTION_SEND);
        i.setType("text/plain");
        i.putExtra(Intent.EXTRA_STREAM, uri);
        i.putExtra(Intent.EXTRA_SUBJECT, "极核诊断日志 " + f.getName());
        i.setClipData(ClipData.newUri(activity.getContentResolver(), "diaglog", uri));
        i.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
        try {
            activity.startActivity(Intent.createChooser(i, "发送诊断日志"));
            return true;
        } catch (Exception e) {
            notifyError("没有可用的分享目标。日志文件路径：" + f.getAbsolutePath());
            return false;
        }
    }

    private void notifyError(String msg) {
        JSONObject o = obj("type", "error");
        try {
            o.put("error", msg);
        } catch (JSONException ignored) {
        }
        // 同样按 JSON 字符串字面量回推
        activity.eval("window.__r485Event&&window.__r485Event(" + JSONObject.quote(o.toString()) + ");");
    }

    public void destroy() {
        ble.destroy();
        wifi.destroy();
    }
}
