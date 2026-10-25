# Reverse Engineering Android Applications (APKs)

Android applications are distributed as `.apk` files (ZIP archives containing Dalvik Executable `classes.dex`, compiled resources, and native `.so` libraries).

---

## 1. APK Decompilation & Extraction

### Method 1: Headless JADX (Recommended for Java/Kotlin Code)
JADX decompiles Dalvik bytecode directly to readable Java source code:
```bash
# Decompile entire APK to target output directory
jadx -d ./decompiled_src/ <app.apk>

# Or decompile only code, skipping resource decoding
jadx --no-res -d ./decompiled_src/ <app.apk>
```

### Method 2: Apktool (Recommended for Resources & Manifest)
Apktool decodes resources back to near-original form and converts Dex to Smali:
```bash
apktool d <app.apk> -o ./apktool_out/
```

---

## 2. Inspecting the Android Manifest

Inspect `AndroidManifest.xml` to discover:
- **Package Name & Version**: `<manifest package="com.example.app">`
- **Permissions**: `<uses-permission android:name="android.permission.INTERNET" />`
- **Entry Points & Exported Components**:
  - Activities: `<activity android:name=".MainActivity" android:exported="true">`
  - Services: `<service android:name=".SyncService" />`
  - Broadcast Receivers: `<receiver android:name=".BootReceiver" />`
  - Content Providers: `<provider android:authorities="..." />`
- **Deep Links & Intent Filters**:
  - Look for `<data android:scheme="myapp" android:host="..." />`

---

## 3. Network Security & API Configuration

Inspect network security configurations:
1. In `AndroidManifest.xml`, check `android:networkSecurityConfig="@xml/network_security_config"`.
2. Inspect `res/xml/network_security_config.xml`:
   - Does it permit cleartext traffic (`cleartextTrafficPermitted="true"`)?
   - Are certificates pinned (`<pin-set>`)?
3. Locate HTTP client libraries in decompiled code:
   - **Retrofit**: Look for interface definitions annotated with `@GET`, `@POST`, `@Headers`.
   - **OkHttp**: Search for `OkHttpClient.Builder()`, interceptors, or custom certificate pinners.
   - **Ktor**: Search for `HttpClient`.

---

## 4. Native Libraries (`.so` / JNI)

Native components reside inside `lib/<architecture>/` (e.g., `lib/arm64-v8a/` or `lib/x86_64/`):
- Find native method declarations in Java:
  ```java
  public native String signRequest(String payload);
  ```
- Identify corresponding JNI symbols in the `.so` binary:
  ```bash
  nm -gU libnative.so | grep Java_
  # e.g., Java_com_example_app_NativeClient_signRequest
  ```
- Use Ghidra, Hopper, or IDA on the extracted `.so` file following [Native & Artifacts](./native-and-artifacts.md).

