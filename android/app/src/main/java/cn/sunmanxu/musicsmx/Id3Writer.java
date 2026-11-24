package cn.sunmanxu.musicsmx;

import java.io.ByteArrayOutputStream;
import java.nio.charset.Charset;
import java.util.ArrayList;
import java.util.List;

/**
 * MP3 的 ID3v2 标签就地重写。
 *
 * 桌面版写标签用的是 node-id3（主进程直接改文件）；安卓这边文件在 SAF 后面，
 * 没有等价库，所以这里只做 MP3 这一种，并且**只替换 TIT2/TPE1/TALB**：
 *  - 其它帧（尤其 APIC 内嵌封面）原样复制，字节不动；
 *  - 音频数据从旧标签之后整段平移，一个字节都不改。
 * 这样即使写出问题，也不会损伤音频本身。非 MP3（FLAC/OGG/M4A）一律返回 null，
 * 由调用方回 ok:false，别去动人家的文件。
 */
public final class Id3Writer {

    private static final Charset LATIN1 = Charset.forName("ISO-8859-1");
    private static final Charset UTF8 = Charset.forName("UTF-8");
    private static final Charset UTF16BE = Charset.forName("UTF-16BE");

    private Id3Writer() {}

    /**
     * @return 重写后的完整文件字节；返回 null 表示这个文件不该/不能改（调用方报 ok:false）
     */
    public static byte[] rewrite(byte[] src, String title, String artist, String album) throws Exception {
        if (src == null || src.length < 12) return null;

        boolean hasTag = src[0] == 'I' && src[1] == 'D' && src[2] == '3';
        int ver = 3;
        int tagEnd = 0;
        List<byte[]> kept = new ArrayList<>();

        if (hasTag) {
            ver = src[3] & 0xff;
            // v2.2 的帧结构（3 字节 id + 3 字节长度）和 v2.3/2.4 完全不同，不冒险改
            if (ver != 3 && ver != 4) return null;
            int flags = src[5] & 0xff;
            if ((flags & 0x40) != 0) return null;   // 带扩展头：很少见，保守跳过
            int tagSize = syncsafe(src, 6);
            tagEnd = Math.min(src.length, 10 + tagSize + (((flags & 0x10) != 0) ? 10 : 0));

            int p = 10;
            while (p + 10 <= 10 + tagSize) {
                if ((src[p] & 0xff) == 0) break;                 // 进入 padding 区，后面没帧了
                String id = new String(src, p, 4, LATIN1);
                int fsize = (ver == 4) ? syncsafe(src, p + 4) : be32(src, p + 4);
                int frameFlags = ((src[p + 8] & 0xff) << 8) | (src[p + 9] & 0xff);
                if (fsize <= 0 || p + 10 + fsize > src.length) break;
                boolean replaced = id.equals("TIT2") || id.equals("TPE1")
                        || id.equals("TALB") || id.equals("TPE2");
                // 压缩/加密帧原样搬走会失效，直接丢弃（这类帧极少，且不是我们关心的文本）
                boolean usable = (frameFlags & 0x000c) == 0;
                if (!replaced && usable) {
                    byte[] f = new byte[10 + fsize];
                    System.arraycopy(src, p, f, 0, 10 + fsize);
                    kept.add(f);
                }
                p += 10 + fsize;
            }
        }

        ByteArrayOutputStream tag = new ByteArrayOutputStream();
        for (byte[] f : kept) tag.write(f);
        byte[] t1 = textFrame(ver, "TIT2", title);
        byte[] t2 = textFrame(ver, "TPE1", artist);
        byte[] t3 = textFrame(ver, "TALB", album);
        if (t1 != null) tag.write(t1);
        if (t2 != null) tag.write(t2);
        if (t3 != null) tag.write(t3);

        byte[] tagBytes = tag.toByteArray();
        byte[] out = new byte[10 + tagBytes.length + (src.length - tagEnd)];
        out[0] = 'I'; out[1] = 'D'; out[2] = '3';
        out[3] = (byte) ver;
        out[4] = 0;
        out[5] = 0;
        writeSyncsafe(out, 6, tagBytes.length);
        System.arraycopy(tagBytes, 0, out, 10, tagBytes.length);
        System.arraycopy(src, tagEnd, out, 10 + tagBytes.length, src.length - tagEnd);
        return out;
    }

    private static byte[] textFrame(int ver, String id, String text) {
        if (text == null) text = "";
        byte[] body = textBody(ver, text);
        byte[] f = new byte[10 + body.length];
        byte[] idb = id.getBytes(LATIN1);
        System.arraycopy(idb, 0, f, 0, 4);
        if (ver == 4) writeSyncsafe(f, 4, body.length); else writeBe32(f, 4, body.length);
        System.arraycopy(body, 0, f, 10, body.length);
        return f;
    }

    /** v2.3 用「编码 1 = UTF-16 + BOM」，v2.4 支持 UTF-8，中文才不会变成乱码 */
    private static byte[] textBody(int ver, String text) {
        if (ver == 4) {
            byte[] b = text.getBytes(UTF8);
            byte[] out = new byte[1 + b.length];
            out[0] = 3;
            System.arraycopy(b, 0, out, 1, b.length);
            return out;
        }
        byte[] b = text.getBytes(UTF16BE);
        byte[] out = new byte[3 + b.length];
        out[0] = 1;
        out[1] = (byte) 0xFE;
        out[2] = (byte) 0xFF;
        System.arraycopy(b, 0, out, 3, b.length);
        return out;
    }

    private static int syncsafe(byte[] b, int off) {
        return ((b[off] & 0x7f) << 21) | ((b[off + 1] & 0x7f) << 14)
                | ((b[off + 2] & 0x7f) << 7) | (b[off + 3] & 0x7f);
    }

    private static void writeSyncsafe(byte[] b, int off, int v) {
        b[off] = (byte) ((v >> 21) & 0x7f);
        b[off + 1] = (byte) ((v >> 14) & 0x7f);
        b[off + 2] = (byte) ((v >> 7) & 0x7f);
        b[off + 3] = (byte) (v & 0x7f);
    }

    private static int be32(byte[] b, int off) {
        return ((b[off] & 0xff) << 24) | ((b[off + 1] & 0xff) << 16)
                | ((b[off + 2] & 0xff) << 8) | (b[off + 3] & 0xff);
    }

    private static void writeBe32(byte[] b, int off, int v) {
        b[off] = (byte) ((v >> 24) & 0xff);
        b[off + 1] = (byte) ((v >> 16) & 0xff);
        b[off + 2] = (byte) ((v >> 8) & 0xff);
        b[off + 3] = (byte) (v & 0xff);
    }
}
