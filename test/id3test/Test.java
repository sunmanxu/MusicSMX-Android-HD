import java.io.*;
import java.nio.charset.Charset;
import java.nio.file.*;
import java.util.*;

/** 离线验证 Id3Writer：重写标签后逐字节比对音频段，并回读 TIT2/TPE1/TALB。 */
public class Test {

    static final Charset LATIN1 = Charset.forName("ISO-8859-1");

    public static void main(String[] args) throws Exception {
        File in = new File(args[0]);
        byte[] src = Files.readAllBytes(in.toPath());
        int oldTagSize = 0;
        if (src[0] == 'I' && src[1] == 'D' && src[2] == '3') {
            int[] tagEnd = new int[1];
            oldTagSize = 10 + syncsafe(src, 6);
        }
        byte[] out = Id3Writer.rewrite(src, "测试标题 Test", "测试歌手", "测试专辑 Album");
        System.out.println("input  bytes = " + src.length);
        System.out.println("output bytes = " + (out == null ? "null" : String.valueOf(out.length)));

        if (out != null) {
            int newTag = 10 + syncsafe(out, 6);
            // 音频段应当与原文完全一致（只允许旧标签到音频的偏移不同）
            int audioSrcStart = (src[0] == 'I') ? 10 + syncsafe(src, 6) + (((src[5] & 0x10) != 0) ? 10 : 0) : 0;
            byte[] a = Arrays.copyOfRange(src, audioSrcStart, src.length);
            byte[] b = Arrays.copyOfRange(out, newTag, out.length);
            System.out.println("audio len src=" + a.length + " out=" + b.length + " identical=" + Arrays.equals(a, b));
            System.out.println("new tag size = " + newTag + " (old " + (oldTagSize == 0 ? "none" : oldTagSize) + ")");

            // 回读新标签里的三个文本帧
            int p = 10;
            while (p + 10 <= newTag) {
                if ((out[p] & 0xff) == 0) break;
                String id = new String(out, p, 4, LATIN1);
                int sz = (out[3] & 0xff) == 4 ? syncsafe(out, p + 4) : ((out[p + 4] & 0xff) << 24 | (out[p + 5] & 0xff) << 16 | (out[p + 6] & 0xff) << 8 | (out[p + 7] & 0xff));
                if (sz <= 0 || p + 10 + sz > newTag) break;
                if (id.startsWith("T") && (id.equals("TIT2") || id.equals("TPE1") || id.equals("TALB"))) {
                    System.out.println("  " + id + " = " + decode(out, p + 10, sz));
                }
                p += 10 + sz;
            }
            Files.write(Paths.get(args[0] + ".out.mp3"), out);
        }

        // 无标签文件也能写
        byte[] bare = new byte[200];
        Arrays.fill(bare, (byte) 0x55);
        byte[] bareOut = Id3Writer.rewrite(bare, "无标签标题", "无名歌手", "未知专辑");
        System.out.println("no-tag case: out len=" + (bareOut == null ? "null" : bareOut.length)
                + " audio identical=" + (bareOut != null && Arrays.equals(Arrays.copyOfRange(bareOut, 10 + syncsafe(bareOut, 6), bareOut.length), bare)));
        // 非法输入
        System.out.println("too-short case: " + (Id3Writer.rewrite(new byte[5], "a", "b", "c") == null ? "null(ok)" : "?!"));
    }

    static String decode(byte[] b, int off, int len) {
        int enc = b[off] & 0xff;
        if (enc == 1) {
            byte[] body = Arrays.copyOfRange(b, off + 3, off + len); // 跳过 enc + BOM(FE FF)
            return new String(body, Charset.forName("UTF-16BE"));
        }
        if (enc == 3) return new String(b, off + 1, len - 1, Charset.forName("UTF-8"));
        return new String(b, off + 1, len - 1, LATIN1);
    }

    static int syncsafe(byte[] b, int off) {
        return ((b[off] & 0x7f) << 21) | ((b[off + 1] & 0x7f) << 14) | ((b[off + 2] & 0x7f) << 7) | (b[off + 3] & 0x7f);
    }
}
