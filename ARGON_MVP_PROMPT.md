# VenuePilot — Argon MVP Build Prompt

Attach `PRD.md` v2.1 or place it in the repository root. Use this prompt in an Argon coding environment with file and command access. For one lead agent, leave `WORKSTREAM: ALL`. For teammates running their own agents, change it to `A`, `B`, `C`, or `D`; appoint exactly one integration owner, D. Do not start multiple uncoordinated `ALL` runs against the same project.

---

**WORKSTREAM: ALL**  
**PROJECT: VenuePilot**  
**SOURCE OF TRUTH: the attached or repository-root PRD.md, version 2.1**

Build the working MVP described in the PRD. Execute the implementation, run it, and verify it. Do not stop at a plan, architecture description, static mockup, or code snippets. Make reasonable implementation choices within the PRD and report concrete blockers only after completing work that does not depend on them.

Read existing repository instructions and inspect the current code before changing it. Reuse compatible work and the established package manager. If there is no scaffold, use TypeScript, React/Vite, Three.js, and a small Node backend. Keep dependencies minimal. Follow current official provider documentation for the actual account and SDK; do not invent methods or claim untested access.

## 1. Understand the product

VenuePilot audits and repairs an existing prepared venue. It evaluates audience access, sightlines, and configured comfort needs, proposes a small seating/prop change, verifies the change independently, and visually reinspects the result.

P0 has one venue, approximately 24 audience places, four audience profiles, one runtime Argon reviewer/writer, one repair proposal, and a final real visual inspection. Parallel coding agents are encouraged; multiple runtime audience-review agents, hosted Managed Agents, lighting/sun simulation, arbitrary CAD imports, and production accounts are P1 or excluded.

The main screen must open on the existing room. The user reviews the roster, selects an attendee and their view, starts **Review and improve**, and compares the same attendee before/after with actual per-profile results and remaining failures.

## 2. Divide implementation without conflicts

When `WORKSTREAM: ALL`, act as lead integrator. Establish the shared scaffold/contracts first, then delegate A, B, and C concurrently if coding-subagent tools are available; retain D and integration yourself. Give each agent the PRD, its exclusive paths, interfaces, and completion checks. Inspect and integrate their outputs. If delegation is unavailable, implement the same modules in dependency order without claiming that agents ran.

When assigned A, B, C, or D, work only within that stream and its tests. Do not launch or duplicate another teammate's stream. Read existing shared interfaces; request necessary contract/dependency changes from D. If an interface is missing, provide a proposed contract and continue isolated work without inventing a competing shared schema. D should deliver the foundation first.

| Stream | Owned paths | Required output |
| --- | --- | --- |
| **A — Scene/evidence** | `public/venue/`, `scripts/prepare-venue.*`, `src/scene/`, `tests/scene/` | Prepared asset/manifest, `VenueViewport`, attendee cameras, and `captureEvidence(snapshot, tourSpec)` returning actual video bytes plus a manifest. |
| **B — Evaluation** | `src/evaluation/`, `tests/evaluation/` | `evaluateScene`, `applyAndValidatePatch`, `compareEvaluations`; deterministic metrics, bounded transformations, and acceptance checks. |
| **C — Controller** | `src/server/`, `tests/server/` | Preview/start/status/evidence endpoints, provider adapter, run state, media submission, bounded repair and final inspection, saved records. |
| **D — UI/integration** | `src/ui/`, `src/App.tsx`, `src/main.tsx`, `src/shared/`, root configuration and lockfiles, `tests/integration/`, `README.md` | Shared types/config, app scaffold, complete UI wiring, capture-job handling, startup scripts, integration checks, and documentation. |

Only D changes root dependencies or shared contracts during parallel work. Use separate worktrees/branches if available. Do not overwrite another agent's changes or create competing copies of scoring logic. At handoff report changed files, exported interfaces, commands/tests run, and unresolved issues.

D commits and shares the initial scaffold/contracts; all streams start from that commit. If D revises a contract, announce the new commit and affected interfaces, and have dependent streams update before integration. Include the branch/commit in each handoff. D merges completed work and runs the integration gates.

## 3. Establish the integration contract

Define strict shared schemas for `SceneSnapshot`, `LayoutPatch`, `Evaluation`, `EvidenceManifest`, and `RunRecord` as specified in PRD §10. Use stable IDs and deterministic scene hashes. Persist metres, Y-up, degrees, right-handed yaw about +Y, and zero yaw facing −Z. Put constants and transform conventions in one versioned module.

The normalized snapshot must include fixed/editable objects and bounds, finite-height proxies, places and chair heights, profiles and frozen attendee assignments, route anchors/corridors, the visible presentation target, and source metadata. Evidence identifies its capture request, scene hash, attendee/views, timestamps, and projection. A patch identifies its run and parent hash. Do not accept a stale patch or attach media from another scene.

Create one tiny shared development fixture so B/C/D can build while A prepares the venue. A's first handoff is a genuine recording of that fixture, allowing C to prove media input immediately. Fixture/stub data is for development and tests; the completed live path must use a real prepared scene, real recordings, and real provider responses.

Implement these application endpoints:

- `POST /api/preview` → normalized snapshot and independent evaluation, no paid model call.
- `POST /api/runs` → run ID promptly; freeze the setup and allow one active run.
- `GET /api/runs/:id` → status, last verified result, and any pending capture request.
- `POST /api/runs/:id/evidence` → multipart video plus manifest; verify capture ID/hash and make repeated delivery idempotent.

Document request/response examples in the README. Let the frontend poll status; a token stream or message broker is unnecessary.

## 4. Prepare the existing venue

Use the PRD's existing-model candidates and acknowledge their documented download/import uncertainty. Check access, scale, editability, and rendering promptly. Annotate one flat audience area, seat/bay IDs, movable items, fixed structure, routes, target, and collision/occlusion proxies. Save source/license information and preparation edits.

If those sources cannot be prepared with available tools, generate a compact source fixture in a separate developer-only preparation script/process, export it, and load the saved fixture normally. Clearly record this fallback. Never add building generation to the product flow, deliberately plant failures, or reshape the baseline after seeing optimization results.

Freeze the prepared baseline and evaluator settings before tuning the repair prompt. Use the same simplified blocking geometry in scored views and evaluation. Keep imported decorative details from contradicting the modeled result.

## 5. Implement the actual audience checks

Represent the reference adult, shorter viewer/child, wheelchair user, and extra-legroom profile using explicit editable requirements. The extra-legroom preset may be labeled pregnant; do not infer medical restrictions from that label. Freeze requirements and assignments during the run.

For chair users, derive eye height from the actual seat height plus the profile offset. Wheelchair eye height is independent. Each person has one compatible place; each occupied place has one person. A wheelchair bay contributes capacity without containing a chair. Use the frozen actual roster for headline scores.

Implement PRD §6 exactly:

- Visible target, 15 × 9 samples, matching square 90° cameras, and clear threshold 122/135. Include finite-height blockers, chair backs, and simple other-attendee proxies; exclude the viewer's own proxy and chair.
- Route/turning-space, fit, and required-legroom checks. Keep main corridors fixed and recompute each moved chair's final approach. Apply the destination-footprint exemption only during its final entry maneuver. Do not add general pathfinding.
- Separate structural invalidity from an existing access/comfort/view problem that the tool should audit.
- Enforce the PRD's per-person/per-profile non-regression gates before its ordered comparison. Preserve the best result on rejection or ties. Show separate metrics and remaining failures, not a synthetic universal-accessibility score.

The patch allowlist is translation/yaw of existing movable chairs, fixed-member groups, or designated props. Enforce six operations, 0.05 m translation steps, at most 0.60 m per horizontal axis per proposal, 10° yaw, 1.50 m displacement from baseline, and stricter manifest bounds. Prevent overlapping operations on a chair and its group from bypassing limits. Fixed structures, bays, capacity, assignments, dimensions, target, profiles, and scoring rules are immutable.

## 6. Build a real media loop

Use the foreground demo browser for P0 evidence capture. A dedicated capture canvas renders the exact frozen snapshot and camera schedule while the main viewport remains usable. Record a short real video using a browser-supported encoding that the configured provider actually accepts. Prove that path with a tiny clip before implementing a polished tour. Avoid adding headless WebGL or transcoding infrastructure unless needed by an observed blocker.

The backend publishes a capture request containing its unique ID, scene hash/snapshot, tour specification, and deadline. The frontend records and uploads it once. The backend submits the bytes through a supported provider upload/inline-media mechanism and waits until processing completes. A local filename, localhost URL, or text description is not video input.

For the first model call, provide the actual baseline video, manifest, profile requirements, roster, scene, goal, and edit contract. Withhold evaluator pass/fail findings and obstruction labels; do not burn answer-revealing heatmaps into the clip. Require concise evidence-linked findings and a schema-valid patch. Keep response length modest.

Trusted code evaluates the proposal on a copy and makes the acceptance decision. If valid, request a matching revised recording and make a second real model call that inspects that video with the measured results. Require evidence-linked final findings. A saved after-video alone is insufficient. Keep rejected candidates labeled and the best accepted scene visible.

Enforce the 110-second total live deadline, including captures and final inspection. If the model fails, the page closes, or the deadline expires, retain verified work and report the correct incomplete/failure state. If no valid patch or improvement is found, report that honestly. Do not substitute fabricated scores or a saved replay for a live run.

Use server-side credentials from an environment variable and provide `.env.example` without a key. If credentials, model access, or media support are missing, finish runnable local functionality and meaningful tests, then identify the exact blocked live step. Do not claim a completed live MVP or silently substitute a different model.

## 7. Integrate and verify

Work through these gates instead of an hourly schedule:

1. Shared contracts/scaffold exist; A can prepare a source; C can submit a real clip. B/D work against the shared fixture in parallel.
2. The prepared scene renders, attendee selection changes the camera correctly, and B evaluates that same snapshot.
3. One complete real critique → patch → independent verification → revised recording → final inspection works through the app.
4. The PRD's geometry, assignment, fairness, media/hash, failure, and deadline checks pass. Run the real flow again and record all outcomes.
5. Build/typecheck succeed, the browser workflow works, startup is reproducible, and the README documents source provenance, requirements, limitations, and actual measured timing.

Use focused tests with understandable expected results, including a short viewer behind a low blocker, a blocked bay approach, duplicate assignment, forbidden/stale patch, per-profile regression, mismatched media, and an interrupted run. Do not merely test that the implementation repeats its own answer. Take and inspect a browser screenshot when the environment supports it; exercise the controls rather than judging only compilation.

Keep P1 out until the entire P0 path passes. Do not publish or deploy externally as part of this prompt.

## 8. Finish with a concrete handoff

For `ALL`/D, leave a working repository with setup/run instructions, environment-variable names, meaningful tests, the prepared source/manifest and license notes, and a real sanitized run record when available. Finish with what works, exact commands used to verify it, actual live duration/outcome, and any remaining blocker. State clearly if live integration remains unverified.

For A/B/C, finish your assigned module and tests, then hand off its interfaces and integration requirements. Never report the entire MVP complete based solely on one module. Continue implementation now; do not return only this plan.
