package com.zeeho.diag;

import android.content.ContentProvider;
import android.content.ContentValues;
import android.database.Cursor;
import android.database.MatrixCursor;
import android.net.Uri;
import android.os.ParcelFileDescriptor;
import android.provider.OpenableColumns;

import java.io.File;
import java.io.FileNotFoundException;

/**
 * LogProvider — 把当前日志文件以 content:// 暴露给系统分享面板。
 *
 * 说明：本工程没有引入 androidx，因此不能用 FileProvider，这里用一个最小实现的
 * ContentProvider 顶替，避免为了分享日志而改动构建配置。
 * 只读、exported=false，读权限由分享 Intent 临时授予（FLAG_GRANT_READ_URI_PERMISSION）。
 */
public class LogProvider extends ContentProvider {

    public static final String AUTHORITY = "com.zeeho.diag.logs";

    public static Uri uriFor(String name) {
        return Uri.parse("content://" + AUTHORITY + "/" + name);
    }

    @Override
    public boolean onCreate() {
        return true;
    }

    @Override
    public ParcelFileDescriptor openFile(Uri uri, String mode) throws FileNotFoundException {
        if (getContext() == null) {
            throw new FileNotFoundException("Provider 上下文不可用");
        }
        DiagLog log = DiagLog.get(getContext());
        File f = log.current();
        if (f == null || !f.exists()) {
            throw new FileNotFoundException("日志文件尚未就绪");
        }
        return ParcelFileDescriptor.open(f, ParcelFileDescriptor.MODE_READ_ONLY);
    }

    @Override
    public String getType(Uri uri) {
        return "text/plain";
    }

    @Override
    public Cursor query(Uri uri, String[] projection, String selection, String[] selectionArgs, String sortOrder) {
        DiagLog log = DiagLog.get(getContext());
        File f = log.current();
        MatrixCursor c = new MatrixCursor(new String[]{OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE});
        if (f != null && f.exists()) {
            c.addRow(new Object[]{f.getName(), f.length()});
        }
        return c;
    }

    @Override
    public Uri insert(Uri uri, ContentValues values) {
        return null;
    }

    @Override
    public int delete(Uri uri, String selection, String[] selectionArgs) {
        return 0;
    }

    @Override
    public int update(Uri uri, ContentValues values, String selection, String[] selectionArgs) {
        return 0;
    }
}
