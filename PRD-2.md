# VenuePilot — Existing Venue Accessibility and Viewing Review

**Version:** 2.1 · **Date:** October 25, 2026 · **Build budget:** six hours, including testing and submission.  
**Track:** More Dimensions · **Planning assumption:** at least two contributors familiar with web development and model APIs.

## 1. Product decision

VenuePilot reviews an **existing venue design** from different audience perspectives and repairs seating arrangements or small movable obstructions. It helps an organizer or designer answer: **Who cannot comfortably reach or use their place, who cannot see the presentation, and what small change helps?**

The product imports a prepared design, renders audience views, asks Gemini 4 Argon to critique them, applies a bounded revision, and renders and inspects that revision again. Independent code verifies the outcome. The imported original remains the baseline; the system generates only its proposed edits.

Building generation, structural redesign, and acoustic design are outside the product. This is a limited planning aid for modeled access, viewing, and comfort—not an accessibility certification.

## 2. MVP scope

| Required: P0 | Optional after the complete loop: P1 |
| --- | --- |
| One prepared, single-level venue and existing seating layout | Additional venues; arbitrary guest counts or editable room dimensions |
| Four configurable audience profiles; one fixed guest roster per run | Separate AI reviewer agents for the profiles |
| Seat/bay selection and profile-specific camera views | Animated attendee movement or richer avatars |
| Modeled route, clearance, legroom, and sampled visibility checks | Lighting/sunlight checks and approved furniture alternatives |
| One Argon repair proposal and final visual reinspection | Additional repair rounds; hosted Managed Agents integration |
| Before/after comparison; minimal saved JSON and media | Comprehensive export, refresh/restart recovery, polished replay |

No arbitrary CAD/BIM/PDF import, automatic room reconstruction, general pathfinding, structural edits, crowd simulation, acoustics simulation, or production accounts. Manual annotations during developer setup are acceptable and must be disclosed.

## 3. Start from an existing design

Use a developer-prepared **GLB plus a small scene manifest**. This is one curated import, not a general model-upload product.

| Source | Fit and preparation |
| --- | --- |
| [Village Hall and Community Events](https://3dassets.dev/packs/village-hall-and-community-events) — [starter GLB](https://cdn.3dassets.dev/assets/35232/v1/model.glb) | The source advertises a 2.9 MB assembled hall with stage, chairs, and event furniture, licensed CC0. Best candidate for a movable-seating demo. Simplify unrelated clutter once, before freezing the baseline. |
| [Blender Classroom by Christophe Seux](https://www.blender.org/download/demo-files/) — [ZIP download](https://download.blender.org/demo/test/classroom.zip) | Official listing: CC0, approximately 72 MB. Existing classroom scene; requires a one-time Blender cleanup/export to GLB. Use if a contributor knows Blender. |

**Research status:** Village Hall's listing and license were checked, but its CDN returned HTTP 403 in this research environment. Classroom's download returned valid partial ZIP bytes. Neither scene has been fully imported or checked for editable chair nodes. These are designed demo scenes, not surveyed building blueprints; Village Hall is explicitly AI-generated.

**Source readiness gate:** confirm access, load time, scale, usable floor area, and separable movable objects. Record the source, license, preparation edits, and frozen asset hash. Other workstreams can use the shared development fixture while this happens. Do not spend the build developing a general importer.

**Fallback:** if neither source can be prepared quickly, use Argon in a separate developer-only process to draft a small venue from an ordinary architectural brief. Export and freeze that design before VenuePilot evaluates it. The brief may specify aesthetic and acoustic intent, but no acoustic performance is claimed. Do not deliberately insert failures or tune the source design to inflate repair results. There is no building-generation control in VenuePilot.

## 4. Prepared scene and permitted edits

Prepare approximately **24 audience places**, including at least one wheelchair bay, within one flat audience area. Freeze the exact count after validating the chosen asset. Other counts are optional prepared rosters; the application never silently removes attendees.

The manifest identifies:

- Fixed shell, stage/presentation area, entrances, floor boundary, and reserved circulation regions.
- Stable seat/bay IDs, chair dimensions and seat heights, permitted movement regions, and editable object IDs.
- Finite-height obstruction geometry: pillars, partitions, signs, décor, chair backs, and simple static seated head/torso proxies.
- A predefined entrance-to-approach route for each occupied place, required turning pads, and the presentation target.

Use a small set of boxes/cylinders for trusted collision and occlusion geometry. Show the same simplified geometry in the scored inspection scene. Any imported detail that could change access or sightlines must be represented or explicitly excluded from the modeled view; a decorative mesh cannot silently contradict the score.

**Allowed patch:** translate or yaw an existing movable chair, fixed-membership chair group, or designated freestanding prop. Maximum six operations on nonoverlapping targets; 0.05 m translation increments, at most 0.60 m per horizontal axis per proposal, at most 10° yaw, and 1.50 m total displacement from baseline. Manifest bounds may be stricter. Wheelchair bays and their route templates remain fixed in P0.

The agent cannot delete audience places, move structural elements, resize objects, change target dimensions, raise eye heights, or change scoring rules. Chair-height differences are measured from the design; arbitrary chair lifting is not an allowed repair. Approved alternative chair models are P1.

## 5. Audience profiles and state

Profiles describe **explicit needs**, not assumptions about everyone with a demographic or disability label. All values are visible, editable before a run, and frozen during comparison.

| Demo profile | Example state and test |
| --- | --- |
| Reference seated adult | Eye offset above the chair seat; ordinary seat and route requirements. |
| Child / shorter seated viewer | Lower eye offset; test views past chair backs, people, and low partitions. |
| Wheelchair user | Independent seated eye height, wheelchair footprint, bay dimensions, step-free route width, and turning-space requirement. A bay contains no ordinary chair. |
| Extra-legroom attendee, optionally labeled pregnant | User-selected front clearance and aisle preference. Pregnancy alone does not imply a mobility restriction or a universal clearance requirement. |

Use simple demonstration values in one versioned configuration file, not demographic averages or legal thresholds. For chair users, derive eye position from **actual chair-seat height plus the profile's eye offset**. Wheelchair eye height is independently specified. Recompute body proxies and cameras from the same state.

Each attendee has one stable ID and one assigned compatible place; no two attendees occupy the same place. Freeze the roster, assignments, and chair/bay types for the run. **Capacity counts audience places, not chairs.** Profile previews may inspect other compatible places, but headline results use the actual frozen assignments, never overlapping hypothetical allocations.

State returned for each attendee: sampled visibility, modeled route status, fit/legroom checks, failed requirements, and optional preference findings. Static profiles are virtual attendees; they are not separate AI agents unless independent model executions actually review them.

## 6. Measurements and acceptance

### Visibility

Render a visible presentation panel matching the scored region. Cast rays from each attendee's eye to a fixed **15 × 9 grid** across that panel. A sample succeeds only when inside the camera's viewing field and unblocked before the target. Exclude the viewer's own body/chair and the target surface; other occupied places remain occluders.

Use a square perspective inspection view with 90° horizontal and vertical fields of view. Camera projection, blocker geometry, and saved transforms must match the evaluator. Finite-height blockers make differences in eye height meaningful.

Report **sampled visibility = visible samples / 135**. “Clear” means at least 90%, or **122/135** samples. This estimates sampled target coverage, not visual acuity or exact visible area. Freeze the grid, threshold, and numerical tolerances before comparing layouts.

### Access and comfort

Check the attendee's place type, required footprint, specified legroom region, and predefined route clearance. Keep the entrance/aisle route corridors fixed; derive and validate the final approach segment from that corridor to each chair's current transform after every edit. End at an approach point outside the destination footprint; exempt only that destination's own footprint during its final entry maneuver. Check turning pads against modeled obstacles and other occupied footprints. Routes serving other places must not pass through occupied bays. No navigation mesh is needed.

**Usable** means all required access, fit, and comfort checks pass; **clear-and-usable** also requires a clear view.

Report **modeled route clear/blocked**, not “universally accessible.” Required comfort checks affect acceptance; optional preferences are shown separately. An unmodeled or unknown condition is not a pass. Broader accessibility includes requirements beyond these checks; see the [Access Board route guide](https://www.access-board.gov/ada/guides/chapter-4-accessible-routes/) and [assembly seating requirements](https://www.access-board.gov/ada/chapter/ch08/).

### Candidate decision

Separate **invalid scene data** from **problems being audited**. Reject malformed geometry, chairs/props outside their allowed floor regions or intersecting walls, fixed obstacles, or other furniture, incompatible or duplicated assignments, unauthorized edits, and changes to fixed data. An existing blocked route, poor view, or insufficient legroom remains an auditable failure; it must not prevent examining the baseline.

Accept a candidate only when structural checks pass, no previously passing attendee access/comfort requirement becomes a failure, and no represented profile loses clear-and-usable places or mean visibility. Then compare, in order:

1. Fewer attendees with any unmet required condition, including a non-clear view.
2. Fewer failed requirement checks, allowing partial repairs to count.
3. Higher mean visibility for the worst-performing represented profile.
4. Higher total visible-sample count.

Keep the current best on a tie. Show the components per profile; do not combine them into an invented “accessibility score.” A partial improvement may be retained with remaining failures listed. Only zero remaining failures supports **All modeled attendee requirements met**.

## 7. Argon and the visual repair loop

**P0:** one real Argon reviewer/writer evaluates all audience profiles in a structured response. **P1:** three independent reviewers cover shorter-viewer, wheelchair, and extra-legroom needs in parallel, with the reference profile as a shared comparison; one repair writer reconciles their findings. Reviewers never independently apply competing edits. Hosted Managed Agents is an additional integration/prize target, not a dependency of the core track unless organizers explicitly require it.

1. Freeze the imported scene, roster, requirements, and allowed edits; independently evaluate the baseline.
2. Record a short overview plus representative profile views, including a low-view seat and a route/clearance concern when present. Save view IDs, attendee IDs, timestamps, and the scene hash.
3. Supply the actual clip, profile requirements, roster, layout, goal, and edit contract to Argon. **Exclude evaluator pass/fail findings and obstruction labels until its first visual critique.** The clip contains no answer-revealing heatmap.
4. Receive brief findings tied to the evidence and one bounded JSON patch. Validate and score a copy of the scene in trusted code.
5. Retain the better verified layout; record rejected proposals and their reasons.
6. Render a valid revision using matching attendee views. **Send the revised media back to Argon and obtain a final evidence-linked assessment.** Saving an after-video alone does not complete the loop.

Default: one proposal, a 10–15 second inspection clip, and a **110-second total live deadline** including final inspection. If no valid revision is produced, report that outcome. If time expires after numerical improvement but before visual reinspection, preserve the result and label the visual loop incomplete.

## 8. Lighting and sunlight extension

Keep one fixed lighting condition in P0. Argon may flag apparent glare or darkness as **unmeasured visual observations**; these do not alter the verified score.

P1 adds one window, two named fixed sun directions, and one adjustable blind or luminaire. Test identical lighting scenarios before and after. A ray toward a light/sun source and a fixed viewing-angle rule may flag possible direct exposure; report it separately from visibility. Do not claim measured glare severity, lux, heat, or acoustic performance. Real date/location solar modeling is later work.

## 9. Interface, implementation, and records

The screen opens on the existing room. The organizer reviews the roster, selects an attendee/seat, sees their view and failed checks, and selects **Review and improve**. Results show the same attendee before/after, capacity, per-profile metrics, accepted changes, and remaining problems.

Use React/Three.js, a small Node backend, strict JSON patches, and one shared scene/configuration schema. Keep credentials and authoritative validation outside model-writable storage. A deterministic evaluator controls acceptance; model judgments remain explanatory. Support one active run and keep the last verified layout visible.

States: `preparing → capturing_baseline → inspecting_baseline → proposing → verifying → rendering_revision → inspecting_revision → finished`. Distinguish improved, no improvement, partial/incomplete, timeout, and failure. Preserve verified work when a call fails; never display a replay as live execution.

Save the source/scene hash, normalized baseline, roster, profile settings, proposed patches, evaluations, best layout, evidence manifests, real provider IDs, and elapsed time. Use local file writes; elaborate exports and restart recovery are optional.

## 10. Team execution steps

These are dependency gates, not an hourly schedule. Assign one owner per workstream; teammates can each use a coding agent. One person may own multiple streams. **Coding agents building the application are separate from optional audience-review agents running inside it.**

### Step 1 — Establish one shared foundation

The integration owner creates the scaffold, a tiny development fixture, and `src/shared/` before parallel implementation. Agree on metres, Y-up, persisted degrees, right-handed yaw about +Y, and zero yaw facing −Z. Freeze these contracts:

| Contract | Required shared meaning |
| --- | --- |
| `SceneSnapshot` | Version/hash, asset references, fixed/editable objects, proxy geometry, places, routes, target, profile requirements, and attendee assignments. |
| `LayoutPatch` | Run ID, parent-scene hash, evidence references, diagnosis, and allowed object/group operations. |
| `Evaluation` | Scene hash, structural errors, attendee checks, per-profile metrics, and comparison components from §6. |
| `EvidenceManifest` | Capture ID, scene hash, actual media reference, camera settings, attendee/view IDs, and timestamps. |
| `RunRecord` | Status, baseline, best layout, attempts, evaluations, capture requests, evidence, provider IDs, deadline, and terminal reason. |

Keep numerical constants in one versioned module. Contract examples may use development data; they must not masquerade as a real agent run. Changes to shared contracts or dependencies go through the integration owner.

### Step 2 — Build four workstreams in parallel

| Owner | Exclusive paths | Deliverables and handoff |
| --- | --- | --- |
| **A: Venue and rendering** | `public/venue/`, `scripts/prepare-venue.*`, `src/scene/`, `tests/scene/` | Prepare and annotate one source design; implement `VenueViewport` and `captureEvidence(snapshot, tourSpec)`; return a real clip and matching manifest. Freeze the prepared baseline before prompt tuning. |
| **B: Geometry and scoring** | `src/evaluation/`, `tests/evaluation/` | Export pure `evaluateScene`, `applyAndValidatePatch`, and `compareEvaluations` functions. Own sightlines, routes, fit, acceptance, and focused correctness fixtures. No model calls or UI state. |
| **C: Argon and backend** | `src/server/`, `tests/server/` | Prove real media input; implement provider adapter, run endpoints, deadline, storage, initial critique/patch, and final visual reinspection. Invoke B's functions rather than duplicating its rules. |
| **D: UI and integration** | `src/ui/`, `src/App.tsx`, `src/main.tsx`, `src/shared/`, root configuration/lockfiles, `tests/integration/`, `README.md` | Own shared contracts and dependencies; assemble roster review, selection, progress, per-profile comparison, and the evidence-upload connection; run integration gates and document startup. |

Agents edit only their assigned paths. Request changes to another owner's interface instead of rewriting it. Use separate branches/worktrees when available. Each handoff states exports, files changed, checks run, and remaining blockers. Avoid two agents concurrently editing the same entry point, schema, or lockfile.

D commits and shares the initial scaffold/contracts; every stream starts from that commit. D announces any contract revision and affected interfaces so dependent owners update before integration. Handoffs include the branch/commit to merge. D merges completed streams and runs the integration gates.

### Step 3 — Connect a real preview and media path

A first hands C a genuine recording of the shared development fixture, so the media smoke test does not wait for venue preparation. A and C then resolve source/media feasibility while B and D continue on the shared contracts. The integration owner connects the prepared room to B's real evaluation and verifies that attendee cameras match the scored geometry. Complete this before polishing the interface.

Use a dedicated browser capture canvas derived from the same snapshot. The backend requests baseline/revision captures through run status; the active demo page records and uploads each requested clip once. C transfers the bytes using the provider's supported media mechanism and waits for readiness. Do not assume the provider can read a local filename or laptop URL. A closed page must produce an incomplete/timeout state, not invented evidence.

Freeze these application endpoints; they are not provider API methods:

- `POST /api/preview`: validate setup and return a normalized snapshot plus independent evaluation, with no model call.
- `POST /api/runs`: freeze the setup and start one run; return its ID promptly.
- `GET /api/runs/:id`: return status, verified results, and any pending capture request.
- `POST /api/runs/:id/evidence`: accept the requested clip/manifest; validate capture ID and scene hash, and handle duplicate uploads without another model call.

### Step 4 — Integrate one complete repair

Connect actual capture → Argon critique/patch → B's validation/comparison → revised capture → Argon final inspection. Retain the best verified layout. A development fixture or provider stub does not satisfy this gate. If the gate fails, fix the broken boundary before adding features.

### Step 5 — Verify, freeze, and hand off

Run §11's critical checks and repeat the live workflow. Record timing, failures, and remaining limitations; meet the 110-second live target. Finish the README, source/license record, saved real run, and demo. Add P1 only after P0 passes. If behind, cut lighting, extra runtime agents, hosted orchestration, and polish while preserving the complete core loop.

## 11. Acceptance and demonstration

Before calling P0 complete, verify:

- Identical saved scenes produce identical scores; known blocked/clear rays and boundary contacts behave correctly.
- A low obstacle affects the shorter viewer differently; actual chair height changes the eye position correctly.
- A blocked bay approach or insufficient clearance is detected; one place cannot satisfy two attendees simultaneously.
- A patch cannot remove people, change their requirements, move fixed objects, or replace the best layout with a worse result.
- Initial and revised media match evaluated scene hashes and are actually supplied to Argon; final inspection returns evidence-linked findings.
- One live run completes within 110 seconds on the demo setup, and a repeat run reports all outcomes, including no improvement.

**Three-minute demo:** 0:00–0:35 show the existing design and contrasting attendee views; 0:35–2:25 run one fresh review/repair; 2:25–3:00 show the same people afterward and the independent results. If no repair is accepted, show the retained baseline and why.

Submission includes public source, setup instructions, asset provenance/license, modeled limitations, a saved real run, and an approximately one-minute video. Confirm event-specific submission rules and deadlines with the organizers. Claim the observed result, not universal accessibility or a benchmark win.
