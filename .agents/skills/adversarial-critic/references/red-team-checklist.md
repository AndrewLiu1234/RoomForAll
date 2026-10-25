# Adversarial Red-Team Checklist

Use this 20-point rubric to stress-test project proposals, system architectures, and implementations.

---

## 1. Demo & Presentation Resilience
- [ ] **Cold Start Latency**: Does the project take more than 3 seconds to boot or show the initial interactive surface?
- [ ] **Offline / Degraded Fallbacks**: If external APIs (OpenAI, Anthropic, Gemini, external DBs) return 500, 429, or hang, does the app show an explicit mock/fallback or crash with an empty white screen?
- [ ] **Mock Data Seed**: Is there reliable seed data, or does the demo depend on live third-party accounts or fragile network access?
- [ ] **Deterministic Paths**: Can the core "wow moment" be reproduced reliably 10 times in a row without state corruption?

---

## 2. Architecture & Complexity Control
- [ ] **YAGNI (You Aren't Gonna Need It)**: Are there abstraction layers (factories, custom middleware, unnecessary microservices) with only a single implementation?
- [ ] **Dependency Count**: Are there bloated external packages installed for trivial tasks (e.g. installing `moment` for a simple date format)?
- [ ] **State Duplication**: Is state stored in multiple places (e.g. React local state + URL params + local storage) risking desynchronization?
- [ ] **Single Point of Failure (SPOF)**: What single component crashing brings down the entire system?

---

## 3. Security & Trust Boundaries
- [ ] **Client-Side Secrets**: Are API keys, private tokens, or administrative secrets bundled into client-side code?
- [ ] **Input Sanitization**: Are user-provided inputs rendered directly into HTML (XSS), SQL queries, or shell commands?
- [ ] **Unauthenticated Endpoints**: Can any user invoke administrative or mutation endpoints by guessing URLs?
- [ ] **CORS & Origin Security**: Are sensitive APIs wide open to any origin (`*`) with credentials enabled?

---

## 4. Concurrency & Runtime Robustness
- [ ] **Race Conditions**: What happens if the user double-clicks a submit button or rapid-fires requests?
- [ ] **Error Boundaries**: Are async promises wrapped in `try/catch` with user-facing error indicators, or do unhandled rejections crash the process?
- [ ] **Resource Cleanup**: Are intervals, event listeners, file descriptors, and database connections properly closed/unsubscribed?
- [ ] **Pagination & Memory Spikes**: Does any endpoint or query attempt to load an unbounded array of records into memory at once?

---

## 5. Hackathon & Product Viability
- [ ] **The 30-Second Hook**: Can a stranger understand what makes this project novel, impressive, or useful within 30 seconds?
- [ ] **Clarity of Mechanism**: Is the AI doing something genuinely hard and useful, or is it a trivial wrapper around a prompt?
- [ ] **Technical Depth**: Is there real engineering (caching, indexing, custom protocols, robust pipelines) or just boilerplate?
- [ ] **Defensibility**: Could a competitor or another hackathon team replicate this in 20 minutes?

