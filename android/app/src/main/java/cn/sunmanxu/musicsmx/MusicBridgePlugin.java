package cn.sunmanxu.musicsmx;

import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.net.Uri;
import android.os.Build;
import android.provider.DocumentsContract;
import android.util.Base64;
import android.util.Log;

import androidx.activity.result.ActivityResult;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.security.MessageDigest;
import java.util.List;

/**
 * window.mb 的原生实现。
 * 铁律：方法名 / 参数 / 返回结构都与桌面版 preload.js 的 mb 契约 1:1 对齐；
 * 渲染层 app.js 一行业务逻辑都不改，只靠 www/native/bridge.js 做一层薄壳 + 事件转发。
 */
@CapacitorPlugin(name = "MusicBridge")
public class MusicBridgePlugin extends Plugin {

    private static final String TAG = "MusicBridge";
    private static final int BATCH = 20;

    private SafLib saf;
    private MediaServer mediaServer;
    private StorageHelper storage;

    // ==================== 曲库缓存（第二次启动不再重扫） ====================
    // 两条缓存：
    //  1) library-cache.json —— 上一次扫出来的完整曲目表（去掉内嵌封面，封面由渲染层按需自取）
    //  2) tag-index.json     —— 每个文件的「大小 + 修改时间 → 标题/歌手/专辑」指纹，
    //     文件没变就直接复用解析结果，不再去拆 ID3/FLAC（重扫时慢的就是这一步）
    private static final String LIB_CACHE_FILE = "library-cache.json";
    private static final String TAG_INDEX_FILE = "tag-index.json";
    private JSONObject libCache;
    private JSONObject tagIndex;
    private boolean tagIndexDirty = false;
    private volatile boolean refreshingLib = false;

    private File libCacheFile() { return new File(getContext().getFilesDir(), LIB_CACHE_FILE); }
    private File tagIndexFile() { return new File(getContext().getFilesDir(), TAG_INDEX_FILE); }

    private JSONObject libCache() {
        if (libCache == null) {
            libCache = new JSONObject();
            try {
                File f = libCacheFile();
                if (f.exists() && f.length() > 0) {
                    libCache = new JSONObject(readText(f));
                }
            } catch (Exception e) {
                Log.w(TAG, "library cache unreadable, ignore", e);
                libCache = new JSONObject();
            }
        }
        return libCache;
    }

    private JSONObject tagIndexOf() {
        if (tagIndex == null) {
            tagIndex = new JSONObject();
            try {
                File f = tagIndexFile();
                if (f.exists() && f.length() > 0) tagIndex = new JSONObject(readText(f));
            } catch (Exception e) {
                tagIndex = new JSONObject();
            }
        }
        return tagIndex;
    }

    private static String readText(File f) throws Exception {
        try (java.io.FileInputStream in = new java.io.FileInputStream(f)) {
            byte[] b = new byte[(int) f.length()];
            int off = 0;
            while (off < b.length) {
                int n = in.read(b, off, b.length - off);
                if (n <= 0) break;
                off += n;
            }
            return new String(b, 0, off, java.nio.charset.StandardCharsets.UTF_8);
        }
    }

    private static void writeText(File f, String text) throws Exception {
        File tmp = new File(f.getAbsolutePath() + ".tmp");
        try (java.io.FileOutputStream out = new java.io.FileOutputStream(tmp)) {
            out.write(text.getBytes(java.nio.charset.StandardCharsets.UTF_8));
        }
        if (!tmp.renameTo(f)) {
            // 部分 ROM 的 rename 不覆盖已有文件：先删再改名
            if (f.exists()) f.delete();
            tmp.renameTo(f);
        }
    }

    private static String rootsKey(String[] inputs, boolean recursive) {
        String[] copy = inputs.clone();
        java.util.Arrays.sort(copy);
        StringBuilder sb = new StringBuilder();
        for (String s : copy) sb.append(s).append('\n');
        sb.append(recursive ? "r" : "f");
        return sb.toString();
    }

    /** 落盘曲库：去掉 cover（内嵌封面单张可能几百 KB，1380 首会让缓存文件爆到上百 MB） */
    private void saveLibraryCache(String key, JSONArray tracks) {
        try {
            JSONArray slim = new JSONArray();
            for (int i = 0; i < tracks.length(); i++) {
                JSONObject t = tracks.optJSONObject(i);
                if (t == null) continue;
                JSONObject c = new JSONObject(t.toString());
                c.remove("cover");
                slim.put(c);
            }
            JSONObject root = new JSONObject();
            root.put("key", key);
            root.put("builtAt", System.currentTimeMillis());
            root.put("tracks", slim);
            libCache = root;
            writeText(libCacheFile(), root.toString());
        } catch (Exception e) {
            Log.w(TAG, "save library cache failed", e);
        }
    }

    /** 后台校正：曲库文件没变就什么都不做，变了才落盘并通知渲染层 */
    private void refreshLibraryInBackground(final String[] inputs, final boolean recursive, final String key) {
        if (refreshingLib) return;
        refreshingLib = true;
        new Thread(() -> {
            try {
                List<SafLib.Found> files = saf.collect(inputs, recursive);
                JSArray fresh = new JSArray();
                for (SafLib.Found f : files) {
                    try { add(fresh, trackFrom(f)); } catch (Exception ignore) {}
                }
                persistTagIndex();
                JSONArray old = libCache().optJSONArray("tracks");
                int added = 0, removed = 0, changed = 0;
                java.util.Set<String> oldPaths = new java.util.HashSet<>();
                java.util.Map<String, String> oldStamp = new java.util.HashMap<>();
                if (old != null) {
                    for (int i = 0; i < old.length(); i++) {
                        JSONObject o = old.optJSONObject(i);
                        if (o == null) continue;
                        String p = o.optString("path");
                        oldPaths.add(p);
                        oldStamp.put(p, o.optLong("size") + ":" + o.optLong("mtimeMs"));
                    }
                }
                java.util.Set<String> newPaths = new java.util.HashSet<>();
                for (int i = 0; i < fresh.length(); i++) {
                    JSONObject o = fresh.optJSONObject(i);
                    if (o == null) continue;
                    String p = o.optString("path");
                    newPaths.add(p);
                    String stamp = o.optLong("size") + ":" + o.optLong("mtimeMs");
                    if (!oldPaths.contains(p)) added++;
                    else if (!stamp.equals(oldStamp.get(p))) changed++;
                }
                for (String p : oldPaths) if (!newPaths.contains(p)) removed++;
                boolean differ = added > 0 || removed > 0 || changed > 0 || old == null;
                if (differ) {
                    saveLibraryCache(key, fresh);
                    JSONObject ev = new JSONObject();
                    ev.put("added", added);
                    ev.put("removed", removed);
                    ev.put("changed", changed);
                    ev.put("total", fresh.length());
                    emit("__libraryChanged", ev);
                    Log.i(TAG, "library changed added=" + added + " removed=" + removed + " changed=" + changed);
                } else {
                    Log.i(TAG, "library unchanged (" + fresh.length() + " tracks), cache reused");
                }
            } catch (Exception e) {
                Log.w(TAG, "background refresh failed", e);
            } finally {
                refreshingLib = false;
            }
        }, "library-refresh").start();
    }

    private void persistTagIndex() {
        if (!tagIndexDirty || tagIndex == null) return;
        try {
            writeText(tagIndexFile(), tagIndex.toString());
            tagIndexDirty = false;
        } catch (Exception e) {
            Log.w(TAG, "save tag index failed", e);
        }
    }

    @Override
    public void load() {
        Context ctx = getContext();
        StorageHelper.appCtx = ctx.getApplicationContext();
        storage = new StorageHelper();
        saf = new SafLib(ctx);
        mediaServer = new MediaServer(ctx, saf);
        int port = mediaServer.start();
        Log.i(TAG, "media server on 127.0.0.1:" + port);
        PlaybackService.setSink((action, seekMs) -> {
            String js = "window.__mbMediaAction&&window.__mbMediaAction(" + JSONObject.quote(action) + "," + seekMs + ")";
            runJs(js);
        });
        // 1.0.7：顶部歌词条整体下线，插件起来先把它清掉（老版本残留/权限还在的情况）
        TopLyric.hide();
    }

    // ---------- 安全 put 包装（org.json 的 put 抛受检异常，全部收口在这里） ----------

    private static JSObject jo() { return new JSObject(); }

    private static JSObject set(JSObject o, String k, Object v) {
        try { o.put(k, v); } catch (Exception ignore) {}
        return o;
    }

    /** 一次塞两对键值，等价于链式 set().set() */
    private static JSObject set(JSObject o, String k1, Object v1, String k2, Object v2) {
        return set(set(o, k1, v1), k2, v2);
    }

    private static JSArray add(JSArray a, Object v) {
        try { a.put(v); } catch (Exception ignore) {}
        return a;
    }

    private static JSObject wrap(JSONObject o) {
        if (o instanceof JSObject) return (JSObject) o;
        try { return new JSObject(o.toString()); } catch (Exception e) { return new JSObject(); }
    }

    private void runJs(String js) {
        try {
            Activity a = getActivity();
            if (a != null) a.runOnUiThread(() -> bridge.getWebView().evaluateJavascript(js, null));
        } catch (Exception e) {
            Log.w(TAG, "runJs failed", e);
        }
    }

    private void emit(String channel, JSONObject data) {
        runJs("window.__mbEmit&&window.__mbEmit(" + JSONObject.quote(channel) + "," + data + ")");
    }

    // ==================== 目录选择 / 扫描 ====================

    /**
     * 把系统栏 insets 报给渲染层（网页自己 top:100vh 的边距靠它）。
     * MainActivity 会在 insets 变化时主动推；这里提供一次"启动时主动拉"的入口，
     * 避免 WebView 还没加载完、push 打在空页面上丢掉。
     */
    @PluginMethod
    public void getInsets(PluginCall call) {
        JSObject o = jo();
        int t = 0, r = 0, b = 0, l = 0;
        int decorH = 0, contentH = 0, wvH = 0, wvTop = 0;
        try {
            Activity a = getActivity();
            android.view.View decor = a.getWindow().getDecorView();
            decorH = decor.getHeight();
            androidx.core.view.WindowInsetsCompat wi = androidx.core.view.ViewCompat.getRootWindowInsets(decor);
            if (wi != null) {
                androidx.core.graphics.Insets bars = wi.getInsets(
                    androidx.core.view.WindowInsetsCompat.Type.systemBars()
                        | androidx.core.view.WindowInsetsCompat.Type.displayCutout());
                t = bars.top; r = bars.right; b = bars.bottom; l = bars.left;
            }
            android.view.View content = a.findViewById(android.R.id.content);
            if (content != null) contentH = content.getHeight();
            android.view.View wv = bridge.getWebView();
            if (wv != null) {
                wvH = wv.getHeight();
                int[] loc = new int[2];
                wv.getLocationOnScreen(loc);
                wvTop = loc[1];
            }
        } catch (Exception e) {
            Log.w(TAG, "getInsets failed", e);
        }
        float dens = getContext().getResources().getDisplayMetrics().density;
        set(o, "top", Math.round(t / dens));
        set(o, "right", Math.round(r / dens));
        set(o, "bottom", Math.round(b / dens));
        set(o, "left", Math.round(l / dens));
        set(o, "decorH", decorH);
        set(o, "contentH", contentH);
        set(o, "webViewH", wvH);
        set(o, "webViewTop", wvTop);
        // 视图链诊断：看看到底是谁把内容裁到了系统栏里面
        try {
            Activity a = getActivity();
            StringBuilder sb = new StringBuilder();
            android.view.View v = a.getWindow().getDecorView();
            int[] loc = new int[2];
            int depth = 0;
            while (v != null && depth < 6) {
                v.getLocationOnScreen(loc);
                sb.append(depth).append(':').append(v.getClass().getSimpleName())
                   .append(" h=").append(v.getHeight())
                   .append(" top=").append(loc[1])
                   .append(" padT=").append(v.getPaddingTop())
                   .append(" fits=").append(v.getFitsSystemWindows() ? 1 : 0);
                if (v instanceof android.view.ViewGroup && ((android.view.ViewGroup) v).getChildCount() > 0) {
                    sb.append(" > ");
                    v = ((android.view.ViewGroup) v).getChildAt(0);
                } else {
                    sb.append(" | ");
                    v = null;
                }
                depth++;
            }
            Log.i(TAG, "viewChain " + sb);
        } catch (Exception ignore) {}

        Log.i(TAG, "getInsets t=" + t + " b=" + b + " decorH=" + decorH + " contentH=" + contentH
            + " wvH=" + wvH + " wvTop=" + wvTop);
        call.resolve(o);
    }

    @PluginMethod
    public void pickFolders(PluginCall call) {
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE);
        intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION
            | Intent.FLAG_GRANT_WRITE_URI_PERMISSION
            | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION
            | Intent.FLAG_GRANT_PREFIX_URI_PERMISSION);
        startActivityForResult(call, intent, "pickTreeResult");
    }

    @ActivityCallback
    private void pickTreeResult(PluginCall call, ActivityResult result) {
        if (call == null) return;
        JSArray arr = new JSArray();
        if (result.getResultCode() != Activity.RESULT_OK || result.getData() == null || result.getData().getData() == null) {
            call.resolve(set(jo(), "paths", arr));
            return;
        }
        Uri tree = result.getData().getData();
        try {
            getContext().getContentResolver().takePersistableUriPermission(tree,
                Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
        } catch (Exception e) {
            Log.w(TAG, "takePersistableUriPermission failed", e);
        }
        add(arr, saf.addTree(tree));
        call.resolve(set(jo(), "paths", arr));
    }

    /** 单文件选择（桌面版 pickLyricsFile 的等价：SAF 里挑一个 .lrc 文件） */
    @PluginMethod
    public void pickLyricsFile(PluginCall call) {
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType("*/*");
        startActivityForResult(call, intent, "pickFileResult");
    }

    @ActivityCallback
    private void pickFileResult(PluginCall call, ActivityResult result) {
        if (call == null) return;
        if (result.getResultCode() != Activity.RESULT_OK || result.getData() == null || result.getData().getData() == null) {
            call.resolve(set(jo(), "path", JSONObject.NULL));
            return;
        }
        Uri uri = result.getData().getData();
        try {
            getContext().getContentResolver().takePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION);
        } catch (Exception ignore) {}
        String docId = null;
        try { docId = DocumentsContract.getDocumentId(uri); } catch (Exception ignore) {}
        call.resolve(set(jo(), "path", docId == null ? JSONObject.NULL : saf.pathOfDocId(docId)));
    }

    /** 扫描：异步分批（每批 20 个），每批推一次进度 —— 同步遍历上千首会卡死 WebView（桌面版老坑） */
    @PluginMethod
    public void scan(PluginCall call) {
        JSArray pathsArr = call.getArray("paths");
        Boolean recursive = call.getBoolean("recursive", Boolean.TRUE);
        JSArray tracks = new JSArray();
        if (pathsArr == null) {
            call.resolve(set(jo(), "tracks", tracks));
            return;
        }
        String[] inputs = new String[pathsArr.length()];
        for (int i = 0; i < pathsArr.length(); i++) inputs[i] = pathsArr.optString(i, "");

        boolean recurs = recursive == null || recursive;
        String key = rootsKey(inputs, recurs);
        boolean preferCache = Boolean.TRUE.equals(call.getBoolean("preferCache", Boolean.FALSE));

        // 启动装载：同一批目录、缓存还在 → 先把上次的曲库秒回去，真正扫库放到后台校正。
        // 这样"杀掉进程再进软件"不用等几千首重新拆标签。
        if (preferCache) {
            JSONArray cached = libCache().optJSONArray("tracks");
            if (cached != null && cached.length() > 0 && key.equals(libCache().optString("key"))) {
                JSObject out = set(jo(), "tracks", cached, "cached", Boolean.TRUE);
                call.resolve(out);
                refreshLibraryInBackground(inputs, recurs, key);
                Log.i(TAG, "scan: served cached library, " + cached.length() + " tracks");
                return;
            }
        }

        List<SafLib.Found> files = saf.collect(inputs, recurs);
        int total = files.size();
        Log.i(TAG, "scan inputs=" + inputs.length + " recursive=" + (recursive == null || recursive)
            + " roots=" + saf.rootPaths() + " found=" + total);
        if (total == 0) {
            // 扫不出歌时把每一环的诊断一起回给渲染层（打印到 logcat，测试期证据就靠它）
            JSArray dbg = new JSArray();
            for (String in : inputs) {
                try {
                    JSONObject d = saf.diagnose(in);
                    Log.w(TAG, "scan empty diag: " + d);
                    dbg.put(d);
                } catch (Exception ignore) {}
            }
            JSObject empty = jo();
            empty.put("tracks", tracks);
            empty.put("debug", dbg);
            call.resolve(empty);
            return;
        }
        for (int i = 0; i < total; i += BATCH) {
            int end = Math.min(i + BATCH, total);
            for (int j = i; j < end; j++) {
                try {
                    add(tracks, trackFrom(files.get(j)));
                } catch (Exception e) {
                    Log.w(TAG, "track failed", e);
                }
            }
            try {
                JSONObject p = jo();
                p.put("done", end);
                p.put("total", total);
                emit("__scanProgress", p);
            } catch (Exception ignore) {}
            Thread.yield(); // 让出时间片，保持 UI 可交互
        }
        persistTagIndex();
        saveLibraryCache(key, tracks);
        call.resolve(set(jo(), "tracks", tracks));
    }

    /**
     * 取标签：文件「大小 + 修改时间」没变就直接用上次解析的结果（tag-index.json），
     * 不再去拆 ID3/FLAC —— 重扫上千首慢的就是这一步。
     * 注意：指纹缓存里不存内嵌封面（单张可能几百 KB），复用条目时 cover 为空，
     * 渲染层会按自己的封面缓存/联网补封面（settings.autoCover 已有这条链路）。
     */
    private TagReader.Meta tagsFor(SafLib.Found f, String name) {
        try {
            JSONObject idx = tagIndexOf();
            JSONObject ent = idx.optJSONObject(f.path);
            if (ent != null && ent.optLong("s", -2) == f.size && ent.optLong("m", -2) == f.mtime) {
                TagReader.Meta cachedMeta = new TagReader.Meta();
                cachedMeta.title = ent.optString("t", "");
                cachedMeta.artist = ent.optString("a", "");
                cachedMeta.album = ent.optString("l", "");
                return cachedMeta;
            }
            TagReader.Meta meta = TagReader.read(getContext(), saf.docUriForPath(f.path), name);
            JSONObject e = new JSONObject();
            e.put("s", f.size);
            e.put("m", f.mtime);
            e.put("t", meta.title);
            e.put("a", meta.artist);
            e.put("l", meta.album);
            idx.put(f.path, e);
            tagIndexDirty = true;
            return meta;
        } catch (Exception e) {
            // 索引出问题就退回同步解析，功能不能因为缓存挂掉
            try {
                return TagReader.read(getContext(), saf.docUriForPath(f.path), name);
            } catch (Exception e2) {
                TagReader.Meta m = new TagReader.Meta();
                return m;
            }
        }
    }

    private JSONObject trackFrom(SafLib.Found f) throws Exception {
        String name = f.path.substring(f.path.lastIndexOf('/') + 1);
        TagReader.Meta meta = tagsFor(f, name);
        String[] guess = guessFromName(name);
        JSONObject t = jo();
        t.put("path", f.path);
        t.put("root", f.root);
        t.put("name", name);
        t.put("title", !meta.title.isEmpty() ? meta.title : (!guess[1].isEmpty() ? guess[1] : name));
        t.put("artist", !meta.artist.isEmpty() ? meta.artist : (!guess[0].isEmpty() ? guess[0] : "未知歌手"));
        // 文件名形如「歌手 - 标题 - 专辑」时，第三段就是专辑，别写死"未知专辑"
        String alb = !meta.album.isEmpty() ? meta.album : (!guess[2].isEmpty() ? guess[2] : "未知专辑");
        t.put("album", alb);
        if (meta.cover != null) t.put("cover", meta.cover); else t.put("cover", JSONObject.NULL);
        t.put("size", f.size);
        t.put("mtimeMs", f.mtime);
        return t;
    }

    /**
     * 文件名兜底解析「歌手 - 标题」。
     * 「A - B - C」这种三段命名（歌单常见「歌手 - 标题 - 专辑」）以前会把 B 和 C 一起当标题
     * （"Beautiful - Beautiful"），拿去联网搜必然搜不到——这里按三段切开，返回 {歌手, 标题, 专辑}。
     */
    private static String[] guessFromName(String name) {
        String base = name.replaceAll("\\.[^.]+$", "");
        base = base.replaceAll("^\\d+[\\s._-]+", "");
        String[] parts = base.split("\\s+[-－—]\\s+");
        if (parts.length >= 3) {
            return new String[]{parts[0].trim(), parts[1].trim(), parts[2].trim()};
        }
        if (parts.length == 2) {
            return new String[]{parts[0].trim(), parts[1].trim(), ""};
        }
        // 没有空格分隔的老写法（"歌手-标题"）：仍按第一个连字符切，别把 "A-Lin" 这类艺名拆坏
        java.util.regex.Matcher m = java.util.regex.Pattern.compile("^(.+?)\\s*[-－—]\\s*(.+)$").matcher(base);
        if (m.find()) return new String[]{m.group(1).trim(), m.group(2).trim(), ""};
        return new String[]{"", base.trim(), ""};
    }

    @PluginMethod
    public void readFileTags(PluginCall call) {
        String path = call.getString("path", call.getString("filePath", ""));
        JSObject out = jo();
        try {
            Uri u = saf.docUriForPath(path == null ? "" : path);
            if (u == null) { call.resolve(out); return; }
            String name = path.substring(path.lastIndexOf('/') + 1);
            TagReader.Meta meta = TagReader.read(getContext(), u, name);
            out.put("title", meta.title);
            out.put("artist", meta.artist);
            out.put("album", meta.album);
            if (meta.cover != null) out.put("cover", meta.cover);
        } catch (Exception e) {
            Log.w(TAG, "readFileTags failed", e);
        }
        call.resolve(out);
    }

    @PluginMethod
    public void fileExists(PluginCall call) {
        String path = call.getString("path", "");
        call.resolve(set(jo(), "exists", saf.exists(path == null ? "" : path)));
    }

    // ==================== 配置持久化（整份读写，绝不字段级合并） ====================

    private File configFile() {
        return new File(StorageHelper.dataDir(getContext()), "config.json");
    }

    /** 读一份 JSON 配置；空文件/损坏都当没读到，返回 null */
    private JSObject readConfigFile(File f) {
        try {
            if (f == null || !f.exists() || f.length() <= 0) return null;
            String s = StorageHelper.readText(f);
            if (s == null || s.trim().isEmpty()) return null;
            JSObject o = new JSObject(s);
            // 只认 json 对象；数组/破损内容会让渲染层直接崩，所以宁可不给
            if (!(o instanceof JSObject)) return null;
            return o;
        } catch (Exception e) {
            return null;
        }
    }

    /**
     * 读配置。曲库条目都在 config.json 里，一旦读到空文件就等于「用户的曲库突然全没了」，
     * 所以这里按 config.json → config.json.tmp → config.json.bak 依次兜底。
     */
    /**
     * 安卓端强制关掉均衡器（1.0.4 起界面里已经没有 EQ 了）。
     *
     * 桌面版的 EQ 是真的 AudioContext + createMediaElementSource 音频图：
     * 一旦搭起来，<audio> 的音频就永久改走 Web Audio；而 WebView 里 AudioContext 大概率
     * 停在 suspended（自动播放策略），于是「在播、但一点声音都没有」。
     * 老配置里 settings.eq.on 还是 true，所以必须在渲染层读到配置之前就把它改成 off，
     * 否则 app.js 的 initEqFromSettings() 会把这条静音的链搭起来（用户这次遇到的就是这个）。
     */
    private boolean sanitizeEq(JSONObject cfg) {
        if (cfg == null) return false;
        JSONObject st = cfg.optJSONObject("settings");
        if (st == null) return false;
        JSONObject eq = st.optJSONObject("eq");
        if (eq == null || !eq.optBoolean("on", false)) return false;
        try {
            eq.put("on", false);
            eq.put("preamp", 0);
            eq.put("preset", "flat");
            JSONArray flat = new JSONArray();
            for (int i = 0; i < 10; i++) flat.put(0);
            eq.put("gains", flat);
            st.put("eq", eq);
            cfg.put("settings", st);
        } catch (Exception ignore) {}
        return true;
    }

    @PluginMethod
    public void getConfig(PluginCall call) {
        File dir = StorageHelper.dataDir(getContext());
        File dst = configFile();
        JSObject o = readConfigFile(dst);
        // 正常写入时留的"好副本"：比 .bak 更可靠（.bak 只在换文件那一刻才更新）
        if (o == null) o = readConfigFile(new File(dir, "config.json.good"));
        if (o == null) o = readConfigFile(new File(dir, "config.json.tmp"));
        if (o == null) o = readConfigFile(new File(dir, "config.json.bak"));
        if (o == null) o = jo();

        // 自愈：配置里没有 folders（被写成空文件/损坏）但 SAF 授权还在 —— 用授权目录把曲库找回来，
        // 渲染层启动时会按 cfg.folders 重扫，等于自动恢复，不用用户重新选目录。
        JSONArray folders = o.optJSONArray("folders");
        if (folders == null || folders.length() == 0) {
            try {
                List<String> roots = saf.rootPaths();
                if (roots != null && !roots.isEmpty()) {
                    JSONArray arr = new JSONArray();
                    for (String r : roots) arr.put(r);
                    o.put("folders", arr);
                    Log.i(TAG, "getConfig: folders 丢失，已按 SAF 授权恢复 " + roots.size() + " 个目录");
                }
            } catch (Exception ignore) {}
        }
        // 旧配置里若还留着「均衡器已启用」：强制改成关闭再交给渲染层，
        // 顺手把磁盘上的那份也改掉（否则每次启动都要再修一遍）
        if (sanitizeEq(o)) {
            try {
                writeText(configFile(), o.toString());
                Log.i(TAG, "getConfig: 旧配置的均衡器已强制关闭（避免 AudioContext 静音）");
            } catch (Exception ignore) {}
        }
        call.resolve(o);
    }

    @PluginMethod
    public void setConfig(PluginCall call) {
        try {
            JSObject cfg = call.getObject("cfg");
            if (cfg == null) cfg = call.getObject("config");
            if (cfg == null) cfg = jo();
            // 渲染层回写配置时也保证 EQ 是关的（双保险）
            sanitizeEq(cfg);
            File dir = StorageHelper.dataDir(getContext());
            File tmp = new File(dir, "config.json.tmp");
            File dst = configFile();
            File bak = new File(dir, "config.json.bak");
            File good = new File(dir, "config.json.good");
            String body = cfg.toString();
            // 空内容绝不落盘：写进去就等于"曲库/设置凭空没了"，不如保留旧的那份
            if (body == null || body.trim().isEmpty() || body.trim().equals("null")) {
                call.resolve(set(set(jo(), "ok", false), "error", "空配置已拒绝写入"));
                return;
            }
            StorageHelper.writeText(tmp, body);
            if (!tmp.exists() || tmp.length() <= 0) {
                call.resolve(set(set(jo(), "ok", false), "error", "临时文件写入失败"));
                return;
            }
            // 先留一份备份再换：宁可多一份旧配置，也不要出现「config.json 不见了」的窗口
            if (dst.exists()) {
                if (bak.exists()) bak.delete();
                dst.renameTo(bak);
            }
            boolean ok = tmp.renameTo(dst);
            if (!ok && bak.exists()) bak.renameTo(dst); // 换失败就把备份还回去
            if (dst.exists() && dst.length() > 0) {
                try { StorageHelper.writeText(good, body); } catch (Exception ignore) {}
            }
            call.resolve(set(jo(), "ok", ok || dst.exists()));
        } catch (Exception e) {
            Log.w(TAG, "setConfig failed", e);
            call.resolve(set(set(jo(), "ok", false), "error", String.valueOf(e.getMessage())));
        }
    }

    @PluginMethod
    public void getInheritInfo(PluginCall call) {
        call.resolve(set(jo(), "value", JSONObject.NULL)); // 安卓没有便携版继承
    }

    @PluginMethod
    public void getDefaultDirs(PluginCall call) {
        Context ctx = getContext();
        File cache = StorageHelper.defaultCacheDir(ctx);
        String userData = StorageHelper.dataDir(ctx).getAbsolutePath();
        JSObject o = jo();
        set(o, "cache", cache.getAbsolutePath());
        set(o, "covers", cache.getAbsolutePath());
        set(o, "lyrics", cache.getAbsolutePath());
        set(o, "userData", userData);
        call.resolve(o);
    }

    // ==================== 封面 / 歌词缓存 ====================

    @PluginMethod
    public void scanLocalCache(PluginCall call) {
        String coverDir = call.getString("coverDir", "");
        String lyricsDir = call.getString("lyricsDir", "");
        JSArray legacy = call.getArray("legacyDirs");
        try {
            JSONObject r = storage.scanLocalCache(coverDir, lyricsDir, legacy == null ? new JSONArray() : legacy);
            call.resolve(wrap(r));
        } catch (Exception e) {
            JSObject empty = jo();
            set(empty, "covers", new JSArray());
            set(empty, "lyrics", new JSArray());
            call.resolve(empty);
        }
    }

    @PluginMethod
    public void readCoverFile(PluginCall call) {
        call.resolve(wrap(storage.readCoverFile(call.getString("filePath", ""))));
    }

    // ==================== 列表缩略封面（1.0.12） ====================
    // 列表每行左侧要一张小封面。内嵌封面原图动辄几百 KB，1380 首全塞进 WebView 会把内存打爆，
    // 所以这里不返回原图：解标签 → 居中裁方 → 缩到 96px → JPEG(质量 78) → 落到 cacheDir/thumbs
    // （约 3~5KB/张，按“路径 MD5”命名），第二次直接读文件。解析跑在后台线程，不堵 UI。
    private File thumbDir() {
        File d = new File(getContext().getCacheDir(), "thumbs");
        if (!d.exists()) d.mkdirs();
        return d;
    }

    private String thumbKey(String path) {
        try {
            MessageDigest md = MessageDigest.getInstance("MD5");
            byte[] b = md.digest(path.getBytes("UTF-8"));
            StringBuilder sb = new StringBuilder();
            for (byte x : b) sb.append(String.format("%02x", x));
            return sb.toString();
        } catch (Exception e) {
            return "t" + path.hashCode();
        }
    }

    private String jpegFileToDataUrl(File f) {
        try {
            byte[] b = new byte[(int) f.length()];
            FileInputStream in = new FileInputStream(f);
            int off = 0, n;
            while (off < b.length && (n = in.read(b, off, b.length - off)) > 0) off += n;
            in.close();
            if (off <= 0) return null;
            return "data:image/jpeg;base64," + Base64.encodeToString(b, Base64.NO_WRAP);
        } catch (Exception e) {
            return null;
        }
    }

    private byte[] makeSquareThumb(byte[] raw, int size) {
        try {
            BitmapFactory.Options probe = new BitmapFactory.Options();
            probe.inJustDecodeBounds = true;
            BitmapFactory.decodeByteArray(raw, 0, raw.length, probe);
            int w = probe.outWidth, h = probe.outHeight;
            if (w <= 0 || h <= 0) return null;
            int sample = 1;
            int min = Math.min(w, h);
            while (min / (sample * 2) >= size * 2) sample *= 2;
            BitmapFactory.Options opt = new BitmapFactory.Options();
            opt.inSampleSize = sample;
            Bitmap bmp = BitmapFactory.decodeByteArray(raw, 0, raw.length, opt);
            if (bmp == null) return null;
            int bw = bmp.getWidth(), bh = bmp.getHeight();
            int side = Math.min(bw, bh);
            Bitmap square = Bitmap.createBitmap(bmp, (bw - side) / 2, (bh - side) / 2, side, side);
            Bitmap out = Bitmap.createScaledBitmap(square, size, size, true);
            ByteArrayOutputStream bos = new ByteArrayOutputStream();
            out.compress(Bitmap.CompressFormat.JPEG, 78, bos);
            if (square != bmp && !square.isRecycled()) square.recycle();
            if (!bmp.isRecycled()) bmp.recycle();
            if (!out.isRecycled()) out.recycle();
            return bos.toByteArray();
        } catch (Throwable t) {
            return null;
        }
    }

    @PluginMethod
    public void readThumb(PluginCall call) {
        final String path = call.getString("path", "");
        final String key = call.getString("key", "");
        final int size = Math.max(48, Math.min(256, call.getInt("size", 96)));
        // 两种模式：给 path = 现场解内嵌标签并缩图；给 key = 只查已落盘的缩略图（联网抓的封面走这个）
        if ((path == null || path.isEmpty()) && (key == null || key.isEmpty())) {
            JSObject o = new JSObject();
            o.put("ok", false);
            call.resolve(o);
            return;
        }
        final File cacheFile = new File(thumbDir(), thumbKey((key != null && !key.isEmpty()) ? key : path) + ".jpg");
        if (cacheFile.exists() && cacheFile.length() > 0) {
            String d = jpegFileToDataUrl(cacheFile);
            JSObject o = new JSObject();
            o.put("ok", d != null);
            o.put("dataUrl", d);
            o.put("cached", true);
            call.resolve(o);
            return;
        }
        if (path == null || path.isEmpty()) {
            JSObject o = new JSObject();
            o.put("ok", false);
            call.resolve(o);
            return;
        }
        new Thread(() -> {
            JSObject o = new JSObject();
            try {
                String name = new File(path).getName();
                TagReader.Meta meta = TagReader.read(getContext(), saf.docUriForPath(path), name);
                String cover = meta != null ? meta.cover : null;
                if (cover == null || cover.isEmpty() || cover.indexOf(',') < 0) {
                    o.put("ok", false);
                    call.resolve(o);
                    return;
                }
                byte[] raw = Base64.decode(cover.substring(cover.indexOf(',') + 1), Base64.DEFAULT);
                byte[] jpg = makeSquareThumb(raw, size);
                if (jpg == null) {
                    o.put("ok", false);
                    call.resolve(o);
                    return;
                }
                try {
                    FileOutputStream fos = new FileOutputStream(cacheFile);
                    fos.write(jpg);
                    fos.close();
                } catch (Exception ignore) {}
                o.put("ok", true);
                o.put("dataUrl", "data:image/jpeg;base64," + Base64.encodeToString(jpg, Base64.NO_WRAP));
                o.put("cached", false);
            } catch (Throwable t) {
                o.put("ok", false);
                Log.w(TAG, "readThumb 失败: " + path, t);
            }
            call.resolve(o);
        }).start();
    }

    @PluginMethod
    public void readLyricsFile(PluginCall call) {
        call.resolve(wrap(storage.readLyricsFile(call.getString("filePath", ""))));
    }

    @PluginMethod
    public void saveCover(PluginCall call) {
        call.resolve(wrap(storage.saveCover(
            call.getString("dataUrl", ""), call.getString("saveDir", ""),
            call.getString("artist", ""), call.getString("title", ""))));
    }

    /**
     * 保存一张已经缩好的缩略图（渲染层把联网抓来的封面用 canvas 缩到 96px 再送过来）。
     * 参数：{key, dataUrl}；key 一般是 "alb:歌手|专辑"，下次 readThumb({key}) 直接命中。
     */
    @PluginMethod
    public void saveThumb(PluginCall call) {
        String key = call.getString("key", "");
        String dataUrl = call.getString("dataUrl", "");
        JSObject o = new JSObject();
        if (key == null || key.isEmpty() || dataUrl == null || dataUrl.indexOf(',') < 0) {
            o.put("ok", false);
            call.resolve(o);
            return;
        }
        try {
            byte[] raw = Base64.decode(dataUrl.substring(dataUrl.indexOf(',') + 1), Base64.DEFAULT);
            File f = new File(thumbDir(), thumbKey(key) + ".jpg");
            FileOutputStream fos = new FileOutputStream(f);
            fos.write(raw);
            fos.close();
            o.put("ok", true);
        } catch (Throwable t) {
            Log.w(TAG, "saveThumb 失败: " + key, t);
            o.put("ok", false);
        }
        call.resolve(o);
    }

    @PluginMethod
    public void saveLyrics(PluginCall call) {
        JSObject meta = call.getObject("meta");
        call.resolve(wrap(storage.saveLyrics(
            call.getString("lrc", ""), call.getString("tlyric", ""),
            call.getString("rlyric", ""), call.getString("yrc", ""),
            call.getString("saveDir", ""), call.getString("artist", ""), call.getString("title", ""),
            meta != null ? meta.getString("songName", "") : "",
            meta != null ? meta.getString("artist", "") : "")));
    }

    @PluginMethod
    public void saveLyricOffset(PluginCall call) {
        Double offset = call.getDouble("offset", 0.0);
        call.resolve(wrap(storage.saveLyricOffset(
            call.getString("saveDir", ""), call.getString("artist", ""),
            call.getString("title", ""), offset == null ? 0.0 : offset)));
    }

    // ==================== 文件操作 ====================

    @PluginMethod
    public void deleteFile(PluginCall call) {
        call.resolve(wrap(saf.deleteFile(call.getString("filePath", call.getString("path", "")))));
    }

    @PluginMethod
    public void renameFile(PluginCall call) {
        call.resolve(wrap(saf.renameFile(call.getString("oldPath", ""), call.getString("newName", ""))));
    }

    @PluginMethod
    public void copyFile(PluginCall call) {
        Boolean skip = call.getBoolean("skipExisting", Boolean.FALSE);
        call.resolve(wrap(saf.copyFile(call.getString("src", ""), call.getString("destDir", ""), skip != null && skip)));
    }

    @PluginMethod
    public void writeTextFile(PluginCall call) {
        call.resolve(wrap(saf.writeTextFile(call.getString("filePath", ""), call.getString("text", ""))));
    }

    @PluginMethod
    public void findDuplicateFiles(PluginCall call) {
        JSArray out = new JSArray();
        JSArray paths = call.getArray("paths");
        if (paths != null) {
            String[] arr = new String[paths.length()];
            for (int i = 0; i < paths.length(); i++) arr[i] = paths.optString(i, "");
            List<JSONObject> groups = saf.findDuplicateFiles(arr);
            for (JSONObject g : groups) add(out, g);
        }
        call.resolve(set(jo(), "groups", out));
    }

    @PluginMethod
    public void showItemInFolder(PluginCall call) { call.resolve(set(jo(), "ok", true)); }

    @PluginMethod
    public void openFolder(PluginCall call) { call.resolve(set(jo(), "ok", true)); }

    @PluginMethod
    public void openExternal(PluginCall call) {
        String url = call.getString("url", call.getString("value", ""));
        if (url != null && (url.startsWith("http://") || url.startsWith("https://"))) {
            try {
                Intent i = new Intent(Intent.ACTION_VIEW, Uri.parse(url));
                i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                getContext().startActivity(i);
            } catch (Exception e) {
                Log.w(TAG, "openExternal failed", e);
            }
        }
        call.resolve(set(jo(), "ok", true));
    }

    // ==================== 播放：媒体服务 ====================

    /** 音频流地址前缀：渲染层用它把 file:///虚拟路径 换成 http://127.0.0.1:port/a/... */
    @PluginMethod
    public void getMediaBase(PluginCall call) {
        int port = mediaServer.start();
        JSObject o = jo();
        set(o, "base", "http://127.0.0.1:" + port);
        set(o, "token", mediaServer.token());
        call.resolve(o);
    }

    @PluginMethod
    public void updateMediaState(PluginCall call) {
        try {
            Context ctx = getContext();
            String title = call.getString("title", "");
            String artist = call.getString("artist", "");
            String album = call.getString("album", "");
            Boolean playing = call.getBoolean("playing", Boolean.FALSE);
            Double position = call.getDouble("position", 0.0);
            Double duration = call.getDouble("duration", 0.0);
            String cover = call.getString("cover", null);
            boolean isPlaying = playing != null && playing;

            Intent svc = new Intent(ctx, PlaybackService.class);
            // 暂停也要把服务留住：通知栏/耳机键要在"暂停状态"也能恢复播放，
            // 只有服务在跑，MediaSession 才存在，远程按键才送得到渲染层。
            boolean needStart = isPlaying || (!title.isEmpty() && MainActivity.visible);
            if (needStart) {
                if (Build.VERSION.SDK_INT >= 26) ctx.startForegroundService(svc);
                else ctx.startService(svc);
            }
            PlaybackService player = PlaybackService.getInstance();
            if (player != null) {
                double pos = position == null ? 0.0 : position;
                double dur = duration == null ? 0.0 : duration;
                player.updateState(title, artist, album, isPlaying, pos, dur, cover,
                    call.getString("lyric", ""), Boolean.TRUE.equals(call.getBoolean("liked", Boolean.FALSE)));
            }
            call.resolve(set(jo(), "ok", true));
        } catch (Exception e) {
            Log.w(TAG, "updateMediaState failed", e);
            call.resolve(set(jo(), "ok", false));
        }
    }

    // ==================== 系统栏配色（状态栏/导航栏跟随软件主题） ====================

    @PluginMethod
    public void setImmersiveBars(PluginCall call) {
        boolean on = Boolean.TRUE.equals(call.getBoolean("on", false));
        try {
            android.app.Activity a = getActivity();
            if (a instanceof MainActivity) ((MainActivity) a).setImmersiveBars(on);
        } catch (Throwable t) {
            Log.w(TAG, "setImmersiveBars failed", t);
        }
        call.resolve(set(jo(), "ok", true, "on", on));
    }

    @PluginMethod
    public void setChromeColors(PluginCall call) {
        final String top = call.getString("top", "#12141a");
        final String bottom = call.getString("bottom", top);
        final Boolean light = call.getBoolean("lightIcons", Boolean.FALSE);
        final MainActivity act = (MainActivity) getActivity();
        if (act == null) { call.resolve(set(jo(), "ok", false)); return; }
        act.runOnUiThread(new Runnable() {
            @Override public void run() {
                act.applyChromeColors(parseColor(top, 0xFF12141A), parseColor(bottom, 0xFF0F1115),
                    light != null && light);
            }
        });
        call.resolve(set(jo(), "ok", true));
    }

    private int parseColor(String s, int fallback) {
        try {
            if (s == null || s.isEmpty()) return fallback;
            if (s.startsWith("#")) return (int) android.graphics.Color.parseColor(s);
            // 支持 "rgb(18,20,26)" / "rgba(18,20,26,0.9)" 这类 CSS 写法
            String nums = s.replaceAll("[^0-9.,]", "");
            String[] p = nums.split(",");
            if (p.length >= 3) {
                int r = (int) Double.parseDouble(p[0]);
                int g = (int) Double.parseDouble(p[1]);
                int b = (int) Double.parseDouble(p[2]);
                return android.graphics.Color.rgb(r, g, b);
            }
        } catch (Exception ignore) {}
        return fallback;
    }

    // 1.0.7：顶部悬浮歌词条已下线（用户嫌那条灰带丑）。
    // 这些方法保留只为兼容渲染层老调用点，一律"拒绝绘制 + 把让位归零"，不会再往屏幕上挂任何窗口。

    @PluginMethod
    public void topLyricCanDraw(PluginCall call) {
        JSObject r = jo();
        set(r, "ok", true);
        set(r, "can", false);
        set(r, "shown", false);
        call.resolve(r);
    }

    @PluginMethod
    public void topLyricShow(PluginCall call) {
        TopLyric.hide();
        applyLyricTop();
        JSObject r = jo();
        set(r, "ok", false);
        set(r, "can", false);
        set(r, "shown", false);
        call.resolve(r);
    }

    /** 让位高度：歌词条没了，App 内容直接从状态栏下面开始，永远 0 */
    private void applyLyricTop() {
        try {
            MainActivity act = (MainActivity) getActivity();
            if (act != null) act.setExtraTopPx(0);
        } catch (Exception ignore) {}
    }

    @PluginMethod
    public void topLyricHide(PluginCall call) {
        TopLyric.hide();
        MainActivity act = (MainActivity) getActivity();
        if (act != null) act.setExtraTopPx(0);
        JSObject r = jo();
        set(r, "ok", true);
        set(r, "shown", false);
        call.resolve(r);
    }

    @PluginMethod
    public void topLyricSet(PluginCall call) {
        // 歌词条下线：收到歌词也就什么都不做（通知栏/锁屏歌词照旧走 updateMediaState）
        call.resolve(set(jo(), "ok", true));
    }

    @PluginMethod
    public void requestOverlayPermission(PluginCall call) {
        try {
            Context ctx = getContext();
            Intent i = new Intent(android.provider.Settings.ACTION_MANAGE_OVERLAY_PERMISSION,
                android.net.Uri.parse("package:" + ctx.getPackageName()));
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            ctx.startActivity(i);
            call.resolve(set(jo(), "ok", true));
        } catch (Exception e) {
            Log.w(TAG, "requestOverlayPermission failed", e);
            call.resolve(set(jo(), "ok", false));
        }
    }

    @PluginMethod
    public void stopPlayback(PluginCall call) {
        try {
            Context ctx = getContext();
            PlaybackService player = PlaybackService.getInstance();
            if (player != null) player.updateState("", "", "", false, 0, 0, null, "", false);
            ctx.stopService(new Intent(ctx, PlaybackService.class));
        } catch (Exception ignore) {}
        call.resolve(set(jo(), "ok", true));
    }

    // ==================== 窗口语义替换 ====================

    @PluginMethod
    public void setFullScreen(PluginCall call) {
        Boolean on = call.getBoolean("on", Boolean.FALSE);
        final boolean want = on != null && on;
        runUi(() -> {
            Activity a = getActivity();
            if (a == null) return;
            WindowInsetsControllerCompat c = WindowCompat.getInsetsController(a.getWindow(), a.getWindow().getDecorView());
            if (want) {
                c.hide(WindowInsetsCompat.Type.systemBars());
                c.setSystemBarsBehavior(WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
            } else {
                c.show(WindowInsetsCompat.Type.systemBars());
            }
        });
        call.resolve(set(jo(), "ok", true));
    }

    @PluginMethod public void isFullScreen(PluginCall call) { call.resolve(set(jo(), "value", false)); }
    @PluginMethod public void toggleMaximize(PluginCall call) { call.resolve(set(jo(), "ok", true)); }
    @PluginMethod public void isMaximized(PluginCall call) { call.resolve(set(jo(), "value", true)); }
    @PluginMethod public void toggleAlwaysOnTop(PluginCall call) { call.resolve(set(jo(), "value", false)); }
    @PluginMethod public void isAlwaysOnTop(PluginCall call) { call.resolve(set(jo(), "value", false)); }
    @PluginMethod public void setCloseToTray(PluginCall call) { call.resolve(set(jo(), "ok", true)); }
    @PluginMethod public void getAutostart(PluginCall call) { call.resolve(set(jo(), "value", false)); }
    @PluginMethod public void setAutostart(PluginCall call) { call.resolve(set(jo(), "ok", true)); }
    @PluginMethod public void setMiniTheme(PluginCall call) { call.resolve(set(jo(), "ok", true)); }

    @PluginMethod
    public void minimize(PluginCall call) {
        runUi(() -> {
            Activity a = getActivity();
            if (a != null) a.moveTaskToBack(true);
        });
        call.resolve(set(jo(), "ok", true));
    }

    @PluginMethod
    public void closeWindow(PluginCall call) {
        runUi(() -> {
            Activity a = getActivity();
            if (a != null) a.moveTaskToBack(true);
        });
        call.resolve(set(jo(), "ok", true));
    }

    // ==================== 联网元数据（P3） ====================
    // 真正的搜索/匹配逻辑用移植过来的 www/native/online.js 在 JS 层跑（与桌面版同一套算法，
    // 包含 QQ 封面 300/500/800 规格、时长权重匹配等定案），原生这边只提供两件事：
    //   1) httpFetch —— WebView 里 fetch 会被 CORS 拦，跨域抓取必须走原生
    //   2) decryptKrc —— 酷狗逐字歌词 KRC 需要 XOR + zlib 解压，浏览器里没有 inflate

    @PluginMethod
    public void httpFetch(PluginCall call) {
        String url = call.getString("url", "");
        JSObject headers = call.getObject("headers");
        Integer timeoutMs = call.getInt("timeoutMs", 12000);
        if (url == null || url.isEmpty()) {
            call.resolve(set(jo(), "ok", false, "error", "empty url"));
            return;
        }
        // 1.0.13：这个方法是阻塞式 IO，原来直接在当前（插件）线程里跑，
        // 结果所有网络请求被一个个排队执行——多个封面源"并发"其实等于串行，
        // 谁后发谁超时，缩略图自然出得慢。改到独立线程里去跑，并发才真的是并发。
        final int to = timeoutMs == null ? 12000 : timeoutMs;
        Thread t = new Thread(() -> {
            try {
                HttpResult r = httpGetBytes(url, headers, to);
                JSObject out = jo();
                out.put("ok", r.status >= 200 && r.status < 400);
                out.put("status", r.status);
                out.put("contentType", r.contentType == null ? "" : r.contentType);
                out.put("finalUrl", r.finalUrl == null ? url : r.finalUrl);
                out.put("base64", r.body == null ? "" : android.util.Base64.encodeToString(r.body,
                    android.util.Base64.NO_WRAP));
                call.resolve(out);
            } catch (Exception e) {
                Log.w(TAG, "httpFetch failed " + url, e);
                call.resolve(set(jo(), "ok", false, "error", String.valueOf(e.getMessage())));
            }
        });
        t.setDaemon(true);
        t.start();
    }

    private static class HttpResult {
        int status;
        byte[] body;
        String contentType;
        String finalUrl;
    }

    /** 带重定向跟随、可自定义请求头的 GET；返回原始字节（图片/文本都走这条） */
    private HttpResult httpGetBytes(String url, JSObject headers, int timeoutMs) throws Exception {
        String cur = url;
        for (int hop = 0; hop < 4; hop++) {
            java.net.URL u = new java.net.URL(cur);
            java.net.HttpURLConnection c = (java.net.HttpURLConnection) u.openConnection();
            c.setConnectTimeout(timeoutMs);
            c.setReadTimeout(timeoutMs);
            c.setInstanceFollowRedirects(false);
            c.setRequestProperty("User-Agent",
                "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Mobile Safari/537.36");
            c.setRequestProperty("Accept", "*/*");
            c.setRequestProperty("Accept-Encoding", "identity");
            if (headers != null) {
                java.util.Iterator<String> it = headers.keys();
                while (it.hasNext()) {
                    String k = it.next();
                    try { c.setRequestProperty(k, headers.getString(k)); } catch (Exception ignore) {}
                }
            }
            int code = c.getResponseCode();
            if (code >= 300 && code < 400) {
                String loc = c.getHeaderField("Location");
                c.disconnect();
                if (loc == null || loc.isEmpty()) throw new Exception("redirect without location");
                cur = new java.net.URL(u, loc).toString();
                continue;
            }
            HttpResult r = new HttpResult();
            r.status = code;
            r.contentType = c.getContentType();
            r.finalUrl = cur;
            java.io.InputStream in = (code >= 400) ? c.getErrorStream() : c.getInputStream();
            if (in != null) {
                java.io.ByteArrayOutputStream bos = new java.io.ByteArrayOutputStream();
                byte[] buf = new byte[8192];
                int n;
                while ((n = in.read(buf)) > 0) bos.write(buf, 0, n);
                in.close();
                r.body = bos.toByteArray();
            } else {
                r.body = new byte[0];
            }
            c.disconnect();
            return r;
        }
        throw new Exception("too many redirects");
    }

    /** 酷狗 KRC：base64 → 去掉 "krc1" 头 → 按固定密钥异或 → zlib inflate → 明文 */
    @PluginMethod
    public void decryptKrc(PluginCall call) {
        String b64 = call.getString("base64", "");
        try {
            byte[] raw = android.util.Base64.decode(b64 == null ? "" : b64, android.util.Base64.DEFAULT);
            if (raw.length < 8) { call.resolve(set(jo(), "ok", false)); return; }
            String head = new String(raw, 0, 4, "UTF-8");
            if (!head.equals("krc1")) { call.resolve(set(jo(), "ok", false)); return; }
            byte[] body = new byte[raw.length - 4];
            System.arraycopy(raw, 4, body, 0, body.length);
            int[] key = {0x40,0x47,0x61,0x77,0x5e,0x32,0x74,0x47,0x51,0x36,0x31,0x2d,0xce,0xd2,0x6e,0x69};
            for (int i = 0; i < body.length; i++) body[i] ^= (byte) key[i % key.length];
            java.util.zip.Inflater inf = new java.util.zip.Inflater();
            inf.setInput(body);
            java.io.ByteArrayOutputStream bos = new java.io.ByteArrayOutputStream();
            byte[] buf = new byte[8192];
            while (!inf.finished()) {
                int n = inf.inflate(buf);
                if (n == 0) break;
                bos.write(buf, 0, n);
            }
            inf.end();
            String text = new String(bos.toByteArray(), "UTF-8");
            call.resolve(set(jo(), "ok", true, "text", text));
        } catch (Exception e) {
            call.resolve(set(jo(), "ok", false, "error", String.valueOf(e.getMessage())));
        }
    }

    /**
     * 回写 ID3 标签（桌面版用 node-id3 在主进程改文件，安卓走 SAF 只能自己重写标签区）。
     * 只支持 MP3：替换 TIT2/TPE1/TALB，其它帧（含内嵌封面）原样保留，音频字节不动。
     */
    @PluginMethod
    public void writeMusicMetadata(PluginCall call) {
        String path = call.getString("path", "");
        String title = call.getString("title", "");
        String artist = call.getString("artist", "");
        String album = call.getString("album", "");
        JSObject o = jo();
        try {
            if (path == null || path.isEmpty()) {
                set(o, "ok", false, "error", "缺少文件路径");
                call.resolve(o);
                return;
            }
            if (!path.toLowerCase().endsWith(".mp3")) {
                set(o, "ok", false, "error", "安卓端目前只回写 MP3 标签");
                call.resolve(o);
                return;
            }
            byte[] src = saf.readBytes(path, 64L * 1024 * 1024);
            if (src == null) {
                set(o, "ok", false, "error", "读不出文件（可能过大或没有权限）");
                call.resolve(o);
                return;
            }
            byte[] outBytes = Id3Writer.rewrite(src, title, artist, album);
            if (outBytes == null) {
                set(o, "ok", false, "error", "这个文件的标签格式不支持改写");
                call.resolve(o);
                return;
            }
            JSONObject w = saf.writeBytesFile(path, outBytes);
            boolean ok = w != null && w.optBoolean("ok", false);
            set(o, "ok", ok);
            if (!ok) set(o, "error", w == null ? "写入失败" : w.optString("error", "写入失败"));
            call.resolve(o);
        } catch (Exception e) {
            call.resolve(set(jo(), "ok", false, "error", String.valueOf(e.getMessage())));
        }
    }

    @PluginMethod public void convertToMp3(PluginCall call) { call.resolve(set(jo(), "ok", false, "error", "安卓端暂不支持格式转换")); }
    @PluginMethod public void convertFormat(PluginCall call) { call.resolve(set(jo(), "ok", false, "error", "安卓端暂不支持格式转换")); }

    // ==================== 诊断 ====================

    @PluginMethod
    public void getSafRoots(PluginCall call) {
        call.resolve(set(jo(), "roots", wrap(saf.rootsJson())));
    }

    private void runUi(Runnable r) {
        Activity a = getActivity();
        if (a != null) a.runOnUiThread(r);
    }
}
