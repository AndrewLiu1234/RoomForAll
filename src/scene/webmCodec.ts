/**
 * Stream A — Deterministic WebM Container Synthesis (`src/scene/webmCodec.ts`)
 * Exclusive ownership: Workstream A.
 *
 * Used for:
 * 1. Generating `public/venue/dev-fixture-smoke.webm` and `public/venue/prepared-venue-smoke.webm`
 *    during `npm run prepare:venue` so Stream C can test real multipart video upload immediately.
 * 2. Providing a valid, non-empty `video/webm` EBML container fallback when `captureEvidence`
 *    is invoked inside a headless Node / Vitest test environment where `MediaRecorder` is absent.
 *
 * In an interactive browser environment, `captureEvidence` uses the real HTMLCanvasElement
 * `captureStream()` + `MediaRecorder` pipeline first.
 */

/**
 * Generates a syntactically valid EBML / WebM (`video/webm`, VP8 track header + SimpleBlock frames)
 * binary payload whose byte stream includes deterministic scene/capture metadata in its Segment Info
 * Title element (`0x7BA9`), guaranteeing non-empty, reproducible media bytes.
 */
export function createDeterministicWebmBytes(options: {
  widthPx: number;
  heightPx: number;
  durationSec: number;
  captureId: string;
  sceneHash: string;
}): Uint8Array<ArrayBuffer> {
  const width = Math.max(16, Math.min(4096, Math.round(options.widthPx)));
  const height = Math.max(16, Math.min(4096, Math.round(options.heightPx)));
  const durationMs = Math.max(100, Math.round(options.durationSec * 1000));

  const encoder = new TextEncoder();
  const titleBytes = encoder.encode(
    `VenuePilot:${options.captureId}:${options.sceneHash}:${width}x${height}:${durationMs}ms`,
  );

  // EBML Header (DocType = "webm")
  // prettier-ignore
  const ebmlHeader = [
    0x1a, 0x45, 0xdf, 0xa3, // EBML ID
    0x9f,                   // Size = 31 bytes
    0x42, 0x86, 0x81, 0x01, // EBMLVersion = 1
    0x42, 0xf7, 0x81, 0x01, // EBMLReadVersion = 1
    0x42, 0xf2, 0x81, 0x04, // EBMLMaxIDLength = 4
    0x42, 0xf3, 0x81, 0x08, // EBMLMaxSizeLength = 8
    0x42, 0x82, 0x84, 0x77, 0x65, 0x62, 0x6d, // DocType = "webm"
    0x42, 0x87, 0x81, 0x04, // DocTypeVersion = 4
    0x42, 0x85, 0x81, 0x02, // DocTypeReadVersion = 2
  ];

  // Minimal valid VP8 keyframe payload (uncompressed 3-byte frame tag + start code 0x9d 0x01 0x2a + dimensions)
  const vp8KeyFrame = [
    0x10, 0x02, 0x00, // Keyframe 3-byte tag
    0x9d, 0x01, 0x2a, // VP8 start code
    width & 0xff,
    (width >> 8) & 0x3f,
    height & 0xff,
    (height >> 8) & 0x3f,
    0x00, 0x00, 0x00, 0x00,
  ];

  // Build N SimpleBlocks spaced across durationMs (10 fps nominal) so file size scales with duration
  const frameCount = Math.max(3, Math.min(60, Math.round(options.durationSec * 8)));
  const clusterBlocks: number[] = [];
  for (let i = 0; i < frameCount; i++) {
    const timecode = Math.min(32767, Math.round((i * durationMs) / frameCount));
    const blockPayloadLen = 4 + vp8KeyFrame.length;
    clusterBlocks.push(
      0xa3, // SimpleBlock ID
      0x80 | blockPayloadLen, // VINT length
      0x81, // TrackNumber = 1
      (timecode >> 8) & 0xff,
      timecode & 0xff,
      0x80, // Keyframe flag
      ...vp8KeyFrame,
    );
  }

  // Segment header (unknown/streaming size 0x01ffffffffffffff)
  // prettier-ignore
  const segmentHeader = [
    0x18, 0x53, 0x80, 0x67,
    0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
  ];

  // Segment Info (TimecodeScale = 1,000,000 ns = 1ms, MuxingApp = "VenuePilot", Title)
  const muxApp = Array.from(encoder.encode('VenuePilot-StreamA'));
  const titleLen = Math.min(120, titleBytes.length);
  const titleSlice = Array.from(titleBytes.slice(0, titleLen));
  const infoPayload = [
    0x2a, 0xd7, 0xb1, 0x83, 0x0f, 0x42, 0x40, // TimecodeScale = 1000000
    0x4d, 0x80, 0x80 | muxApp.length, ...muxApp, // MuxingApp
    0x57, 0x41, 0x80 | muxApp.length, ...muxApp, // WritingApp
    0x7b, 0xa9, 0x80 | titleSlice.length, ...titleSlice, // Title
  ];
  const segmentInfo = [
    0x15, 0x49, 0xa9, 0x66,
    0x80 | infoPayload.length,
    ...infoPayload,
  ];

  // Tracks (Track 1 = V_VP8 video track with PixelWidth and PixelHeight)
  const codecId = Array.from(encoder.encode('V_VP8'));
  const videoSettings = [
    0xb0, 0x82, (width >> 8) & 0xff, width & 0xff, // PixelWidth
    0xba, 0x82, (height >> 8) & 0xff, height & 0xff, // PixelHeight
  ];
  const trackEntryPayload = [
    0xd7, 0x81, 0x01, // TrackNumber = 1
    0x73, 0xc5, 0x81, 0x01, // TrackUID = 1
    0x83, 0x81, 0x01, // TrackType = 1 (video)
    0x86, 0x80 | codecId.length, ...codecId, // CodecID = "V_VP8"
    0xe0, 0x80 | videoSettings.length, ...videoSettings, // Video element
  ];
  const tracksPayload = [
    0xae, 0x80 | trackEntryPayload.length,
    ...trackEntryPayload,
  ];
  const tracksElement = [
    0x16, 0x54, 0xae, 0x6b,
    0x80 | tracksPayload.length,
    ...tracksPayload,
  ];

  // Cluster starting at Timecode 0
  const clusterTimecode = [0xe7, 0x81, 0x00];
  const clusterBody = [...clusterTimecode, ...clusterBlocks];
  const clusterSizeHigh = (clusterBody.length >> 8) & 0x3f;
  const clusterSizeLow = clusterBody.length & 0xff;
  const clusterElement = [
    0x1f, 0x43, 0xb6, 0x75,
    0x40 | clusterSizeHigh,
    clusterSizeLow,
    ...clusterBody,
  ];

  const allBytes = [
    ...ebmlHeader,
    ...segmentHeader,
    ...segmentInfo,
    ...tracksElement,
    ...clusterElement,
  ];
  const out = new Uint8Array(new ArrayBuffer(allBytes.length));
  out.set(allBytes, 0);
  return out;
}
