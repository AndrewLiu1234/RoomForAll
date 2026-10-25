---
name: reverse-engineer-anything
description: >-
  Reverse engineer native binaries, managed assemblies, Electron/JavaScript applications, Android APKs, packaged artifacts, firmware, and browser/web runtime targets with REA (Reverse Engineer Anything), and build clean-room reconstructions or AgentEnv specifications. Use this skill when an investigation or feature reproduction depends on shipped binaries, compiled packages, decompilation, runtime network captures, or application behavior not documented in source code. Skip for ordinary source-repository architecture analysis.
---

# Reverse Engineer Anything (REA)

REA is an agentic reverse-engineering framework that connects AI assistants to local binary analysis engines, decompilers, runtime observers, and package parsers. Rather than speculating or hallucinating code implementations from high-level descriptions, REA grounds analysis strictly in verifiable evidence extracted directly from compiled targets.

---

## 1. Scope & Activation Rules

### When to Use REA
Activate this skill whenever a task involves:
- **Compiled or Native Binaries**: Mach-O, ELF, or PE executables, dynamic libraries (`.dylib`, `.so`, `.dll`), stripped symbols, or firmware.
- **Packaged & Desktop Apps**: Electron applications (`.asar`), Node bundles, or desktop installers.
- **Managed Code**: Android APKs, Dex bytecode, or .NET assemblies (`.exe`/`.dll` Common Intermediate Language).
- **Web & Network Runtime Captures**: Inspecting undocumented APIs, WebSocket streams, `.har` captures, or live browser sessions.
- **Feature Reconstruction & Clean-Room Specs**: Extracting an algorithm, protocol, data format, or UI interaction pattern from a closed app to reimplement cleanly.

### When to Skip REA
- **Complete Source Repositories**: If the full source code is already present in the workspace, use standard file search and reading tools. Do not run REA providers or setup commands.
- **Standard Greenfield Coding**: Writing standard features from clear specifications where binary inspection is irrelevant.
- **Simple Public Web Scraping**: Standard web fetching without reverse-engineering client app internals or complex obfuscated protocols.

---

## 2. Core Epistemic Rule: Evidence Discipline

When reverse engineering, accuracy is paramount. Always enforce the three-tier categorization:

1. **Observed (Ground Truth)**:
   - What is directly evidenced by decompiled pseudocode, assembly instructions, strings, manifest declarations, or captured packets.
   - Always cite the exact evidence: file path, SHA-256 hash, symbol name, virtual address, or request ID.
2. **Inferred (Hypothesis)**:
   - Logical deductions made from the observed data (e.g., "The presence of HMAC-SHA256 with a 32-byte key in `auth_token_signer` indicates token tamper protection").
   - Explicitly label these as hypotheses or inferences.
3. **Unknown (Information Gaps)**:
   - What cannot be established due to stripping, obfuscation, missing runtime context, or tool limitations.
   - Never fill gaps with plausible guesses. State explicitly: *"Absence of findings is not evidence of absence."*

> Detailed instructions: See [Evidence Workflows](./references/evidence-workflows.md).

---

## 3. Investigation Workflow

```text
┌─────────────────┐     ┌───────────────────┐     ┌───────────────────┐     ┌──────────────────┐
│  Target Routing │ ──> │ Evidence Gathering│ ──> │ Synthesis & Spec  │ ──> │  Reconstruction  │
│ Format & Engine │     │ Decompile & Trace │     │ Knowns vs Inferred│     │ Clean-Room Code  │
└─────────────────┘     └───────────────────┘     └───────────────────┘     └──────────────────┘
```

### Stage 1: Target Identification & Session Initialization
1. Identify the target format and calculate its cryptographic fingerprint:
   ```bash
   shasum -a 256 <target-file>
   file <target-file>
   ```
2. Route to the appropriate tool or engine:
   - **Native Binary**: Route to Ghidra, Hopper, IDA, or Rizin via `open_binary`.
   - **Electron / JS App**: Unpack `.asar` or parse JavaScript bundle via `analyze_javascript_application`.
   - **Android Package**: Decompile Dex classes and resources via `inspect_android_package` (headless JADX).
   - **.NET Assembly**: Decompile CIL via `inspect_dotnet_assembly` (ILSpy/dnSpy).
   - **Web / Network**: Load HAR capture or launch CDP session via `inspect_web_application`.

### Stage 2: Structural & Behavioral Decomposition
- Extract symbols, exports, imports, and string tables.
- Identify entry points, IPC channels, registered routes, or intent filters.
- Trace data flow from user inputs / network payloads down to business logic and storage.

### Stage 3: Verification & Boundary Testing
- Cross-reference static findings with runtime observation if dynamic tracing is possible.
- Check edge conditions, cryptographic parameters, serialization schemas, and error states.

### Stage 4: Clean-Room Specification & Reimplementation
- Formulate a clean, modular specification document explaining the discovered logic.
- Implement equivalent, modern code matching the specification without copying proprietary code or violating licensing boundaries.

---

## 4. Target Routing Reference Guide

| Target Type | Primary Tools / Providers | Reference Guide |
| :--- | :--- | :--- |
| **Native Binaries** (`Mach-O`, `ELF`, `PE`) | Ghidra, Hopper, IDA Pro, Rizin/Radare2, `objdump` | [Native & Artifacts](./references/native-and-artifacts.md) |
| **Electron & JavaScript** | `asar`, Node AST parsers, source-map-unpack, Chrome DevTools | [JavaScript Applications](./references/javascript-applications.md) |
| **Android APKs** | JADX (headless), Apktool, `baksmali`, Android AAPT | [Android Applications](./references/android-applications.md) |
| **Runtime & Network** | Chrome DevTools Protocol (CDP), Mitmproxy, Wireshark/tshark, HAR | [Runtime Observation](./references/runtime-observation.md) |
| **Troubleshooting & MCP** | REA CLI, `rea doctor`, MCP server configuration | [Connection & Recovery](./references/connection-and-recovery.md) |

---

## 5. Tooling & Environment Management

REA operates both as an automated Model Context Protocol (MCP) server providing structured tools (`mcp__rea__*`) and as an extensible CLI toolchain.

### CLI Check & Setup
To verify local reverse-engineering tools or initialize the REA environment:
```bash
# Check available analysis engines and providers
npx -y rea-agents@latest doctor

# List detected capabilities (Ghidra, Hopper, JADX, Node, etc.)
npx -y rea-agents@latest providers --json
```

If an MCP tool session is interrupted, or an active decompiler worker disconnects, refer to [Connection & Recovery](./references/connection-and-recovery.md) to re-establish the session without repeating previously completed scans.

