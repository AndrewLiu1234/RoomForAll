# Reverse Engineering JavaScript & Electron Applications

Electron desktop applications bundle web technologies (HTML, CSS, JavaScript/TypeScript) with Node.js and Chromium. While packaged inside archives, their client-side logic is frequently recoverable.

---

## 1. Locating and Extracting the ASAR Archive

Electron packages its application code inside an ASAR (`app.asar`) archive.

### Locating `app.asar`
- **macOS**: `<App>.app/Contents/Resources/app.asar`
- **Windows**: `resources/app.asar` (inside the installation directory)
- **Linux**: `/opt/<app>/resources/app.asar` or `usr/lib/<app>/resources/app.asar`

### Unpacking the ASAR
```bash
# List contents without extraction
npx asar list <path/to/app.asar>

# Extract the archive into an analysis workspace
npx asar extract <path/to/app.asar> ./unpacked_app/
```

---

## 2. Inspecting Electron Architecture & Security Boundaries

Inside the unpacked directory, inspect `package.json` to identify:
1. `main`: The main process entry point (typically `main.js`, `bundle.js`, or `dist/main.js`).
2. Dependencies & build tooling (e.g. `@electron/remote`, `electron-builder`, `webpack`).

### The Main Process vs. Preload vs. Renderer
Inspect how the `BrowserWindow` is instantiated in the main script:
```javascript
// Look for security flags:
const win = new BrowserWindow({
  webPreferences: {
    nodeIntegration: false,        // If true, renderer has raw Node access
    contextIsolation: true,         // If true, preload scripts use contextBridge
    sandbox: true,
    preload: path.join(__dirname, 'preload.js')
  }
});
```

### IPC Channel Mapping
Map all Inter-Process Communication channels between Renderer and Main:
- **Renderer to Main**:
  - `ipcRenderer.send('channel:name', ...args)`
  - `ipcRenderer.invoke('channel:name', ...args)` -> returns a Promise
- **Main Listeners**:
  - `ipcMain.on('channel:name', (event, ...args) => ...)`
  - `ipcMain.handle('channel:name', async (event, ...args) => ...)`
- **Exposed Bridges (`preload.js`)**:
  - Inspect `contextBridge.exposeInMainWorld('api', { ... })` to see what capabilities are exposed to the DOM.

```bash
# Quick grep for IPC channels across the codebase
grep -rnE 'ipcRenderer\.(send|invoke)|ipcMain\.(on|handle)|contextBridge\.exposeInMainWorld' ./unpacked_app/
```

---

## 3. De-minifying Bundles & Recovering Source Maps

Modern web and desktop applications bundle assets with Webpack, esbuild, or Rollup.

### Recovering Inline or External Source Maps
Check bundle files for source map references:
```bash
grep -n 'sourceMappingURL=' ./unpacked_app/**/*.js
```

If a `.map` file is present (or an inline `data:application/json;base64,...` URL):
```bash
# Extract full original source tree using source-map-unpack
npx source-map-unpack <path-to-bundle.js.map> ./recovered_src/
```

### De-obfuscating Minified Code
If source maps are absent:
1. Format minified files using Prettier or Terser:
   ```bash
   npx prettier --write ./unpacked_app/dist/*.js
   ```
2. Search for identifier string mappings or export dictionaries (e.g. `__webpack_require__("...")`).
3. Trace configuration variables, API base URLs, cryptographic salts, and query endpoints.

