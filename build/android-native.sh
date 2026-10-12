#!/usr/bin/env bash
# Scorecard Android adapter. Generated only in android CI builds, never on web or iOS.
set -euo pipefail
DIR="android/app/src/main/java/io/github/willyros01/scorecard"
mkdir -p "$DIR"
cat > "$DIR/MainActivity.java" <<'JAVA'
package io.github.willyros01.scorecard;
import android.os.Bundle;
import com.getcapacitor.BridgeActivity;
public class MainActivity extends BridgeActivity {
  @Override public void onCreate(Bundle savedInstanceState) {
    registerPlugin(ScorecardAndroidPlugin.class);
    super.onCreate(savedInstanceState);
  }
}
JAVA

cat > "$DIR/ScorecardAndroidPlugin.java" <<'JAVA'
package io.github.willyros01.scorecard;
import android.Manifest;
import android.content.ActivityNotFoundException;
import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.MediaStore;

import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;

@CapacitorPlugin(name="ScorecardAndroid", permissions={
  @Permission(alias="legacyStorage",strings={Manifest.permission.WRITE_EXTERNAL_STORAGE})
})
public class ScorecardAndroidPlugin extends Plugin {
  @PluginMethod
  public void openExternal(PluginCall call) {
    String url=call.getString("url");
    if(url==null || url.length()>6000) { call.reject("Invalid address"); return; }
    final Uri address;
    try {
      address=Uri.parse(url);
      String scheme=address.getScheme();
      if(scheme==null || !(scheme.equalsIgnoreCase("https") || scheme.equalsIgnoreCase("http")
        || scheme.equalsIgnoreCase("mailto") || scheme.equalsIgnoreCase("sms")
        || scheme.equalsIgnoreCase("smsto"))) {
        call.reject("Unsupported external address"); return;
      }
      if ((scheme.equalsIgnoreCase("https")||scheme.equalsIgnoreCase("http"))
          && (address.getHost()==null || address.getHost().isEmpty())) {
        call.reject("External website address is incomplete"); return;
      }
      // Do not use resolveActivity(getPackageManager()): on Fire OS / Android 11+
      // package visibility may wrongly report Silk as absent.
      Intent intent = new Intent(Intent.ACTION_VIEW,address);
      intent.addCategory(Intent.CATEGORY_BROWSABLE);
      intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
      getContext().startActivity(intent);
      call.resolve(new JSObject());
    } catch(ActivityNotFoundException e) {
      call.reject("No app can open this address",e);
    } catch(Exception e) {
      call.reject("Could not open external address",e);
    }
  }

  @PluginMethod
  public void saveToDownloads(PluginCall call) {
    String name=call.getString("fileName");
    String data=call.getString("data");
    if(name==null || !name.matches("[A-Za-z0-9._-]+\\.(json|txt|csv)")
         || data==null || data.length()>12000000) {
      call.reject("Invalid file name or backup data"); return;
    }
    if(Build.VERSION.SDK_INT>=Build.VERSION_CODES.Q) {
      writeScoped(call,name,data); return;
    }
    if(getPermissionState("legacyStorage")!=PermissionState.GRANTED) {
      requestPermissionForAlias("legacyStorage",call,"permissionResult"); return;
    }
    writeLegacy(call,name,data);
  }

  @PermissionCallback
  private void permissionResult(PluginCall call) {
    if(call==null) return;
    if(getPermissionState("legacyStorage")!=PermissionState.GRANTED) {
      call.reject("Storage permission was denied"); return;
    }
    String name=call.getString("fileName"),data=call.getString("data");
    if(name==null || data==null) { call.reject("Backup expired; please retry"); return; }
    writeLegacy(call,name,data);
  }

  private void success(PluginCall call,String name) {
    JSObject r=new JSObject();
    r.put("saved",true);
    r.put("fileName",name);
    r.put("location","Downloads");
    call.resolve(r);
  }

  private void writeScoped(PluginCall call,String name,String data) {
    ContentResolver resolver=getContext().getContentResolver();
    ContentValues v=new ContentValues();
    v.put(MediaStore.MediaColumns.DISPLAY_NAME,name);
    v.put(MediaStore.MediaColumns.MIME_TYPE,name.endsWith(".json")?"application/json":
      name.endsWith(".csv")?"text/csv":"text/plain");
    v.put(MediaStore.MediaColumns.RELATIVE_PATH,Environment.DIRECTORY_DOWNLOADS+"/");
    v.put(MediaStore.MediaColumns.IS_PENDING,1);
    Uri uri=null;
    try {
      uri=resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI,v);
      if(uri==null) throw new IOException("Downloads is unavailable");
      try(OutputStream out=resolver.openOutputStream(uri,"w")) {
        if(out==null) throw new IOException("Cannot write Downloads file");
        out.write(data.getBytes(StandardCharsets.UTF_8));
        out.flush();
      }
      ContentValues ready=new ContentValues();
      ready.put(MediaStore.MediaColumns.IS_PENDING,0);
      if(resolver.update(uri,ready,null,null)<1) throw new IOException("Cannot finish backup");
      String realName=name;
      try(Cursor cursor=resolver.query(uri,new String[]{MediaStore.MediaColumns.DISPLAY_NAME},null,null,null)) {
        if(cursor!=null && cursor.moveToFirst()) realName=cursor.getString(0);
      } catch(Exception ignored) { /* already saved; only label query failed */ }
      success(call,realName);
    } catch(Exception e) {
      if(uri!=null) try{resolver.delete(uri,null,null);}catch(Exception ignored){}
      call.reject("Could not write Downloads file: "+e.getMessage());
    }
  }

  @SuppressWarnings("deprecation")
  private void writeLegacy(PluginCall call,String name,String data) {
    File file=null;
    try {
      if(!Environment.MEDIA_MOUNTED.equals(Environment.getExternalStorageState()))
        throw new IOException("Storage unavailable");
      File dir=Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS);
      if(!dir.exists()&&!dir.mkdirs()) throw new IOException("Cannot open Downloads");
      String prefix=name.substring(0,name.lastIndexOf('.'));
      String ext=name.substring(name.lastIndexOf('.'));
      file=new File(dir,name);
      for(int i=2;file.exists();i++) {
        if(i>1000) throw new IOException("Too many backup copies");
        file=new File(dir,prefix+"-"+i+ext);
      }
      if(!file.createNewFile()) throw new IOException("Cannot create file");
      try(OutputStream out=new FileOutputStream(file)) {
        out.write(data.getBytes(StandardCharsets.UTF_8));out.flush();
      }
      success(call,file.getName());
    } catch(Exception e) {
      if(file!=null&&file.exists()) file.delete();
      call.reject("Could not write Downloads file: "+e.getMessage());
    }
  }
}
JAVA
# Android 9 and earlier require storage permission; Android 10+ MediaStore needs none.
python3 - <<'PY'
from pathlib import Path
p=Path("android/app/src/main/AndroidManifest.xml")
s=p.read_text()
perm='<uses-permission android:name="android.permission.WRITE_EXTERNAL_STORAGE" android:maxSdkVersion="28" />'
if perm not in s:
    assert '<application' in s
    s=s.replace('<application',perm+'\n    <application',1)
    p.write_text(s)
# Add Android App Links for Scorecard one-use invitation links. Existing iOS AASA untouched.
link='''<intent-filter android:autoVerify="true">\n                <action android:name="android.intent.action.VIEW" />\n                <category android:name="android.intent.category.DEFAULT" />\n                <category android:name="android.intent.category.BROWSABLE" />\n                <data android:scheme="https" android:host="www.cuberoot-systems.com" android:pathPrefix="/scorecard/join/" />\n            </intent-filter>\n        '''
if link not in s:
    assert '</activity>' in s, "Unexpected Android activity manifest layout"
    s=s.replace('</activity>',link+'</activity>',1)
    p.write_text(s)
PY
