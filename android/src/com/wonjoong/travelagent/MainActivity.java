package com.wonjoong.travelagent;

import android.app.Activity;
import android.app.AlarmManager;
import android.app.PendingIntent;
import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.net.ConnectivityManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.Vibrator;
import android.provider.MediaStore;
import android.speech.RecognitionListener;
import android.speech.RecognizerIntent;
import android.speech.SpeechRecognizer;
import android.speech.tts.TextToSpeech;
import android.view.View;
import android.view.Window;
import android.webkit.GeolocationPermissions;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.ArrayList;
import java.util.Locale;

/**
 * 얇은 네이티브 껍데기.
 * 화면은 BASE 주소(GitHub Pages)의 웹 화면을 쓰되, 요청은 가로채서
 * ① 내려받아 둔 최신본(filesDir/www) ② APK에 들어 있는 기본본(assets/www) 순으로 즉시 보여준다.
 * 새 버전은 뒤에서 version.json을 보고 받아 와서 바로 다시 그린다(앱 재설치 없이 수정 반영).
 */
public class MainActivity extends Activity {
    static final String BASE = "https://qkatlehdrnf.github.io/travel-agent/";
    static final String PREFS = "ta";

    WebView web;
    TextToSpeech tts;
    boolean ttsReady = false;
    SpeechRecognizer sr;
    final Handler ui = new Handler(Looper.getMainLooper());
    volatile boolean updating = false;

    @Override
    protected void onCreate(Bundle b) {
        super.onCreate(b);
        Window w = getWindow();
        w.setStatusBarColor(0xFF14202B);

        ArrayList<String> perms = new ArrayList<String>();
        perms.add("android.permission.ACCESS_FINE_LOCATION");
        perms.add("android.permission.ACCESS_COARSE_LOCATION");
        perms.add("android.permission.RECORD_AUDIO");
        if (Build.VERSION.SDK_INT >= 33) perms.add("android.permission.POST_NOTIFICATIONS");
        ArrayList<String> need = new ArrayList<String>();
        for (String p : perms) if (checkSelfPermission(p) != PackageManager.PERMISSION_GRANTED) need.add(p);
        if (!need.isEmpty()) requestPermissions(need.toArray(new String[0]), 1);

        web = new WebView(this);
        setContentView(web);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setGeolocationEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setCacheMode(WebSettings.LOAD_DEFAULT);
        s.setUserAgentString(s.getUserAgentString() + " TravelAgentApp/" + versionName());
        web.addJavascriptInterface(new Bridge(), "Android");
        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onGeolocationPermissionsShowPrompt(String origin, GeolocationPermissions.Callback cb) {
                cb.invoke(origin, true, true);
            }
        });
        web.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView v, WebResourceRequest req) {
                String url = req.getUrl().toString();
                if (!url.startsWith(BASE) || !"GET".equals(req.getMethod())) return null;
                String path = url.substring(BASE.length());
                int q = path.indexOf('?'); if (q >= 0) path = path.substring(0, q);
                int h = path.indexOf('#'); if (h >= 0) path = path.substring(0, h);
                if (path.length() == 0 || path.endsWith("/")) path = path + "index.html";
                if (path.contains("..")) return null;
                InputStream in = openLocal(path);
                if (in == null) return null; // 로컬에 없으면 네트워크로
                WebResourceResponse r = new WebResourceResponse(mime(path), "utf-8", in);
                java.util.HashMap<String, String> hd = new java.util.HashMap<String, String>();
                hd.put("Cache-Control", "no-store");
                hd.put("Access-Control-Allow-Origin", "*");
                r.setResponseHeaders(hd);
                return r;
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView v, String url) {
                if (url.startsWith(BASE)) return false;
                openExternal(url);
                return true;
            }
        });
        if (b != null) web.restoreState(b); else web.loadUrl(BASE + "index.html");

        tts = new TextToSpeech(this, new TextToSpeech.OnInitListener() {
            public void onInit(int st) {
                if (st == TextToSpeech.SUCCESS) { tts.setLanguage(Locale.KOREAN); ttsReady = true; }
            }
        });
        checkUpdate(false);
    }

    @Override
    protected void onSaveInstanceState(Bundle out) { super.onSaveInstanceState(out); web.saveState(out); }

    @Override
    protected void onResume() {
        super.onResume();
        if (web != null) js("window.onAppResume&&onAppResume()");
        checkUpdate(false);
    }

    @Override
    public void onBackPressed() {
        web.evaluateJavascript("(window.onBack&&onBack())?'1':'0'", new ValueCallback<String>() {
            public void onReceiveValue(String v) {
                if (v == null || !v.contains("1")) MainActivity.super.onBackPressed();
            }
        });
    }

    @Override
    protected void onDestroy() {
        if (tts != null) tts.shutdown();
        if (sr != null) sr.destroy();
        super.onDestroy();
    }

    // ---------- local web content ----------
    File wwwDir() { return new File(getFilesDir(), "www"); }

    int bundledBuild() { return readBuild(openAsset("version.json")); }

    int downloadedBuild() {
        File f = new File(wwwDir(), "version.json");
        try { return f.exists() ? readBuild(new FileInputStream(f)) : -1; } catch (Exception e) { return -1; }
    }

    boolean useDownloaded() { return downloadedBuild() > bundledBuild(); }

    int currentBuild() { return Math.max(downloadedBuild(), bundledBuild()); }

    InputStream openAsset(String path) {
        try { return getAssets().open("www/" + path); } catch (Exception e) { return null; }
    }

    InputStream openLocal(String path) {
        if (useDownloaded()) {
            File f = new File(wwwDir(), path);
            if (f.isFile()) { try { return new FileInputStream(f); } catch (Exception e) { } }
        }
        return openAsset(path);
    }

    static int readBuild(InputStream in) {
        if (in == null) return -1;
        try { return new JSONObject(new String(readAll(in), "UTF-8")).optInt("build", -1); } catch (Exception e) { return -1; }
    }

    static byte[] readAll(InputStream in) throws Exception {
        ByteArrayOutputStream bo = new ByteArrayOutputStream();
        byte[] buf = new byte[16384]; int n;
        while ((n = in.read(buf)) > 0) bo.write(buf, 0, n);
        in.close();
        return bo.toByteArray();
    }

    static byte[] httpGet(String u, int timeout) throws Exception {
        HttpURLConnection c = (HttpURLConnection) new URL(u).openConnection();
        c.setConnectTimeout(timeout); c.setReadTimeout(timeout * 2);
        c.setUseCaches(false);
        c.setRequestProperty("Cache-Control", "no-cache");
        int code = c.getResponseCode();
        if (code != 200) throw new Exception("HTTP " + code + " " + u);
        return readAll(c.getInputStream());
    }

    static String mime(String p) {
        p = p.toLowerCase(Locale.ROOT);
        if (p.endsWith(".html")) return "text/html";
        if (p.endsWith(".js")) return "application/javascript";
        if (p.endsWith(".css")) return "text/css";
        if (p.endsWith(".json")) return "application/json";
        if (p.endsWith(".svg")) return "image/svg+xml";
        if (p.endsWith(".png")) return "image/png";
        if (p.endsWith(".jpg") || p.endsWith(".jpeg")) return "image/jpeg";
        if (p.endsWith(".webp")) return "image/webp";
        return "application/octet-stream";
    }

    /** version.json 의 build 가 지금보다 크면 files 목록을 모두 받아서 교체한 뒤 화면에 알린다. */
    void checkUpdate(final boolean manual) {
        if (updating) return;
        updating = true;
        new Thread(new Runnable() {
            public void run() {
                String result;
                try {
                    JSONObject v = new JSONObject(new String(httpGet(BASE + "version.json?t=" + System.currentTimeMillis(), 4000), "UTF-8"));
                    int remote = v.optInt("build", -1);
                    int cur = currentBuild();
                    if (remote > cur) {
                        File tmp = new File(getFilesDir(), "www_tmp");
                        deleteRec(tmp); tmp.mkdirs();
                        JSONArray files = v.getJSONArray("files");
                        for (int i = 0; i < files.length(); i++) {
                            String f = files.getString(i);
                            if (f.contains("..")) continue;
                            byte[] data = httpGet(BASE + f + "?b=" + remote, 8000);
                            File out = new File(tmp, f); out.getParentFile().mkdirs();
                            FileOutputStream fo = new FileOutputStream(out); fo.write(data); fo.close();
                        }
                        FileOutputStream fo = new FileOutputStream(new File(tmp, "version.json"));
                        fo.write(v.toString().getBytes("UTF-8")); fo.close();
                        File old = wwwDir(); deleteRec(old);
                        if (!tmp.renameTo(old)) throw new Exception("rename failed");
                        result = "{\"updated\":true,\"build\":" + remote + ",\"note\":" + JSONObject.quote(v.optString("note", "")) + "}";
                    } else {
                        result = "{\"updated\":false,\"build\":" + cur + "}";
                    }
                    JSONObject apk = v.optJSONObject("apk");
                    if (apk != null && apk.optInt("versionCode", 0) > versionCode()) {
                        js("window.onApkAvailable&&onApkAvailable(" + apk.toString() + ")");
                    }
                } catch (Exception e) {
                    result = "{\"updated\":false,\"error\":" + JSONObject.quote(String.valueOf(e.getMessage())) + "}";
                }
                updating = false;
                js("window.onAppUpdated&&onAppUpdated(" + result + "," + manual + ")");
            }
        }).start();
    }

    static void deleteRec(File f) {
        if (f == null || !f.exists()) return;
        File[] ch = f.listFiles();
        if (ch != null) for (File c : ch) deleteRec(c);
        f.delete();
    }

    int versionCode() {
        try { return getPackageManager().getPackageInfo(getPackageName(), 0).versionCode; } catch (Exception e) { return 0; }
    }

    String versionName() {
        try { return getPackageManager().getPackageInfo(getPackageName(), 0).versionName; } catch (Exception e) { return "?"; }
    }

    void js(final String code) {
        ui.post(new Runnable() { public void run() { if (web != null) web.evaluateJavascript(code, null); } });
    }

    boolean openExternal(String url) {
        try {
            Intent i = new Intent(Intent.ACTION_VIEW, Uri.parse(url));
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            startActivity(i);
            return true;
        } catch (Exception e) {
            return false;
        }
    }

    // ---------- JS bridge ----------
    class Bridge {
        @JavascriptInterface
        public String info() {
            try {
                JSONObject o = new JSONObject();
                o.put("versionCode", versionCode());
                o.put("versionName", versionName());
                o.put("webBuild", currentBuild());
                o.put("bundledBuild", bundledBuild());
                o.put("sdk", Build.VERSION.SDK_INT);
                o.put("voice", SpeechRecognizer.isRecognitionAvailable(MainActivity.this));
                return o.toString();
            } catch (Exception e) { return "{}"; }
        }

        @JavascriptInterface
        public void checkUpdate() { MainActivity.this.checkUpdate(true); }

        @JavascriptInterface
        public void reload() { ui.post(new Runnable() { public void run() { web.clearCache(true); web.loadUrl(BASE + "index.html"); } }); }

        @JavascriptInterface
        public boolean openUrl(String url) { return openExternal(url); }

        @JavascriptInterface
        public boolean canOpen(String url) {
            Intent i = new Intent(Intent.ACTION_VIEW, Uri.parse(url));
            return i.resolveActivity(getPackageManager()) != null;
        }

        @JavascriptInterface
        public void toast(final String m) {
            ui.post(new Runnable() { public void run() { Toast.makeText(MainActivity.this, m, Toast.LENGTH_SHORT).show(); } });
        }

        @JavascriptInterface
        public void vibrate(long ms) {
            Vibrator v = (Vibrator) getSystemService(Context.VIBRATOR_SERVICE);
            if (v != null) v.vibrate(ms);
        }

        @JavascriptInterface
        public boolean isUnmetered() {
            ConnectivityManager cm = (ConnectivityManager) getSystemService(Context.CONNECTIVITY_SERVICE);
            return cm != null && cm.getActiveNetworkInfo() != null && cm.getActiveNetworkInfo().isConnected() && !cm.isActiveNetworkMetered();
        }

        @JavascriptInterface
        public void speak(String text) {
            if (ttsReady) tts.speak(text, TextToSpeech.QUEUE_FLUSH, null, "ta");
        }

        @JavascriptInterface
        public void stopSpeak() { if (ttsReady) tts.stop(); }

        @JavascriptInterface
        public void share(final String text) {
            ui.post(new Runnable() { public void run() {
                Intent i = new Intent(Intent.ACTION_SEND);
                i.setType("text/plain");
                i.putExtra(Intent.EXTRA_TEXT, text);
                startActivity(Intent.createChooser(i, "보내기"));
            } });
        }

        /** Download 폴더에 파일 저장(KML 내보내기 등). Android 10+ 만. */
        @JavascriptInterface
        public String saveDownload(String name, String content, String mimeType) {
            try {
                if (Build.VERSION.SDK_INT < 29) return "Android 10 이상에서만 저장할 수 있어요";
                ContentResolver cr = getContentResolver();
                ContentValues cv = new ContentValues();
                cv.put("_display_name", name);
                cv.put("mime_type", mimeType);
                cv.put("relative_path", "Download/");
                Uri u = cr.insert(MediaStore.Files.getContentUri("external"), cv);
                if (u == null) return "저장 실패";
                OutputStream o = cr.openOutputStream(u);
                o.write(content.getBytes("UTF-8")); o.close();
                return "ok";
            } catch (Exception e) { return "저장 실패: " + e.getMessage(); }
        }

        @JavascriptInterface
        public void setAlarm(int id, double atMs, String title, String text) {
            AlarmManager am = (AlarmManager) getSystemService(Context.ALARM_SERVICE);
            Intent i = new Intent(MainActivity.this, AlarmReceiver.class);
            i.putExtra("id", id); i.putExtra("title", title); i.putExtra("text", text);
            PendingIntent pi = PendingIntent.getBroadcast(MainActivity.this, id, i,
                    PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
            am.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, (long) atMs, pi);
        }

        @JavascriptInterface
        public void cancelAlarm(int id) {
            AlarmManager am = (AlarmManager) getSystemService(Context.ALARM_SERVICE);
            Intent i = new Intent(MainActivity.this, AlarmReceiver.class);
            PendingIntent pi = PendingIntent.getBroadcast(MainActivity.this, id, i,
                    PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
            am.cancel(pi);
        }

        @JavascriptInterface
        public void startVoice(final String lang) {
            ui.post(new Runnable() { public void run() { beginVoice(lang); } });
        }

        @JavascriptInterface
        public void stopVoice() {
            ui.post(new Runnable() { public void run() { if (sr != null) sr.stopListening(); } });
        }

        @JavascriptInterface
        public String prefGet(String k) { return getSharedPreferences(PREFS, 0).getString(k, null); }

        @JavascriptInterface
        public void prefSet(String k, String v) { getSharedPreferences(PREFS, 0).edit().putString(k, v).apply(); }
    }

    void beginVoice(String lang) {
        if (checkSelfPermission("android.permission.RECORD_AUDIO") != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[]{"android.permission.RECORD_AUDIO"}, 2);
            js("window.onVoice&&onVoice({type:'error',msg:'마이크 권한을 허용해 주세요'})");
            return;
        }
        if (!SpeechRecognizer.isRecognitionAvailable(this)) {
            js("window.onVoice&&onVoice({type:'error',msg:'이 폰에서 음성 인식을 쓸 수 없어요'})");
            return;
        }
        if (sr != null) sr.destroy();
        sr = SpeechRecognizer.createSpeechRecognizer(this);
        sr.setRecognitionListener(new RecognitionListener() {
            public void onReadyForSpeech(Bundle p) { js("window.onVoice&&onVoice({type:'ready'})"); }
            public void onBeginningOfSpeech() { }
            public void onRmsChanged(float r) { }
            public void onBufferReceived(byte[] b) { }
            public void onEndOfSpeech() { js("window.onVoice&&onVoice({type:'end'})"); }
            public void onError(int e) { js("window.onVoice&&onVoice({type:'error',code:" + e + "})"); }
            public void onResults(Bundle r) { send("final", r); }
            public void onPartialResults(Bundle r) { send("partial", r); }
            public void onEvent(int t, Bundle p) { }
            void send(String type, Bundle r) {
                ArrayList<String> l = r.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION);
                String t = (l != null && !l.isEmpty()) ? l.get(0) : "";
                js("window.onVoice&&onVoice({type:'" + type + "',text:" + JSONObject.quote(t) + "})");
            }
        });
        Intent i = new Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH);
        i.putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM);
        i.putExtra(RecognizerIntent.EXTRA_LANGUAGE, lang == null || lang.length() == 0 ? "ko-KR" : lang);
        i.putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true);
        i.putExtra("android.speech.extra.PREFER_OFFLINE", true);
        sr.startListening(i);
    }
}
