package cn.sunmanxu.musicsmx;

import android.Manifest;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.Bundle;
import android.webkit.WebSettings;

import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    /** 界面是否在前台：用来判断能不能安全地启动前台服务（Android 12+ 后台启动 FGS 会抛异常） */
    public static volatile boolean visible = false;

    /** 顶部悬浮歌词条额外占行的像素（0 = 没开） */
    private int extraTopPx = 0;
    private int lastL = 0, lastT = 0, lastR = 0, lastB = 0;

    @Override
    public void onResume() {
        super.onResume();
        visible = true;
    }

    @Override
    public void onPause() {
        visible = false;
        super.onPause();
    }

    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(MusicBridgePlugin.class);
        super.onCreate(savedInstanceState);

        try {
            WebSettings s = bridge.getWebView().getSettings();
            // 播放器必须能自动续播（恢复上次曲目时没有用户手势）
            s.setMediaPlaybackRequiresUserGesture(false);
            s.setJavaScriptEnabled(true);
            s.setDomStorageEnabled(true);
            s.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
            // WebView 自己默认是白底：海报模式的界面底色是半透明的，
            // 背后一旦是白色，整个列表就会变成灰白一片（文字也跟着看不清）。
            bridge.getWebView().setBackgroundColor(0xFF12141A);
        } catch (Exception ignore) {}

        requestNotificationPermission();
        // 侧滑返回（Android 13+ 的 OnBackInvokedCallback）：不注册的话侧滑会被系统直接当成"退出 Activity"
        setupBackCallback();
        // 真·edge-to-edge：WebView 铺到状态栏/导航栏底下，系统栏背景透明。
        // 这样状态栏那条显示的就是软件自己的底色（含海报氛围层），而不是原生那一块纯色。
        applyEdgeToEdge();
        applySystemBarInsets();
        // 图标按深色皮肤来（浅色图标的"透明白勾"在深底上会发灰，很像一条灰条）
        applyChromeColors(0x00000000, 0x00000000, false);
    }

    /** 让内容铺满整屏（含状态栏/导航栏区域），系统栏本身画成透明 */
    private void applyEdgeToEdge() {
        try {
            androidx.core.view.WindowCompat.setDecorFitsSystemWindows(getWindow(), false);
            android.util.Log.i("MusicBridge", "setDecorFitsSystemWindows(false) done");
        } catch (Throwable t) {
            android.util.Log.w("MusicBridge", "setDecorFitsSystemWindows failed", t);
        }
        try {
            getWindow().setStatusBarColor(android.graphics.Color.TRANSPARENT);
            getWindow().setNavigationBarColor(android.graphics.Color.TRANSPARENT);
            if (Build.VERSION.SDK_INT >= 29) {
                // 手势条那一小块也别垫系统默认的半透明遮罩，否则底部又是一条灰带
                getWindow().setNavigationBarDividerColor(android.graphics.Color.TRANSPARENT);
                getWindow().setNavigationBarContrastEnforced(false);
                getWindow().setStatusBarContrastEnforced(false);
            }
            getWindow().getDecorView().setBackgroundColor(android.graphics.Color.TRANSPARENT);
            bridge.getWebView().setBackgroundColor(0x00000000);
            android.view.View decor = getWindow().getDecorView();
            android.util.Log.i("MusicBridge", "decor padT=" + decor.getPaddingTop()
                + " decorH=" + decor.getHeight() + " wvH=" + bridge.getWebView().getHeight());
        } catch (Exception ignore) {}
    }

    /**
     * 状态栏 / 导航栏配色跟随软件主题（渲染层通过 setChromeColors 推当前底色过来）。
     * edge-to-edge 之后底色由网页自己画，这里只负责图标明暗。
     */
    public void applyChromeColors(int topColor, int bottomColor, boolean lightIcons) {
        try {
            androidx.core.view.WindowInsetsControllerCompat c =
                androidx.core.view.WindowCompat.getInsetsController(getWindow(), getWindow().getDecorView());
            c.setAppearanceLightStatusBars(lightIcons);
            c.setAppearanceLightNavigationBars(lightIcons);
        } catch (Exception ignore) {}
    }

    /**
     * 1.0.14：播放页「沉浸全屏」时把系统栏（状态栏 + 手势条）也收起来，
     * 只留封面和歌词；退出沉浸再显回来。上滑一次会临时浮出，随后自动隐藏。
     */
    public void setImmersiveBars(final boolean on) {
        runOnUiThread(() -> {
            try {
                androidx.core.view.WindowInsetsControllerCompat c =
                    androidx.core.view.WindowCompat.getInsetsController(getWindow(), getWindow().getDecorView());
                if (on) {
                    c.setSystemBarsBehavior(
                        androidx.core.view.WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
                    c.hide(androidx.core.view.WindowInsetsCompat.Type.systemBars());
                } else {
                    c.show(androidx.core.view.WindowInsetsCompat.Type.systemBars());
                }
            } catch (Throwable t) {
                android.util.Log.w("MusicBridge", "setImmersiveBars failed", t);
            }
        });
    }

    /** 状态栏高度（给顶部悬浮歌词条让位用） */
    public int statusBarHeightPx() {
        return lastT;
    }

    /**
     * 状态栏 / 刘海 / 手势条留白。
     * edge-to-edge 之后内容已经铺到系统栏底下，留白必须由网页自己加（padding 加在 #app 上），
     * 所以这里只负责把 insets 数值推给渲染层，不再给原生 content 加 padding
     * —— 原生加 padding 就是那条"深灰横条"的来源。
     */
    private void applySystemBarInsets() {
        try {
            // 关键：监听器装在 DecorView 上并返回 insets，DecorView 就不会再照着系统栏给
            // 自己加 padding —— 那条"深灰横条"就是这层 padding 露出来的原生底色。
            // 留白改由网页自己加（CSS 变量 --mb-top/--mb-bottom）。
            final android.view.View decor = getWindow().getDecorView();
            decor.setFitsSystemWindows(false);
            androidx.core.view.ViewCompat.setOnApplyWindowInsetsListener(decor, (v, insets) -> {
                androidx.core.graphics.Insets bars = insets.getInsets(
                    androidx.core.view.WindowInsetsCompat.Type.systemBars()
                        | androidx.core.view.WindowInsetsCompat.Type.displayCutout());
                lastL = bars.left; lastT = bars.top; lastR = bars.right; lastB = bars.bottom;
                v.setPadding(0, 0, 0, 0);
                pushInsetsToWeb(lastT, lastR, lastB, lastL, extraTopPx);
                return insets;
            });
            androidx.core.view.ViewCompat.requestApplyInsets(decor);
            decor.requestLayout();
            pushInsetsToWeb(lastT, lastR, lastB, lastL, extraTopPx);
        } catch (Exception ignore) {}
    }

    /** 把 inset 数值推给网页：CSS 变量 --mb-top/--mb-bottom/--mb-extra-top（单位换算成 dp=CSS px） */
    private void pushInsetsToWeb(final int top, final int right, final int bottom, final int left, final int extraTop) {
        try {
            final float dens = getResources().getDisplayMetrics().density;
            final int t = Math.round(top / dens);
            final int r = Math.round(right / dens);
            final int b = Math.round(bottom / dens);
            final int l = Math.round(left / dens);
            final int e = Math.round(extraTop / dens);
            final String js = "window.__mbInsets&&window.__mbInsets(" + t + "," + r + "," + b + "," + l + "," + e + ")";
            bridge.getWebView().post(new Runnable() {
                @Override public void run() {
                    try { bridge.getWebView().evaluateJavascript(js, null); } catch (Exception ignore) {}
                }
            });
        } catch (Exception ignore) {}
    }

    /**
     * 顶部悬浮歌词条占掉的高度：开着的时候把内容区往下让一条，
     * 否则那条歌词会盖住软件自己的顶栏（搜索框）。
     */
    public void setExtraTopPx(final int px) {
        extraTopPx = Math.max(0, px);
        runOnUiThread(new Runnable() {
            @Override public void run() { applySystemBarInsets(); }
        });
    }

    private void requestNotificationPermission() {
        if (Build.VERSION.SDK_INT >= 33) {
            if (ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS)
                != PackageManager.PERMISSION_GRANTED) {
                ActivityCompat.requestPermissions(this, new String[]{Manifest.permission.POST_NOTIFICATIONS}, 1001);
            }
        }
    }

    @Override
    public void onConfigurationChanged(android.content.res.Configuration cfg) {
        super.onConfigurationChanged(cfg);
        // 旋转/分屏后 insets 会变，但值没变时监听器不一定重跑，这里补推一次
        runOnUiThread(new Runnable() {
            @Override public void run() {
                try {
                    androidx.core.view.ViewCompat.requestApplyInsets(getWindow().getDecorView());
                } catch (Exception ignore) {}
                pushInsetsToWeb(lastT, lastR, lastB, lastL, extraTopPx);
                // 顶部歌词条在横竖屏切换后位置会变，重新量一次（量完会把让位高度推回来）
                try { TopLyric.remeasure(); } catch (Throwable ignore) {}
            }
        });
    }

    /** 返回键：交给网页按自己的层级回退；网页明确说"到顶了"（exit）才退到后台 */
    private long lastBackAt = 0L;

    /**
     * Android 13+ 起"侧滑返回"走的是 OnBackInvokedDispatcher，不再是 onBackPressed。
     * 小米平板（HyperOS / Android 14）上如果没注册这个回调，侧滑会被系统当成"完成 Activity"，
     * 于是不管在哪一层都直接回桌面 —— 这就是用户反馈的"侧滑一下就回桌面"。
     * 所以这里必须显式注册（配合 AndroidManifest 的 enableOnBackInvokedCallback="true"）。
     */
    private void setupBackCallback() {
        if (Build.VERSION.SDK_INT < 33) return;
        try {
            android.window.OnBackInvokedCallback cb = () -> handleBack("gesture");
            getOnBackInvokedDispatcher().registerOnBackInvokedCallback(
                android.window.OnBackInvokedDispatcher.PRIORITY_DEFAULT, cb);
            android.util.Log.i("MusicSMX", "OnBackInvokedCallback registered");
        } catch (Throwable t) {
            android.util.Log.w("MusicSMX", "register back callback failed: " + t);
        }
    }

    private void handleBack(final String from) {
        // 极少数 ROM 会把同一次手势派发两次，去重一下免得一层被连退两层
        long now = System.currentTimeMillis();
        if (now - lastBackAt < 250) return;
        lastBackAt = now;
        try {
            bridge.getWebView().evaluateJavascript(
                // 1) 渲染层抛异常一律当"已处理"，绝不能让一次报错把用户踢出 App
                // 2) 只有同时满足"网页说 exit" + "确认已在根页面" 才真的离开
                "(function(){try{var r=window.__mbBack?window.__mbBack():'handled';" +
                "if(r==='exit'){return (window.__mbAtRoot&&window.__mbAtRoot())?'exit':'handled';}" +
                "return r;}catch(e){return 'handled';}})()",
                value -> {
                    String v = value == null ? "null" : value.trim();
                    android.util.Log.i("MusicSMX", "back(" + from + ") -> " + v);
                    if (v.equals("\"exit\"") || v.equals("exit")) moveTaskToBack(true);
                });
        } catch (Exception e) {
            android.util.Log.w("MusicSMX", "back evaluate failed: " + e);
        }
    }

    @Override
    public void onBackPressed() {
        handleBack("key");
    }
}
