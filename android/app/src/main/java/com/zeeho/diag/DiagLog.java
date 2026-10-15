package com.zeeho.diag;

import android.content.Context;
import android.os.Build;

import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.util.Arrays;
import java.util.Comparator;
import java.util.Date;
import java.text.SimpleDateFormat;
import java.util.Locale;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * DiagLog — 诊断日志落盘。
 *
 * 所有 TX / RX / 蓝牙事件 / 页面侧诊断告警（组帧成功、校验不符、脏字节丢弃…）
 * 都会写入同一个文件，排查时直接把文件发出来即可，不需要在手机上手抄屏幕日志。
 *
 * 位置：/sdcard/Android/data/com.zeeho.diag/files/logs/zeeho-<时间戳>.log
 * （取不到外部目录时退回应用内部 files/logs）
 * 单文件超过 2MB 自动滚动，最多保留 5 个。
 *
 * 所有文件操作都在同一条单线程队列上执行，避免写日志阻塞 UI 线程，
 * 也避免并发写导致行错乱。
 */
public final class DiagLog {

    private static final long MAX_BYTES = 2L * 1024 * 1024;
    private static final int KEEP = 5;

    private static DiagLog instance;

    private final Context ctx;
    private final File dir;
    private final ExecutorService io = Executors.newSingleThreadExecutor();
    private final SimpleDateFormat stamp = new SimpleDateFormat("MM-dd HH:mm:ss.SSS", Locale.US);

    private volatile File file;
    private FileOutputStream out;
    private long bytes;
    private long lines;

    private DiagLog(Context c) {
        ctx = c;
        File base = null;
        try {
            base = c.getExternalFilesDir(null);
        } catch (Exception ignored) {
        }
        if (base == null) base = c.getFilesDir();
        if (base == null) base = new File(c.getCacheDir(), "logs");
        dir = new File(base, "logs");
        try {
            //noinspection ResultOfMethodCallIgnored
            dir.mkdirs();
        } catch (Exception ignored) {
        }
        io.execute(new Runnable() {
            @Override
            public void run() {
                openLocked();
            }
        });
    }

    public static DiagLog get(Context c) {
        synchronized (DiagLog.class) {
            if (instance == null) instance = new DiagLog(c.getApplicationContext());
            return instance;
        }
    }

    // ---------- 以下 *Locked 方法只在 io 单线程队列上调用 ----------

    private void openLocked() {
        String name = "zeeho-" + new SimpleDateFormat("yyyyMMdd-HHmmss", Locale.US).format(new Date()) + ".log";
        file = new File(dir, name);
        try {
            out = new FileOutputStream(file, true);
        } catch (Exception e) {
            out = null;
        }
        bytes = file.length();
        lines = 0;
        pruneLocked();
        rawLocked("SYS", "==== 日志开始 ====");
        rawLocked("SYS", "app " + versionName() + " | " + Build.MANUFACTURER + " " + Build.MODEL
                + " | Android " + Build.VERSION.RELEASE + " (SDK " + Build.VERSION.SDK_INT + ")");
        rawLocked("SYS", "文件: " + file.getAbsolutePath());
    }

    private void rawLocked(String tag, String text) {
        if (out == null) return;
        String line = "[" + stamp.format(new Date()) + "] " + tag + " " + text + "\n";
        try {
            byte[] b = line.getBytes("UTF-8");
            out.write(b);
            out.flush();
            bytes += b.length;
            lines++;
        } catch (Exception ignored) {
        }
    }

    private void rotateLocked() {
        try {
            if (out != null) out.close();
        } catch (Exception ignored) {
        }
        out = null;
        openLocked();
    }

    private void pruneLocked() {
        try {
            File[] fs = dir.listFiles();
            if (fs == null || fs.length <= KEEP) return;
            Arrays.sort(fs, new Comparator<File>() {
                @Override
                public int compare(File a, File b) {
                    return Long.compare(b.lastModified(), a.lastModified());
                }
            });
            for (int i = KEEP; i < fs.length; i++) {
                //noinspection ResultOfMethodCallIgnored
                fs[i].delete();
            }
        } catch (Exception ignored) {
        }
    }

    private String versionName() {
        try {
            return ctx.getPackageManager().getPackageInfo(ctx.getPackageName(), 0).versionName;
        } catch (Exception e) {
            return "?";
        }
    }

    // ---------- 对外 ----------

    /** 写一行日志（异步，不阻塞调用线程） */
    public void write(final String tag, final String text) {
        if (text == null) return;
        io.execute(new Runnable() {
            @Override
            public void run() {
                rawLocked(tag, text);
                if (bytes > MAX_BYTES) rotateLocked();
            }
        });
    }

    /** 当前日志文件（供分享用），可能尚未就绪（返回 null） */
    public File current() {
        return file;
    }

    public String dirPath() {
        return dir.getAbsolutePath();
    }

    public String infoJson() {
        JSONObject o = new JSONObject();
        try {
            File f = file;
            boolean exists = f != null && f.exists();
            o.put("path", f != null ? f.getAbsolutePath() : "");
            o.put("dir", dir.getAbsolutePath());
            o.put("name", f != null ? f.getName() : "");
            o.put("size", exists ? f.length() : 0);
            o.put("lines", lines);
            o.put("exists", exists);
        } catch (Exception ignored) {
        }
        return o.toString();
    }

    /** 清空并重新开始一个日志文件 */
    public boolean clear() {
        io.execute(new Runnable() {
            @Override
            public void run() {
                try {
                    if (out != null) out.close();
                } catch (Exception ignored) {
                }
                out = null;
                try {
                    File[] fs = dir.listFiles();
                    if (fs != null) {
                        for (File f : fs) {
                            //noinspection ResultOfMethodCallIgnored
                            f.delete();
                        }
                    }
                } catch (Exception ignored) {
                }
                openLocked();
            }
        });
        return true;
    }
}
