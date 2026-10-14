package com.zeeho.diag;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.Bundle;
import android.view.WindowManager;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import java.util.ArrayList;
import java.util.List;

/**
 * MainActivity — WebView 壳：加载 assets/diag.html，注入 JS 桥 window.Android。
 * 页面层通过 window.r485(cmd, data, cb) 调用原生 BLE/WiFi 桥（见 diag.html 内注入脚本）。
 */
public class MainActivity extends Activity {

    public static final String ASSET_URL = "file:///android_asset/diag.html";
    private static final int REQ_PERM = 1001;

    private WebView webView;
    private Bridge bridge;

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        // 诊断时保持屏幕常亮
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        setContentView(R.layout.activity_main);

        webView = findViewById(R.id.webview);
        WebSettings s = webView.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setAllowFileAccess(true);
        s.setAllowContentAccess(true);
        s.setUseWideViewPort(true);
        s.setLoadWithOverviewMode(true);

        bridge = new Bridge(this);
        webView.setWebViewClient(new WebViewClient() {
            @Override
            public void onPageFinished(WebView view, String url) {
                // 页面就绪后自检蓝牙状态/权限，结果直接显示在扫描区
                view.postDelayed(new Runnable() {
                    @Override
                    public void run() {
                        if (bridge != null) {
                            bridge.ble.announceState();
                        }
                    }
                }, 600);
            }
        });
        webView.addJavascriptInterface(bridge, "Android");

        if (needsPermissions()) {
            requestPermissions(neededPermissions().toArray(new String[0]), REQ_PERM);
        } else {
            loadPage();
        }
    }

    private boolean needsPermissions() {
        for (String perm : neededPermissions()) {
            if (checkSelfPermission(perm) != PackageManager.PERMISSION_GRANTED) {
                return true;
            }
        }
        return false;
    }

    private List<String> neededPermissions() {
        List<String> p = new ArrayList<>();
        if (Build.VERSION.SDK_INT >= 31) {
            p.add(Manifest.permission.BLUETOOTH_SCAN);
            p.add(Manifest.permission.BLUETOOTH_CONNECT);
        } else {
            p.add(Manifest.permission.BLUETOOTH);
            p.add(Manifest.permission.BLUETOOTH_ADMIN);
        }
        // 定位权限全版本申请：部分机型定位权限/开关缺失时 BLE 扫描静默返回空结果
        p.add(Manifest.permission.ACCESS_FINE_LOCATION);
        return p;
    }

    private void loadPage() {
        webView.loadUrl(ASSET_URL);
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode == REQ_PERM) {
            loadPage();
        }
    }

    /** 主线程执行 JS（事件/回调推给页面层）。
     *  用 loadUrl("javascript:") 而非 evaluateJavascript —— 部分机型 ROM 的
     *  evaluateJavascript 会静默失败，导致页面永远收不到原生事件（表现为"一直在扫描"）。 */
    public void eval(final String js) {
        runOnUiThread(new Runnable() {
            @Override
            public void run() {
                try {
                    webView.loadUrl("javascript:" + js);
                } catch (Exception ignored) {
                }
            }
        });
    }

    @Override
    protected void onDestroy() {
        super.onDestroy();
        if (bridge != null) {
            bridge.destroy();
        }
        if (webView != null) {
            webView.destroy();
        }
    }
}
