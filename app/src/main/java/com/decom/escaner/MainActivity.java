package com.decom.escaner;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.ClipData;
import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Bundle;
import android.os.Environment;
import android.provider.MediaStore;
import android.util.Base64;
import android.view.WindowManager;
import android.webkit.JavascriptInterface;
import android.webkit.PermissionRequest;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

import androidx.core.content.FileProvider;

import org.json.JSONArray;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/**
 * Contenedor nativo del escáner. La interfaz y el procesamiento de imagen viven en assets/www.
 * Aquí solo está lo que el navegador no puede hacer solo: abrir la cámara del teléfono,
 * guardar en Descargas / Galería y compartir.
 */
public class MainActivity extends Activity {

    private static final String HOST = "appassets.androidplatform.net";
    private static final String START_URL = "https://" + HOST + "/www/index.html";
    private static final String FOLDER = "Escaner DECOM";
    private static final int REQ_CAMERA = 51;
    private static final int REQ_GALLERY = 52;
    private static final int REQ_PERM_CAMERA = 61;

    // Pedido de cámara de la página que espera el permiso de Android
    private PermissionRequest pendingWebPermission;

    private static final Map<String, String> CONTENT_TYPES = new HashMap<>();
    static {
        CONTENT_TYPES.put("html", "text/html");
        CONTENT_TYPES.put("js", "application/javascript");
        CONTENT_TYPES.put("mjs", "application/javascript");
        CONTENT_TYPES.put("css", "text/css");
        CONTENT_TYPES.put("svg", "image/svg+xml");
        CONTENT_TYPES.put("png", "image/png");
        CONTENT_TYPES.put("jpg", "image/jpeg");
        CONTENT_TYPES.put("json", "application/json");
    }

    private WebView webView;
    private ValueCallback<Uri[]> fileCallback;
    private Uri cameraUri;

    // Imágenes compartidas desde otras apps (se sirven en /entrada/N)
    private final List<Uri> sharedUris = new ArrayList<>();
    private boolean pageReady = false;
    private boolean sharedPending = false;

    // Archivo que el JS está armando en trozos base64
    private ByteArrayOutputStream building;
    private String buildingName;
    private final ArrayList<Uri> shareQueue = new ArrayList<>();

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        webView = new WebView(this);
        setContentView(webView);

        WebSettings s = webView.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(true);
        s.setMediaPlaybackRequiresUserGesture(false);

        webView.addJavascriptInterface(new Bridge(), "Android");
        webView.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                return serve(request.getUrl());
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                return !HOST.equals(request.getUrl().getHost());
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                pageReady = true;
                if (sharedPending) notifyShared();
            }
        });
        webView.setWebChromeClient(new WebChromeClient() {
            /** La cámara dentro de la app (getUserMedia) pide permiso aquí. */
            @Override
            public void onPermissionRequest(PermissionRequest request) {
                runOnUiThread(() -> {
                    boolean video = false;
                    for (String r : request.getResources()) {
                        if (PermissionRequest.RESOURCE_VIDEO_CAPTURE.equals(r)) video = true;
                    }
                    if (!video) {
                        request.deny();
                        return;
                    }
                    if (checkSelfPermission(Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) {
                        request.grant(new String[]{PermissionRequest.RESOURCE_VIDEO_CAPTURE});
                    } else {
                        if (pendingWebPermission != null) pendingWebPermission.deny();
                        pendingWebPermission = request;
                        requestPermissions(new String[]{Manifest.permission.CAMERA}, REQ_PERM_CAMERA);
                    }
                });
            }

            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
                if (fileCallback != null) fileCallback.onReceiveValue(null);
                fileCallback = callback;
                if (params.isCaptureEnabled() && openCamera()) return true;
                return openGallery(params.getMode() == FileChooserParams.MODE_OPEN_MULTIPLE);
            }
        });

        webView.loadUrl(START_URL);
        handleIntent(getIntent());
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        handleIntent(intent);
    }

    /* ---------------- cámara y galería ---------------- */

    private boolean openCamera() {
        try {
            File dir = new File(getCacheDir(), "camara");
            if (!dir.exists() && !dir.mkdirs()) return false;
            // Se conservan pocas fotos temporales
            File[] old = dir.listFiles();
            if (old != null && old.length > 6) for (File f : old) //noinspection ResultOfMethodCallIgnored
                f.delete();
            File photo = new File(dir, "foto_" + System.currentTimeMillis() + ".jpg");
            cameraUri = FileProvider.getUriForFile(this, getPackageName() + ".archivos", photo);
            Intent i = new Intent(MediaStore.ACTION_IMAGE_CAPTURE);
            i.putExtra(MediaStore.EXTRA_OUTPUT, cameraUri);
            i.setClipData(ClipData.newRawUri("foto", cameraUri));
            i.addFlags(Intent.FLAG_GRANT_WRITE_URI_PERMISSION | Intent.FLAG_GRANT_READ_URI_PERMISSION);
            startActivityForResult(i, REQ_CAMERA);
            return true;
        } catch (Exception e) {
            toast("No se encontró la cámara; elige una foto de la galería");
            return false;
        }
    }

    private boolean openGallery(boolean multiple) {
        Intent i = new Intent(Intent.ACTION_GET_CONTENT);
        i.setType("image/*");
        i.addCategory(Intent.CATEGORY_OPENABLE);
        i.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, multiple);
        try {
            startActivityForResult(Intent.createChooser(i, "Elegir fotos"), REQ_GALLERY);
            return true;
        } catch (ActivityNotFoundException e) {
            if (fileCallback != null) fileCallback.onReceiveValue(null);
            fileCallback = null;
            return false;
        }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (fileCallback == null) return;
        Uri[] result = null;
        if (resultCode == RESULT_OK) {
            if (requestCode == REQ_CAMERA && cameraUri != null) {
                result = new Uri[]{cameraUri};
            } else if (requestCode == REQ_GALLERY && data != null) {
                if (data.getClipData() != null) {
                    ClipData clip = data.getClipData();
                    result = new Uri[clip.getItemCount()];
                    for (int k = 0; k < clip.getItemCount(); k++) result[k] = clip.getItemAt(k).getUri();
                } else if (data.getData() != null) {
                    result = new Uri[]{data.getData()};
                }
            }
        }
        fileCallback.onReceiveValue(result);
        fileCallback = null;
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode != REQ_PERM_CAMERA || pendingWebPermission == null) return;
        if (grantResults.length > 0 && grantResults[0] == PackageManager.PERMISSION_GRANTED) {
            pendingWebPermission.grant(new String[]{PermissionRequest.RESOURCE_VIDEO_CAPTURE});
        } else {
            pendingWebPermission.deny();
        }
        pendingWebPermission = null;
    }

    /* ---------------- imágenes compartidas desde otras apps ---------------- */

    private void handleIntent(Intent intent) {
        if (intent == null) return;
        String action = intent.getAction();
        List<Uri> uris = new ArrayList<>();
        if (Intent.ACTION_SEND.equals(action)) {
            Uri u = intent.getParcelableExtra(Intent.EXTRA_STREAM);
            if (u != null) uris.add(u);
        } else if (Intent.ACTION_SEND_MULTIPLE.equals(action)) {
            ArrayList<Uri> list = intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM);
            if (list != null) uris.addAll(list);
        }
        if (uris.isEmpty()) return;
        sharedUris.clear();
        sharedUris.addAll(uris);
        if (pageReady) notifyShared(); else sharedPending = true;
    }

    private void notifyShared() {
        sharedPending = false;
        JSONArray arr = new JSONArray();
        for (int k = 0; k < sharedUris.size(); k++) arr.put("/entrada/" + k + "?t=" + System.currentTimeMillis());
        final String js = "window.onSharedImages && window.onSharedImages(" + arr + ")";
        runOnUiThread(() -> webView.evaluateJavascript(js, null));
    }

    private WebResourceResponse serve(Uri url) {
        if (!HOST.equals(url.getHost()) || url.getPath() == null) return null;
        String path = url.getPath();
        try {
            if (path.startsWith("/entrada/")) {
                int idx = Integer.parseInt(path.substring("/entrada/".length()));
                if (idx < 0 || idx >= sharedUris.size()) return notFound();
                InputStream in = getContentResolver().openInputStream(sharedUris.get(idx));
                return new WebResourceResponse("image/*", null, in);
            }
            if (path.startsWith("/www/")) {
                String asset = path.substring(1);
                if (asset.contains("..")) return notFound();
                String ext = asset.substring(asset.lastIndexOf('.') + 1).toLowerCase(Locale.ROOT);
                String type = CONTENT_TYPES.containsKey(ext) ? CONTENT_TYPES.get(ext) : "application/octet-stream";
                return new WebResourceResponse(type, "UTF-8", getAssets().open(asset));
            }
        } catch (Exception e) {
            return notFound();
        }
        return notFound();
    }

    private WebResourceResponse notFound() {
        WebResourceResponse r = new WebResourceResponse("text/plain", "UTF-8", null);
        r.setStatusCodeAndReasonPhrase(404, "Not Found");
        return r;
    }

    /* ---------------- guardar y compartir ---------------- */

    /** Guarda en Descargas/Escaner DECOM (PDF) o Imágenes/Escaner DECOM (JPG). */
    private Uri saveToMediaStore(byte[] bytes, String name, String mime) throws Exception {
        ContentResolver cr = getContentResolver();
        ContentValues v = new ContentValues();
        v.put(MediaStore.MediaColumns.DISPLAY_NAME, name);
        v.put(MediaStore.MediaColumns.MIME_TYPE, mime);
        v.put(MediaStore.MediaColumns.IS_PENDING, 1);
        Uri collection;
        if (mime.startsWith("image/")) {
            v.put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_PICTURES + "/" + FOLDER);
            collection = MediaStore.Images.Media.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY);
        } else {
            v.put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS + "/" + FOLDER);
            collection = MediaStore.Downloads.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY);
        }
        Uri uri = cr.insert(collection, v);
        if (uri == null) throw new Exception("No se pudo crear el archivo");
        try (OutputStream out = cr.openOutputStream(uri)) {
            if (out == null) throw new Exception("No se pudo escribir");
            out.write(bytes);
        }
        ContentValues done = new ContentValues();
        done.put(MediaStore.MediaColumns.IS_PENDING, 0);
        cr.update(uri, done, null, null);
        return uri;
    }

    private Uri saveToShareCache(byte[] bytes, String name) throws Exception {
        File dir = new File(getCacheDir(), "compartir");
        if (!dir.exists() && !dir.mkdirs()) throw new Exception("Sin espacio temporal");
        File f = new File(dir, name);
        try (FileOutputStream out = new FileOutputStream(f)) {
            out.write(bytes);
        }
        return FileProvider.getUriForFile(this, getPackageName() + ".archivos", f);
    }

    private void toast(String msg) {
        runOnUiThread(() -> Toast.makeText(this, msg, Toast.LENGTH_SHORT).show());
    }

    @Override
    public void onBackPressed() {
        webView.evaluateJavascript("window.handleBack ? window.handleBack() : false", value -> {
            if (!"true".equals(value)) MainActivity.super.onBackPressed();
        });
    }

    /** Métodos que la interfaz web llama como Android.xxx() */
    private class Bridge {
        @JavascriptInterface
        public void beginFile(String name) {
            building = new ByteArrayOutputStream();
            buildingName = name.replaceAll("[\\\\/:*?\"<>|]", "-");
        }

        @JavascriptInterface
        public void appendFile(String base64Chunk) {
            if (building == null) return;
            byte[] b = Base64.decode(base64Chunk, Base64.DEFAULT);
            building.write(b, 0, b.length);
        }

        /**
         * Termina el archivo. destino: "dispositivo" (Descargas o Galería según el tipo)
         * o "compartir" (queda en la cola para shareQueued). Devuelve el uri o "" si falló.
         */
        @JavascriptInterface
        public String endFile(String mime, String destino) {
            if (building == null) return "";
            byte[] bytes = building.toByteArray();
            building = null;
            try {
                if ("compartir".equals(destino)) {
                    Uri u = saveToShareCache(bytes, buildingName);
                    shareQueue.add(u);
                    return u.toString();
                }
                return saveToMediaStore(bytes, buildingName, mime).toString();
            } catch (Exception e) {
                return "";
            }
        }

        @JavascriptInterface
        public void shareQueued(String mime) {
            if (shareQueue.isEmpty()) return;
            Intent i;
            if (shareQueue.size() == 1) {
                i = new Intent(Intent.ACTION_SEND);
                i.putExtra(Intent.EXTRA_STREAM, shareQueue.get(0));
            } else {
                i = new Intent(Intent.ACTION_SEND_MULTIPLE);
                i.putParcelableArrayListExtra(Intent.EXTRA_STREAM, new ArrayList<>(shareQueue));
            }
            i.setType(mime);
            i.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            shareQueue.clear();
            final Intent chooser = Intent.createChooser(i, "Compartir");
            runOnUiThread(() -> {
                try {
                    startActivity(chooser);
                } catch (ActivityNotFoundException e) {
                    toast("No hay apps para compartir");
                }
            });
        }

        @JavascriptInterface
        public void openUri(String uriString, String mime) {
            Intent i = new Intent(Intent.ACTION_VIEW);
            i.setDataAndType(Uri.parse(uriString), mime);
            i.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
            runOnUiThread(() -> {
                try {
                    startActivity(i);
                } catch (ActivityNotFoundException e) {
                    toast("No hay una app para abrir este archivo");
                }
            });
        }

        /** Mantiene la pantalla encendida mientras la cámara está abierta. */
        @JavascriptInterface
        public void keepScreenOn(boolean on) {
            runOnUiThread(() -> {
                if (on) getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
                else getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
            });
        }

        @JavascriptInterface
        public void toast(String msg) {
            MainActivity.this.toast(msg);
        }
    }
}
