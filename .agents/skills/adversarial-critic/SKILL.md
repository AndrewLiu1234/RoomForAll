---
name: adversarial-critic
description: >-
  Mandatory protocol to invoke an Adversarial Critic subagent whenever planning, scaffolding, creating, or implementing a new project or major subsystem. Use whenever creating a new project, scaffolding codebases, introducing architectures, or finalizing milestones to red-team assumptions, uncover blind spots, and eliminate failure modes before shipping.
---

# Adversarial Critic Protocol

AI coding assistants are prone to confirmation bias, self-favoring evaluations, and "confident wrongness." When a single agent designs, writes, and reviews its own work, critical edge cases, demo landmines, and security vulnerabilities easily slip through unnoticed.

The **Adversarial Critic** pattern enforces a strict **Maker-Checker (Proponent-Critic)** architecture:
1. **The Primary Agent (Maker)** proposes the project design, architecture, or codebase scaffold.
2. A separate **Adversarial Critic subagent** is spawned in an isolated context window with explicit adversarial instructions to disprove assumptions, attack single points of failure, and hunt for flaws.
3. The Primary Agent reviews the critique, remediates verified issues, and documents the resolution before presenting the finished work to the user.

---

## 1. When to Invoke the Adversarial Critic

You **MUST** invoke the Adversarial Critic whenever:
- **Creating a New Project**: Scaffolding a repository, selecting tech stacks, or designing project structure.
- **Architectural Milestone**: Introducing a new database schema, authentication flow, communication protocol, or background worker system.
- **Hackathon Builds**: Before finalizing a hackathon prototype, to ensure the live demo won't crash on edge cases or latency spikes.
- **Major Refactors / Feature Additions**: High-blast-radius changes to core logic.

---

## 2. The 5-Step Execution Workflow

```text
┌─────────────────────────┐
│ 1. Maker Stage          │ Primary agent crafts project plan, architecture, or code.
└────────────┬────────────┘
             ▼
┌─────────────────────────┐
│ 2. Define Subagent      │ Call define_subagent with the Adversarial Critic persona.
└────────────┬────────────┘
             ▼
┌─────────────────────────┐
│ 3. Invoke Subagent      │ Call invoke_subagent with the project brief & artifacts.
└────────────┬────────────┘
             ▼
┌─────────────────────────┐
│ 4. Critic Attacks       │ Subagent stress-tests across 5 adversarial dimensions.
└────────────┬────────────┘
             ▼
┌─────────────────────────┐
│ 5. Adjudicate & Fix     │ Remediate valid criticisms before shipping to user.
└─────────────────────────┘
```

### Step 1: Draft the Project Proposal
The primary agent outlines the project scope, architectural diagram, chosen technologies, key files, and API contracts.

### Step 2: Ensure the Critic Subagent is Defined
Use the `define_subagent` tool to register the critic if it hasn't been defined in the current conversation:
```json
{
  "Name": "adversarial-critic",
  "Description": "Hyper-critical, uncompromising red-team subagent that ruthlessly analyzes project designs, code scaffolds, and architectures to find failure modes, security vulnerabilities, edge cases, and demo risks.",
  "SystemPrompt": "<System prompt from references/critic-system-prompt.md>",
  "EnableWriteTools": false,
  "EnableSubagentTools": false,
  "EnableMCPTools": false
}
```
*(The critic runs in a read-only context to inspect files and code without mutating project state.)*

### Step 3: Invoke the Critic Subagent
Invoke the subagent with the `invoke_subagent` tool:
```json
{
  "TypeName": "adversarial-critic",
  "Role": "Adversarial Architecture Critic",
  "Prompt": "Perform a rigorous adversarial audit of the following project design and codebase.\n\nProject Context:\n<Insert project architecture, core files, and goals>\n\nFocus areas: 1) Demo & Failure Modes, 2) Scalability & Race Conditions, 3) Security & Credential Hygiene, 4) Over-engineering vs YAGNI, 5) Hackathon Winning Potential.",
  "Model": "inherit"
}
```

### Step 4: The Critic's Attack Dimensions
The subagent interrogates the project using the [Red-Team Checklist](./references/red-team-checklist.md):
1. **Live Demo Traps**: What happens on cold starts? What happens when a 3rd party API times out or rate limits? Is there a working fallback?
2. **YAGNI & Over-Engineering**: Are there 4 unnecessary layers of abstraction, microservices, or custom protocols when a simple library or script suffices?
3. **Security & Boundary Attacks**: Injection vectors, missing auth barriers, exposed environment secrets, CORS misconfigurations.
4. **Data Integrity & Concurrency**: Race conditions, unhandled async rejection, schema mismatch, state desynchronization.
5. **The Value & Winning Edge**: Does this genuinely solve the problem? Will judges or users immediately understand the "magic" in the first 30 seconds?

### Step 5: Adjudication and Remediation
When the critic subagent returns its critique:
1. **Never ignore valid critiques**: Categorize each finding:
   - 🔴 **Critical (Must Fix)**: Live crashes, security holes, broken core logic. *Fix immediately in code.*
   - 🟡 **Warning (Mitigate / Document)**: Edge cases, potential rate limits. *Add guards, fallbacks, or timeouts.*
   - 🟢 **Accepted Risk / Non-Goal**: Deliberate tradeoffs for MVP scope. *Explain why it is accepted for now.*
2. Present the user with a concise **Adversarial Audit Summary** showing what the critic attacked and how the project was hardened as a result.

---

## 3. Companion References

- [`references/critic-system-prompt.md`](./references/critic-system-prompt.md): The full, battle-tested system prompt for the Adversarial Critic subagent.
- [`references/red-team-checklist.md`](./references/red-team-checklist.md): Comprehensive 20-point vulnerability and stress-test rubric.

