# VenuePilot — Existing Venue Accessibility and Viewing Review

VenuePilot imports a prepared single-level venue layout, evaluates audience access, sightlines, and explicit comfort requirements across four audience profiles, records real first-person and overview inspection media, asks Gemini 4 Argon to diagnose obstructions and propose a bounded JSON seating/prop patch, verifies the candidate layout deterministically, and performs a final visual reinspection.

---

## 1. Parallel Workstream Ownership (`ARGON_MVP_PROMPT.md` §2)

All four workstreams branch from this foundational commit and import shared schemas/constants exclusively from `src/shared/`. Only **Stream D** modifies root dependencies or `src/shared/`.

| Stream | Exclusive Owned Paths | Primary Deliverables | Test Command |
| --- | --- | --- | --- |
| **A — Scene & Evidence** | `public/venue/`, `scripts/prepare-venue.*`, `src/scene/`, `tests/scene/` | Prepared venue asset/manifest (~24 places), `VenueViewport`, attendee cameras, `captureEvidence(snapshot, tourSpec)` | `npm run test:A` |
| **B — Evaluation** | `src/evaluation/`, `tests/evaluation/` | `evaluateScene`, `applyAndValidatePatch`, `compareEvaluations` (15×9 visibility grid, routes, footprints, non-regression gates) | `npm run test:B` |
| **C — Controller** | `src/server/`, `tests/server/` | Express API endpoints, Gemini/Argon provider adapter, real media upload, 110s deadline, run state persistence | `npm run test:C` |
| **D — UI & Integration** | `src/shared/`, `src/ui/`, `src/App.tsx`, `src/main.tsx`, `tests/integration/`, root config, `README.md` | Shared contracts, roster/comparison UI, capture-job polling & upload loop, end-to-end integration | `npm run test:D` |

---

## 2. Frozen Coordinate & Scoring Conventions (`src/shared/constants.ts`)

- **Units:** Metres (`m`), Y-up (`+Y`), angles persisted in degrees (`°`).
- **Orientation:** Right-handed yaw about `+Y`; `0°` yaw faces `-Z` (`[0, 0, -1]`).
- **Visibility:** `15 × 9 = 135` target grid samples; clear view threshold is `>= 122 / 135` (`~90.37%`), square perspective camera (`90°` H/V FOV, `aspect = 1.0`).
- **Bounded Patch Rules:** At most `6` non-overlapping operations (`object` or `group`), `0.05 m` horizontal translation increments, `<= 0.60 m` per horizontal axis per proposal, `<= 10°` yaw change, and `<= 1.50 m` total horizontal displacement from frozen baseline.
- **Deadline:** `110,000 ms` (110 seconds) total live run budget.

---

## 3. Quick Start

```bash
npm install
cp .env.example .env
# Set GEMINI_API_KEY in .env for live Argon runs

# Terminal 1 — Start backend API server (port 3001)
npm run dev:server

# Terminal 2 — Start Vite frontend (port 5173, proxies /api -> :3001)
npm run dev:client

# Verification
npm run typecheck
npm test
```

---

## 4. Application API Endpoints & Examples (`PRD.md` §10 Step 3)

### `POST /api/preview`
Validates the current scene/profile/roster setup and returns a normalized `SceneSnapshot` with an updated deterministic `sceneHash` and independent `Evaluation` (no model call).

**Request:**
```json
{
  "profiles": {
    "extra_legroom": {
      "id": "extra_legroom",
      "label": "Extra-legroom attendee (optionally labeled pregnant)",
      "compatiblePlaceKinds": ["chair"],
      "eyeHeightMode": "seat_offset",
      "eyeOffsetAboveSeatM": 0.75,
      "requiredFootprintWidthM": 0.58,
      "requiredFootprintDepthM": 0.65,
      "requiredFrontLegroomM": 0.55,
      "requiredRouteWidthM": 0.75,
      "requiredTurningCircleDiameterM": 0,
      "prefersAisle": true,
      "torsoProxyHeightM": 0.83,
      "torsoProxyWidthM": 0.48,
      "torsoProxyDepthM": 0.34
    }
  }
}
```

**Response (`200 OK`):**
```json
{
  "snapshot": {
    "contractVersion": "2.1.0",
    "sceneId": "dev_fixture_hall_v1",
    "sceneHash": "vp_..."
  },
  "evaluation": {
    "contractVersion": "2.1.0",
    "sceneHash": "vp_...",
    "isValidStructure": true,
    "capacityCount": 4,
    "occupiedCount": 4,
    "allModeledRequirementsMet": true
  }
}
```

### `POST /api/runs`
Freezes the setup and starts one active run (`409 Conflict` if a run is already active).

**Request:**
```json
{
  "snapshot": { "...normalized SceneSnapshot..." }
}
```

**Response (`201 Created`):**
```json
{
  "runId": "run_1792950000000",
  "state": "capturing_baseline",
  "sceneHash": "vp_...",
  "deadlineIso": "2026-10-25T18:01:50.000Z",
  "pendingCapture": {
    "captureId": "cap_run_1792950000000_baseline",
    "runId": "run_1792950000000",
    "phase": "baseline",
    "sceneHash": "vp_...",
    "totalDurationSec": 3
  }
}
```

### `GET /api/runs/:id`
Polls run status, last verified evaluation/snapshot, and any pending capture request.

**Response (`200 OK`):**
```json
{
  "run": {
    "contractVersion": "2.1.0",
    "runId": "run_1792950000000",
    "state": "capturing_baseline",
    "outcome": "in_progress",
    "elapsedMs": 1420
  }
}
```

### `POST /api/runs/:id/evidence`
Multipart form upload with fields:
- `video`: recorded browser video clip (`video/webm` or `video/mp4`)
- `manifest`: JSON string matching `EvidenceManifest` (`captureId` and `sceneHash` verified; duplicate uploads are idempotent).

**Response (`200 OK`):**
```json
{
  "runId": "run_1792950000000",
  "captureId": "cap_run_1792950000000_baseline",
  "deduplicated": false,
  "state": "capturing_baseline",
  "outcome": "in_progress"
}
```
