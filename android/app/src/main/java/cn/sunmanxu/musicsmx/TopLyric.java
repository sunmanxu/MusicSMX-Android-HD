package cn.sunmanxu.musicsmx;

import android.content.Context;
import android.graphics.PixelFormat;
import android.graphics.drawable.GradientDrawable;
import android.os.Build;
import android.provider.Settings;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.WindowManager;
import android.widget.TextView;

/**
 * 顶部歌词条（对应桌面版的「任务栏歌词」）。
 *
 * 安卓没法往系统状态栏里写字（那是系统自己的绘制区域），等价物只能是悬浮窗：
 * 用 TYPE_APPLICATION_OVERLAY 贴在屏幕最顶上，盖在别的 App 之上。
 * 需要「显示在其他应用上层」权限，没权限时 show() 直接返回 false，让渲染层去引导授权。
 * 窗口不可触摸、不可聚焦，点下面的内容照常能点。
 */
public final class TopLyric {

    private static WindowManager wm;
    private static TextView view;
    private static boolean shown = false;
    private static String lastText = "";

    private TopLyric() {}

    public static boolean canDraw(Context c) {
        if (Build.VERSION.SDK_INT >= 23) return Settings.canDrawOverlays(c);
        return true;
    }

    public static boolean isShown() {
        return shown;
    }

    /** 歌词条固定高度（dp 换算成 px）：App 内容区要照这个让出一条，别互相盖住 */
    public static int barHeightPx(Context ctx) {
        return (int) (38 * ctx.getResources().getDisplayMetrics().density);
    }

    /** 状态栏高度：edge-to-edge 之后悬浮条要落在状态栏下面，别把时间盖住 */
    private static int statusBarHeightPx(Context ctx) {
        int id = ctx.getResources().getIdentifier("status_bar_height", "dimen", "android");
        if (id > 0) return ctx.getResources().getDimensionPixelSize(id);
        return (int) (24 * ctx.getResources().getDisplayMetrics().density);
    }

    public static String text() {
        return lastText;
    }

    public static boolean show(Context ctx, int bgColor, int textColor) {
        if (shown) return true;
        if (!canDraw(ctx)) return false;
        try {
            wm = (WindowManager) ctx.getSystemService(Context.WINDOW_SERVICE);
            if (wm == null) return false;

            TextView tv = new TextView(ctx);
            tv.setTextSize(TypedValue.COMPLEX_UNIT_SP, 15);
            tv.setTextColor(textColor);
            tv.setGravity(Gravity.CENTER);
            tv.setSingleLine(true);
            tv.setEllipsize(android.text.TextUtils.TruncateAt.END);
            int ph = (int) (14 * ctx.getResources().getDisplayMetrics().density);
            int pv = (int) (9 * ctx.getResources().getDisplayMetrics().density);
            tv.setPadding(ph, pv, ph, pv);

            // 实底色、不要描边：描边会在状态栏下面划出一条"灰线"，
            // 正好是用户抱怨的那条横杠。
            GradientDrawable bg = new GradientDrawable();
            bg.setColor(bgColor);
            tv.setBackground(bg);
            tv.setText(lastText.isEmpty() ? " " : lastText);
            if (lastText.isEmpty()) tv.setVisibility(android.view.View.INVISIBLE);

            WindowManager.LayoutParams lp = new WindowManager.LayoutParams(
                WindowManager.LayoutParams.MATCH_PARENT,
                barHeightPx(ctx),
                Build.VERSION.SDK_INT >= 26
                    ? WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY
                    : WindowManager.LayoutParams.TYPE_PHONE,
                WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE
                    | WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE
                    | WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN,
                PixelFormat.TRANSLUCENT);
            lp.gravity = Gravity.TOP | Gravity.CENTER_HORIZONTAL;
            lp.y = statusBarHeightPx(ctx);

            wm.addView(tv, lp);
            view = tv;
            shown = true;
            measureBottom(tv);
            return true;
        } catch (Exception e) {
            shown = false;
            view = null;
            return false;
        }
    }

    public static void hide() {
        try {
            if (wm != null && view != null) wm.removeView(view);
        } catch (Exception ignore) {}
        view = null;
        shown = false;
        bottomPx = 0;
    }

    /**
     * 歌词条在屏幕上的真实底边（物理 px）。
     * 让位高度必须按实测来算：不同机型、不同密度下 overlay 的实际 y 偏移
     * 和 status_bar_height 之间能差出上百像素（平板竖屏实测差 97px），照 barHeight 猜会让
     * 歌词条压住 App 自己的顶栏。
     */
    private static int bottomPx = 0;
    /** 布局完成后回调（插件用它把新的让位高度推给网页） */
    public static Runnable onLayout = null;

    public static int bottomPx() { return bottomPx; }

    /** 旋转/分屏/改密度后重新测一次（onLayout 回调会顺带把让位高度推回去） */
    public static void remeasure() {
        try { if (view != null) measureBottom(view); } catch (Exception ignore) {}
    }

    private static void measureBottom(final android.view.View v) {
        try {
            v.post(new Runnable() {
                @Override public void run() {
                    try {
                        int[] loc = new int[2];
                        v.getLocationOnScreen(loc);
                        bottomPx = loc[1] + v.getHeight();
                        if (onLayout != null) onLayout.run();
                    } catch (Exception ignore) {}
                }
            });
        } catch (Exception ignore) {}
    }

    public static void setText(String s) {
        lastText = s == null ? "" : s;
        try {
            if (view != null) {
                view.setText(lastText.isEmpty() ? " " : lastText);
                view.setVisibility(lastText.isEmpty() ? android.view.View.INVISIBLE : android.view.View.VISIBLE);
            }
        } catch (Exception ignore) {}
    }
}
