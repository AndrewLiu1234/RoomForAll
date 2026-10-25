/**
 * Shared TypeScript Contracts for VenuePilot (PRD v2.1 §10)
 * Owned by Stream D (Integration Owner). All workstreams import from `src/shared/`.
 */

export type Vec2 = [number, number]; // [x, z] in metres on floor plane
export type Vec3 = [number, number, number]; // [x, y, z] in metres, +Y up

export interface AABB2D {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

export interface AABB3D {
  min: Vec3;
  max: Vec3;
}

export interface Transform3D {
  position: Vec3;
  /** Right-handed yaw in degrees about +Y; 0° faces -Z */
  yawDeg: number;
}

export interface ProxyPrimitive {
  id: string;
  kind: 'box' | 'cylinder';
  /**
   * 3D geometric center [cx, cy, cz] relative to parent SceneObject.transform
   * (matches Three.js BoxGeometry/CylinderGeometry origin convention).
   */
  localPosition: Vec3;
  localYawDeg: number;
  /** For 'box': [widthX, heightY, depthZ] in metres */
  size?: Vec3;
  /** For 'cylinder': radius and heightY in metres */
  radiusM?: number;
  heightM?: number;
  blocksVisibility: boolean;
  blocksMovement: boolean;
}

export type ProfileId =
  | 'reference_adult'
  | 'shorter_seated'
  | 'wheelchair_user'
  | 'extra_legroom';

export type PlaceKind = 'chair' | 'wheelchair_bay';

export interface ProfileRequirements {
  id: ProfileId;
  label: string;
  compatiblePlaceKinds: PlaceKind[];
  /**
   * 'seat_offset': eyeY = place.seatHeightM + eyeOffsetAboveSeatM
   * 'independent': eyeY = independentEyeHeightM (used for wheelchair_user)
   */
  eyeHeightMode: 'seat_offset' | 'independent';
  eyeOffsetAboveSeatM?: number;
  independentEyeHeightM?: number;
  requiredFootprintWidthM: number;
  requiredFootprintDepthM: number;
  requiredFrontLegroomM: number;
  requiredRouteWidthM: number;
  requiredTurningCircleDiameterM: number;
  /** Optional preference; reported separately, does not block acceptance */
  prefersAisle: boolean;
  /** Finite-height seated body proxy dimensions for occluding viewers behind this place */
  torsoProxyHeightM: number;
  torsoProxyWidthM: number;
  torsoProxyDepthM: number;
}

export interface AttendeeAssignment {
  attendeeId: string;
  label: string;
  profileId: ProfileId;
  assignedPlaceId: string;
}

export interface PresentationTarget {
  id: string;
  label: string;
  /** World-space center of the rectangular presentation target */
  center: Vec3;
  /** Normal direction yaw (e.g., 180° faces +Z toward audience) */
  yawDeg: number;
  widthM: number;
  heightM: number;
}

export type SceneObjectCategory =
  | 'fixed_structure'
  | 'stage'
  | 'movable_chair'
  | 'movable_prop'
  | 'wheelchair_bay_frame';

export interface SceneObject {
  id: string;
  label: string;
  category: SceneObjectCategory;
  editable: boolean;
  /** Optional membership in a fixed-membership chair group */
  groupId?: string;
  /**
   * Always expressed in WORLD space [x, y, z] and world yawDeg,
   * even when `groupId` is set.
   */
  transform: Transform3D;
  /** Frozen world-space baseline transform to enforce <= 1.50m total displacement limit */
  baselineTransform: Transform3D;
  /** Optional stricter per-object horizontal movement bounds (world-space AABB2D) */
  allowedBounds?: AABB2D;
  proxies: ProxyPrimitive[];
}

export interface ChairGroup {
  id: string;
  label: string;
  memberObjectIds: string[];
  transform: Transform3D;
  baselineTransform: Transform3D;
  allowedBounds?: AABB2D;
}

export interface AudiencePlace {
  id: string;
  label: string;
  kind: PlaceKind;
  /** ID of the corresponding SceneObject (movable_chair or wheelchair_bay_frame) */
  objectId: string;
  /** Measured seat height above floor in metres (0 for wheelchair_bay) */
  seatHeightM: number;
  widthM: number;
  depthM: number;
  isAisle: boolean;
  /** References the RouteCorridor from which final approach is computed */
  routeId: string;
  /** Corridor anchor [x, z] where the dynamic final-approach segment starts */
  routeAnchorPoint: Vec2;
  /** Optional turning pad center [x, z] and diameter for wheelchair bays */
  turningPadCenter?: Vec2;
  turningPadDiameterM?: number;
}

export interface RouteCorridor {
  id: string;
  label: string;
  /** Polyline waypoints [x, z] from venue entrance along fixed main corridor */
  waypoints: Vec2[];
  widthM: number;
}

export type EvacuationMode =
  | 'none'
  | 'normal_egress'
  | 'emergency_evacuation';

export interface VenueExitPortal {
  id: string;
  label: string;
  /** Floor-plane center [x, z] in metres */
  position: Vec2;
  /** Platform / 3D floor elevation Y in metres (e.g. 0.30m for elevated wheelchair terrace, defaults to 0.0) */
  elevationM?: number;
  /** Clear portal door width in metres */
  widthM: number;
  /** Outward facing yaw in degrees */
  yawDeg: number;
  /** True for secondary emergency exit portals */
  isEmergencyExit?: boolean;
  /** Optional SceneObject ID (e.g. movable barrier or closed emergency door panel) that can obstruct this exit until moved */
  gateObjectId?: string;
}

export interface EvacuationAgentFrameState {
  position: Vec2;
  yawDeg: number;
  speedMps: number;
  state: 'seated' | 'extricating' | 'walking' | 'queuing' | 'exited';
  targetExitId: string;
  /** True if this agent is blocked by a wall/barrier and cannot reach any exit without phasing through objects */
  trappedByWall?: boolean;
}

export interface EvacuationBottleneckZone {
  center: Vec2;
  radiusM: number;
  peakQueueCount: number;
  causeObjectIds: string[];
  description: string;
}

export interface EvacuationSimResult {
  mode: 'normal_egress' | 'emergency_evacuation';
  durationSec: number;
  totalEvacuationTimeSec: number;
  targetThresholdSec: number;
  evacuationPass: boolean;
  activeExitCount: number;
  totalExitCount: number;
  peakCongestionDensity: number;
  jammedAttendeeIds: string[];
  /** Number of attendees who cannot reach any exit without phasing through walls/barriers */
  trappedCount?: number;
  /** IDs of attendees trapped by walls or isolated levels */
  trappedAttendeeIds?: string[];
  /** Human-readable explanation when exit is impossible without phasing through walls */
  evacuationImpossibleReason?: string;
  bottleneckZones: EvacuationBottleneckZone[];
  attendeeTimesSec: Record<string, number>;
  frames: Array<{
    timeSec: number;
    agents: Record<string, EvacuationAgentFrameState>;
  }>;
}

export type EvacuationEvaluationSummary = Omit<EvacuationSimResult, 'frames'>;

export interface SceneSourceMetadata {
  sourceId: string;
  title: string;
  license: string;
  sourceUrl?: string;
  assetPath?: string;
  assetHash?: string;
  isFallbackFixture: boolean;
  preparationNotes: string;
}

/**
 * Contract 1: SceneSnapshot (PRD §10)
 */
export interface SceneSnapshot {
  contractVersion: string;
  sceneId: string;
  sceneHash: string;
  source: SceneSourceMetadata;
  roomBounds: AABB3D;
  allowedFloorRegions: AABB2D[];
  reservedCirculationRegions: AABB2D[];
  target: PresentationTarget;
  objects: SceneObject[];
  chairGroups: ChairGroup[];
  places: AudiencePlace[];
  routes: RouteCorridor[];
  /** Optional explicit exit portals; when omitted, derived deterministically from routes & room bounds */
  exits?: VenueExitPortal[];
  profiles: Record<ProfileId, ProfileRequirements>;
  roster: AttendeeAssignment[];
}

/**
 * Contract 2: LayoutPatch (PRD §4, §7, §10)
 */
export interface PatchOperation {
  targetType: 'object' | 'group' | 'exit';
  targetId: string;
  /** Translation [dx, dy, dz] in 0.05m steps, |dx| <= 0.60, |dy| <= 0.60, |dz| <= 0.60 */
  deltaPositionM: [number, number, number];
  /** Yaw delta in degrees, |deltaYawDeg| <= 10 */
  deltaYawDeg: number;
  reason: string;
}

export interface EvidenceFinding {
  attendeeId?: string;
  viewId: string;
  timestampSec: number;
  observation: string;
  /** True for unmeasured visual notes like glare/lighting (PRD §8) */
  isUnmeasuredVisualNote?: boolean;
}

export interface LayoutPatch {
  contractVersion: string;
  runId: string;
  parentSceneHash: string;
  diagnosis: EvidenceFinding[];
  operations: PatchOperation[];
  /** Optional new reachable exit portals synthesized by the repairer when existing exits are unreachable without phasing through walls */
  addedExits?: VenueExitPortal[];
  summary: string;
}

/**
 * Contract 3: Evaluation (PRD §6, §10)
 */
export type StructuralErrorCode =
  | 'OUT_OF_BOUNDS'
  | 'OBJECT_COLLISION'
  | 'RESERVED_CIRCULATION_INTRUSION'
  | 'FIXED_OBJECT_MODIFIED'
  | 'DUPLICATE_ASSIGNMENT'
  | 'INCOMPATIBLE_PLACE'
  | 'MISSING_REFERENCE'
  | 'TIERED_SEATING_VIOLATION'
  | 'PATCH_LIMIT_EXCEEDED'
  | 'OVERLAPPING_PATCH_TARGETS'
  | 'STALE_SCENE_HASH'
  | 'MALFORMED_GEOMETRY';

export interface StructuralError {
  code: StructuralErrorCode;
  message: string;
  targetId?: string;
}

export interface AttendeeEvaluation {
  attendeeId: string;
  profileId: ProfileId;
  placeId: string;
  eyePositionWorld: Vec3;
  lookDirectionWorld: Vec3;
  visibleSamples: number;
  totalSamples: number;
  sampledVisibility: number;
  isViewClear: boolean;
  routeStatus: 'clear' | 'blocked';
  footprintFitPass: boolean;
  legroomPass: boolean;
  turningSpacePass: boolean;
  usable: boolean;
  clearAndUsable: boolean;
  failedRequirements: string[];
  optionalPreferenceNotes: string[];
  /** Internal blocker IDs; MUST be stripped before the first Argon visual critique call */
  primaryBlockerIds: string[];
  /** Emergency evacuation exit time in seconds for this attendee */
  evacuationTimeSec?: number;
  /** True if emergency evacuation from this seat is delayed by row bunching or exit bottlenecks */
  evacuationDelayed?: boolean;
}

export interface ProfileSummaryMetrics {
  profileId: ProfileId;
  attendeeCount: number;
  usableCount: number;
  clearViewCount: number;
  clearAndUsableCount: number;
  meanVisibility: number;
  unmetRequirementCount: number;
  failedCheckCount: number;
}

export interface ComparisonComponents {
  /** Priority 1 (lower is better): attendees with >=1 failed required check or non-clear view */
  attendeesWithUnmetRequirements: number;
  /** Priority 2 (lower is better): sum of failed required checks across all attendees */
  totalFailedRequirementChecks: number;
  /** Priority 3 (higher is better): minimum meanVisibility across represented profiles */
  worstProfileMeanVisibility: number;
  /** Priority 4 (higher is better): total visible target samples across all attendees */
  totalVisibleSamples: number;
}

export interface Evaluation {
  contractVersion: string;
  sceneHash: string;
  isValidStructure: boolean;
  structuralErrors: StructuralError[];
  /** Counts audience places (chairs + wheelchair bays), not just chairs */
  capacityCount: number;
  occupiedCount: number;
  allModeledRequirementsMet: boolean;
  attendees: Record<string, AttendeeEvaluation>;
  perProfile: Record<ProfileId, ProfileSummaryMetrics>;
  comparison: ComparisonComponents;
  /** Deterministic emergency evacuation simulation metrics */
  evacuation?: EvacuationEvaluationSummary;
}

/**
 * Contract 4: EvidenceManifest & Capture Tour (PRD §7, §10)
 */
export interface CaptureKeyframe {
  viewId: string;
  label: string;
  kind: 'overview' | 'attendee_pov';
  attendeeId?: string;
  placeId?: string;
  cameraPosition: Vec3;
  cameraLookAt: Vec3;
  fovDeg: number;
  aspect: number;
  startSec: number;
  endSec: number;
}

export interface CaptureTourSpec {
  captureId: string;
  runId: string;
  phase: 'baseline' | 'revision';
  sceneHash: string;
  snapshot: SceneSnapshot;
  keyframes: CaptureKeyframe[];
  totalDurationSec: number;
  deadlineIso: string;
}

export interface EvidenceManifest {
  contractVersion: string;
  captureId: string;
  runId: string;
  phase: 'baseline' | 'revision';
  sceneHash: string;
  mimeType: string;
  byteLength: number;
  durationSec: number;
  widthPx: number;
  heightPx: number;
  keyframes: CaptureKeyframe[];
  recordedAtIso: string;
}

/**
 * Contract 5: RunRecord & State Machine (PRD §9, §10)
 */
export type RunState =
  | 'preparing'
  | 'capturing_baseline'
  | 'inspecting_baseline'
  | 'proposing'
  | 'verifying'
  | 'rendering_revision'
  | 'inspecting_revision'
  | 'finished';

export type RunOutcome =
  | 'in_progress'
  | 'improved'
  | 'no_improvement'
  | 'partial_incomplete'
  | 'timeout'
  | 'failure';

export type ComparisonOutcome =
  | 'accepted'
  | 'rejected_structural'
  | 'rejected_regression'
  | 'rejected_no_improvement';

export interface PatchAttemptRecord {
  attemptIndex: number;
  patch: LayoutPatch;
  candidateSceneHash?: string;
  evaluation?: Evaluation;
  comparisonOutcome: ComparisonOutcome;
  rejectionReasons: string[];
  timestampIso: string;
}

export interface FinalInspectionReport {
  captureId: string;
  sceneHash: string;
  findings: EvidenceFinding[];
  remainingIssuesSummary: string;
  providerResponseId?: string;
}

export interface RunRecord {
  contractVersion: string;
  runId: string;
  state: RunState;
  outcome: RunOutcome;
  terminalReason?: string;
  createdAtIso: string;
  updatedAtIso: string;
  deadlineIso: string;
  elapsedMs: number;
  baselineSnapshot: SceneSnapshot;
  baselineEvaluation: Evaluation;
  bestSnapshot: SceneSnapshot;
  bestEvaluation: Evaluation;
  pendingCapture?: CaptureTourSpec;
  baselineEvidence?: EvidenceManifest;
  revisionEvidence?: EvidenceManifest;
  attempts: PatchAttemptRecord[];
  finalInspection?: FinalInspectionReport;
  providerModel?: string;
  providerRequestIds: string[];
}

/**
 * REST Endpoint Contracts (PRD §10 Step 3)
 */
export interface PreviewRequest {
  snapshot?: SceneSnapshot;
  profiles?: Partial<Record<ProfileId, ProfileRequirements>>;
  roster?: AttendeeAssignment[];
}

export interface PreviewResponse {
  snapshot: SceneSnapshot;
  evaluation: Evaluation;
}

export interface CreateRunRequest {
  snapshot: SceneSnapshot;
}

export interface CreateRunResponse {
  runId: string;
  state: RunState;
  sceneHash: string;
  deadlineIso: string;
  pendingCapture?: CaptureTourSpec;
}

export interface GetRunResponse {
  run: RunRecord;
}

export interface UploadEvidenceResponse {
  runId: string;
  captureId: string;
  deduplicated: boolean;
  state: RunState;
  outcome: RunOutcome;
}

/**
 * Cross-Workstream Function Signatures
 */
export interface PatchValidationResult {
  valid: boolean;
  errors: StructuralError[];
  snapshot?: SceneSnapshot;
}

export interface EvaluationComparisonResult {
  accepted: boolean;
  outcome: ComparisonOutcome;
  reasons: string[];
}

export interface CapturedEvidencePayload {
  videoBlob: Blob;
  manifest: EvidenceManifest;
}

/**
 * Sanitized payload supplied to Argon's first visual critique call (PRD §7).
 * Intentionally excludes `Evaluation`, pass/fail checks, and blocker labels.
 */
export interface BlindCritiquePayload {
  contractVersion: string;
  sceneHash: string;
  evidenceManifest: EvidenceManifest;
  profiles: Record<ProfileId, ProfileRequirements>;
  roster: AttendeeAssignment[];
  editableObjects: Array<
    Pick<
      SceneObject,
      | 'id'
      | 'label'
      | 'category'
      | 'groupId'
      | 'transform'
      | 'baselineTransform'
      | 'allowedBounds'
    >
  >;
  chairGroups: ChairGroup[];
  places: AudiencePlace[];
  routes: RouteCorridor[];
  exits?: VenueExitPortal[];
  target: PresentationTarget;
  roomBounds: AABB3D;
  patchConstraints: {
    readonly maxOperations: number;
    readonly translationStepM: number;
    readonly maxAxisDeltaM: number;
    readonly maxYawDeltaDeg: number;
    readonly maxTotalDisplacementFromBaselineM: number;
  };
}

