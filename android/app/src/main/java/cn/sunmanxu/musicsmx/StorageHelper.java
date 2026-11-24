package cn.sunmanxu.musicsmx;

import android.content.Context;
import android.util.Base64;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;

/**
 * 应用沙盒内的文件读写工具 + 封面/歌词三级缓存的磁盘实现。
 * 缓存文件命名与桌面版 online.js 完全一致：<safeName(歌手 - 歌名)>.jpg / .lrc / .lrc.json（边车）
 */
public class StorageHelper {

    private static final String TAG = "StorageHelper";

    // ---------------- 基础工具 ----------------

    public static String readText(File f) throws IOException {
        byte[] b = new byte[(int) f.length()];
        FileInputStream in = new FileInputStream(f);
        try {
            int off = 0;
            while (off < b.length) {
                int r = in.read(b, off, b.length - off);
                if (r <= 0) break;
                off += r;
            }
        } finally {
            in.close();
        }
        return new String(b, StandardCharsets.UTF_8);
    }

    public static void writeText(File f, String text) throws IOException {
        File parent = f.getParentFile();
        if (parent != null && !parent.exists()) parent.mkdirs();
        FileOutputStream out = new FileOutputStream(f);
        try {
            out.write(text.getBytes(StandardCharsets.UTF_8));
        } finally {
            out.close();
        }
    }

    /** 对齐桌面版 safeName：去掉 Windows 非法字符，截断 120 字 */
    public static String safeName(String s) {
        if (s == null) s = "";
        String r = s.replaceAll("[\\\\/:*?\"<>|]", "_").trim();
        return r.length() > 120 ? r.substring(0, 120) : r;
    }

    public static Context appCtx;

    /** 软件数据目录（与桌面 userData 同等地位） */
    public static File dataDir(Context ctx) {
        File d = ctx.getFilesDir();
        if (!d.exists()) d.mkdirs();
        return d;
    }

    /** 封面/歌词缓存默认目录：外部应用私有目录，文件管理器能看见，不需要任何权限 */
    public static File defaultCacheDir(Context ctx) {
        File base = ctx.getExternalFilesDir(null);
        if (base == null) base = ctx.getFilesDir();
        File c = new File(base, "cache");
        if (!c.exists()) c.mkdirs();
        return c;
    }

    // ---------------- 封面 ----------------

    public JSONObject saveCover(String dataUrl, String saveDir, String artist, String title) {
        JSONObject r = new JSONObject();
        try {
            Context ctx = appCtx;
            File dir = (saveDir != null && !saveDir.isEmpty()) ? new File(saveDir) : defaultCacheDir(ctx);
            if (!dir.exists()) dir.mkdirs();
            if (dataUrl == null || !dataUrl.contains(",")) { r.put("ok", false); return r; }
            String b64 = dataUrl.substring(dataUrl.indexOf(',') + 1);
            byte[] bytes = Base64.decode(b64, Base64.DEFAULT);
            File f = new File(dir, safeName(artist + " - " + title) + ".jpg");
            FileOutputStream out = new FileOutputStream(f);
            try { out.write(bytes); } finally { out.close(); }
            r.put("ok", true);
            r.put("path", f.getAbsolutePath());
        } catch (Exception e) {
            try { r.put("ok", false); r.put("error", String.valueOf(e.getMessage())); } catch (Exception ignore) {}
        }
        return r;
    }

    public JSONObject readCoverFile(String filePath) {
        JSONObject r = new JSONObject();
        try {
            File f = new File(filePath);
            if (!f.exists()) { r.put("ok", false); r.put("error", "文件不存在"); return r; }
            // 0 字节的封面文件（上次写坏了）当"没有封面"：否则渲染层会拼出
            // "data:image/jpeg;base64," 这种空 data URL，界面上就是一张碎图标
            if (f.length() <= 0) { r.put("ok", false); r.put("error", "空文件"); return r; }
            String ext = "";
            int i = f.getName().lastIndexOf('.');
            if (i >= 0) ext = f.getName().substring(i + 1).toLowerCase();
            String mime = ext.equals("png") ? "image/png" : ext.equals("webp") ? "image/webp" : "image/jpeg";
            byte[] b = new byte[(int) f.length()];
            FileInputStream in = new FileInputStream(f);
            try {
                int off = 0;
                while (off < b.length) {
                    int n = in.read(b, off, b.length - off);
                    if (n <= 0) break;
                    off += n;
                }
            } finally { in.close(); }
            r.put("ok", true);
            r.put("dataUrl", "data:" + mime + ";base64," + Base64.encodeToString(b, Base64.NO_WRAP));
        } catch (Exception e) {
            try { r.put("ok", false); r.put("error", String.valueOf(e.getMessage())); } catch (Exception ignore) {}
        }
        return r;
    }

    // ---------------- 歌词（.lrc + .lrc.json 边车） ----------------

    public JSONObject saveLyrics(String lrcText, String tlyric, String rlyric, String yrc,
                                 String saveDir, String artist, String title, String metaSongName, String metaArtist) {
        JSONObject r = new JSONObject();
        try {
            Context ctx = appCtx;
            File dir = (saveDir != null && !saveDir.isEmpty()) ? new File(saveDir) : defaultCacheDir(ctx);
            if (!dir.exists()) dir.mkdirs();
            if (lrcText == null || lrcText.isEmpty()) { r.put("ok", false); return r; }
            String body = lrcText;
            if (metaSongName != null && !metaSongName.isEmpty() && !body.matches("(?i).*\\[ti:[^\\]]*\\].*")) {
                body = "[ti:" + metaSongName + "]\n" + body;
            }
            if (metaArtist != null && !metaArtist.isEmpty() && !body.matches("(?i).*\\[ar:[^\\]]*\\].*")) {
                body = "[ar:" + metaArtist + "]\n" + body;
            }
            File f = new File(dir, safeName(artist + " - " + title) + ".lrc");
            writeText(f, body);
            boolean hasExtra = notEmpty(tlyric) || notEmpty(rlyric) || notEmpty(yrc);
            if (hasExtra) {
                JSONObject side = new JSONObject();
                side.put("lrc", body);
                side.put("tlyric", tlyric == null ? "" : tlyric);
                side.put("rlyric", rlyric == null ? "" : rlyric);
                side.put("yrc", yrc == null ? "" : yrc);
                side.put("savedAt", System.currentTimeMillis());
                writeText(new File(f.getAbsolutePath() + ".json"), side.toString());
            }
            r.put("ok", true);
            r.put("path", f.getAbsolutePath());
        } catch (Exception e) {
            try { r.put("ok", false); r.put("error", String.valueOf(e.getMessage())); } catch (Exception ignore) {}
        }
        return r;
    }

    public JSONObject saveLyricOffset(String saveDir, String artist, String title, double offset) {
        JSONObject r = new JSONObject();
        try {
            Context ctx = appCtx;
            File dir = (saveDir != null && !saveDir.isEmpty()) ? new File(saveDir) : defaultCacheDir(ctx);
            double v = Math.round(offset * 10.0) / 10.0;
            File lrc = new File(dir, safeName(artist + " - " + title) + ".lrc");
            if (!lrc.exists()) { r.put("ok", false); return r; }
            File side = new File(lrc.getAbsolutePath() + ".json");
            JSONObject data;
            try { data = new JSONObject(readText(side)); } catch (Exception e) { data = new JSONObject(); }
            if (Math.abs(v) < 0.001) data.remove("offset"); else data.put("offset", v);
            data.put("savedAt", System.currentTimeMillis());
            writeText(side, data.toString());
            r.put("ok", true);
        } catch (Exception e) {
            try { r.put("ok", false); r.put("error", String.valueOf(e.getMessage())); } catch (Exception ignore) {}
        }
        return r;
    }

    public JSONObject readLyricsFile(String filePath) {
        JSONObject r = new JSONObject();
        try {
            File f = new File(filePath);
            if (!f.exists()) { r.put("ok", false); r.put("error", "文件不存在"); return r; }
            r.put("ok", true);
            r.put("text", readText(f));
        } catch (Exception e) {
            try { r.put("ok", false); r.put("error", String.valueOf(e.getMessage())); } catch (Exception ignore) {}
        }
        return r;
    }

    /** 扫描缓存目录，建立 key->path 索引（key 与桌面版一致：去掉扩展名的小写文件名） */
    public JSONObject scanLocalCache(String coverDir, String lyricsDir, JSONArray legacyDirs) {
        Context ctx = appCtx;
        JSONObject result = new JSONObject();
        JSONArray covers = new JSONArray();
        JSONArray lyrics = new JSONArray();
        try {
            File cDir = (coverDir != null && !coverDir.isEmpty()) ? new File(coverDir) : defaultCacheDir(ctx);
            File lDir = (lyricsDir != null && !lyricsDir.isEmpty()) ? new File(lyricsDir) : cDir;

            // 旧版分开设置的目录：把内容并进当前缓存目录（只做一次，失败忽略）
            if (legacyDirs != null) {
                for (int i = 0; i < legacyDirs.length(); i++) {
                    String p = legacyDirs.optString(i, "");
                    if (p.isEmpty()) continue;
                    File old = new File(p);
                    if (!old.isDirectory() || old.equals(cDir)) continue;
                    File[] fs = old.listFiles();
                    if (fs == null) continue;
                    for (File f : fs) {
                        if (!f.isFile()) continue;
                        File dst = new File(cDir, f.getName());
                        if (dst.exists()) continue;
                        if (!cDir.exists()) cDir.mkdirs();
                        try {
                            FileInputStream in = new FileInputStream(f);
                            FileOutputStream out = new FileOutputStream(dst);
                            byte[] buf = new byte[32768];
                            int n;
                            while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
                            in.close();
                            out.close();
                        } catch (Exception ignore) {}
                    }
                }
            }

            addFiles(cDir, "\\.(jpg|jpeg|png|webp)$", covers);
            if (!lDir.equals(cDir)) addFiles(lDir, "\\.lrc$", lyrics);
            else addFiles(cDir, "\\.lrc$", lyrics);

            result.put("covers", covers);
            result.put("lyrics", lyrics);
        } catch (Exception e) {
            Log.w(TAG, "scanLocalCache failed", e);
        }
        return result;
    }

    private void addFiles(File dir, String extRegex, JSONArray out) {
        if (dir == null || !dir.isDirectory()) return;
        File[] fs = dir.listFiles();
        if (fs == null) return;
        for (File f : fs) {
            if (!f.isFile()) continue;
            String name = f.getName();
            if (!name.toLowerCase().matches(".*" + extRegex)) continue;
            try {
                JSONObject o = new JSONObject();
                o.put("name", name);
                o.put("path", f.getAbsolutePath());
                o.put("key", name.replaceAll("(?i)" + extRegex, "").toLowerCase());
                out.put(o);
            } catch (Exception ignore) {}
        }
    }

    private static boolean notEmpty(String s) {
        return s != null && !s.trim().isEmpty();
    }
}
