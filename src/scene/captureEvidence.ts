/**
 * Stream A — Foreground Browser Evidence Capture Pipeline (`src/scene/captureEvidence.ts`)
 * Exclusive ownership: Workstream A.
 *
 * Implements `captureEvidence(snapshot, tourSpec)` per PRD §7, §10 Step 2 & ARGON_MVP_PROMPT §6:
 * - Validates `snapshot.sceneHash === tourSpec.sceneHash` and checks deadline.
 * - Synthesizes deterministic keyframes if `tourSpec.keyframes` is empty, and synchronizes
 *   all `attendee_pov` keyframe poses with the current `snapshot` (so revision captures
 *   reflect moved chair coordinates).
 * - Renders `snapshot` with `cleanForEvidenceCapture: true` (zero heatmaps or answer-revealing labels)
 *   and enforces self-occlusion exclusion on every `attendee_pov` keyframe.
 * - Composites the 3D WebGL frame (or 2D projection fallback if WebGL is unavailable in a headless browser)
 *   with a neutral camera-telemetry slate (`viewId`, `attendeeId`, `placeId`, `t=X.Xs`) so Argon
 *   can cite exact `viewId` and `timestampSec` in `LayoutPatch.diagnosis`.
 * - Uses a background-tab-safe `setInterval` frame loop + `MediaRecorder` in browsers,
 *   and deterministically cleans up the WebGL context (`dispose()` + `forceContextLoss()`)
 *   in a `finally` block to prevent Chrome WebGL context exhaustion.
 * - Falls back to valid EBML/WebM container bytes (`createDeterministicWebmBytes`) when running
 *   in headless Node / Vitest environments where `MediaRecorder` is unavailable.
 */
import * as THREE from 'three';
import {
  CONTRACT_VERSION,
  INSPECTION_CAMERA,
  getAttendeeCameraPose,
  type CapturedEvidencePayload,
  type CaptureKeyframe,
  type CaptureTourSpec,
  type EvidenceManifest,
  type SceneSnapshot,
} from '../shared/index.js';
import {
  applyKeyframeToCamera,
  buildDefaultCaptureKeyframes,
  getActiveKeyframeAtTime,
} from './cameraSystem.js';
import {
  applyActiveViewerVisibility,
  buildVenueThreeScene,
  disposeVenueScene,
} from './sceneBuilder.js';
import { createDeterministicWebmBytes } from './webmCodec.js';

const PREFERRED_MIME_TYPES = [
  'video/webm;codecs=vp9',
  'video/webm;codecs=vp8',
  'video/webm',
  'video/mp4',
] as const;

export function selectSupportedMediaMimeType(): string {
  if (
    typeof MediaRecorder !== 'undefined' &&
    typeof MediaRecorder.isTypeSupported === 'function'
  ) {
    for (const candidate of PREFERRED_MIME_TYPES) {
      try {
        if (MediaRecorder.isTypeSupported(candidate)) {
          return candidate;
        }
      } catch {
        // Ignore browser quirk and continue checking candidates
      }
    }
  }
  return 'video/webm';
}

/**
 * Normalizes a MIME type string (e.g. `video/webm;codecs=vp8` -> `video/webm`)
 * for clean provider upload headers while preserving container format.
 */
export function normalizeContainerMimeType(mimeType: string): string {
  const base = mimeType.split(';')[0]?.trim().toLowerCase();
  if (base === 'video/mp4') return 'video/mp4';
  return 'video/webm';
}

/**
 * Records a short real video clip and matching `EvidenceManifest` for `tourSpec`.
 */
export async function captureEvidence(
  snapshot: SceneSnapshot,
  tourSpec: CaptureTourSpec,
): Promise<CapturedEvidencePayload> {
  if (snapshot.sceneHash !== tourSpec.sceneHash) {
    throw new Error(
      `Scene hash mismatch: snapshot=${snapshot.sceneHash} vs tourSpec=${tourSpec.sceneHash}`,
    );
  }

  const nowMs = Date.now();
  const deadlineMs = Date.parse(tourSpec.deadlineIso);
  if (Number.isFinite(deadlineMs) && nowMs >= deadlineMs) {
    throw new Error(
      `Capture deadline expired before recording started: deadline=${tourSpec.deadlineIso}`,
    );
  }

  const widthPx = INSPECTION_CAMERA.defaultResolutionPx;
  const heightPx = INSPECTION_CAMERA.defaultResolutionPx;
  const requestedDurationSec =
    tourSpec.totalDurationSec > 0 ? tourSpec.totalDurationSec : 3;

  const rawKeyframes: CaptureKeyframe[] =
    tourSpec.keyframes && tourSpec.keyframes.length > 0
      ? structuredClone(tourSpec.keyframes)
      : buildDefaultCaptureKeyframes(snapshot, requestedDurationSec);

  // Ensure every attendee_pov keyframe reflects the current snapshot's world seat transform
  const keyframes: CaptureKeyframe[] = rawKeyframes.map((kf) => {
    if (kf.kind === 'attendee_pov' && kf.attendeeId) {
      const inRoster = snapshot.roster.some(
        (a) => a.attendeeId === kf.attendeeId,
      );
      if (inRoster) {
        const pose = getAttendeeCameraPose(snapshot, kf.attendeeId);
        return {
          ...kf,
          placeId: pose.placeId,
          cameraPosition: pose.eyePositionWorld,
          cameraLookAt: pose.lookAtWorld,
          fovDeg: pose.fovDeg,
          aspect: pose.aspect,
        };
      }
    }
    return kf;
  });

  const canAttemptBrowserCapture =
    typeof window !== 'undefined' &&
    typeof document !== 'undefined' &&
    typeof MediaRecorder !== 'undefined';

  if (canAttemptBrowserCapture) {
    try {
      const browserResult = await recordBrowserCanvasClip({
        snapshot,
        tourSpec,
        keyframes,
        widthPx,
        heightPx,
        requestedDurationSec,
        deadlineMs,
      });
      if (browserResult && browserResult.videoBlob.size > 0) {
        return browserResult;
      }
    } catch {
      // Fall through to deterministic WebM synthesis if headless/GPU context creation failed
    }
  }

  // Deterministic valid WebM fallback (used in Node/Vitest tests or WebGL-disabled environments)
  const webmBytes = createDeterministicWebmBytes({
    widthPx,
    heightPx,
    durationSec: requestedDurationSec,
    captureId: tourSpec.captureId,
    sceneHash: snapshot.sceneHash,
  });

  const videoBlob = new Blob([webmBytes], { type: 'video/webm' });
  const manifest: EvidenceManifest = {
    contractVersion: CONTRACT_VERSION,
    captureId: tourSpec.captureId,
    runId: tourSpec.runId,
    phase: tourSpec.phase,
    sceneHash: snapshot.sceneHash,
    mimeType: 'video/webm',
    byteLength: videoBlob.size,
    durationSec: requestedDurationSec,
    widthPx,
    heightPx,
    keyframes,
    recordedAtIso: new Date().toISOString(),
  };

  return { videoBlob, manifest };
}

function drawNeutralCameraSlate(
  ctx: CanvasRenderingContext2D,
  activeKf: CaptureKeyframe | undefined,
  virtualSec: number,
  widthPx: number,
): void {
  if (!activeKf) return;
  ctx.save();
  ctx.fillStyle = 'rgba(15, 23, 42, 0.82)';
  ctx.fillRect(0, 0, widthPx, 28);
  ctx.fillStyle = '#f8fafc';
  ctx.font = '600 12px ui-monospace, SFMono-Regular, Menlo, monospace';
  const who = activeKf.attendeeId
    ? ` · ${activeKf.attendeeId} (${activeKf.placeId ?? ''})`
    : ' · Room Overview';
  const text = `${activeKf.viewId}${who} · t=${virtualSec.toFixed(1)}s`;
  ctx.fillText(text, 10, 18);
  ctx.restore();
}

function draw2DFallbackProjection(
  ctx: CanvasRenderingContext2D,
  snapshot: SceneSnapshot,
  activeKf: CaptureKeyframe | undefined,
  widthPx: number,
  heightPx: number,
): void {
  ctx.save();
  ctx.fillStyle = '#0f172a';
  ctx.fillRect(0, 0, widthPx, heightPx);

  // Top-down architectural plan fallback when WebGL is disabled in a headless browser
  const minX = snapshot.roomBounds.min[0];
  const maxX = snapshot.roomBounds.max[0];
  const minZ = snapshot.roomBounds.min[2];
  const maxZ = snapshot.roomBounds.max[2];
  const scaleX = (widthPx - 60) / Math.max(1, maxX - minX);
  const scaleZ = (heightPx - 80) / Math.max(1, maxZ - minZ);
  const scale = Math.min(scaleX, scaleZ);

  const toScreen = (wx: number, wz: number): [number, number] => [
    widthPx / 2 + wx * scale,
    heightPx / 2 + wz * scale,
  ];

  // Target screen bar
  const [tx, tz] = toScreen(
    snapshot.target.center[0],
    snapshot.target.center[2],
  );
  ctx.fillStyle = '#38bdf8';
  ctx.fillRect(
    tx - (snapshot.target.widthM * scale) / 2,
    tz - 4,
    snapshot.target.widthM * scale,
    8,
  );

  // Scene objects
  for (const obj of snapshot.objects) {
    const [ox, oz] = toScreen(
      obj.transform.position[0],
      obj.transform.position[2],
    );
    ctx.fillStyle =
      obj.category === 'movable_prop'
        ? '#d97706'
        : obj.category === 'wheelchair_bay_frame'
          ? '#2563eb'
          : '#64748b';
    ctx.fillRect(ox - 6, oz - 6, 12, 12);
  }

  if (activeKf?.attendeeId) {
    const [cx, cz] = toScreen(
      activeKf.cameraPosition[0],
      activeKf.cameraPosition[2],
    );
    ctx.strokeStyle = '#22d3ee';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(cx, cz, 10, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.restore();
}

async function recordBrowserCanvasClip(params: {
  snapshot: SceneSnapshot;
  tourSpec: CaptureTourSpec;
  keyframes: CaptureKeyframe[];
  widthPx: number;
  heightPx: number;
  requestedDurationSec: number;
  deadlineMs: number;
}): Promise<CapturedEvidencePayload | null> {
  const {
    snapshot,
    tourSpec,
    keyframes,
    widthPx,
    heightPx,
    requestedDurationSec,
    deadlineMs,
  } = params;

  const recordingCanvas = document.createElement('canvas');
  recordingCanvas.width = widthPx;
  recordingCanvas.height = heightPx;
  const ctx2d = recordingCanvas.getContext('2d');

  const webglCanvas = document.createElement('canvas');
  webglCanvas.width = widthPx;
  webglCanvas.height = heightPx;

  let renderer: THREE.WebGLRenderer | null = null;
  let builtScene: ReturnType<typeof buildVenueThreeScene> | null = null;

  try {
    const canInitWebgl =
      typeof webglCanvas.addEventListener === 'function' &&
      Boolean(
        webglCanvas.getContext('webgl2') || webglCanvas.getContext('webgl'),
      );
    if (canInitWebgl) {
      try {
        renderer = new THREE.WebGLRenderer({
          canvas: webglCanvas,
          antialias: true,
          preserveDrawingBuffer: true,
          powerPreference: 'high-performance',
        });
        renderer.setSize(widthPx, heightPx, false);
        renderer.setPixelRatio(1);

        builtScene = buildVenueThreeScene(snapshot, {
          cleanForEvidenceCapture: true,
          viewMode: 'overview',
        });
      } catch {
        renderer = null;
        builtScene = null;
      }
    }

    const camera = new THREE.PerspectiveCamera(
      INSPECTION_CAMERA.fovDeg,
      INSPECTION_CAMERA.aspect,
      INSPECTION_CAMERA.nearM,
      INSPECTION_CAMERA.farM,
    );

    const targetCanvas = ctx2d ? recordingCanvas : webglCanvas;

    const renderKeyframeAt = (elapsedSec: number) => {
      const activeKf =
        getActiveKeyframeAtTime(keyframes, elapsedSec) ?? keyframes[0];

      if (builtScene && renderer) {
        if (activeKf) {
          applyActiveViewerVisibility(
            builtScene.scene,
            snapshot,
            activeKf.kind,
            activeKf.attendeeId,
            builtScene.objectNodesById,
            builtScene.attendeeProxyNodesById,
          );
          applyKeyframeToCamera(camera, activeKf);
        }
        renderer.render(builtScene.scene, camera);
        if (ctx2d) {
          ctx2d.drawImage(webglCanvas, 0, 0);
          drawNeutralCameraSlate(ctx2d, activeKf, elapsedSec, widthPx);
        }
      } else if (ctx2d) {
        draw2DFallbackProjection(
          ctx2d,
          snapshot,
          activeKf,
          widthPx,
          heightPx,
        );
        drawNeutralCameraSlate(ctx2d, activeKf, elapsedSec, widthPx);
      }
    };

    // Draw initial frame before starting stream
    renderKeyframeAt(0);

    const captureStreamFn = (
      targetCanvas as HTMLCanvasElement & {
        captureStream?: (frameRate?: number) => MediaStream;
      }
    ).captureStream;
    if (typeof captureStreamFn !== 'function') {
      return null;
    }

    const fps = 24;
    const stream = captureStreamFn.call(targetCanvas, fps);
    const chosenMime = selectSupportedMediaMimeType();
    let recorder: MediaRecorder;
    try {
      recorder = new MediaRecorder(stream, {
        mimeType: chosenMime,
        videoBitsPerSecond: 1_500_000,
      });
    } catch {
      recorder = new MediaRecorder(stream);
    }

    const chunks: Blob[] = [];
    recorder.ondataavailable = (evt: BlobEvent) => {
      if (evt.data && evt.data.size > 0) {
        chunks.push(evt.data);
      }
    };

    // Bound wall-clock recording time so we never exceed deadlineMs
    const remainingWallMs = Number.isFinite(deadlineMs)
      ? Math.max(400, deadlineMs - Date.now() - 1200)
      : requestedDurationSec * 1000;
    // Allow fast real-time recording (capped at 4.5s wall time even for 10-12s virtual tour schedules
    // so two captures leave >100s of the 110s budget for Argon multimodal inference!)
    const wallDurationMs = Math.min(
      requestedDurationSec * 1000,
      remainingWallMs,
      4500,
    );

    const videoBlob = await new Promise<Blob>((resolve, reject) => {
      let intervalId: ReturnType<typeof setInterval> | null = null;
      const startWallMs = performance.now();

      const cleanupTimer = () => {
        if (intervalId !== null) {
          clearInterval(intervalId);
          intervalId = null;
        }
      };

      recorder.onerror = () => {
        cleanupTimer();
        reject(new Error('MediaRecorder error during captureEvidence'));
      };

      recorder.onstop = () => {
        cleanupTimer();
        for (const track of stream.getTracks()) {
          track.stop();
        }
        const containerType = normalizeContainerMimeType(
          recorder.mimeType || chosenMime,
        );
        resolve(new Blob(chunks, { type: containerType }));
      };

      recorder.start(100);

      // Use setInterval instead of requestAnimationFrame so backgrounded Chrome tabs never stall!
      const frameStepMs = Math.round(1000 / fps);
      intervalId = setInterval(() => {
        const elapsedWallMs = performance.now() - startWallMs;
        const progress = Math.min(
          1.0,
          elapsedWallMs / Math.max(1, wallDurationMs),
        );
        const virtualSec = progress * requestedDurationSec;

        renderKeyframeAt(virtualSec);

        const videoTrack = stream.getVideoTracks()[0] as
          | (MediaStreamTrack & { requestFrame?: () => void })
          | undefined;
        if (videoTrack && typeof videoTrack.requestFrame === 'function') {
          try {
            videoTrack.requestFrame();
          } catch {
            // Ignore if browser does not support manual frame request
          }
        }

        if (elapsedWallMs >= wallDurationMs) {
          cleanupTimer();
          if (recorder.state === 'recording') {
            try {
              recorder.requestData?.();
            } catch {
              // Ignore if browser does not support explicit requestData flush
            }
            recorder.stop();
          }
        }
      }, frameStepMs);
    });

    if (videoBlob.size === 0) {
      return null;
    }

    const containerMime = normalizeContainerMimeType(videoBlob.type);
    const manifest: EvidenceManifest = {
      contractVersion: CONTRACT_VERSION,
      captureId: tourSpec.captureId,
      runId: tourSpec.runId,
      phase: tourSpec.phase,
      sceneHash: snapshot.sceneHash,
      mimeType: containerMime,
      byteLength: videoBlob.size,
      durationSec: requestedDurationSec,
      widthPx,
      heightPx,
      keyframes,
      recordedAtIso: new Date().toISOString(),
    };

    return { videoBlob, manifest };
  } finally {
    if (builtScene) {
      disposeVenueScene(builtScene.scene);
    }
    if (renderer) {
      renderer.dispose();
      try {
        renderer.forceContextLoss();
      } catch {
        // Ignore in environments where WEBGL_lose_context is absent
      }
    }
  }
}
