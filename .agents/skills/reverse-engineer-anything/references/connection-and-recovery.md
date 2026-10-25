# Connection, Diagnostics & Recovery

This guide covers troubleshooting, diagnostics, and session recovery when working with REA tools, Model Context Protocol (MCP) servers, and local analysis engines.

---

## 1. Diagnostics with REA Doctor

If REA MCP tools fail to respond or backend engines cannot be reached, run REA diagnostics:

```bash
# Run automated client environment check
npx -y rea-agents@latest doctor

# Inspect registered capabilities and decompilers in JSON format
npx -y rea-agents@latest providers --json
```

### Checking Specific Engine Availability
- **Java Runtime** (Required for Ghidra and JADX):
  ```bash
  java -version
  ```
  *Requires Java 17+ or 21+ for modern Ghidra releases.*
- **Ghidra**:
  ```bash
  which ghidra || which ghidraRun || echo $GHIDRA_INSTALL_DIR
  ```
- **Node & asar** (Required for Electron/JavaScript apps):
  ```bash
  node -v
  npx asar --version
  ```
- **Disassemblers (macOS / Linux)**:
  ```bash
  otool -v || objdump --version || llvm-objdump --version
  ```

---

## 2. Session Lifecycle & Re-Establishing Sessions

Certain reverse-engineering tasks require long-running background processes (e.g., initial auto-analysis of large binaries by Ghidra, or full APK deobfuscation by JADX).

### Handling Tool Timeouts
1. Large binaries (e.g. >50 MB) can exceed default tool timeouts while parsing symbols.
2. If a call to `open_binary` or `analyze_javascript_application` times out:
   - Check if a background worker process is running:
     ```bash
     ps aux | grep -iE 'ghidra|jadx|rea'
     ```
   - Avoid immediately re-invoking the command with identical parameters, which could spawn duplicate analysis threads.
   - Wait for the initial import job to finish or check the analysis cache directory (`~/.cache/rea/` or local target workdir).

### Session Drops & Disconnects
If an MCP tool session drops or reports `Session expired` / `No active target`:
1. Re-open the session targeting the original file path:
   - In MCP: call `open_binary(path="...")` again.
   - In CLI: verify target path integrity and restart the session.
2. REA preserves analysis caches and symbol databases in its working directory, so reopening an already analyzed target will instantly re-attach to the cached state.

---

## 3. Handling Permission and Execution Blocks

When reverse-engineering software on macOS or Linux:

### macOS Gatekeeper & Quarantine
If inspecting an app downloaded from the web or extracted from DMG:
```bash
# Check quarantine attribute
xattr -l <path-to-binary-or-app>

# Remove quarantine flag if authorized to inspect
xattr -d com.apple.quarantine <path-to-binary-or-app>
```

### Sandboxed Environments
- In restricted sandboxes without internet access, rely on local binaries (`nm`, `strings`, `otool`, `objdump`, `hexdump`, `grep`, `file`).
- When elevated permissions or external network access are needed (such as downloading dependencies or symbol tables), make single, scoped requests with clear justification.

