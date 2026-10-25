---
name: grilling
description: >-
  Grill the user relentlessly about a plan, architectural decision, or idea until every branch of the design tree is resolved. Use when the user wants to stress-test their thinking or uses any 'grill' trigger phrases.
---

# Grilling (The Design Tree Interview Engine)

This skill executes the core design-tree interview engine. For the full protocol, execution loop, and reference documentation, refer to [grill-me](../grill-me/SKILL.md).

---

## Directives

1. **Map the Design Tree**: Every decision branches into sub-decisions that depend on it.
2. **Work in Rounds via the Frontier**: The frontier is the set of all decisions whose prerequisites are already settled. Ask the entire frontier in one round.
3. **Always Include Recommendations**: For every question, provide clear multiple-choice options and a concrete recommended default (`➡️ Recommended: ...`).
4. **Inspect Facts Independently**: Do not ask the user for information present in the codebase or environment—inspect files and configuration directly.
5. **Progressive Traversal**: Each user answer reshapes the tree and unblocks child questions. Continue until the frontier is empty.
6. **Synthesize Before Building**: Provide a structured summary of the resolved design and wait for user confirmation before executing any code.

