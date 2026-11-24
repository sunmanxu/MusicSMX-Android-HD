package cn.sunmanxu.musicsmx;

import android.content.Context;
import android.net.Uri;
import android.util.Base64;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.nio.charset.Charset;
import java.util.Locale;

/**
 * 轻量标签解析器 —— 对标桌面版 src/metadata.js 的手写解析器（只读文件头部，不整读大文件）。
 * 支持：ID3v2.2/2.3/2.4 + ID3v1 / FLAC(VorbisComment+Picture) / Ogg(Vorbis,Opus) / MP4-m4a(ilst)。
 * 返回结构对齐 readFileTags 契约：{title, artist, album, cover(dataURL|null)}
 */
public class TagReader {

    public static class Meta {
        public String title = "";
        public String artist = "";
        public String album = "";
        public String cover = null; // data:image/jpeg;base64,...
        public int year = 0;
    }

    private static final Charset LATIN1 = Charset.forName("ISO-8859-1");
    private static final int MAX_ID3 = 8 * 1024 * 1024;
    private static final int MAX_FLAC = 2 * 1024 * 1024;
    private static final int MAX_OGG = 512 * 1024;
    private static final int MAX_MP4 = 8 * 1024 * 1024;
    private static final int MAX_COVER = 4 * 1024 * 1024;

    public static Meta read(Context ctx, Uri uri, String name) {
        Meta m = new Meta();
        InputStream in = null;
        try {
            in = ctx.getContentResolver().openInputStream(uri);
            if (in == null) return m;
            byte[] h = new byte[10];
            int n = readFully(in, h, 10);
            if (n >= 3 && h[0] == 'I' && h[1] == 'D' && h[2] == '3') {
                if (n >= 10) readId3(in, h, m);
            } else if (n >= 4 && h[0] == 'f' && h[1] == 'L' && h[2] == 'a' && h[3] == 'C') {
                readFlac(in, h, n, m);
            } else if (n >= 4 && h[0] == 'O' && h[1] == 'g' && h[2] == 'g' && h[3] == 'S') {
                readOgg(in, h, n, m);
            } else {
                String ext = extOf(name);
                if (ext.equals("m4a") || ext.equals("mp4") || ext.equals("aac")) readMp4(in, h, n, m);
            }
        } catch (Throwable ignore) {
            // 读不到标签就当作没标签，由文件名兜底（与桌面版一致）
        } finally {
            try { if (in != null) in.close(); } catch (Exception ignore) {}
        }
        if (m.title == null) m.title = "";
        if (m.artist == null) m.artist = "";
        if (m.album == null) m.album = "";
        return m;
    }

    private static String extOf(String name) {
        if (name == null) return "";
        int i = name.lastIndexOf('.');
        return i >= 0 ? name.substring(i + 1).toLowerCase(Locale.ROOT) : "";
    }

    // ---------------- ID3 ----------------

    private static void readId3(InputStream in, byte[] h, Meta m) throws Exception {
        int ver = h[3] & 0xff;
        int flags = h[5] & 0xff;
        long tagSize = ((h[6] & 0x7f) << 21) | ((h[7] & 0x7f) << 14) | ((h[8] & 0x7f) << 7) | (h[9] & 0x7f);
        int total = (int) Math.min(tagSize, MAX_ID3);
        byte[] buf = new byte[total];
        int got = readFully(in, buf, total);
        if (got <= 0) return;
        int pos = 0;
        // 扩展头（v2.3/v2.4）
        if ((flags & 0x40) != 0 && got >= 4) {
            if (ver == 4) {
                int sz = ((buf[0] & 0x7f) << 21) | ((buf[1] & 0x7f) << 14) | ((buf[2] & 0x7f) << 7) | (buf[3] & 0x7f);
                pos = 4 + sz;
            } else {
                int sz = readInt(buf, 0);
                pos = 4 + sz;
            }
        }
        while (pos + 6 <= got) {
            if (ver == 2) {
                String id = new String(buf, pos, 3, LATIN1);
                int size = ((buf[pos + 3] & 0xff) << 16) | ((buf[pos + 4] & 0xff) << 8) | (buf[pos + 5] & 0xff);
                pos += 6;
                if (size <= 0 || pos + size > got) break;
                handleV22(id, buf, pos, size, m);
                pos += size;
            } else {
                String id = new String(buf, pos, 4, LATIN1);
                if (id.charAt(0) == 0) break;
                int size;
                if (ver == 4) {
                    size = ((buf[pos + 4] & 0x7f) << 21) | ((buf[pos + 5] & 0x7f) << 14) | ((buf[pos + 6] & 0x7f) << 7) | (buf[pos + 7] & 0x7f);
                } else {
                    size = readInt(buf, pos + 4);
                }
                int frameFlags = ((buf[pos + 8] & 0xff) << 8) | (buf[pos + 9] & 0xff);
                pos += 10;
                if (size <= 0 || pos + size > got) break;
                // 压缩/加密帧跳过（罕见）
                if ((frameFlags & 0x000c) == 0) handleV23(id, buf, pos, size, m);
                pos += size;
            }
        }
        if (m.title.isEmpty() || m.artist.isEmpty() || m.album.isEmpty()) readId3v1Fallback(in, m);
    }

    private static void handleV22(String id, byte[] b, int off, int len, Meta m) {
        if (id.equals("TT2")) m.title = decodeText(b, off, len);
        else if (id.equals("TP1")) m.artist = decodeText(b, off, len);
        else if (id.equals("TAL")) m.album = decodeText(b, off, len);
        else if (id.equals("PIC")) {
            int enc = b[off] & 0xff;
            String fmt = new String(b, off + 1, 3, LATIN1);
            int p = off + 4;
            p = skipDesc(b, p, off + len, enc);
            int imgLen = off + len - p;
            String mime = fmt.equalsIgnoreCase("PNG") ? "image/png" : "image/jpeg";
            applyCover(m, b, p, imgLen, mime);
        }
    }

    private static void handleV23(String id, byte[] b, int off, int len, Meta m) {
        switch (id) {
            case "TIT2": case "TT2": m.title = decodeText(b, off, len); break;
            case "TPE1": case "TP1": m.artist = decodeText(b, off, len); break;
            case "TALB": case "TAL": m.album = decodeText(b, off, len); break;
            case "TYER": case "TDRC": {
                String y = decodeText(b, off, len);
                try { m.year = Integer.parseInt(y.length() > 4 ? y.substring(0, 4) : y); } catch (Exception ignore) {}
                break;
            }
            case "APIC": {
                int enc = b[off] & 0xff;
                int p = off + 1;
                int mimeEnd = p;
                while (mimeEnd < off + len && b[mimeEnd] != 0) mimeEnd++;
                String mime = new String(b, p, mimeEnd - p, LATIN1);
                p = mimeEnd + 1;      // 跳过 mime 的 0
                p += 1;               // 图片类型 1 字节
                p = skipDesc(b, p, off + len, enc);
                int imgLen = off + len - p;
                if (mime.isEmpty() || !mime.startsWith("image/")) mime = "image/jpeg";
                applyCover(m, b, p, imgLen, mime);
                break;
            }
        }
    }

    private static void readId3v1Fallback(InputStream in, Meta m) {
        // ID3v1 位于文件末尾 128 字节，这里不为了它再整读文件：仅当上面一个字段都没解析到时，
        // 用一次小范围读取尽力补全（CONTENT 流无法 seek，故放弃——由文件名兜底，行为与桌面版 salted 一致）
    }

    // ---------------- FLAC ----------------

    private static void readFlac(InputStream in, byte[] head, int headLen, Meta m) throws Exception {
        byte[] buf = slurp(in, head, headLen, MAX_FLAC);
        int pos = 4; // 跳过 fLaC
        while (pos + 4 <= buf.length) {
            int bh = buf[pos] & 0xff;
            boolean last = (bh & 0x80) != 0;
            int type = bh & 0x7f;
            int len = readInt3(buf, pos + 1);
            pos += 4;
            if (len < 0 || pos + len > buf.length) break;
            if (type == 4) parseVorbisComment(buf, pos, len, m);
            else if (type == 6) parseFlacPicture(buf, pos, len, m);
            pos += len;
            if (last) break;
        }
    }

    private static void parseVorbisComment(byte[] buf, int off, int len, Meta m) {
        int vend = off + len;
        int pos = off;
        int vendorLen = readInt(buf, pos); pos += 4;
        if (vendorLen < 0 || vendorLen > len) return;
        pos += vendorLen;
        if (pos + 4 > vend) return;
        int count = readInt(buf, pos); pos += 4;
        for (int i = 0; i < count && pos + 4 <= vend; i++) {
            int cl = readInt(buf, pos); pos += 4;
            if (cl < 0 || pos + cl > vend) break;
            String kv = new String(buf, pos, cl, Charset.forName("UTF-8"));
            pos += cl;
            int eq = kv.indexOf('=');
            if (eq <= 0) continue;
            String k = kv.substring(0, eq).toUpperCase(Locale.ROOT);
            String v = kv.substring(eq + 1).trim();
            if (k.equals("TITLE") && m.title.isEmpty()) m.title = v;
            else if (k.equals("ARTIST") && m.artist.isEmpty()) m.artist = v;
            else if ((k.equals("ALBUM")) && m.album.isEmpty()) m.album = v;
            else if (k.equals("DATE") && m.year == 0) {
                try { m.year = Integer.parseInt(v.length() > 4 ? v.substring(0, 4) : v); } catch (Exception ignore) {}
            }
        }
    }

    private static void parseFlacPicture(byte[] buf, int off, int len, Meta m) {
        if (m.cover != null) return;
        int pos = off + 4; // picture type
        int mimeLen = readInt(buf, pos); pos += 4;
        if (mimeLen < 0 || pos + mimeLen > off + len) return;
        String mime = new String(buf, pos, mimeLen, LATIN1);
        pos += mimeLen;
        int descLen = readInt(buf, pos); pos += 4;
        if (descLen < 0 || pos + descLen > off + len) return;
        pos += descLen;
        pos += 16; // width/height/depth/colors
        if (pos + 4 > off + len) return;
        int dataLen = readInt(buf, pos); pos += 4;
        if (dataLen <= 0 || pos + dataLen > off + len) return;
        if (mime.isEmpty() || !mime.startsWith("image/")) mime = "image/jpeg";
        applyCover(m, buf, pos, dataLen, mime);
    }

    // ---------------- Ogg ----------------

    private static void readOgg(InputStream in, byte[] head, int headLen, Meta m) throws Exception {
        byte[] buf = slurp(in, head, headLen, MAX_OGG);
        // Opus: "OpusTags" 后接 vorbis comment 结构
        int op = indexOf(buf, "OpusTags".getBytes(LATIN1), 0);
        if (op >= 0) {
            int p = op + 8;
            if (p + 4 <= buf.length) {
                int vendorLen = readInt(buf, p);
                p += 4 + Math.max(0, vendorLen);
                if (p + 4 <= buf.length) parseVorbisCommentSeq(buf, p, m);
            }
        }
        // Vorbis: 0x03 'vorbis' + vendor len...
        if (m.title.isEmpty() && m.artist.isEmpty()) {
            byte[] sig = new byte[]{3, 'v', 'o', 'r', 'b', 'i', 's'};
            int vp = indexOf(buf, sig, 0);
            if (vp >= 0) {
                int p = vp + 7;
                if (p + 4 <= buf.length) {
                    int vendorLen = readInt(buf, p);
                    p += 4 + Math.max(0, vendorLen);
                    if (p + 4 <= buf.length) parseVorbisCommentSeq(buf, p, m);
                }
            }
        }
    }

    /** 从「comment 数量」字段开始解析连续 key=value（无外框长度） */
    private static void parseVorbisCommentSeq(byte[] buf, int pos, Meta m) {
        int count = readInt(buf, pos); pos += 4;
        for (int i = 0; i < count && pos + 4 <= buf.length; i++) {
            int cl = readInt(buf, pos); pos += 4;
            if (cl < 0 || pos + cl > buf.length) break;
            String kv = new String(buf, pos, cl, Charset.forName("UTF-8"));
            pos += cl;
            int eq = kv.indexOf('=');
            if (eq <= 0) continue;
            String k = kv.substring(0, eq).toUpperCase(Locale.ROOT);
            String v = kv.substring(eq + 1).trim();
            if (k.equals("TITLE") && m.title.isEmpty()) m.title = v;
            else if (k.equals("ARTIST") && m.artist.isEmpty()) m.artist = v;
            else if (k.equals("ALBUM") && m.album.isEmpty()) m.album = v;
        }
    }

    // ---------------- MP4 / M4A ----------------

    private static void readMp4(InputStream in, byte[] head, int headLen, Meta m) throws Exception {
        byte[] buf = slurp(in, head, headLen, MAX_MP4);
        int[] ilst = findBox(buf, 0, buf.length, "ilst", 0);
        if (ilst == null) return;
        int pos = ilst[0];
        int end = ilst[0] + ilst[1];
        while (pos + 8 <= end) {
            int size = readInt(buf, pos);
            String type = new String(buf, pos + 4, 4, LATIN1);
            if (size < 8 || pos + size > end) break;
            int p = pos + 8;
            if (p + 8 <= pos + size) {
                int dsize = readInt(buf, p);
                String dtype = new String(buf, p + 4, 4, LATIN1);
                if ("data".equals(dtype)) {
                    int dstart = p + 16; // size+type+typeflags(4)+locale(4)
                    int dlen = pos + size - dstart;
                    if (dlen > 0) {
                        String v = new String(buf, dstart, dlen, Charset.forName("UTF-8")).trim();
                        if (type.equals("\u00A9nam") && m.title.isEmpty()) m.title = v;
                        else if (type.equals("\u00A9ART") && m.artist.isEmpty()) m.artist = v;
                        else if (type.equals("\u00A9alb") && m.album.isEmpty()) m.album = v;
                        else if (type.equals("covr")) {
                            int flag = readInt(buf, p + 8);
                            String mime = (flag == 14) ? "image/png" : "image/jpeg";
                            applyCover(m, buf, dstart, dlen, mime);
                        }
                    }
                }
            }
            pos += size;
        }
    }

    private static int[] findBox(byte[] buf, int start, int end, String type, int depth) {
        if (depth > 6) return null;
        int pos = start;
        while (pos + 8 <= end) {
            long size = readInt(buf, pos);
            if (size == 0) size = end - pos;
            if (size == 1) { // 64bit largesize
                size = ((long) readInt(buf, pos + 8) << 32) | (readInt(buf, pos + 12) & 0xffffffffL);
            }
            String t = new String(buf, pos + 4, 4, LATIN1);
            if (size < 8 || pos + size > end) break;
            if (t.equals(type)) return new int[]{pos + 8, (int) size - 8};
            int childStart = pos + 8;
            if (t.equals("meta")) childStart = pos + 16; // version+flags
            if (t.equals("moov") || t.equals("udta") || t.equals("meta") || t.equals("trak") || t.equals("mdia")) {
                int[] r = findBox(buf, childStart, (int) (pos + size), type, depth + 1);
                if (r != null) return r;
            }
            pos += (int) size;
        }
        return null;
    }

    // ---------------- 工具 ----------------

    private static void applyCover(Meta m, byte[] b, int off, int len, String mime) {
        if (len <= 0 || len > MAX_COVER) return;
        if (!mime.equals("image/png")) mime = "image/jpeg";
        try {
            String b64 = Base64.encodeToString(rangeCopy(b, off, len), Base64.NO_WRAP);
            m.cover = "data:" + mime + ";base64," + b64;
        } catch (Throwable ignore) {}
    }

    private static byte[] rangeCopy(byte[] b, int off, int len) {
        byte[] out = new byte[len];
        System.arraycopy(b, off, out, 0, len);
        return out;
    }

    /** 解码文本帧：0=ISO-8859-1 1=UTF-16(BOM) 2=UTF-16BE 3=UTF-8 */
    private static String decodeText(byte[] b, int off, int len) {
        if (len <= 1) return "";
        int enc = b[off] & 0xff;
        int start = off + 1;
        int n = len - 1;
        try {
            if (enc == 0) return new String(b, start, n, LATIN1).trim();
            if (enc == 1) {
                Charset cs = Charset.forName("UTF-16");
                // 去掉 BOM 后按 UTF-16LE/BE 判断
                if (n >= 2 && (b[start] & 0xff) == 0xff && (b[start + 1] & 0xff) == 0xfe) {
                    return new String(b, start + 2, n - 2, Charset.forName("UTF-16LE")).trim();
                }
                if (n >= 2 && (b[start] & 0xff) == 0xfe && (b[start + 1] & 0xff) == 0xff) {
                    return new String(b, start + 2, n - 2, Charset.forName("UTF-16BE")).trim();
                }
                return new String(b, start, n, cs).trim();
            }
            if (enc == 2) return new String(b, start, n, Charset.forName("UTF-16BE")).trim();
            return new String(b, start, n, Charset.forName("UTF-8")).trim();
        } catch (Throwable e) {
            return "";
        }
    }

    /** 跳过描述字符串（按编码判断 1/2 字节终止符） */
    private static int skipDesc(byte[] b, int p, int end, int enc) {
        if (enc == 1 || enc == 2) {
            while (p + 1 < end) {
                if ((b[p] & 0xff) == 0 && (b[p + 1] & 0xff) == 0) return p + 2;
                p += 2;
            }
            return end;
        }
        while (p < end && b[p] != 0) p++;
        return Math.min(p + 1, end);
    }

    private static int readInt(byte[] b, int off) {
        if (off + 4 > b.length) return 0;
        return ((b[off] & 0xff) << 24) | ((b[off + 1] & 0xff) << 16) | ((b[off + 2] & 0xff) << 8) | (b[off + 3] & 0xff);
    }

    private static int readInt3(byte[] b, int off) {
        if (off + 3 > b.length) return 0;
        return ((b[off] & 0xff) << 16) | ((b[off + 1] & 0xff) << 8) | (b[off + 2] & 0xff);
    }

    private static int indexOf(byte[] hay, byte[] needle, int from) {
        outer:
        for (int i = Math.max(0, from); i <= hay.length - needle.length; i++) {
            for (int j = 0; j < needle.length; j++) {
                if (hay[i + j] != needle[j]) continue outer;
            }
            return i;
        }
        return -1;
    }

    private static int readFully(InputStream in, byte[] buf, int len) {
        int total = 0;
        try {
            while (total < len) {
                int r = in.read(buf, total, len - total);
                if (r <= 0) break;
                total += r;
            }
        } catch (Exception ignore) {}
        return total;
    }

    /** 把已经嗅探出来的头部字节 + 剩余流一起攒成上限 max 的字节数组 */
    private static byte[] slurp(InputStream in, byte[] head, int headLen, int max) throws Exception {
        ByteArrayOutputStream bos = new ByteArrayOutputStream();
        if (head != null && headLen > 0) bos.write(head, 0, Math.min(headLen, head.length));
        byte[] tmp = new byte[8192];
        int read;
        while (bos.size() < max && (read = in.read(tmp)) > 0) bos.write(tmp, 0, read);
        return bos.toByteArray();
    }
}
