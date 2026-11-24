package cn.sunmanxu.musicsmx;

import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import android.util.Log;

import androidx.core.content.FileProvider;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.security.MessageDigest;

/**
 * 1.0.21：应用内「检查更新 / 下载 / 安装」。
 *
 * 全部走 GitHub Release：api.github.com 查 latest，assets 里挑 apk，下载到 cache/updates，
 * 再用 FileProvider 交给系统安装器。
 *
 * 两个真机踩过的点：
 *  1) api.github.com 在平板上能直连（~1s），但下载会 302 到 release-assets.githubusercontent.com，
 *     所以下载这边必须自己跟重定向（最多 5 跳），不能指望一次 openConnection 就到终点；
 *  2) 包名一样但签名不同的 APK 是装不上的（系统只报一句"未安装"），所以下载完先自己比签名，
 *     不一致就直接告诉用户，不要浪费一次安装弹窗。
 */
public class Updater {

    private static final String TAG = "MusicUpdater";
    public static final String REPO = "sunmanxu/MusicSMX-Android-HD";
    private static final String API_LATEST = "https://api.github.com/repos/" + REPO + "/releases/latest";
    private static final String UA = "MusicSMX-Android/HD";

    public interface Progress {
        void onProgress(long bytes, long total);
    }

    // ==================== 检查 ====================

    /** 查 latest release：返回 tag / version / 说明 / apk 资产 */
    public static JSONObject checkLatest(Context ctx) throws Exception {
        JSONObject root = getJson(API_LATEST);
        String tag = root.optString("tag_name", "");
        String name = root.optString("name", "");
        String notes = root.optString("body", "");
        String published = root.optString("published_at", "");
        String htmlUrl = root.optString("html_url", "");

        JSONArray assets = root.optJSONArray("assets");
        JSONObject best = null;
        if (assets != null) {
            for (int i = 0; i < assets.length(); i++) {
                JSONObject a = assets.optJSONObject(i);
                if (a == null) continue;
                String n = a.optString("name", "").toLowerCase();
                if (!n.endsWith(".apk")) continue;
                // 多个 apk 时优先 debug 包（当前发布口径就是 debug 签名）
                if (best == null) { best = a; continue; }
                boolean bestDebug = best.optString("name", "").toLowerCase().contains("debug");
                boolean curDebug = n.contains("debug");
                if (curDebug && !bestDebug) best = a;
            }
        }

        JSONObject out = new JSONObject();
        out.put("ok", best != null);
        out.put("tag", tag);
        out.put("name", name);
        out.put("notes", notes.length() > 800 ? notes.substring(0, 800) : notes);
        out.put("publishedAt", published);
        out.put("htmlUrl", htmlUrl);
        out.put("repo", REPO);

        PackageManager pm = ctx.getPackageManager();
        JSONObject cur = new JSONObject();
        try {
            PackageInfo pi = pm.getPackageInfo(ctx.getPackageName(), 0);
            cur.put("versionName", pi.versionName == null ? "" : pi.versionName);
            cur.put("versionCode", Build.VERSION.SDK_INT >= 28 ? (int) pi.getLongVersionCode() : pi.versionCode);
        } catch (Exception ignore) {}
        out.put("current", cur);

        if (best != null) {
            JSONObject as = new JSONObject();
            as.put("name", best.optString("name", ""));
            as.put("size", best.optLong("size", 0));
            as.put("url", best.optString("browser_download_url", ""));
            out.put("asset", as);
        } else {
            out.put("error", "该 Release 没有 apk 资产");
        }
        return out;
    }

    // ==================== 下载 ====================

    public static JSONObject download(Context ctx, String url, String fileName, long expectedSize,
                                     Progress cb) throws Exception {
        if (url == null || url.isEmpty()) throw new Exception("下载地址为空");
        File dir = new File(ctx.getCacheDir(), "updates");
        if (!dir.exists() && !dir.mkdirs()) throw new Exception("无法创建下载目录");
        // 只留当前这一个包，别把旧包越攒越多
        File[] old = dir.listFiles();
        if (old != null) {
            for (File f : old) {
                if (!f.getName().equals(fileName)) {
                    try { f.delete(); } catch (Exception ignore) {}
                }
            }
        }
        if (fileName == null || fileName.isEmpty() || !fileName.toLowerCase().endsWith(".apk")) {
            fileName = "MusicSMX-update.apk";
        }
        File out = new File(dir, fileName);
        File tmp = new File(dir, fileName + ".part");

        long total = expectedSize > 0 ? expectedSize : -1;
        String cur = url;
        InputStream in = null;
        java.net.HttpURLConnection conn = null;
        for (int hop = 0; hop < 5; hop++) {
            java.net.URL u = new java.net.URL(cur);
            java.net.HttpURLConnection c = (java.net.HttpURLConnection) u.openConnection();
            c.setConnectTimeout(15000);
            c.setReadTimeout(30000);
            c.setInstanceFollowRedirects(false);
            c.setRequestProperty("User-Agent", UA);
            c.setRequestProperty("Accept", "*/*");
            c.setRequestProperty("Accept-Encoding", "identity");
            int code = c.getResponseCode();
            if (code >= 300 && code < 400) {
                String loc = c.getHeaderField("Location");
                c.disconnect();
                if (loc == null || loc.isEmpty()) throw new Exception("重定向缺少 Location");
                cur = new java.net.URL(u, loc).toString();
                continue;
            }
            if (code >= 400) {
                c.disconnect();
                throw new Exception("下载失败 HTTP " + code);
            }
            long len = c.getContentLengthLong();
            if (len > 0) total = len;
            conn = c;
            in = c.getInputStream();
            break;
        }
        if (in == null) throw new Exception("重定向次数过多");

        long got = 0;
        try (InputStream src = in; FileOutputStream fos = new FileOutputStream(tmp)) {
            byte[] buf = new byte[8192];
            int n;
            long lastReport = 0;
            while ((n = src.read(buf)) > 0) {
                fos.write(buf, 0, n);
                got += n;
                if (cb != null && (got - lastReport > 262144 || got == total)) {
                    lastReport = got;
                    cb.onProgress(got, total > 0 ? total : got);
                }
            }
            fos.flush();
        } catch (Exception e) {
            try { tmp.delete(); } catch (Exception ignore) {}
            throw e;
        } finally {
            try { if (conn != null) conn.disconnect(); } catch (Exception ignore) {}
        }

        if (expectedSize > 0 && got < expectedSize * 0.98) {
            try { tmp.delete(); } catch (Exception ignore) {}
            throw new Exception("文件不完整（" + got + "/" + expectedSize + " 字节）");
        }
        if (out.exists()) out.delete();
        if (!tmp.renameTo(out)) throw new Exception("无法保存到 " + out.getAbsolutePath());

        JSONObject res = new JSONObject();
        res.put("ok", true);
        res.put("path", out.getAbsolutePath());
        res.put("size", got);
        res.put("finalUrl", cur);

        // 下载完先把这个包"是什么、能不能装"验一遍
        PackageManager pm = ctx.getPackageManager();
        PackageInfo arch = null;
        try {
            arch = pm.getPackageArchiveInfo(out.getAbsolutePath(),
                Build.VERSION.SDK_INT >= 28 ? PackageManager.GET_SIGNING_CERTIFICATES : PackageManager.GET_SIGNATURES);
        } catch (Throwable ignore) {}
        if (arch == null) {
            res.put("ok", false);
            res.put("error", "下载到的文件不是有效 APK");
            return res;
        }
        res.put("apkPackage", arch.packageName == null ? "" : arch.packageName);
        res.put("apkVersionName", arch.versionName == null ? "" : arch.versionName);
        res.put("apkVersionCode", Build.VERSION.SDK_INT >= 28 ? (int) arch.getLongVersionCode() : arch.versionCode);
        res.put("sameSigner", sameSigner(ctx, arch));
        res.put("samePackage", ctx.getPackageName().equals(arch.packageName));
        return res;
    }

    // ==================== 安装 ====================

    /** 需要「安装未知应用」权限时返回 true（并把用户带去授权页） */
    public static boolean needInstallPermission(Context ctx) {
        if (Build.VERSION.SDK_INT < 26) return false;
        try {
            return !ctx.getPackageManager().canRequestPackageInstalls();
        } catch (Throwable t) {
            return false;
        }
    }

    public static void openInstallPermissionSettings(Context ctx) {
        try {
            Intent i = new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES);
            i.setData(Uri.parse("package:" + ctx.getPackageName()));
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            ctx.startActivity(i);
        } catch (Throwable t) {
            try {
                Intent i = new Intent(Settings.ACTION_SECURITY_SETTINGS);
                i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                ctx.startActivity(i);
            } catch (Throwable ignore) {}
        }
    }

    /** 交给系统安装器：FileProvider 出 content:// + 临时读权限 */
    public static void launchInstaller(Context ctx, File apk) throws Exception {
        if (!apk.exists()) throw new Exception("安装包不存在，请重新下载");
        // 复用 Capacitor/清单里已有的 FileProvider（authority = <包名>.fileprovider，
        // file_paths.xml 已经有 <cache-path path="."/>，cache/updates/*.apk 直接在覆盖范围内）
        Uri uri = FileProvider.getUriForFile(ctx, ctx.getPackageName() + ".fileprovider", apk);
        Intent i = new Intent(Intent.ACTION_VIEW);
        i.setDataAndType(uri, "application/vnd.android.package-archive");
        i.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION
            | Intent.FLAG_ACTIVITY_NEW_TASK
            | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        ctx.startActivity(i);
    }

    /** 卸载当前版本（签名冲突时唯一出路，会丢配置） */
    public static void openUninstall(Context ctx) {
        try {
            Intent i = new Intent(Intent.ACTION_DELETE);
            i.setData(Uri.parse("package:" + ctx.getPackageName()));
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            ctx.startActivity(i);
        } catch (Throwable ignore) {}
    }

    // ==================== 工具 ====================

    private static boolean sameSigner(Context ctx, PackageInfo archive) {
        try {
            String mine = certDigests(ctx.getPackageManager().getPackageInfo(
                ctx.getPackageName(),
                Build.VERSION.SDK_INT >= 28 ? PackageManager.GET_SIGNING_CERTIFICATES : PackageManager.GET_SIGNATURES));
            String theirs = certDigests(archive);
            return mine != null && mine.equals(theirs);
        } catch (Throwable t) {
            Log.w(TAG, "sameSigner failed", t);
            return false;
        }
    }

    private static String certDigests(PackageInfo pi) throws Exception {
        if (pi == null) return null;
        StringBuilder sb = new StringBuilder();
        if (Build.VERSION.SDK_INT >= 28 && pi.signingInfo != null) {
            android.content.pm.SigningInfo d = pi.signingInfo;
            android.content.pm.Signature[] arr = d.hasMultipleSigners()
                ? d.getApkContentsSigners() : d.getSigningCertificateHistory();
            if (arr != null) for (android.content.pm.Signature s : arr) sb.append(sha256(s.toByteArray())).append(';');
        } else if (pi.signatures != null) {
            for (android.content.pm.Signature s : pi.signatures) sb.append(sha256(s.toByteArray())).append(';');
        }
        return sb.length() == 0 ? null : sb.toString();
    }

    private static String sha256(byte[] b) throws Exception {
        MessageDigest md = MessageDigest.getInstance("SHA-256");
        byte[] d = md.digest(b);
        StringBuilder sb = new StringBuilder();
        for (byte x : d) sb.append(String.format("%02x", x));
        return sb.toString();
    }

    private static JSONObject getJson(String url) throws Exception {
        String cur = url;
        for (int hop = 0; hop < 5; hop++) {
            java.net.URL u = new java.net.URL(cur);
            java.net.HttpURLConnection c = (java.net.HttpURLConnection) u.openConnection();
            c.setConnectTimeout(12000);
            c.setReadTimeout(12000);
            c.setInstanceFollowRedirects(false);
            c.setRequestProperty("User-Agent", UA);
            c.setRequestProperty("Accept", "application/vnd.github+json");
            int code = c.getResponseCode();
            if (code >= 300 && code < 400) {
                String loc = c.getHeaderField("Location");
                c.disconnect();
                if (loc == null || loc.isEmpty()) throw new Exception("重定向缺少 Location");
                cur = new java.net.URL(u, loc).toString();
                continue;
            }
            if (code == 404) { c.disconnect(); throw new Exception("仓库还没有发布任何 Release"); }
            if (code >= 400) { c.disconnect(); throw new Exception("GitHub 返回 HTTP " + code); }
            try (InputStream in = c.getInputStream()) {
                java.io.ByteArrayOutputStream bos = new java.io.ByteArrayOutputStream();
                byte[] buf = new byte[4096];
                int n;
                while ((n = in.read(buf)) > 0) bos.write(buf, 0, n);
                return new JSONObject(new String(bos.toByteArray(), "UTF-8"));
            } finally {
                c.disconnect();
            }
        }
        throw new Exception("重定向次数过多");
    }
}
