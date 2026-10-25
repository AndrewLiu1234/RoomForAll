# Native Binaries, Managed Code & Artifact Extraction

This guide covers analyzing compiled native binaries (Mach-O, ELF, PE), managed assemblies (.NET), containers, and firmware packages.

---

## 1. Native Binary Inspection Pipeline

### Step 1: Binary Identification & Header Inspection
Determine architecture, binary format, linkage type, and protections:
```bash
file <binary>

# macOS (Mach-O headers & load commands)
otool -hv <binary>
otool -l <binary> | grep -E 'cmd |cryptid|segname'

# Linux / ELF headers
readelf -h <binary>
readelf -l <binary>

# Security mitigations (ASLR / PIE, stack canaries, NX)
checksec --file=<binary> 2>/dev/null || otool -hv <binary>
```

### Step 2: Extracting Strings & Critical Constants
Strings often yield API endpoints, encryption identifiers, file paths, and format strings:
```bash
# ASCII and Unicode strings with offsets
strings -a -t x <binary> | grep -iE 'http|token|secret|key|api|encrypt|sign'

# In Mach-O, dump specific sections (__cstring, __os_log)
otool -v -s __TEXT __cstring <binary>
```

### Step 3: Symbols & Dynamic Relocations
```bash
# Exported and imported symbols
nm -gU <binary> 2>/dev/null || nm -D <binary> 2>/dev/null

# Shared libraries / linked frameworks
otool -L <binary>        # macOS
ldd <binary> 2>/dev/null || readelf -d <binary> | grep NEEDED  # Linux
```

### Step 4: Decompilation & Control Flow Analysis
Using Ghidra, Hopper, or IDA via REA `open_binary`:
- Locate the entry point (`_main`, `main`, or exported handler).
- Identify cross-references (XREFs) to the critical strings found in Step 2.
- Inspect the decompiled pseudocode around authentication, serialization, and business logic.
- Trace arguments passed to cryptographic libraries (CommonCrypto, OpenSSL, libsodium).

---

## 2. Managed Code (.NET Assemblies)

.NET assemblies (`.exe`, `.dll`) compile to Common Intermediate Language (CIL/MSIL), retaining rich metadata.

### Tools:
- **ILSpy CLI / dnSpy**: Decompile CIL back into readable C#.
- **monodis / ikdasm**: Disassemble CIL instructions.

```bash
# Inspect assembly metadata & dependencies
monodis --assemblyref <assembly.dll>

# Export all types and methods
monodis --typedef <assembly.dll>
```

---

## 3. Archive & Container Extraction

### macOS Disk Images (`.dmg`)
```bash
# Attach DMG quietly
hdiutil attach -nobrowse -readonly <image.dmg>

# Copy payload to inspection directory, then detach
cp -R "/Volumes/<VolumeName>/<App>.app" ./extracted/
hdiutil detach "/Volumes/<VolumeName>"
```

### Windows Installers & MSI / MSIX
```bash
# Extract MSI archive
msiextract <installer.msi> -C ./extracted/

# Extract InnoSetup or NSIS installers
7z x <installer.exe> -o./extracted/
```

### Firmware Blobs & Compressed Images
```bash
# Scan and extract nested filesystems (SquashFS, CramFS, JFFS2)
binwalk -Me <firmware.bin>

# Or modern unblob engine
unblob <firmware.bin>
```

