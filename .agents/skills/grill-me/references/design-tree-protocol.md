# Design Tree Protocol & Interrogation Techniques

This guide details the mechanics of constructing and traversing design trees during an interactive grilling session.

---

## 1. Graph Structure of a Design Tree

A design tree is a directed acyclic dependency graph of architectural decisions:

```text
               [Root: Storage Engine]
                    /          \
            (PostgreSQL)     (SQLite)
               /     \            \
    [ORM: Prisma]  [Drizzle]   [Litestream Replication?]
         /             \           /       \
   (Migrations)   (Relations)   (Yes)      (No)
```

- **Root Nodes**: High-level structural choices (e.g., synchronous vs asynchronous, client vs server rendered, relational vs document storage).
- **Branch Nodes**: Implementation techniques that are meaningless until the root node is decided.
- **Leaf Nodes**: Concrete edge cases, boundary conditions, performance thresholds, and error handling policies.

---

## 2. Calculating the Frontier

In any given turn:
1. Examine all unvisited nodes in the design tree.
2. Filter for nodes whose parent dependencies have all been explicitly resolved by the user's past answers.
3. This set of unblocked nodes forms the **Frontier**.
4. Present the entire frontier as a single round.

### Anti-Patterns to Avoid:
- ❌ **Premature Branching**: Asking *"What replication strategy will you use in PostgreSQL?"* in Round 1 before the user has decided whether they want SQLite, PostgreSQL, or DynamoDB.
- ❌ **One-by-One Interrogation**: Asking a single question, waiting for reply, asking one more, leading to dozens of tedious round trips. Batch the active frontier into clean rounds.
- ❌ **Asking for Discoverable Facts**: Asking *"What version of Node are you using?"* when `package.json` or `.nvmrc` is right in the repository. Inspect it yourself first.

---

## 3. Designing High-Impact Questions

A great grilling question exposes hidden tradeoffs. Compare:

- **Weak Question**: *"Do you want authentication?"*
  - Problem: Trivial yes/no question that doesn't advance design.
- **Strong Grilling Question**:
  - *"For user authentication, what identity model fits your roadmap?"*
  - **Option A**: Session-based cookie auth with Redis store (simple, secure, server-rendered friendly).
  - **Option B**: JWT bearer tokens with refresh token rotation in database (stateless API, mobile-client friendly).
  - **Option C**: Third-party OAuth only (Auth0/Clerk/Supabase) to offload credential storage completely.
  - **Recommended**: **Option A**, because your existing app is a monolithic Express/Fastify server with low distributed scaling requirements.

---

## 4. Grilling Categories Checklist

When formulating the design tree, test these dimensions:
1. **Scope & Non-Goals**: What is explicitly *out* of scope for this version?
2. **Data & State Lifecycle**: Where does ground truth live? Who owns mutations? How is cache invalidated?
3. **Failure Modes & Degradation**: What happens when an external dependency or network call fails? Is there a fallback or circuit breaker?
4. **Security & Permissions**: Who is authorized to trigger this action? How are inputs sanitized?
5. **Observability & Debuggability**: How will failures be diagnosed in production? What structured telemetry is needed?

---

## 5. Completing the Session

When the frontier is empty:
1. Announce that all branches of the design tree have been explored.
2. Present a concise **Design Synthesis** summarizing:
   - Settled architectural decisions.
   - Identified non-goals.
   - Core contracts and data models.
   - Next execution steps.
3. Wait for the user's sign-off before proceeding to code generation or task execution.

