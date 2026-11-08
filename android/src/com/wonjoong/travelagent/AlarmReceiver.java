package com.wonjoong.travelagent;

import android.app.Notification;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.os.Vibrator;

/** 하차 알람 등: 진동 + 알림. 채널 API(26+)는 API 23 SDK로 빌드하므로 리플렉션으로 만든다. */
public class AlarmReceiver extends BroadcastReceiver {
    static final String CH = "ta_alarm";

    @Override
    public void onReceive(Context c, Intent in) {
        Vibrator v = (Vibrator) c.getSystemService(Context.VIBRATOR_SERVICE);
        if (v != null) v.vibrate(new long[]{0, 600, 300, 600, 300, 900}, -1);
        NotificationManager nm = (NotificationManager) c.getSystemService(Context.NOTIFICATION_SERVICE);
        Notification.Builder b;
        try {
            if (Build.VERSION.SDK_INT >= 26) {
                Class<?> chc = Class.forName("android.app.NotificationChannel");
                Object ch = chc.getConstructor(String.class, CharSequence.class, int.class)
                        .newInstance(CH, "하차·일정 알람", 4 /* IMPORTANCE_HIGH */);
                chc.getMethod("enableVibration", boolean.class).invoke(ch, true);
                NotificationManager.class.getMethod("createNotificationChannel", chc).invoke(nm, ch);
                b = Notification.Builder.class.getConstructor(Context.class, String.class).newInstance(c, CH);
            } else {
                b = new Notification.Builder(c);
                b.setPriority(Notification.PRIORITY_HIGH);
                b.setVibrate(new long[]{0, 600, 300, 600});
            }
        } catch (Exception e) {
            b = new Notification.Builder(c);
        }
        Intent open = new Intent(c, MainActivity.class);
        open.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent pi = PendingIntent.getActivity(c, 0, open, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        b.setSmallIcon(R.drawable.ic_launcher)
                .setContentTitle(in.getStringExtra("title"))
                .setContentText(in.getStringExtra("text"))
                .setAutoCancel(true)
                .setContentIntent(pi)
                .setCategory(Notification.CATEGORY_ALARM);
        nm.notify(in.getIntExtra("id", 1), b.build());
    }
}
