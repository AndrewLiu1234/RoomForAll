import { describe, expect, it } from 'vitest';
import {
  CONTRACT_VERSION,
  VISIBILITY_CLEAR_MIN_SAMPLES,
  VISIBILITY_TOTAL_SAMPLES,
  createDevFixtureSnapshot,
  withUpdatedSceneHash,
  type LayoutPatch,
  type PatchOperation,
} from '../../src/shared/index.js';
import {
  applyAndValidatePatch,
  compareEvaluations,
  evaluateScene,
  simulateEvacuation,
} from '../../src/evaluation/index.js';
import {
  createPreparedVenueSnapshot,
  getVenueSurfaceElevationAt,
} from '../../src/scene/index.js';

function makePatch(
  parentSceneHash: string,
  operations: PatchOperation[],
): LayoutPatch {
  return {
    contractVersion: CONTRACT_VERSION,
    runId: 'run_test_b',
    parentSceneHash,
    diagnosis: [],
    operations,
    summary: 'Unit test patch',
  };
}

describe('Stream B — Deterministic Geometry, Scoring & Patch Validation', () => {
  describe('1. Dev Fixture Baseline & Single-Step Repair', () => {
    it('evaluates createDevFixtureSnapshot() with att_shorter_01 occluded by obj_chair_r1_c1 and all other profiles clear and usable', () => {
      const snapshot = createDevFixtureSnapshot();
      const evalResult = evaluateScene(snapshot);

      expect(evalResult.isValidStructure).toBe(true);
      expect(evalResult.structuralErrors).toEqual([]);
      expect(evalResult.sceneHash).toBe(snapshot.sceneHash);
      expect(evalResult.capacityCount).toBe(4);
      expect(evalResult.occupiedCount).toBe(4);
      expect(evalResult.allModeledRequirementsMet).toBe(false);

      const shorter = evalResult.attendees['att_shorter_01']!;
      expect(shorter.visibleSamples).toBeLessThan(VISIBILITY_CLEAR_MIN_SAMPLES);
      expect(shorter.totalSamples).toBe(VISIBILITY_TOTAL_SAMPLES);
      expect(shorter.isViewClear).toBe(false);
      expect(shorter.primaryBlockerIds).toContain('obj_chair_r1_c1');
      expect(shorter.routeStatus).toBe('clear');
      expect(shorter.footprintFitPass).toBe(true);
      expect(shorter.legroomPass).toBe(true);
      expect(shorter.turningSpacePass).toBe(true);
      expect(shorter.usable).toBe(true);
      expect(shorter.clearAndUsable).toBe(false);
      expect(shorter.failedRequirements).toContain('clear_view');

      for (const id of [
        'att_adult_01',
        'att_extra_legroom_01',
        'att_wheelchair_01',
      ]) {
        const att = evalResult.attendees[id]!;
        expect(att.routeStatus).toBe('clear');
        expect(att.footprintFitPass).toBe(true);
        expect(att.legroomPass).toBe(true);
        expect(att.turningSpacePass).toBe(true);
        expect(att.usable).toBe(true);
        expect(att.visibleSamples).toBeGreaterThanOrEqual(
          VISIBILITY_CLEAR_MIN_SAMPLES,
        );
        expect(att.isViewClear).toBe(true);
        expect(att.clearAndUsable).toBe(true);
        expect(att.failedRequirements).toEqual([]);
      }

      expect(evalResult.comparison.attendeesWithUnmetRequirements).toBe(1);
      expect(evalResult.comparison.totalFailedRequirementChecks).toBe(1);
    });

    it('repairs att_shorter_01 sightline in a single valid patch moving obj_chair_r1_c1 by [-0.55, 0, 0] and accepts via compareEvaluations', () => {
      const baselineSnapshot = createDevFixtureSnapshot();
      const baselineEval = evaluateScene(baselineSnapshot);

      const patch = makePatch(baselineSnapshot.sceneHash, [
        {
          targetType: 'object',
          targetId: 'obj_chair_r1_c1',
          deltaPositionM: [-0.55, 0, 0],
          deltaYawDeg: 0,
          reason: 'Shift Row 1 Left Chair left to clear shorter seated viewer sightline',
        },
      ]);

      const patchRes = applyAndValidatePatch(
        baselineSnapshot,
        baselineSnapshot,
        patch,
      );
      expect(patchRes.valid).toBe(true);
      expect(patchRes.errors).toEqual([]);
      expect(patchRes.snapshot).toBeDefined();

      const candidateEval = evaluateScene(patchRes.snapshot!);
      expect(candidateEval.isValidStructure).toBe(true);

      const shorterAfter = candidateEval.attendees['att_shorter_01']!;
      expect(shorterAfter.visibleSamples).toBeGreaterThanOrEqual(
        VISIBILITY_CLEAR_MIN_SAMPLES,
      );
      expect(shorterAfter.isViewClear).toBe(true);
      expect(shorterAfter.clearAndUsable).toBe(true);
      expect(shorterAfter.failedRequirements).toEqual([]);
      expect(candidateEval.allModeledRequirementsMet).toBe(true);

      const comparison = compareEvaluations(baselineEval, candidateEval);
      expect(comparison.accepted).toBe(true);
      expect(comparison.outcome).toBe('accepted');
    });
  });

  describe('2. Chair Height & Eye Position Sensitivity', () => {
    it('verifies a low blocker occludes shorter_seated while reference_adult at the same [x, z] sees over it', () => {
      const shortSnapshot = createDevFixtureSnapshot();
      const shortEval = evaluateScene(shortSnapshot);
      expect(shortEval.attendees['att_shorter_01']!.isViewClear).toBe(false);

      // Place a reference_adult at the exact same place_chair_r2_c1 ([0, 0, 0.5]) behind obj_prop_sign_01
      const adultAtSameSeatSnapshot = createDevFixtureSnapshot();
      const r2Member = adultAtSameSeatSnapshot.roster.find(
        (r) => r.attendeeId === 'att_shorter_01',
      )!;
      r2Member.profileId = 'reference_adult';
      const updatedAdultSnap = withUpdatedSceneHash(adultAtSameSeatSnapshot);
      const adultEval = evaluateScene(updatedAdultSnap);

      const viewerAtR2 = adultEval.attendees['att_shorter_01']!;
      expect(viewerAtR2.eyePositionWorld).toEqual([0, 1.23, 0.5]);
      expect(viewerAtR2.visibleSamples).toBeGreaterThanOrEqual(
        VISIBILITY_CLEAR_MIN_SAMPLES,
      );
      expect(viewerAtR2.isViewClear).toBe(true);
    });

    it('shifts chair-user eye height when place.seatHeightM increases while leaving wheelchair_user independent eye height unchanged', () => {
      const snap = createDevFixtureSnapshot();
      for (const place of snap.places) {
        if (place.id === 'place_chair_r2_c1') {
          place.seatHeightM += 0.25;
        }
      }
      const updated = withUpdatedSceneHash(snap);
      const evaluation = evaluateScene(updated);

      // Reference adult at R1-1 (seatHeightM 0.45): 0.45 + 0.78 = 1.23
      expect(
        evaluation.attendees['att_adult_01']!.eyePositionWorld[1],
      ).toBeCloseTo(1.23, 4);

      // Shorter viewer at R2-1: (0.45 + 0.25) + 0.52 = 1.22 -> now sees over Row 1!
      expect(
        evaluation.attendees['att_shorter_01']!.eyePositionWorld[1],
      ).toBeCloseTo(1.22, 4);
      expect(evaluation.attendees['att_shorter_01']!.isViewClear).toBe(true);

      // Wheelchair user: independentEyeHeightM remains 1.18 regardless of seatHeightM
      expect(
        evaluation.attendees['att_wheelchair_01']!.eyePositionWorld[1],
      ).toBeCloseTo(1.18, 4);
    });
  });

  describe('3. Route & Bay Approach Checks', () => {
    it('flags routeStatus = blocked when an object is moved into an attendee final-approach corridor', () => {
      const snap = createDevFixtureSnapshot();
      // Move obj_chair_r1_c1 into place_chair_r2_c1's final approach ([0, 1.8] -> [0, 0.825])
      const chair = snap.objects.find((o) => o.id === 'obj_chair_r1_c1')!;
      chair.transform.position = [0.0, 0.0, 1.25];
      chair.allowedBounds = { minX: -3.0, maxX: 3.0, minZ: -3.2, maxZ: 2.5 };

      const evalBlocked = evaluateScene(withUpdatedSceneHash(snap));
      expect(evalBlocked.isValidStructure).toBe(true);
      const shorter = evalBlocked.attendees['att_shorter_01']!;
      expect(shorter.routeStatus).toBe('blocked');
      expect(shorter.usable).toBe(false);
      expect(shorter.failedRequirements).toContain('accessible_route');
    });

    it('flags turningSpacePass = false when a chair or prop intrudes onto a wheelchair turning pad', () => {
      const snap = createDevFixtureSnapshot();
      // Wheelchair turning pad is at [-2.0, 1.3] with required diameter 1.50m (radius 0.75m)
      // Move obj_chair_r2_c1 to [-1.45, 0.0, 1.3] (outside bay footprint [-2.475..-1.525, -0.175..1.175], inside turning circle)
      const r2Chair = snap.objects.find((o) => o.id === 'obj_chair_r2_c1')!;
      r2Chair.transform.position = [-1.15, 0.0, 1.3];

      const evalTurningBlocked = evaluateScene(withUpdatedSceneHash(snap));
      expect(evalTurningBlocked.isValidStructure).toBe(true);
      const wc = evalTurningBlocked.attendees['att_wheelchair_01']!;
      expect(wc.turningSpacePass).toBe(false);
      expect(wc.usable).toBe(false);
      expect(wc.failedRequirements).toContain('turning_space');
    });

    it('exempts ONLY the destination place own footprint/object during its final approach', () => {
      const snap = createDevFixtureSnapshot();
      // Each chair in devFixture has its chair-back proxy at localZ = +0.22 (between routeAnchorPoint at z=1.8 and chair center).
      // Destination-footprint exemption ensures the chair's own back proxy and footprint do not self-block its approach.
      const evaluation = evaluateScene(snap);
      expect(evaluation.attendees['att_adult_01']!.routeStatus).toBe('clear');
      expect(evaluation.attendees['att_extra_legroom_01']!.routeStatus).toBe(
        'clear',
      );
      expect(evaluation.attendees['att_shorter_01']!.routeStatus).toBe('clear');
      expect(evaluation.attendees['att_wheelchair_01']!.routeStatus).toBe(
        'clear',
      );
    });

    it('reports optional prefers_aisle_unmet note without failing usable or failedRequirements', () => {
      const snap = createDevFixtureSnapshot();
      const placeR1C2 = snap.places.find((p) => p.id === 'place_chair_r1_c2')!;
      placeR1C2.isAisle = false;

      const evaluation = evaluateScene(withUpdatedSceneHash(snap));
      const extraLeg = evaluation.attendees['att_extra_legroom_01']!;
      expect(extraLeg.usable).toBe(true);
      expect(extraLeg.failedRequirements).toEqual([]);
      expect(extraLeg.optionalPreferenceNotes).toContain('prefers_aisle_unmet');
    });
  });

  describe('4. Assignment & Structural Guards', () => {
    it('flags DUPLICATE_ASSIGNMENT when two attendees are assigned to the same place', () => {
      const snap = createDevFixtureSnapshot();
      snap.roster[1]!.assignedPlaceId = snap.roster[0]!.assignedPlaceId;

      const evaluation = evaluateScene(withUpdatedSceneHash(snap));
      expect(evaluation.isValidStructure).toBe(false);
      expect(
        evaluation.structuralErrors.some(
          (e) => e.code === 'DUPLICATE_ASSIGNMENT',
        ),
      ).toBe(true);
    });

    it('flags INCOMPATIBLE_PLACE when wheelchair_user is assigned to a chair or reference_adult to a wheelchair_bay', () => {
      const snap = createDevFixtureSnapshot();
      // Swap assigned places between reference_adult (chair) and wheelchair_user (wheelchair_bay)
      const adultRoster = snap.roster.find(
        (r) => r.attendeeId === 'att_adult_01',
      )!;
      const wcRoster = snap.roster.find(
        (r) => r.attendeeId === 'att_wheelchair_01',
      )!;
      const tmp = adultRoster.assignedPlaceId;
      adultRoster.assignedPlaceId = wcRoster.assignedPlaceId;
      wcRoster.assignedPlaceId = tmp;

      const evaluation = evaluateScene(withUpdatedSceneHash(snap));
      expect(evaluation.isValidStructure).toBe(false);
      expect(
        evaluation.structuralErrors.filter(
          (e) => e.code === 'INCOMPATIBLE_PLACE',
        ).length,
      ).toBeGreaterThanOrEqual(2);
    });

    it('flags MISSING_REFERENCE and MALFORMED_GEOMETRY for broken references or zero-area target', () => {
      const snapMissing = createDevFixtureSnapshot();
      snapMissing.roster[0]!.assignedPlaceId = 'place_nonexistent';
      const evalMissing = evaluateScene(withUpdatedSceneHash(snapMissing));
      expect(evalMissing.isValidStructure).toBe(false);
      expect(
        evalMissing.structuralErrors.some(
          (e) => e.code === 'MISSING_REFERENCE',
        ),
      ).toBe(true);

      const snapMalformed = createDevFixtureSnapshot();
      snapMalformed.target.widthM = 0;
      const evalMalformed = evaluateScene(withUpdatedSceneHash(snapMalformed));
      expect(evalMalformed.isValidStructure).toBe(false);
      expect(
        evalMalformed.structuralErrors.some(
          (e) => e.code === 'MALFORMED_GEOMETRY',
        ),
      ).toBe(true);
    });

    it('flags RESERVED_CIRCULATION_INTRUSION and OBJECT_COLLISION when furniture violates spatial rules', () => {
      const snapCirc = createDevFixtureSnapshot();
      const chair = snapCirc.objects.find((o) => o.id === 'obj_chair_r1_c1')!;
      chair.allowedBounds = undefined;
      snapCirc.chairGroups[0]!.allowedBounds = undefined;
      // Move chair into reservedCirculationRegions (minX: -4.2, maxX: -2.8, minZ: -2.5, maxZ: 5.0)
      chair.transform.position = [-3.2, 0.0, 0.0];
      const evalCirc = evaluateScene(withUpdatedSceneHash(snapCirc));
      expect(evalCirc.isValidStructure).toBe(false);
      expect(
        evalCirc.structuralErrors.some(
          (e) => e.code === 'RESERVED_CIRCULATION_INTRUSION',
        ),
      ).toBe(true);

      const snapCol = createDevFixtureSnapshot();
      const chair1 = snapCol.objects.find((o) => o.id === 'obj_chair_r1_c1')!;
      const chair2 = snapCol.objects.find((o) => o.id === 'obj_chair_r1_c2')!;
      chair2.transform.position = [...chair1.transform.position];
      const evalCol = evaluateScene(withUpdatedSceneHash(snapCol));
      expect(evalCol.isValidStructure).toBe(false);
      expect(
        evalCol.structuralErrors.some((e) => e.code === 'OBJECT_COLLISION'),
      ).toBe(true);
    });
  });

  describe('5. Patch Guardrails', () => {
    it('rejects stale parentSceneHash with STALE_SCENE_HASH', () => {
      const snap = createDevFixtureSnapshot();
      const res = applyAndValidatePatch(
        snap,
        snap,
        makePatch('vp_stale_hash', []),
      );
      expect(res.valid).toBe(false);
      expect(res.errors[0]?.code).toBe('STALE_SCENE_HASH');
    });

    it('rejects > 6 operations with PATCH_LIMIT_EXCEEDED', () => {
      const snap = createDevFixtureSnapshot();
      const ops: PatchOperation[] = Array.from({ length: 7 }, (_, i) => ({
        targetType: 'object',
        targetId: `obj_${i}`,
        deltaPositionM: [0.05, 0, 0],
        deltaYawDeg: 0,
        reason: 'op',
      }));
      const res = applyAndValidatePatch(
        snap,
        snap,
        makePatch(snap.sceneHash, ops),
      );
      expect(res.valid).toBe(false);
      expect(res.errors[0]?.code).toBe('PATCH_LIMIT_EXCEEDED');
    });

    it('rejects non-0.05m step increments, |dx| > 0.60m, and |deltaYawDeg| > 10° with PATCH_LIMIT_EXCEEDED', () => {
      const snap = createDevFixtureSnapshot();

      const badStep = applyAndValidatePatch(
        snap,
        snap,
        makePatch(snap.sceneHash, [
          {
            targetType: 'object',
            targetId: 'obj_chair_r1_c1',
            deltaPositionM: [0.13, 0, 0],
            deltaYawDeg: 0,
            reason: 'non-0.05m step',
          },
        ]),
      );
      expect(badStep.valid).toBe(false);
      expect(badStep.errors[0]?.code).toBe('PATCH_LIMIT_EXCEEDED');

      const badAxis = applyAndValidatePatch(
        snap,
        snap,
        makePatch(snap.sceneHash, [
          {
            targetType: 'object',
            targetId: 'obj_chair_r1_c1',
            deltaPositionM: [0.65, 0, 0],
            deltaYawDeg: 0,
            reason: 'exceeds 0.60m axis delta',
          },
        ]),
      );
      expect(badAxis.valid).toBe(false);
      expect(badAxis.errors[0]?.code).toBe('PATCH_LIMIT_EXCEEDED');

      const badYaw = applyAndValidatePatch(
        snap,
        snap,
        makePatch(snap.sceneHash, [
          {
            targetType: 'object',
            targetId: 'obj_chair_r1_c1',
            deltaPositionM: [0, 0, 0],
            deltaYawDeg: 12,
            reason: 'exceeds 10 deg yaw',
          },
        ]),
      );
      expect(badYaw.valid).toBe(false);
      expect(badYaw.errors[0]?.code).toBe('PATCH_LIMIT_EXCEEDED');
    });

    it('rejects cumulative displacement > 1.50m from frozen baseline across sequential patches', () => {
      const baseline = createDevFixtureSnapshot();

      // Step 1: move +0.60m in X (from 0.00m to +0.60m)
      const step1 = applyAndValidatePatch(
        baseline,
        baseline,
        makePatch(baseline.sceneHash, [
          {
            targetType: 'object',
            targetId: 'obj_chair_r2_c1',
            deltaPositionM: [0.6, 0, 0],
            deltaYawDeg: 0,
            reason: 'step 1',
          },
        ]),
      );
      expect(step1.valid).toBe(true);

      // Step 2: move another +0.60m in X (to +1.20m, total 1.20m <= 1.50m)
      const step2 = applyAndValidatePatch(
        baseline,
        step1.snapshot!,
        makePatch(step1.snapshot!.sceneHash, [
          {
            targetType: 'object',
            targetId: 'obj_chair_r2_c1',
            deltaPositionM: [0.6, 0, 0],
            deltaYawDeg: 0,
            reason: 'step 2',
          },
        ]),
      );
      expect(step2.valid).toBe(true);

      // Step 3: move another +0.40m in X (total 1.60m > 1.50m) -> rejected!
      const step3 = applyAndValidatePatch(
        baseline,
        step2.snapshot!,
        makePatch(step2.snapshot!.sceneHash, [
          {
            targetType: 'object',
            targetId: 'obj_chair_r2_c1',
            deltaPositionM: [0.4, 0, 0],
            deltaYawDeg: 0,
            reason: 'step 3 exceeds 1.50m cumulative displacement',
          },
        ]),
      );
      expect(step3.valid).toBe(false);
      expect(step3.errors[0]?.code).toBe('PATCH_LIMIT_EXCEEDED');
    });

    it('rejects fixed-object edits (obj_stage_platform or obj_bay_wc_01) with FIXED_OBJECT_MODIFIED', () => {
      const snap = createDevFixtureSnapshot();

      for (const fixedId of ['obj_stage_platform', 'obj_bay_wc_01']) {
        const res = applyAndValidatePatch(
          snap,
          snap,
          makePatch(snap.sceneHash, [
            {
              targetType: 'object',
              targetId: fixedId,
              deltaPositionM: [0.05, 0, 0],
              deltaYawDeg: 0,
              reason: 'attempt to move fixed object',
            },
          ]),
        );
        expect(res.valid).toBe(false);
        expect(res.errors[0]?.code).toBe('FIXED_OBJECT_MODIFIED');
      }
    });

    it('rejects overlapping group + member operations (group_row1 + obj_chair_r1_c1) with OVERLAPPING_PATCH_TARGETS', () => {
      const snap = createDevFixtureSnapshot();
      const res = applyAndValidatePatch(
        snap,
        snap,
        makePatch(snap.sceneHash, [
          {
            targetType: 'group',
            targetId: 'group_row1',
            deltaPositionM: [0.1, 0, 0],
            deltaYawDeg: 0,
            reason: 'move row 1 group',
          },
          {
            targetType: 'object',
            targetId: 'obj_chair_r1_c1',
            deltaPositionM: [0.1, 0, 0],
            deltaYawDeg: 0,
            reason: 'also move member chair r1_c1',
          },
        ]),
      );
      expect(res.valid).toBe(false);
      expect(res.errors[0]?.code).toBe('OVERLAPPING_PATCH_TARGETS');
    });

    it('applies valid ChairGroup transform updates to all member objects and updates sceneHash', () => {
      const snap = createDevFixtureSnapshot();
      const res = applyAndValidatePatch(
        snap,
        snap,
        makePatch(snap.sceneHash, [
          {
            targetType: 'group',
            targetId: 'group_row1',
            deltaPositionM: [0.1, 0, -0.05],
            deltaYawDeg: 0,
            reason: 'nudge row 1 slightly',
          },
        ]),
      );
      expect(res.valid).toBe(true);
      const c1 = res.snapshot!.objects.find(
        (o) => o.id === 'obj_chair_r1_c1',
      )!;
      const c2 = res.snapshot!.objects.find(
        (o) => o.id === 'obj_chair_r1_c2',
      )!;
      expect(c1.transform.position[0]).toBeCloseTo(-0.25, 4);
      expect(c1.transform.position[2]).toBeCloseTo(-0.85, 4);
      expect(c2.transform.position[0]).toBeCloseTo(1.3, 4);
      expect(c2.transform.position[2]).toBeCloseTo(-0.85, 4);
    });
  });

  describe('6. Non-Regression & Tie-Breaking', () => {
    it('rejects a candidate that breaks front legroom for extra_legroom with rejected_regression', () => {
      const baselineSnap = createDevFixtureSnapshot();
      const baselineEval = evaluateScene(baselineSnap);

      // Add a fixed structural column in front of place_chair_r1_c2 (extra_legroom seat at [1.2, 0, -0.8])
      // while shifting obj_chair_r1_c1 to [-0.90, 0, -0.8] so att_shorter_01 has 135/135 view:
      const candSnap = createDevFixtureSnapshot();
      const r1c1 = candSnap.objects.find((o) => o.id === 'obj_chair_r1_c1')!;
      r1c1.transform.position = [-0.9, 0.0, -0.8];
      candSnap.objects.push({
        id: 'obj_pillar_front_right',
        label: 'Structural Column',
        category: 'fixed_structure',
        editable: false,
        transform: { position: [1.2, 0.0, -1.35], yawDeg: 0 },
        baselineTransform: { position: [1.2, 0.0, -1.35], yawDeg: 0 },
        proxies: [
          {
            id: 'proxy_pillar_front_right',
            kind: 'box',
            localPosition: [0.0, 0.4, 0.0],
            localYawDeg: 0,
            size: [0.36, 0.8, 0.2],
            blocksVisibility: false,
            blocksMovement: true,
          },
        ],
      });
      const candEval = evaluateScene(withUpdatedSceneHash(candSnap));

      expect(candEval.attendees['att_shorter_01']!.visibleSamples).toBe(135);
      expect(candEval.attendees['att_extra_legroom_01']!.legroomPass).toBe(
        false,
      );

      const cmp = compareEvaluations(baselineEval, candEval);
      expect(cmp.accepted).toBe(false);
      expect(cmp.outcome).toBe('rejected_regression');
    });

    it('rejects a candidate that improves one profile but causes a per-profile meanVisibility regression on another', () => {
      const baselineSnap = createDevFixtureSnapshot();
      const baselineEval = evaluateScene(baselineSnap);

      // Shift obj_chair_r1_c1 to [-0.90, 0, -0.8] (so att_shorter_01 improves to 135/135),
      // while placing a structural column in front of att_adult_01 at [-0.90, 0, -1.8]:
      const candSnap = createDevFixtureSnapshot();
      const r1c1 = candSnap.objects.find((o) => o.id === 'obj_chair_r1_c1')!;
      r1c1.transform.position = [-0.9, 0.0, -0.8];
      candSnap.objects.push({
        id: 'obj_pillar_front_left',
        label: 'Structural Column',
        category: 'fixed_structure',
        editable: false,
        transform: { position: [-0.9, 0.0, -1.8], yawDeg: 0 },
        baselineTransform: { position: [-0.9, 0.0, -1.8], yawDeg: 0 },
        proxies: [
          {
            id: 'proxy_pillar_front_left',
            kind: 'box',
            localPosition: [0.0, 0.7, 0.0],
            localYawDeg: 0,
            size: [0.6, 1.4, 0.2],
            blocksVisibility: true,
            blocksMovement: true,
          },
        ],
      });
      const candEval = evaluateScene(withUpdatedSceneHash(candSnap));

      expect(candEval.attendees['att_shorter_01']!.isViewClear).toBe(true);
      expect(
        candEval.perProfile.reference_adult.meanVisibility,
      ).toBeLessThan(baselineEval.perProfile.reference_adult.meanVisibility);

      const cmp = compareEvaluations(baselineEval, candEval);
      expect(cmp.accepted).toBe(false);
      expect(cmp.outcome).toBe('rejected_regression');
    });

    it('rejects identical or tied evaluations with rejected_no_improvement', () => {
      const baselineSnap = createDevFixtureSnapshot();
      const baselineEval = evaluateScene(baselineSnap);

      // Identical evaluation
      const sameCmp = compareEvaluations(baselineEval, baselineEval);
      expect(sameCmp.accepted).toBe(false);
      expect(sameCmp.outcome).toBe('rejected_no_improvement');

      // Different sceneHash (e.g. moving a front-right chair slightly outward without changing any visibility or access metrics)
      const movedSnap = applyAndValidatePatch(
        baselineSnap,
        baselineSnap,
        makePatch(baselineSnap.sceneHash, [
          {
            targetType: 'object',
            targetId: 'obj_chair_r1_c2',
            deltaPositionM: [0.05, 0, 0],
            deltaYawDeg: 0,
            reason: 'tiny shift with identical scores',
          },
        ]),
      ).snapshot!;
      const movedEval = evaluateScene(movedSnap);
      expect(movedEval.sceneHash).not.toBe(baselineEval.sceneHash);

      const tiedCmp = compareEvaluations(baselineEval, movedEval);
      expect(tiedCmp.accepted).toBe(false);
      expect(tiedCmp.outcome).toBe('rejected_no_improvement');
    });
  });

  describe('7. Adversarial Edge Cases (Red-Team Hardening)', () => {
    it('detects occlusion from rotated OBBs and 3D finite cylinder pillars', () => {
      const snap = createDevFixtureSnapshot();
      // Place a cylinder pillar in front of att_adult_01 (at X=-0.35, Z=-0.8)
      snap.objects.push({
        id: 'obj_pillar_cyl',
        label: 'Cylindrical Pillar',
        category: 'fixed_structure',
        editable: false,
        transform: { position: [-0.35, 0.0, -2.2], yawDeg: 45 },
        baselineTransform: { position: [-0.35, 0.0, -2.2], yawDeg: 45 },
        proxies: [
          {
            id: 'proxy_cyl_01',
            kind: 'cylinder',
            localPosition: [0, 1.0, 0],
            localYawDeg: 0,
            radiusM: 0.45,
            heightM: 2.0,
            blocksVisibility: true,
            blocksMovement: true,
          },
        ],
      });

      const evaluation = evaluateScene(withUpdatedSceneHash(snap));
      const adult = evaluation.attendees['att_adult_01']!;
      expect(adult.visibleSamples).toBeLessThan(VISIBILITY_CLEAR_MIN_SAMPLES);
      expect(adult.isViewClear).toBe(false);
      expect(adult.primaryBlockerIds).toContain('obj_pillar_cyl');
    });

    it('scores 0 visible samples when a viewer sits behind the presentation target looking at its back', () => {
      const snap = createDevFixtureSnapshot();
      // Flip target yawDeg from 180° (facing +Z toward audience) to 0° (facing -Z away from audience)
      snap.target.yawDeg = 0;

      const evaluation = evaluateScene(withUpdatedSceneHash(snap));
      for (const att of Object.values(evaluation.attendees)) {
        expect(att.visibleSamples).toBe(0);
        expect(att.isViewClear).toBe(false);
      }
    });

    it('exempts an unoccupied wheelchair bay from blocking front legroom of a chair behind it', () => {
      const snap = createDevFixtureSnapshot();
      // Remove wheelchair attendee from roster so place_bay_wc_01 is unoccupied
      snap.roster = snap.roster.filter(
        (r) => r.attendeeId !== 'att_wheelchair_01',
      );
      // Position obj_chair_r2_c1 directly behind place_bay_wc_01 so its front legroom overlaps the empty bay
      const r2Chair = snap.objects.find((o) => o.id === 'obj_chair_r2_c1')!;
      r2Chair.transform.position = [-2.0, 0.0, 1.55];

      const evaluation = evaluateScene(withUpdatedSceneHash(snap));
      expect(evaluation.attendees['att_shorter_01']!.legroomPass).toBe(true);
    });

    it('catches NaN or non-positive eyeOffsetAboveSeatM / independentEyeHeightM as MALFORMED_GEOMETRY', () => {
      const snap = createDevFixtureSnapshot();
      snap.profiles.reference_adult.eyeOffsetAboveSeatM = Number.NaN;

      const evaluation = evaluateScene(snap);
      expect(evaluation.isValidStructure).toBe(false);
      expect(
        evaluation.structuralErrors.some(
          (e) => e.code === 'MALFORMED_GEOMETRY',
        ),
      ).toBe(true);
    });
  });

  describe('8. Emergency Evacuation & Bunched Row Repair', () => {
    it('detects row bunching in createBunchedEmergencyVenueSnapshot and repairs via createBunchedEmergencyReferencePatch', async () => {
      const {
        createBunchedEmergencyVenueSnapshot,
        createBunchedEmergencyReferencePatch,
      } = await import('../../src/scene/index.js');

      const baseSnap = createBunchedEmergencyVenueSnapshot();
      const baseEval = evaluateScene(baseSnap);

      expect(baseEval.isValidStructure).toBe(true);
      expect(baseEval.evacuation).toBeDefined();
      expect(baseEval.evacuation!.activeExitCount).toBe(2);
      expect(baseEval.evacuation!.totalExitCount).toBe(2);
      expect(baseEval.evacuation!.jammedAttendeeIds.length).toBeGreaterThan(0);

      const patch = createBunchedEmergencyReferencePatch(
        'run_bunched_24',
        baseSnap.sceneHash,
      );
      const validated = applyAndValidatePatch(baseSnap, baseSnap, patch);
      expect(validated.valid).toBe(true);
      expect(validated.snapshot).toBeDefined();

      const candEval = evaluateScene(validated.snapshot!);
      expect(candEval.evacuation!.activeExitCount).toBe(2);
      expect(candEval.evacuation!.jammedAttendeeIds).toHaveLength(0);
      expect(candEval.evacuation!.totalEvacuationTimeSec).toBeLessThan(
        baseEval.evacuation!.totalEvacuationTimeSec,
      );

      const cmp = compareEvaluations(baseEval, candEval);
      expect(cmp.accepted).toBe(true);
    });
  });

  describe('9. Tiered Seating Architecture (Riser Elevation, ADA Ramp Slopes, Headroom Clearance)', () => {
    it('allows vertical translation dy in patch operations for chair groups and elevates member objects', () => {
      const baseline = createDevFixtureSnapshot();
      const patch = makePatch(baseline.sceneHash, [
        {
          targetType: 'group',
          targetId: 'group_row1',
          deltaPositionM: [0, 0.05, 0],
          deltaYawDeg: 0,
          reason: 'Elevate Row 1 by 0.05m on stepped riser',
        },
        {
          targetType: 'object',
          targetId: 'obj_chair_r2_c1',
          deltaPositionM: [0, 0.10, 0],
          deltaYawDeg: 0,
          reason: 'Elevate Row 2 by 0.10m to satisfy monotonicity and ADA slope',
        },
      ]);

      const result = applyAndValidatePatch(baseline, baseline, patch);
      expect(result.valid).toBe(true);
      expect(result.snapshot).toBeDefined();

      const updatedGroup = result.snapshot!.chairGroups.find(
        (g) => g.id === 'group_row1',
      )!;
      expect(updatedGroup.transform.position[1]).toBe(0.05);

      const member1 = result.snapshot!.objects.find(
        (o) => o.id === 'obj_chair_r1_c1',
      )!;
      const member2 = result.snapshot!.objects.find(
        (o) => o.id === 'obj_chair_r1_c2',
      )!;
      expect(member1.transform.position[1]).toBe(0.05);
      expect(member2.transform.position[1]).toBe(0.05);

      const r2Member = result.snapshot!.objects.find(
        (o) => o.id === 'obj_chair_r2_c1',
      )!;
      expect(r2Member.transform.position[1]).toBe(0.10);
    });

    it('validates tiered seating when rows are monotonically elevated with equal steps and ADA compliant slopes', () => {
      const snap = createDevFixtureSnapshot();
      // Row 1 (z = -0.80): elevation 0.00m
      // Row 2 (z = 0.50, dz = 1.30m): elevation 0.10m (slope = 0.10 / 1.30 = 0.0769 <= 1/12)
      const r2 = snap.objects.find((o) => o.id === 'obj_chair_r2_c1')!;
      r2.transform.position[1] = 0.10;

      const evaluation = evaluateScene(withUpdatedSceneHash(snap));
      expect(
        evaluation.structuralErrors.filter(
          (e) => e.code === 'TIERED_SEATING_VIOLATION',
        ),
      ).toEqual([]);
    });

    it('rejects tiered seating violating 5ft headroom clearance above a 1.85m standing person', () => {
      const snap = createDevFixtureSnapshot();
      // Ceiling is 4.0m. Requires 1.85m (person) + 1.524m (5ft clearance) = 3.374m.
      // Max platform height is 4.0 - 3.374 = 0.626m. An elevation of 0.70m violates clearance.
      const r2 = snap.objects.find((o) => o.id === 'obj_chair_r2_c1')!;
      r2.transform.position[1] = 0.70;

      const evaluation = evaluateScene(withUpdatedSceneHash(snap));
      expect(evaluation.isValidStructure).toBe(false);
      expect(
        evaluation.structuralErrors.some(
          (e) =>
            e.code === 'TIERED_SEATING_VIOLATION' &&
            e.message.includes('violates 5-foot ceiling clearance'),
        ),
      ).toBe(true);
    });

    it('rejects tiered seating violating monotonicity (rear row lower than front row)', () => {
      const snap = createDevFixtureSnapshot();
      // Elevate Row 1 to 0.20m while Row 2 remains at 0.00m (rear row lower than front row)
      const r1c1 = snap.objects.find((o) => o.id === 'obj_chair_r1_c1')!;
      const r1c2 = snap.objects.find((o) => o.id === 'obj_chair_r1_c2')!;
      r1c1.transform.position[1] = 0.20;
      r1c2.transform.position[1] = 0.20;

      const evaluation = evaluateScene(withUpdatedSceneHash(snap));
      expect(evaluation.isValidStructure).toBe(false);
      expect(
        evaluation.structuralErrors.some(
          (e) =>
            e.code === 'TIERED_SEATING_VIOLATION' &&
            e.message.includes('Tiered seating requires strictly increasing elevations'),
        ),
      ).toBe(true);
    });

    it('rejects tiered seating with unequal step differences exceeding 0.05m tolerance', () => {
      const snap = createDevFixtureSnapshot();
      // Add a 3rd row to test step differences: Row 1 = 0.00m, Row 2 = 0.05m, Row 3 = 0.25m
      // Step 1 = 0.05m, Step 2 = 0.20m; variation = 0.15m > 0.05m
      const r2 = snap.objects.find((o) => o.id === 'obj_chair_r2_c1')!;
      r2.transform.position[1] = 0.05;

      const r3Chair = structuredClone(r2);
      r3Chair.id = 'obj_chair_r3_c1';
      r3Chair.transform.position = [0.0, 0.25, 2.0];
      snap.objects.push(r3Chair);

      const evaluation = evaluateScene(withUpdatedSceneHash(snap));
      expect(evaluation.isValidStructure).toBe(false);
      expect(
        evaluation.structuralErrors.some(
          (e) =>
            e.code === 'TIERED_SEATING_VIOLATION' &&
            e.message.includes('Elevation step differences between successive rows are unequal'),
        ),
      ).toBe(true);
    });

    it('rejects tiered seating where the ramp incline between rows exceeds ADA 1:12 slope', () => {
      const snap = createDevFixtureSnapshot();
      // dz = 0.50 - (-0.80) = 1.30m. Max allowed dy for 1:12 is 1.30 / 12 = 0.108m.
      // Setting dy = 0.25m creates slope = 0.25 / 1.30 = 0.192 (> 1:12).
      const r2 = snap.objects.find((o) => o.id === 'obj_chair_r2_c1')!;
      r2.transform.position[1] = 0.25;

      const evaluation = evaluateScene(withUpdatedSceneHash(snap));
      expect(evaluation.isValidStructure).toBe(false);
      expect(
        evaluation.structuralErrors.some(
          (e) =>
            e.code === 'TIERED_SEATING_VIOLATION' &&
            e.message.includes('exceeds ADA maximum feasible ramp slope of 1:12'),
        ),
      ).toBe(true);
    });

    it('rejects chairs that obstruct the outside accessible wheelchair ramp corridor', () => {
      const snap = createDevFixtureSnapshot();
      // Place a chair into the west wheelchair ramp corridor (X = -3.50, Z = 0.0)
      const r2 = snap.objects.find((o) => o.id === 'obj_chair_r2_c1')!;
      r2.allowedBounds = { minX: -5.0, maxX: 5.0, minZ: -5.0, maxZ: 5.0 };
      r2.transform.position = [-3.50, 0.0, 0.0];

      const evaluation = evaluateScene(withUpdatedSceneHash(snap));
      expect(evaluation.isValidStructure).toBe(false);
      expect(
        evaluation.structuralErrors.some(
          (e) =>
            e.code === 'TIERED_SEATING_VIOLATION' &&
            e.message.includes('obstructs the accessible wheelchair ramp corridor'),
        ),
      ).toBe(true);
    });

    it('routes wheelchair users directly to the high-level wheelchair terrace exit in prepared venue', () => {
      const snap = createPreparedVenueSnapshot();
      const sim = simulateEvacuation(snap, 'emergency_evacuation');
      expect(sim.frames.length).toBeGreaterThan(0);
      // Both wheelchair attendees should target the rear terrace exit
      const lastFrame = sim.frames[sim.frames.length - 1]!;
      const wc01 = lastFrame.agents['att_wheelchair_01'];
      const wc02 = lastFrame.agents['att_wheelchair_02'];
      expect(wc01?.targetExitId).toBe('exit_wheelchair_terrace');
      expect(wc02?.targetExitId).toBe('exit_wheelchair_terrace');
    });

    it('allows patching exit portal positions via targetType: exit in applyAndValidatePatch', () => {
      const baseline = createPreparedVenueSnapshot();
      const patch = makePatch(baseline.sceneHash, [
        {
          targetType: 'exit',
          targetId: 'exit_main_west',
          deltaPositionM: [0, 0, -0.40],
          deltaYawDeg: 0,
          reason: 'Shift west low-level exit forward to optimize egress time',
        },
      ]);

      const result = applyAndValidatePatch(baseline, baseline, patch);
      expect(result.valid).toBe(true);
      expect(result.snapshot?.exits).toBeDefined();
      const updatedExit = result.snapshot!.exits!.find((e) => e.id === 'exit_main_west')!;
      expect(updatedExit.position[1]).toBeCloseTo(-2.20, 2);
    });

    it('computes continuous 3D surface elevations along ramps and stepped tiers via getVenueSurfaceElevationAt', () => {
      // Platform tiers:
      expect(getVenueSurfaceElevationAt(0, -2.0)).toBe(0.04); // Row 1
      expect(getVenueSurfaceElevationAt(0, -0.3)).toBe(0.10); // Row 2
      expect(getVenueSurfaceElevationAt(0, 1.4)).toBe(0.20);  // Row 3
      expect(getVenueSurfaceElevationAt(0, 3.3)).toBe(0.30);  // Row 4 / Terrace

      // Outside accessible ramp corridor (e.g. West at X = -3.65m):
      expect(getVenueSurfaceElevationAt(-3.65, -2.40)).toBe(0.0); // Below ramp start
      expect(getVenueSurfaceElevationAt(-3.65, 3.35)).toBe(0.30); // Above ramp top
      // Mid-ramp slope interpolation:
      const midElevation = getVenueSurfaceElevationAt(-3.65, 0.475);
      expect(midElevation).toBeGreaterThan(0.10);
      expect(midElevation).toBeLessThan(0.20);
    });
  });
});
