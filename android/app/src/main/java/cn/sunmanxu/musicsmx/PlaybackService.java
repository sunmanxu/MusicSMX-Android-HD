package cn.sunmanxu.musicsmx;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.drawable.Icon;
import android.media.MediaMetadata;
import android.media.MediaMetadataRetriever;
import android.media.session.MediaSession;
import android.media.session.PlaybackState;
import android.media.AudioManager;
import android.os.Build;
import android.os.IBinder;
import android.util.Base64;
import android.util.Log;

import androidx.core.app.NotificationCompat;

/**
 * 前台服务 + 系统 MediaSession：安卓上的「托盘 / 任务栏歌词」等价物就只有它——通知栏 / 锁屏 / 耳机线控。
 * 真正的音频解码在 WebView 里（HTML5 audio），本服务只负责：
 *   1) 把进程保活（否则切后台 WebView 被回收，播放中断）
 *   2) 把渲染层的播放状态映射成 MediaSession，供通知栏/锁屏/耳机按键控制
 *   3) 把控制指令回送给渲染层（window.__mbMediaAction），保证 S.playing 等状态不脱节
 */
public class PlaybackService extends Service {

    private static final String TAG = "PlaybackService";
    private static final String CHANNEL_ID = "smx_playback";

    public static final String ACTION_SET_STATE = "cn.sunmanxu.musicsmx.SET_STATE";
    public static final String ACTION_CMD = "cn.sunmanxu.musicsmx.CMD";
    public static final String ACTION_STOP = "cn.sunmanxu.musicsmx.STOP";

    /** 由插件注入：把控制指令送回 WebView */
    public interface CommandSink {
        void onCommand(String action, long seekMs);
    }

    private static CommandSink sink;
    private static PlaybackService instance;

    private MediaSession mediaSession;
    private BroadcastReceiver noisyReceiver;
    private boolean foregroundStarted = false;

    private String title = "";
    private String artist = "";
    private String album = "";
    /** 当前这一句歌词：通知栏/锁屏的副标题就放它（安卓没有"任务栏歌词"，通知栏是最接近的位置） */
    private String lyric = "";
    /** 通知内容的指纹，避免歌词每句都重发通知 */
    private String lastNotifiedKey = "";
    private Bitmap cover;
    private boolean playing = false;
    private boolean liked = false;
    private long positionMs = 0;
    private long durationMs = 0;

    public static void setSink(CommandSink s) {
        sink = s;
    }

    public static PlaybackService getInstance() {
        return instance;
    }

    public static void cmdToRenderer(String action, long seekMs) {
        CommandSink s = sink;
        if (s != null) {
            try { s.onCommand(action, seekMs); } catch (Exception ignore) {}
        }
    }

    @Override
    public void onCreate() {
        super.onCreate();
        instance = this;
        createChannel();
        mediaSession = new MediaSession(this, "MusicSMX");
        mediaSession.setCallback(new MediaSession.Callback() {
            @Override public void onPlay() { cmdToRenderer("play", 0); }
            @Override public void onPause() { cmdToRenderer("pause", 0); }
            @Override public void onStop() { cmdToRenderer("stop", 0); }
            @Override public void onSkipToNext() { cmdToRenderer("next", 0); }
            @Override public void onSkipToPrevious() { cmdToRenderer("prev", 0); }
            @Override public void onSeekTo(long pos) { cmdToRenderer("seek", pos); }
            @Override public void onCustomAction(String action, android.os.Bundle extras) {
                if ("smx_like".equals(action)) cmdToRenderer("like", 0);
            }
        });
        mediaSession.setActive(true);

        // 拔耳机 / 蓝牙断开：桌面版靠系统媒体浮层，安卓必须自己接这个广播
        noisyReceiver = new BroadcastReceiver() {
            @Override
            public void onReceive(Context context, Intent intent) {
                if (AudioManager.ACTION_AUDIO_BECOMING_NOISY.equals(intent.getAction())) {
                    cmdToRenderer("pause", 0);
                }
            }
        };
        IntentFilter filter = new IntentFilter(AudioManager.ACTION_AUDIO_BECOMING_NOISY);
        if (Build.VERSION.SDK_INT >= 33) {
            registerReceiver(noisyReceiver, filter, Context.RECEIVER_NOT_EXPORTED);
        } else {
            registerReceiver(noisyReceiver, filter);
        }
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null) {
            String action = intent.getAction();
            if (ACTION_STOP.equals(action)) {
                stopSelf();
                return START_NOT_STICKY;
            }
            if (ACTION_CMD.equals(action)) {
                String cmd = intent.getStringExtra("cmd");
                long seek = intent.getLongExtra("seek", 0);
                if (cmd != null) cmdToRenderer(cmd, seek);
            }
        }
        if (!foregroundStarted) {
            startForegroundCompat();
        }
        return START_STICKY;
    }

    private void startForegroundCompat() {
        try {
            Notification n = buildNotification();
            if (Build.VERSION.SDK_INT >= 29) {
                startForeground(1001, n, 2 /* FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK */);
            } else {
                startForeground(1001, n);
            }
            foregroundStarted = true;
        } catch (Exception e) {
            Log.w(TAG, "startForeground failed", e);
        }
    }

    private void createChannel() {
        if (Build.VERSION.SDK_INT >= 26) {
            NotificationChannel ch = new NotificationChannel(CHANNEL_ID, "正在播放", NotificationManager.IMPORTANCE_LOW);
            ch.setShowBadge(false);
            ch.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC);
            ch.enableVibration(false);
            ch.setSound(null, null);
            NotificationManager nm = getSystemService(NotificationManager.class);
            if (nm != null) nm.createNotificationChannel(ch);
        }
    }

    /** 渲染层每次状态变化都调这里（经插件 updateMediaState） */
    public void updateState(String title, String artist, String album, boolean isPlaying,
                            double positionSec, double durationSec, String coverPayload,
                            String lyricText, boolean isLiked) {
        this.title = title == null ? "" : title;
        this.artist = artist == null ? "" : artist;
        this.album = album == null ? "" : album;
        this.lyric = lyricText == null ? "" : lyricText;
        this.playing = isPlaying;
        this.liked = isLiked;
        this.positionMs = (long) (positionSec * 1000);
        this.durationMs = (long) (durationSec * 1000);
        // 封面 base64 可能接近 900KB：只在渲染层真的换了封面时才解码，空值沿用上一张
        if (coverPayload != null && !coverPayload.isEmpty()) this.cover = decodeCover(coverPayload);

        try {
            MediaMetadata.Builder md = new MediaMetadata.Builder();
            md.putString(MediaMetadata.METADATA_KEY_TITLE, this.title);
            md.putString(MediaMetadata.METADATA_KEY_ARTIST, this.artist);
            md.putString(MediaMetadata.METADATA_KEY_ALBUM, this.album);
            // 时长要给：系统播放卡片（进度条 0:00 / 总时长）就靠它 + PlaybackState 位置
            md.putLong(MediaMetadata.METADATA_KEY_DURATION, this.durationMs);
            if (cover != null) md.putBitmap(MediaMetadata.METADATA_KEY_ALBUM_ART, cover);
            mediaSession.setMetadata(md.build());

            PlaybackState.Builder pb = new PlaybackState.Builder();
            pb.setActions(PlaybackState.ACTION_PLAY | PlaybackState.ACTION_PAUSE | PlaybackState.ACTION_PLAY_PAUSE
                | PlaybackState.ACTION_SKIP_TO_NEXT | PlaybackState.ACTION_SKIP_TO_PREVIOUS
                | PlaybackState.ACTION_SEEK_TO | PlaybackState.ACTION_STOP);
            // 1.0.16：系统播放卡片（小米 HyperOS 等）那排按钮是照 MediaSession 来的，
            // 自造的「喜欢」必须作为 CustomAction 挂上去，卡片右侧才会多出那颗心
            try {
                pb.addCustomAction(new PlaybackState.CustomAction.Builder(
                    "smx_like", liked ? "取消喜欢" : "喜欢",
                    liked ? R.drawable.ic_notif_heart_on : R.drawable.ic_notif_heart)
                    .build());
            } catch (Exception ignore) {}
            int state = playing ? PlaybackState.STATE_PLAYING : PlaybackState.STATE_PAUSED;
            pb.setState(state, positionMs, playing ? 1.0f : 0.0f);
            mediaSession.setPlaybackState(pb.build());
            mediaSession.setActive(true);
        } catch (Exception e) {
            Log.w(TAG, "updateState failed", e);
        }
        if (!foregroundStarted) startForegroundCompat();
        // 歌词每秒都在换：只有内容真的变了才重发通知，别让系统每秒重绘一次
        String key = title + "\u0001" + artist + "\u0001" + lyric + "\u0001" + playing + "\u0001" + liked;
        if (!key.equals(lastNotifiedKey)) {
            lastNotifiedKey = key;
            updateNotification();
        }
    }

    private void updateNotification() {
        try {
            NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
            if (nm != null) nm.notify(1001, buildNotification());
        } catch (Exception ignore) {}
    }

    private Bitmap decodeCover(String payload) {
        try {
            if (payload == null || payload.isEmpty()) return null;
            if (payload.startsWith("data:")) {
                String b64 = payload.substring(payload.indexOf(',') + 1);
                byte[] bytes = Base64.decode(b64, Base64.DEFAULT);
                return BitmapFactory.decodeByteArray(bytes, 0, bytes.length);
            }
            if (payload.startsWith("/")) {
                return BitmapFactory.decodeFile(payload);
            }
        } catch (Exception ignore) {}
        return null;
    }

    private PendingIntent cmdIntent(String cmd, long seek) {
        Intent i = new Intent(this, PlaybackService.class);
        i.setAction(ACTION_CMD);
        i.putExtra("cmd", cmd);
        i.putExtra("seek", seek);
        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= 23) flags |= PendingIntent.FLAG_IMMUTABLE;
        return PendingIntent.getService(this, (cmd + seek).hashCode(), i, flags);
    }

    private Notification buildNotification() {
        Intent open = new Intent(this, MainActivity.class);
        open.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= 23) flags |= PendingIntent.FLAG_IMMUTABLE;
        PendingIntent contentPI = PendingIntent.getActivity(this, 0, open, flags);

        // 1.0.16：API 26+ 走系统自带的 Notification.MediaStyle —— 安卓（小米/HyperOS 也一样）
        // 会把这条通知渲染成和网易云/QQ音乐同款的播放卡片：专辑缩略图 + 歌名 + 播放控制，
        // 展开后还有「喜欢」。低版本（24/25）保留 NotificationCompat 的普通版。
        if (Build.VERSION.SDK_INT >= 26) {
            int prevIcon = android.R.drawable.ic_media_previous;
            int toggleIcon = playing ? android.R.drawable.ic_media_pause : android.R.drawable.ic_media_play;
            int nextIcon = android.R.drawable.ic_media_next;
            int likeIcon = liked ? R.drawable.ic_notif_heart_on : R.drawable.ic_notif_heart;
            int listIcon = R.drawable.ic_notif_list;

            Notification.Action aPrev = new Notification.Action.Builder(
                Icon.createWithResource(this, prevIcon), "上一首", cmdIntent("prev", 0)).build();
            Notification.Action aToggle = new Notification.Action.Builder(
                Icon.createWithResource(this, toggleIcon), playing ? "暂停" : "播放", cmdIntent("toggle", 0)).build();
            Notification.Action aNext = new Notification.Action.Builder(
                Icon.createWithResource(this, nextIcon), "下一首", cmdIntent("next", 0)).build();
            Notification.Action aLike = new Notification.Action.Builder(
                Icon.createWithResource(this, likeIcon), liked ? "取消喜欢" : "喜欢", cmdIntent("like", 0)).build();
            // 第五个：回到 App 的列表页（对应其它音乐 App 卡片右侧那个「列表」图标）
            Notification.Action aOpen = new Notification.Action.Builder(
                Icon.createWithResource(this, listIcon), "打开列表", contentPI).build();

            Notification.MediaStyle style = new Notification.MediaStyle();
            // 小米 HyperOS 的播放卡片：给满 5 个槽位（喜欢 / 上一首 / 暂停播放 / 下一首 / 列表）
            // 才会展开成完整一排，只给 3~4 个时它会退化成「上一首 / 暂停 / 下一首」三颗
            try {
                style.setShowActionsInCompactView(0, 1, 2, 3, 4);
            } catch (Exception e) {
                try {
                    style.setShowActionsInCompactView(0, 1, 2, 3);
                } catch (Exception e2) {
                    style.setShowActionsInCompactView(1, 2, 3);
                }
            }
            try {
                if (mediaSession != null) style.setMediaSession(mediaSession.getSessionToken());
            } catch (Exception ignore) {}

            Notification.Builder nb = new Notification.Builder(this, CHANNEL_ID)
                .setSmallIcon(R.drawable.ic_stat_music)
                .setContentTitle(title.isEmpty() ? "MusicSMX" : title)
                .setContentText(lyric.isEmpty() ? artist : lyric)
                .setContentIntent(contentPI)
                .setShowWhen(false)
                .setOnlyAlertOnce(true)
                .setOngoing(playing)
                .setVisibility(Notification.VISIBILITY_PUBLIC)
                .setStyle(style)
                .addAction(aLike).addAction(aPrev).addAction(aToggle).addAction(aNext).addAction(aOpen);
            // 专辑缩略图：大图位显示封面
            if (cover != null) nb.setLargeIcon(cover);
            if (artist != null && !artist.isEmpty()) {
                nb.setSubText(album == null || album.isEmpty() ? artist : artist + " · " + album);
            }
            if (durationMs > 0) {
                nb.setProgress((int) durationMs, (int) Math.min(positionMs, durationMs), !playing);
            }
            Notification nn = nb.build();
            nn.flags |= Notification.FLAG_ONGOING_EVENT;
            return nn;
        }

        NotificationCompat.Builder b = new NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_stat_music)
            .setContentTitle(title.isEmpty() ? "MusicSMX" : title)
            // 有歌词就把歌词放到第二行（通知栏/锁屏都能看到当前在唱哪句），没有就回落到歌手
            .setContentText(lyric.isEmpty() ? artist : lyric)
            .setContentIntent(contentPI)
            .setShowWhen(false)
            .setOnlyAlertOnce(true)
            .setOngoing(playing)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setPriority(NotificationCompat.PRIORITY_LOW);

        if (cover != null) b.setLargeIcon(cover);
        // 第二行：有歌词放当前这句，没有就放「歌手 · 专辑」，跟其它音乐 App 一致
        if (artist != null && !artist.isEmpty()) {
            b.setSubText(album == null || album.isEmpty() ? artist : artist + " · " + album);
        }
        if (durationMs > 0) {
            b.setProgress((int) durationMs, (int) Math.min(positionMs, durationMs), !playing);
        }

        // 顺序照主流音乐 App：上一首 / 暂停播放 / 下一首 / 喜欢
        b.addAction(new NotificationCompat.Action(
            android.R.drawable.ic_media_previous, "上一首", cmdIntent("prev", 0)));
        b.addAction(new NotificationCompat.Action(
            playing ? android.R.drawable.ic_media_pause : android.R.drawable.ic_media_play,
            playing ? "暂停" : "播放", cmdIntent("toggle", 0)));
        b.addAction(new NotificationCompat.Action(
            android.R.drawable.ic_media_next, "下一首", cmdIntent("next", 0)));
        b.addAction(new NotificationCompat.Action(
            liked ? R.drawable.ic_notif_heart_on : R.drawable.ic_notif_heart,
            liked ? "取消喜欢" : "喜欢", cmdIntent("like", 0)));

        Notification n = b.build();
        n.flags |= Notification.FLAG_ONGOING_EVENT;
        return n;
    }

    @Override
    public void onDestroy() {
        try { unregisterReceiver(noisyReceiver); } catch (Exception ignore) {}
        try { mediaSession.setActive(false); mediaSession.release(); } catch (Exception ignore) {}
        instance = null;
        foregroundStarted = false;
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
