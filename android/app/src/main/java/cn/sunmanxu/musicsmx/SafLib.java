package cn.sunmanxu.musicsmx;

import android.content.Context;
import android.content.UriPermission;
import android.database.Cursor;
import android.net.Uri;
import android.provider.DocumentsContract;
import android.util.Log;

import org.json.JSONObject;

import java.io.File;
import java.io.InputStream;
import java.io.OutputStream;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * SAF 目录映射与文件操作。
 *
 * 虚拟路径方案（对渲染层谎称这些是普通文件路径，app.js 一行业务逻辑都不用改）：
 *   content://com.android.externalstorage.documents/tree/primary%3AMusic  ->  rootPath = /内部存储/Music
 *   文件 primary:Music/周杰伦/晴天.mp3                                   ->  path      = /内部存储/Music/周杰伦/晴天.mp3
 * 反解：真实根 docId（'primary:Music'）+ 相对路径拼出真实文件 docId，再按树 Uri 构造 document Uri。
 * 这样路径跨会话稳定（同一 tree + 同一相对路径永远得到同一 path），满足「路径是全局主键」。
 */
public class SafLib {

    private static final String TAG = "SafLib";
    private static final String AUDIO_EXT = "mp3|flac|wav|ogg|oga|opus|m4a|aac|mp4|webm|aif|aiff";
    private static final int MAX_DEPTH = 12;
    private static final int MAX_FILES = 20000;

    private final Context ctx;
    private final File storeFile;
    private final Map<String, String> roots = new LinkedHashMap<>(); // 显示根路径 -> 树 Uri 字符串

    public SafLib(Context ctx) {
        this.ctx = ctx.getApplicationContext();
        this.storeFile = new File(this.ctx.getFilesDir(), "saf-roots.json");
        load();
    }

    // ---------------- 持久化 ----------------

    private synchronized void load() {
        roots.clear();
        try {
            if (storeFile.exists()) {
                String s = StorageHelper.readText(storeFile);
                JSONObject o = new JSONObject(s);
                java.util.Iterator<String> it = o.keys();
                while (it.hasNext()) {
                    String k = it.next();
                    roots.put(k, o.optString(k));
                }
            }
        } catch (Exception e) {
            Log.w(TAG, "load roots failed", e);
        }
        // 补：系统里仍然有效的树权限（卸载重装/清数据后靠这个恢复）
        try {
            UriPermission[] noop = null;
            for (UriPermission p : ctx.getContentResolver().getPersistedUriPermissions()) {
                if (!p.isReadPermission()) continue;
                Uri u = p.getUri();
                if (u == null || !DocumentsContract.isTreeUri(u)) continue;
                String rootDocId = DocumentsContract.getTreeDocumentId(u);
                String disp = pathOfDocId(rootDocId);
                if (!roots.containsKey(disp)) roots.put(disp, u.toString());
            }
        } catch (Exception ignore) {}
    }

    public synchronized void save() {
        try {
            JSONObject o = new JSONObject();
            for (Map.Entry<String, String> e : roots.entrySet()) o.put(e.getKey(), e.getValue());
            StorageHelper.writeText(storeFile, o.toString());
        } catch (Exception e) {
            Log.w(TAG, "save roots failed", e);
        }
    }

    /** 记录一个用户刚授权的目录树 */
    public synchronized String addTree(Uri treeUri) {
        String rootDocId = DocumentsContract.getTreeDocumentId(treeUri);
        String disp = pathOfDocId(rootDocId);
        roots.put(disp, treeUri.toString());
        save();
        return disp;
    }

    public synchronized JSONObject rootsJson() {
        JSONObject o = new JSONObject();
        for (Map.Entry<String, String> e : roots.entrySet()) {
            try { o.put(e.getKey(), e.getValue()); } catch (Exception ignore) {}
        }
        return o;
    }

    public synchronized List<String> rootPaths() {
        return new ArrayList<>(roots.keySet());
    }

    /** path -> 树 Uri（取最长前缀匹配的根） */
    private synchronized String treeForPath(String path) {
        String bestKey = null;
        for (String k : roots.keySet()) {
            if (path.equals(k) || path.startsWith(k + "/")) {
                if (bestKey == null || k.length() > bestKey.length()) bestKey = k;
            }
        }
        return bestKey == null ? null : roots.get(bestKey);
    }

    private synchronized String rootForDocId(String docId) {
        String bestKey = null;
        String bestReal = null;
        for (Map.Entry<String, String> e : roots.entrySet()) {
            String real = DocumentsContract.getTreeDocumentId(Uri.parse(e.getValue()));
            if (docId.equals(real) || docId.startsWith(real + "/")) {
                if (bestReal == null || real.length() > bestReal.length()) {
                    bestReal = real;
                    bestKey = e.getKey();
                }
            }
        }
        return bestKey == null ? null : bestKey + "|" + bestReal;
    }

    // ---------------- 路径换算 ----------------

    /** 真实 docId -> 显示用虚拟路径（无对应根时回退为 '/卷/路径'） */
    public String pathOfDocId(String docId) {
        int idx = docId.indexOf(':');
        String vol = idx >= 0 ? docId.substring(0, idx) : docId;
        String rest = idx >= 0 ? docId.substring(idx + 1) : "";
        String disp = docId.startsWith("primary:") ? "内部存储" : vol;
        return "/" + disp + (rest.isEmpty() ? "" : "/" + rest);
    }

    /**
     * 虚拟路径 -> 真实 document Uri（依据所在树的根 docId + 相对路径）。
     * 找不到对应树时返回 null（表示该路径不可访问，渲染层会当作文件缺失处理）。
     */
    public Uri docUriForPath(String path) {
        if (path == null) return null;
        String treeStr = treeForPath(path);
        if (treeStr == null) return null;
        Uri tree = Uri.parse(treeStr);
        String realRoot = DocumentsContract.getTreeDocumentId(tree);
        String displayRoot = pathOfDocId(realRoot);
        String rel = path.equals(displayRoot) ? "" : path.substring(displayRoot.length() + 1);
        String docId = rel.isEmpty() ? realRoot : realRoot + "/" + rel;
        try {
            return DocumentsContract.buildDocumentUriUsingTree(tree, docId);
        } catch (Exception e) {
            return null;
        }
    }

    /** 真实 docId -> document Uri（音频流服务用） */
    public Uri docUriForDocId(String docId) {
        String pair = rootForDocId(docId);
        if (pair == null) return null;
        int bar = pair.lastIndexOf('|');
        String treeStr = roots.get(pair.substring(0, bar));
        if (treeStr == null) treeStr = pair; // 理论上不会到这里
        try {
            return DocumentsContract.buildDocumentUriUsingTree(Uri.parse(treeStr), docId);
        } catch (Exception e) {
            return null;
        }
    }

    /** 虚拟路径 -> 真实 docId */
    public String docIdForPath(String path) {
        Uri u = docUriForPath(path);
        if (u == null) return null;
        try { return DocumentsContract.getDocumentId(u); } catch (Exception e) { return null; }
    }

    // ---------------- 查询 ----------------

    public static class Doc {
        public String docId;
        public String name;
        public String mime;
        public long size;
        public long mtime;
        /** 目录判定：ExternalStorageProvider 给的是 vnd.android.document/directory，
         *  以前用 endsWith(".directory") 判错了（结尾是 "/directory" 没有点），导致整棵树被当成一个文件 */
        public boolean isDir() {
            if (mime == null) return false;
            return mime.equals(DocumentsContract.Document.MIME_TYPE_DIR) || mime.endsWith("/directory");
        }
    }

    public Doc statDoc(Uri docUri) {
        if (docUri == null) return null;
        Cursor c = null;
        try {
            c = ctx.getContentResolver().query(docUri, new String[]{
                DocumentsContract.Document.COLUMN_DOCUMENT_ID,
                DocumentsContract.Document.COLUMN_DISPLAY_NAME,
                DocumentsContract.Document.COLUMN_MIME_TYPE,
                DocumentsContract.Document.COLUMN_SIZE,
                DocumentsContract.Document.COLUMN_LAST_MODIFIED
            }, null, null, null);
            if (c != null && c.moveToFirst()) {
                Doc d = new Doc();
                d.docId = c.getString(0);
                d.name = c.getString(1);
                d.mime = c.getString(2);
                d.size = c.isNull(3) ? 0 : c.getLong(3);
                d.mtime = c.isNull(4) ? 0 : c.getLong(4);
                return d;
            }
        } catch (Exception e) {
            Log.w(TAG, "stat failed " + docUri, e);
        } finally {
            try { if (c != null) c.close(); } catch (Exception ignore) {}
        }
        return null;
    }

    public Doc stat(String path) {
        return statDoc(docUriForPath(path));
    }

    /** 列出某目录下的直接子项（docId + 基本信息） */
    public List<Doc> listChildren(Uri treeUri, String parentDocId) {
        List<Doc> out = new ArrayList<>();
        Cursor c = null;
        try {
            Uri children = DocumentsContract.buildChildDocumentsUriUsingTree(treeUri, parentDocId);
            c = ctx.getContentResolver().query(children, new String[]{
                DocumentsContract.Document.COLUMN_DOCUMENT_ID,
                DocumentsContract.Document.COLUMN_DISPLAY_NAME,
                DocumentsContract.Document.COLUMN_MIME_TYPE,
                DocumentsContract.Document.COLUMN_SIZE,
                DocumentsContract.Document.COLUMN_LAST_MODIFIED
            }, null, null, null);
            while (c != null && c.moveToNext()) {
                Doc d = new Doc();
                d.docId = c.getString(0);
                d.name = c.getString(1);
                d.mime = c.getString(2);
                d.size = c.isNull(3) ? 0 : c.getLong(3);
                d.mtime = c.isNull(4) ? 0 : c.getLong(4);
                out.add(d);
            }
        } catch (Exception e) {
            Log.w(TAG, "listChildren failed " + parentDocId, e);
        } finally {
            try { if (c != null) c.close(); } catch (Exception ignore) {}
        }
        return out;
    }

    /** 递归收集音频文件（虚拟路径 + 所属输入根） */
    public static class Found {
        public String path;
        public String root;
        public long size;
        public long mtime;
    }

    /** 诊断：扫不出歌时用来定位到底卡在哪一环（授权没记上 / 路径对不上 / 目录列不出） */
    public JSONObject diagnose(String path) {
        JSONObject o = new JSONObject();
        try {
            o.put("input", path == null ? "" : path);
            org.json.JSONArray keys = new org.json.JSONArray();
            for (String k : roots.keySet()) keys.put(k);
            o.put("roots", keys);
            String tree = treeForPath(path);
            o.put("tree", tree == null ? JSONObject.NULL : tree);
            Uri u = docUriForPath(path);
            o.put("uri", u == null ? JSONObject.NULL : u.toString());
            Doc d = stat(path);
            if (d == null) {
                o.put("stat", JSONObject.NULL);
            } else {
                JSONObject s = new JSONObject();
                s.put("docId", d.docId == null ? "" : d.docId);
                s.put("name", d.name == null ? "" : d.name);
                s.put("mime", d.mime == null ? "" : d.mime);
                s.put("size", d.size);
                s.put("isDir", d.isDir());
                o.put("stat", s);
                if (d.isDir()) {
                    String docId = d.docId != null ? d.docId : docIdForPath(path);
                    List<Doc> kids = listChildren(Uri.parse(tree), docId);
                    o.put("childrenCount", kids.size());
                    org.json.JSONArray sample = new org.json.JSONArray();
                    for (int i = 0; i < Math.min(kids.size(), 8); i++) {
                        Doc k = kids.get(i);
                        sample.put((k.name == null ? "?" : k.name) + (k.isDir() ? "/" : ""));
                    }
                    o.put("childrenSample", sample);
                }
            }
        } catch (Exception e) {
            try { o.put("error", String.valueOf(e)); } catch (Exception ignore) {}
        }
        return o;
    }

    public List<Found> collect(String[] inputs, boolean recursive) {
        List<Found> out = new ArrayList<>();
        java.util.Set<String> seen = new java.util.HashSet<>();
        for (String input : inputs) {
            if (input == null || input.isEmpty()) continue;
            Doc d = stat(input);
            if (d == null) continue; // 目录已失联（权限被收回/卡拔掉）→ 跳过，交给渲染层判断"结果为空"
            if (d.isDir()) {
                walk(input, input, recursive, 0, out, seen);
            } else if (isAudioName(d.name)) {
                String key = input.toLowerCase();
                if (!seen.contains(key)) {
                    seen.add(key);
                    Found f = new Found();
                    f.path = input;
                    f.root = parentPath(input);
                    f.size = d.size;
                    f.mtime = d.mtime;
                    out.add(f);
                }
            }
        }
        return out;
    }

    private void walk(String dirPath, String rootPath, boolean recursive, int depth, List<Found> out, java.util.Set<String> seen) {
        if (depth > MAX_DEPTH || out.size() > MAX_FILES) return;
        Uri dirUri = docUriForPath(dirPath);
        String docId = docIdForPath(dirPath);
        if (dirUri == null || docId == null) return;
        Uri tree = Uri.parse(treeForPath(dirPath) == null ? "content://" : treeForPath(dirPath));
        List<Doc> kids = listChildren(tree, docId);
        for (Doc k : kids) {
            if (k.name == null) continue;
            String childPath = dirPath.endsWith("/") ? dirPath + k.name : dirPath + "/" + k.name;
            if (k.isDir()) {
                if (!recursive) continue;
                if (k.name.startsWith(".") || k.name.equals("node_modules") || k.name.equals("$RECYCLE.BIN")) continue;
                walk(childPath, rootPath, recursive, depth + 1, out, seen);
            } else if (isAudioName(k.name)) {
                if (k.name.startsWith(".")) continue;
                if (k.name.matches(".*(_tmp_\\d+|_bak_|\\.smxtag-|\\.smxbak-).*")) continue;
                String key = childPath.toLowerCase();
                if (seen.contains(key)) continue;
                seen.add(key);
                Found f = new Found();
                f.path = childPath;
                f.root = rootPath;
                f.size = k.size;
                f.mtime = k.mtime;
                out.add(f);
            }
        }
    }

    public static String parentPath(String p) {
        int i = p.lastIndexOf('/');
        return i > 0 ? p.substring(0, i) : "/";
    }

    public static boolean isAudioName(String name) {
        if (name == null) return false;
        int dot = name.lastIndexOf('.');
        if (dot < 0) return false;
        String ext = name.substring(dot + 1).toLowerCase();
        for (String e : AUDIO_EXT.split("\\|")) if (e.equals(ext)) return true;
        return false;
    }

    // ---------------- 文件操作 ----------------

    public JSONObject deleteFile(String path) {
        JSONObject r = new JSONObject();
        try {
            Uri u = docUriForPath(path);
            if (u == null) { r.put("ok", false); r.put("error", "路径不可访问"); return r; }
            boolean ok = DocumentsContract.deleteDocument(ctx.getContentResolver(), u);
            r.put("ok", ok);
            if (!ok) r.put("error", "删除失败（可能是只读目录）");
        } catch (Exception e) {
            try { r.put("ok", false); r.put("error", String.valueOf(e.getMessage())); } catch (Exception ignore) {}
        }
        return r;
    }

    public JSONObject renameFile(String oldPath, String newName) {
        JSONObject r = new JSONObject();
        try {
            Uri u = docUriForPath(oldPath);
            if (u == null) { r.put("ok", false); r.put("error", "路径不可访问"); return r; }
            Doc doc = statDoc(u);
            if (doc == null) { r.put("ok", false); r.put("error", "文件不存在"); return r; }

            // 与桌面版 main.js 的 rename-file 一致：清洗非法字符、保留扩展名、重名加 _N 后缀
            String clean = (newName == null ? "" : newName).replaceAll("[\\\\/:*?\"<>|]", "_").trim();
            if (clean.isEmpty()) { r.put("ok", false); r.put("error", "新文件名无效"); return r; }
            String ext = "";
            String oldName = doc.name == null ? "" : doc.name;
            int dot = oldName.lastIndexOf('.');
            if (dot > 0) ext = oldName.substring(dot);

            String dir = parentPath(oldPath);
            String treeStr = treeForPath(oldPath);
            String dirDocId = docIdForPath(dir);
            java.util.List<Doc> kids = listChildren(Uri.parse(treeStr), dirDocId);
            String target = clean + ext;
            int counter = 1;
            while (true) {
                boolean clash = false;
                for (Doc k : kids) {
                    if (k.name != null && k.name.equalsIgnoreCase(target) && !k.name.equalsIgnoreCase(oldName)) { clash = true; break; }
                }
                if (!clash) break;
                target = clean + "_" + counter + ext;
                counter++;
                if (counter > 999) break;
            }

            Uri n = DocumentsContract.renameDocument(ctx.getContentResolver(), u, target);
            if (n == null) { r.put("ok", false); r.put("error", "该目录不支持重命名"); return r; }
            String newDocId = DocumentsContract.getDocumentId(n);
            r.put("ok", true);
            r.put("newPath", pathOfDocId(newDocId));
            r.put("newDocId", newDocId);
        } catch (Exception e) {
            try { r.put("ok", false); r.put("error", String.valueOf(e.getMessage())); } catch (Exception ignore) {}
        }
        return r;
    }

    /** 整读文件字节（改 ID3 标签要用）。超过 maxBytes 直接失败，避免把几百 MB 的无损文件读进内存 */
    public byte[] readBytes(String path, long maxBytes) {
        InputStream is = null;
        java.io.ByteArrayOutputStream bos = new java.io.ByteArrayOutputStream();
        try {
            Uri u = docUriForPath(path);
            if (u == null) return null;
            is = ctx.getContentResolver().openInputStream(u);
            if (is == null) return null;
            byte[] buf = new byte[8192];
            int n;
            long total = 0;
            while ((n = is.read(buf)) > 0) {
                total += n;
                if (total > maxBytes) return null;
                bos.write(buf, 0, n);
            }
            return bos.toByteArray();
        } catch (Exception e) {
            return null;
        } finally {
            try { if (is != null) is.close(); } catch (Exception ignore) {}
        }
    }

    /** 整写文件字节（覆盖写入，用于回写 ID3 标签） */
    public JSONObject writeBytesFile(String path, byte[] data) {
        JSONObject r = new JSONObject();
        OutputStream os = null;
        try {
            Uri u = docUriForPath(path);
            if (u == null) { r.put("ok", false); r.put("error", "路径不可访问"); return r; }
            os = ctx.getContentResolver().openOutputStream(u, "wt");
            if (os == null) { r.put("ok", false); r.put("error", "无法写入"); return r; }
            os.write(data);
            os.flush();
            r.put("ok", true);
        } catch (Exception e) {
            try { r.put("ok", false); r.put("error", String.valueOf(e.getMessage())); } catch (Exception ignore) {}
        } finally {
            try { if (os != null) os.close(); } catch (Exception ignore) {}
        }
        return r;
    }

    public JSONObject writeTextFile(String path, String text) {
        JSONObject r = new JSONObject();
        OutputStream os = null;
        try {
            Uri u = docUriForPath(path);
            if (u == null) { r.put("ok", false); r.put("error", "路径不可访问"); return r; }
            os = ctx.getContentResolver().openOutputStream(u, "wt");
            if (os == null) { r.put("ok", false); r.put("error", "无法写入"); return r; }
            os.write(text.getBytes("UTF-8"));
            r.put("ok", true);
        } catch (Exception e) {
            try { r.put("ok", false); r.put("error", String.valueOf(e.getMessage())); } catch (Exception ignore) {}
        } finally {
            try { if (os != null) os.close(); } catch (Exception ignore) {}
        }
        return r;
    }

    /**
     * 复制文件到目标目录。skipExisting=true 时同名同大小直接跳过（桌面版踩过 1300 文件翻倍的坑，防重入语义必须保留）。
     */
    public JSONObject copyFile(String srcPath, String destDir, boolean skipExisting) {
        JSONObject r = new JSONObject();
        try {
            Uri src = docUriForPath(srcPath);
            if (src == null) { r.put("ok", false); r.put("error", "源文件不可访问"); return r; }
            Doc srcDoc = statDoc(src);
            if (srcDoc == null) { r.put("ok", false); r.put("error", "源文件不存在"); return r; }
            Uri destDirUri = docUriForPath(destDir);
            String destDocId = docIdForPath(destDir);
            if (destDirUri == null || destDocId == null) { r.put("ok", false); r.put("error", "目标目录不可访问"); return r; }
            Uri tree = Uri.parse(treeForPath(destDir));

            // 同名目标
            List<Doc> kids = listChildren(tree, destDocId);
            Doc exist = null;
            for (Doc k : kids) if (k.name != null && k.name.equals(srcDoc.name)) { exist = k; break; }
            if (exist != null && skipExisting && exist.size > 0 && exist.size == srcDoc.size) {
                r.put("ok", true);
                r.put("skipped", true);
                r.put("destPath", destDir + "/" + exist.name);
                return r;
            }

            String newName = srcDoc.name;
            if (exist != null) {
                // 生成不重名的名字：name (1).mp3
                String base = newName, ext = "";
                int dot = newName.lastIndexOf('.');
                if (dot > 0) { base = newName.substring(0, dot); ext = newName.substring(dot); }
                int i = 1;
                while (exist != null && i < 999) {
                    String cand = base + " (" + i + ")" + ext;
                    boolean dup = false;
                    for (Doc k : kids) if (k.name != null && k.name.equals(cand)) { dup = true; break; }
                    if (!dup) { newName = cand; exist = null; break; }
                    i++;
                }
            }
            Uri destDoc = DocumentsContract.createDocument(ctx.getContentResolver(), destDirUri, srcDoc.mime != null ? srcDoc.mime : "audio/mpeg", newName);
            if (destDoc == null) { r.put("ok", false); r.put("error", "创建目标文件失败"); return r; }

            InputStream is = ctx.getContentResolver().openInputStream(src);
            OutputStream os = ctx.getContentResolver().openOutputStream(destDoc);
            if (is == null || os == null) {
                r.put("ok", false);
                r.put("error", "读写流打开失败");
                return r;
            }
            byte[] buf = new byte[64 * 1024];
            int n;
            long total = 0;
            while ((n = is.read(buf)) > 0) os.write(buf, 0, n);
            os.flush();
            is.close();
            os.close();
            r.put("ok", true);
            r.put("destPath", destDir + "/" + newName);
            r.put("size", total);
        } catch (Exception e) {
            try { r.put("ok", false); r.put("error", String.valueOf(e.getMessage())); } catch (Exception ignore) {}
        }
        return r;
    }

    /** 查重：先按大小分组，再对同组算 MD5（分块读，不整读内存） */
    public List<JSONObject> findDuplicateFiles(String[] paths) {
        List<JSONObject> groups = new ArrayList<>();
        List<String> all = new ArrayList<>();
        Map<Long, List<String>> bySize = new LinkedHashMap<>();
        for (String p : paths) {
            if (p == null) continue;
            Doc d = stat(p);
            if (d == null || d.isDir()) continue;
            all.add(p);
            bySize.computeIfAbsent(d.size, k -> new ArrayList<>()).add(p);
        }
        for (Map.Entry<Long, List<String>> e : bySize.entrySet()) {
            if (e.getValue().size() < 2) continue;
            Map<String, List<String>> byHash = new LinkedHashMap<>();
            for (String p : e.getValue()) {
                String h = md5(p);
                if (h == null) continue;
                byHash.computeIfAbsent(h, k -> new ArrayList<>()).add(p);
            }
            for (Map.Entry<String, List<String>> h : byHash.entrySet()) {
                if (h.getValue().size() < 2) continue;
                JSONObject g = new JSONObject();
                try {
                    g.put("hash", h.getKey());
                    g.put("size", e.getKey());
                    org.json.JSONArray arr = new org.json.JSONArray();
                    for (String p : h.getValue()) arr.put(p);
                    g.put("paths", arr);
                } catch (Exception ignore) {}
                groups.add(g);
            }
        }
        return groups;
    }

    private String md5(String path) {
        try {
            Uri u = docUriForPath(path);
            if (u == null) return null;
            InputStream is = ctx.getContentResolver().openInputStream(u);
            if (is == null) return null;
            MessageDigest md = MessageDigest.getInstance("MD5");
            byte[] buf = new byte[64 * 1024];
            int n;
            while ((n = is.read(buf)) > 0) md.update(buf, 0, n);
            is.close();
            byte[] dig = md.digest();
            StringBuilder sb = new StringBuilder();
            for (byte b : dig) sb.append(String.format("%02x", b));
            return sb.toString();
        } catch (Exception e) {
            return null;
        }
    }

    public boolean exists(String path) {
        return stat(path) != null;
    }
}
