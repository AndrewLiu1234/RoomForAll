# Project & Engineering Rules

## 1. Mandatory Adversarial Critic Invocation
Whenever starting, planning, scaffolding, or implementing any new project, subsystem, or hackathon build in this workspace:
- The agent **MUST** activate the `adversarial-critic` skill.
- Before finalizing the project architecture, tech stack, or implementation, the agent **MUST** invoke an **Adversarial Critic** subagent (`invoke_subagent` with the `adversarial-critic` role) to stress-test the proposal.
- The agent must review the Critic's findings, remediate all critical flaws, and present the user with an Adversarial Audit summary showing what was challenged and how the project was hardened.

## 2. Design & Polish Standards
- When building animations, follow the `animate` skill (Emil Kowalski standards).
- When styling UI components, follow the `better-ui` skill (Jakub Krehel polish principles).
- When resolving user requirements or ambiguous architectures, use the `grill-me` skill to interview across design tree frontiers.

