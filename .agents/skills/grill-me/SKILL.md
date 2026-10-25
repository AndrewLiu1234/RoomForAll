---
name: grill-me
description: >-
  Relentlessly interview the user about a plan, architectural decision, or idea until every branch of the design tree is resolved. Use when the user invokes /grill-me, asks to be grilled, or wants to stress-test their thinking before implementation.
---

# Grill Me (The Socratic Design-Tree Interview)

Interview the user relentlessly until reaching a shared, unambiguous understanding. Rather than passively accepting vague requirements or making unverified assumptions, stress-test ideas by mapping them into a **design tree** and resolving every branch in structured **rounds**.

---

## 1. Core Operating Principles

### A. The Design Tree & The Frontier
- **Design Tree**: Every architectural choice branches into sub-decisions that depend on it (e.g., choosing WebSockets vs. HTTP long-polling unlocks different security, state, and scaling questions).
- **The Frontier**: The set of decisions whose prerequisites are already settled—meaning the questions you can ask *now* without guessing at answers you haven't received yet.
- **Strict Dependency Order**: Never ask a question that depends on an unresolved answer. Downstream questions belong to *later* rounds.

### B. Finding Facts vs. Asking Decisions
- **Finding facts is the agent's job**: Never ask the user anything you can discover yourself. Before asking about existing dependencies, configurations, database schemas, or project layouts, inspect the codebase and files directly.
- **Decisions belong to the user**: Strategy, trade-offs, business logic, UX preferences, and architectural boundaries must be explicitly put to the user.

### C. Always Provide Recommended Answers
Never leave the user facing a blank question. For every question on the frontier:
- Outline clear options or trade-offs.
- Provide a concrete, justified recommendation so the user can simply respond with quick agreement (e.g., *"1 yes, 2 opt B"*) or adjust as desired.

---

## 2. Round Formatting

Ask the entire frontier in one structured round.

### Text Format:
```markdown
### 🎯 Grilling Round <N>

❓ **Q1** - **<Question Title>**: <Context and clear description of the dilemma or choice>
- **A)** <Option 1>
- **B)** <Option 2>
- **C)** <Option 3>
➡️ **Recommended**: **A)** <Brief explanation why this fits the project context best>

---

❓ **Q2** - **<Question Title>**: <Context and explanation>
- **A)** <Option 1>
- **B)** <Option 2>
➡️ **Recommended**: **B)** <Brief explanation>
```

*(When multiple-choice questions are suitable, you may also invoke the `ask_question` tool to provide interactive UI selection buttons alongside the round.)*

---

## 3. The Execution Loop

```text
┌─────────────────────────┐
│ 1. Survey Environment   │ Lookup facts in codebase first; do not ask user.
└────────────┬────────────┘
             ▼
┌─────────────────────────┐
│ 2. Compute Frontier     │ Identify all decisions whose prerequisites are settled.
└────────────┬────────────┘
             ▼
┌─────────────────────────┐
│ 3. Present Round        │ Ask questions numbered with recommended answers.
└────────────┬────────────┘
             ▼
┌─────────────────────────┐
│ 4. Ingest Answers       │ Settled answers push the frontier outward to child nodes.
└────────────┬────────────┘
             ▼
┌─────────────────────────┐
│ 5. Frontier Empty?      │ 
└────────────┬────────────┘
      No     │     Yes
      └──────┘      ▼
             ┌─────────────────────────┐
             │ 6. Synthesize & Align   │ Produce final specification or plan.
             └─────────────────────────┘
```

1. **Round 1 (Root Decisions)**: Fundamental architecture, primary interfaces, high-level scope, and constraints.
2. **Intermediate Rounds (Branches)**: Storage schemas, protocol nuances, error handling, performance tolerances, edge cases.
3. **Leaf Rounds (Edge Cases & Failure Modes)**: Fallback mechanisms, logging, migration strategy, backwards compatibility.
4. **Termination**: When no open questions remain on the frontier, summarize the agreed-upon design into a structured plan or specification. Do not begin coding until the user reviews and confirms alignment.

---

## 4. When to Use

- **Invoke when**:
  - The user types `/grill-me`, `/grilling`, or asks "grill me on this".
  - The user presents a complex, underspecified feature or architectural proposal.
  - Designing critical systems where unexamined assumptions lead to costly rework.
- **Do not invoke when**:
  - The task is a small bug fix or well-defined single-line change.
  - The user has already provided an exact, unambiguous specification and asked for immediate execution.

For detailed guidelines on tree traversal and handling edge cases, refer to [Design Tree Protocol](./references/design-tree-protocol.md).

