# VenuePilot — Prepared Venue Asset & Provenance Record

## 1. Source Readiness Gate & Fallback Decision (PRD v2.1 §3)

| Candidate Source | License | Readiness Check Outcome |
| --- | --- | --- |
| Village Hall and Community Events (`https://cdn.3dassets.dev/assets/35232/v1/model.glb`) | CC0-1.0 | CDN returned HTTP 403 Forbidden during automated preparation check (as documented in PRD §3). |
| Blender Classroom (`https://download.blender.org/demo/test/classroom.zip`) | CC0-1.0 | ~72 MB raw `.blend` archive requiring interactive Blender desktop export; excluded to keep repository lightweight and reproducible. |
| **Prepared Community Lecture Hall (`prepared-venue.glb` + `scene-manifest.json`)** | **CC0-1.0** | **Selected per PRD §3 Fallback Protocol.** Deterministic glTF 2.0 binary asset and annotated 24-place manifest generated via `npm run prepare:venue`. |

## 2. Frozen Asset & Baseline Identifiers

- **Scene ID:** `prepared_community_hall_24_v1`
- **Deterministic Scene Hash:** `vp_ff15d29aa1200205`
- **GLB Asset Path:** `/venue/prepared-venue.glb` (`7080` bytes)
- **GLB Asset Hash:** `vp_d8a8f02bff7e5310`
- **Total Audience Places:** `24` (`22` movable chairs across `4` groups + `2` fixed wheelchair bays)
- **Frozen Roster:** `24` attendees across `4` profiles (`reference_adult`, `shorter_seated`, `wheelchair_user`, `extra_legroom`)

## 3. Modeled Geometry & Baseline Audit Scenario

1. **Shorter Seated Viewer Sightline (`att_shorter_01` at `place_chair_r1_c3`):**
   - Movable welcome sign (`obj_prop_welcome_sign`) at `[0.0, 0.0, -2.55]` (width `0.48m`, height `1.16m`) blocks the central/lower presentation target samples for the shorter viewer (`eyeY = 0.97m`).
   - Shifting `obj_prop_welcome_sign` by `[-0.55, 0, 0]` places it in the inter-column gap at `X = -0.55m` without obstructing any viewer.
2. **Extra-Legroom Front Clearance (`att_extra_legroom_01` & `att_extra_legroom_02` in Row 1 East):**
   - Movable stage-front literature table (`obj_prop_catering_table`, height `0.44m`, `blocksVisibility: false`) at `Z = -2.35m` leaves `0.40m` front legroom (below the required `0.55m`).
   - Shifting `obj_prop_catering_table` toward the stage by `[0, 0, -0.35]` increases Row 1 East front legroom to `0.75m` with zero impact on rear rows.
3. **Wheelchair Bay Turning Pad & Approach (`att_wheelchair_01` at `place_bay_wc_01`):**
   - Movable AV equipment cart (`obj_prop_av_cart`) at `[-3.10, 0.0, 3.65]` intrudes into West Wheelchair Bay W1 turning pad (`1.55m` diameter centered at `[-3.10, 3.90]`).
   - Shifting `obj_prop_av_cart` by `[0.60, 0, 0.50]` clears the turning pad and approach corridor completely.
