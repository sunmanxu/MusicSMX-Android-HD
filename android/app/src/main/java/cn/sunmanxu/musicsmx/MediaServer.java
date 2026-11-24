package cn.sunmanxu.musicsmx;

import android.content.Context;
import android.net.Uri;
import android.util.Log;

import java.io.BufferedOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.URLDecoder;
import java.security.SecureRandom;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * 本地回环 HTTP 服务：把 SAF 里的音频流给 WebView 的 HTML5 audio。
 *
 * 为什么必须有它：WebView 里的 <audio> 无法读 file:/// 虚拟路径，也无法直连 content://（media 加载走
 * 独立数据源，不经过 shouldInterceptRequest）。走 127.0.0.1 + Range 是最稳的一条路：可拖动进度条、
 * 可续播，且不需要把音频复制进沙盒。URL 里带一次性 token，防止本机其他页面蹭读。
 */
public class MediaServer {

    private static final String TAG = "MediaServer";

    private final Context ctx;
    private final SafLib saf;
    private final String token;
    private ServerSocket serverSocket;
    private Thread acceptThread;
    private final ExecutorService pool = Executors.newFixedThreadPool(4);
    private volatile boolean running = false;

    public MediaServer(Context ctx, SafLib saf) {
        this.ctx = ctx.getApplicationContext();
        this.saf = saf;
        byte[] tb = new byte[12];
        new SecureRandom().nextBytes(tb);
        StringBuilder sb = new StringBuilder();
        for (byte b : tb) sb.append(String.format("%02x", b));
        this.token = sb.toString();
    }

    public String token() { return token; }

    public synchronized int start() {
        if (running) return port();
        try {
            serverSocket = new ServerSocket(0, 16, InetAddress.getByName("127.0.0.1"));
            running = true;
            acceptThread = new Thread(() -> {
                while (running) {
                    try {
                        Socket s = serverSocket.accept();
                        pool.execute(() -> handle(s));
                    } catch (IOException e) {
                        if (running) Log.w(TAG, "accept failed", e);
                        break;
                    }
                }
            }, "smx-media-accept");
            acceptThread.setDaemon(true);
            acceptThread.start();
            return port();
        } catch (IOException e) {
            Log.e(TAG, "start failed", e);
            return -1;
        }
    }

    public int port() {
        return serverSocket == null ? -1 : serverSocket.getLocalPort();
    }

    public String baseUrl() {
        return "http://127.0.0.1:" + port();
    }

    public synchronized void stop() {
        running = false;
        try { if (serverSocket != null) serverSocket.close(); } catch (IOException ignore) {}
        serverSocket = null;
    }

    private void handle(Socket socket) {
        InputStream in = null;
        OutputStream out = null;
        try {
            socket.setSoTimeout(15000);
            in = socket.getInputStream();
            out = new BufferedOutputStream(socket.getOutputStream(), 32 * 1024);
            String requestLine = readLine(in);
            if (requestLine == null) return;
            String[] parts = requestLine.split(" ");
            if (parts.length < 2) return;
            String method = parts[0];
            String target = parts[1];

            Map<String, String> headers = new HashMap<>();
            String line;
            while ((line = readLine(in)) != null && !line.isEmpty()) {
                int c = line.indexOf(':');
                if (c > 0) headers.put(line.substring(0, c).trim().toLowerCase(Locale.ROOT), line.substring(c + 1).trim());
            }

            String path = target;
            String query = "";
            int q = target.indexOf('?');
            if (q >= 0) {
                path = target.substring(0, q);
                query = target.substring(q + 1);
            }
            if (!path.startsWith("/a/")) {
                respond(out, 404, "text/plain", null, "not found".getBytes("UTF-8"), null);
                return;
            }
            if (!query.contains("k=" + token)) {
                respond(out, 403, "text/plain", null, "forbidden".getBytes("UTF-8"), null);
                return;
            }
            // URL 里的路径是 base64url(虚拟路径)，由桥自己解回 SAF 文档
            String trackPath;
            try {
                trackPath = new String(android.util.Base64.decode(path.substring(3), android.util.Base64.URL_SAFE | android.util.Base64.NO_PADDING), "UTF-8");
            } catch (Exception e) {
                respond(out, 400, "text/plain", null, "bad path".getBytes("UTF-8"), null);
                return;
            }
            Uri uri = saf.docUriForPath(trackPath);
            if (uri == null) {
                respond(out, 404, "text/plain", null, "no tree".getBytes("UTF-8"), null);
                return;
            }
            SafLib.Doc doc = saf.statDoc(uri);
            long size = doc != null ? doc.size : -1;
            String mime = mimeFor(trackPath, doc != null ? doc.mime : null);

            String range = headers.get("range");
            long start = 0, end = size - 1;
            boolean partial = false;
            if (range != null && size > 0) {
                try {
                    String rs = range.substring(range.indexOf('=') + 1);
                    int dash = rs.indexOf('-');
                    if (dash > 0) {
                        start = Long.parseLong(rs.substring(0, dash).trim());
                        String e = rs.substring(dash + 1).trim();
                        if (!e.isEmpty()) end = Long.parseLong(e);
                    } else if (dash == 0) {
                        long tail = Long.parseLong(rs.substring(1).trim());
                        start = Math.max(0, size - tail);
                    }
                    if (end >= size) end = size - 1;
                    partial = start > 0 || end < size - 1;
                } catch (Exception ignore) {}
            }

            InputStream media = ctx.getContentResolver().openInputStream(uri);
            if (media == null) {
                respond(out, 500, "text/plain", null, "open failed".getBytes("UTF-8"), null);
                return;
            }
            try {
                if (method.equals("HEAD")) {
                    StringBuilder sb = new StringBuilder();
                    sb.append("HTTP/1.1 200 OK\r\n");
                    sb.append("Content-Type: ").append(mime).append("\r\n");
                    sb.append("Content-Length: ").append(size < 0 ? 0 : size).append("\r\n");
                    sb.append("Accept-Ranges: bytes\r\n");
                    sb.append("Connection: close\r\n\r\n");
                    out.write(sb.toString().getBytes("UTF-8"));
                    out.flush();
                    return;
                }
                long len = end - start + 1;
                StringBuilder sb = new StringBuilder();
                if (partial) sb.append("HTTP/1.1 206 Partial Content\r\n");
                else sb.append("HTTP/1.1 200 OK\r\n");
                sb.append("Content-Type: ").append(mime).append("\r\n");
                sb.append("Content-Length: ").append(len).append("\r\n");
                sb.append("Accept-Ranges: bytes\r\n");
                if (partial) sb.append("Content-Range: bytes ").append(start).append("-").append(end).append("/").append(size).append("\r\n");
                sb.append("Cache-Control: no-store\r\n");
                sb.append("Connection: close\r\n\r\n");
                out.write(sb.toString().getBytes("UTF-8"));

                skipFully(media, start);
                byte[] buf = new byte[64 * 1024];
                long left = len;
                while (left > 0) {
                    int want = (int) Math.min(buf.length, left);
                    int n = media.read(buf, 0, want);
                    if (n <= 0) break;
                    out.write(buf, 0, n);
                    left -= n;
                }
                out.flush();
            } finally {
                try { media.close(); } catch (Exception ignore) {}
            }
        } catch (Exception e) {
            // 播放器频繁取消请求是常态，不刷日志
        } finally {
            try { if (out != null) out.close(); } catch (Exception ignore) {}
            try { if (in != null) in.close(); } catch (Exception ignore) {}
            try { socket.close(); } catch (Exception ignore) {}
        }
    }

    private void skipFully(InputStream in, long n) throws IOException {
        long skipped = 0;
        while (skipped < n) {
            long s = in.skip(n - skipped);
            if (s <= 0) {
                if (in.read() < 0) return;
                s = 1;
            }
            skipped += s;
        }
    }

    private void respond(OutputStream out, int code, String mime, String extra, byte[] body, String msg) throws IOException {
        StringBuilder sb = new StringBuilder();
        sb.append("HTTP/1.1 ").append(code).append(" ").append(msg == null ? "OK" : msg).append("\r\n");
        sb.append("Content-Type: ").append(mime).append("\r\n");
        sb.append("Content-Length: ").append(body == null ? 0 : body.length).append("\r\n");
        sb.append("Connection: close\r\n\r\n");
        out.write(sb.toString().getBytes("UTF-8"));
        if (body != null) out.write(body);
        out.flush();
    }

    private static String mimeFor(String docId, String saMime) {
        String lower = docId.toLowerCase(Locale.ROOT);
        if (lower.endsWith(".mp3")) return "audio/mpeg";
        if (lower.endsWith(".flac")) return "audio/flac";
        if (lower.endsWith(".wav")) return "audio/wav";
        if (lower.endsWith(".ogg") || lower.endsWith(".oga")) return "audio/ogg";
        if (lower.endsWith(".opus")) return "audio/ogg";
        if (lower.endsWith(".m4a")) return "audio/mp4";
        if (lower.endsWith(".aac")) return "audio/aac";
        if (lower.endsWith(".mp4")) return "video/mp4";
        if (lower.endsWith(".webm")) return "audio/webm";
        if (lower.endsWith(".aif") || lower.endsWith(".aiff")) return "audio/aiff";
        return saMime != null ? saMime : "application/octet-stream";
    }

    private static String readLine(InputStream in) throws IOException {
        StringBuilder sb = new StringBuilder();
        int c;
        while ((c = in.read()) >= 0) {
            if (c == '\n') break;
            if (c == '\r') continue;
            sb.append((char) c);
            if (sb.length() > 8192) break;
        }
        return sb.length() == 0 && c < 0 ? null : sb.toString();
    }
}
