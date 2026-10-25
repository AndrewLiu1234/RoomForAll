# Evidence Workflows & Epistemic Boundaries

In reverse engineering, inaccurate claims or hallucinated disassembly can derail entire implementations. This reference defines the protocols for collecting, recording, and citing evidence during REA investigations.

---

## 1. The Three Tiers of Knowledge

Every observation during analysis must be categorized under one of three tiers:

### Tier 1: Observed (Ground Truth)
- Direct, verifiable facts extracted from an artifact.
- **Requirements**:
  - Must include explicit coordinates: file path, SHA-256 checksum, virtual address, function symbol, string offset, or packet timestamp.
  - Must cite the engine or tool used to extract it (e.g., `Ghidra v11.1 Decompiler`, `asar v3.2.0`, `mitmproxy v10.4.2`).
- **Examples**:
  - `[Observed] String "X-Custom-Signature" found at .rodata offset 0x0041a20 in binary libcrypto_helper.dylib (SHA-256: 8f9b2a...)`
  - `[Observed] IPC channel "app:request-token" is registered in preload.js:42 via contextBridge.exposeInMainWorld`

### Tier 2: Inferred (Deductions & Hypotheses)
- Interpretations, patterns, or architectural models inferred from observed facts.
- **Requirements**:
  - Must explicitly cite the Tier 1 observations that support the deduction.
  - Must be phrased as hypotheses or logical derivations, not definitive facts.
- **Examples**:
  - `[Inferred] Based on the initialization of AES-GCM-256 with an incrementing 12-byte counter at 0x10004b20, the protocol likely prevents replay attacks.`
  - `[Inferred] The function sub_140001090 appears to be an RC4 key scheduling algorithm based on the 256-iteration permutation loop.`

### Tier 3: Unknown (Visibility Limits & Gaps)
- Information that cannot be determined with the available tools, symbols, or captures.
- **Requirements**:
  - Explicitly log unknowns rather than guessing.
  - Note the exact constraint (e.g., stripped symbols, packed section, encrypted payload, missing private key, TLS certificate pinning).
- **Golden Rule**:
  > *"Absence of findings is not evidence of absence."*
  > If a string or symbol is not found, do not assume the feature does not exist; it may be dynamically constructed, compressed, or fetched at runtime.

---

## 2. Evidence Record Schema (Evidence v2)

When producing analysis notes or synthesizing specifications, format key findings using the structured schema:

```markdown
### Finding: <Short Descriptive Title>
- **Target**: `<filename>` (SHA-256: `<hash>`)
- **Status**: [Observed | Inferred | Unknown]
- **Provider**: `<engine/tool name>`
- **Location**: `<offset / address / file:line / network ID>`
- **Details**:
  - Concise description of what was verified.
- **Confidence**: [High | Medium | Low]
- **Remaining Questions / Unknowns**:
  - What remains unverified or blocked.
```

---

## 3. Provenance & Hash Tracking

Before opening any target file:
1. Generate and record its SHA-256 hash:
   ```bash
   shasum -a 256 <target-path>
   ```
2. If modifying or unpacking the artifact into a temporary directory:
   - Keep the original target immutable.
   - Record the extracted files manifest and their corresponding hashes.
   - Never analyze modified binaries without noting the modification in the evidence log.

---

## 4. Avoiding Clean-Room Contamination

When the goal of reverse engineering is to build a replacement or compatible software module:
- Focus on documenting **specifications**, **interfaces**, **data contracts**, and **algorithms** in abstract terms.
- Avoid copying decompiled pseudocode verbatim into the new codebase.
- Write unit tests against the observed input/output contracts to prove compatibility.

