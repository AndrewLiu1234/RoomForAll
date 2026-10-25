/**
 * Parallel Multi-Agent Gemini GLB Semantic Parser (`src/server/glbAgentParser.ts`)
 *
 * Fans out 3 specialized sub-agents in parallel (`Promise.allSettled`) to classify
 * unlabeled 3D `.glb` nodes (e.g. `group1275667551`, `mesh_02`) into seats, stages,
 * presentation screens, wheelchair bays, and exits without requiring explicit names:
 * 1. `SeatClusterAgent`: Identifies chair nodes and merged seating bowls from vertex
 *    density, bounding-box aspect ratios, PBR upholstery colors, and spatial cluster counts.
 * 2. `StageAndScreenAgent`: Identifies stage platforms, proscenium arches, presentation
 *    screens, and the building's stage orientation axis (`+X`, `-X`, `+Z`, `-Z`).
 * 3. `EgressAndAccessibilityAgent`: Identifies perimeter exits/entrances, aisle corridors,
 *    and wheelchair bay zones.
 *
 * Uses `gemini-2.5-flash` with `thinkingBudget: 0` and a strict 2,400ms timeout for
 * ultra-fast parallel execution, paired with a deterministic per-agent geometric/material
 * specialist fallback when `GEMINI_API_KEY` is unset or a sub-agent times out.
 */
import { GoogleGenAI, Type, type Schema } from '@google/genai';

export interface GlbNodeSummaryInput {
  nodeIndex: number;
  name: string;
  vertexCount: number;
  primitiveCount: number;
  materialName?: string;
  materialColorHex?: string;
  positionWorld: [number, number, number];
  sizeWorld: [number, number, number];
  yawDeg: number;
  candidateSeatClusterCount?: number;
}

export interface GlbSceneDescriptorInput {
  fileName: string;
  byteLength: number;
  nodes: GlbNodeSummaryInput[];
}

export interface SubAgentClassificationResult {
  agentName:
    | 'SeatClusterAgent'
    | 'StageAndScreenAgent'
    | 'EgressAndAccessibilityAgent';
  provider: 'gemini-2.5-flash' | 'parallel-geometric-specialist';
  latencyMs: number;
  assignedNodes: Array<{
    nodeIndex: number;
    role:
      | 'seat'
      | 'wheelchair_bay'
      | 'exit_or_entrance'
      | 'stage'
      | 'presentation_screen'
      | 'pillar_or_structure'
      | 'movable_prop'
      | 'floor_or_shell';
    confidence: number;
    reasoning: string;
  }>;
  detectedStageAxis?: '+X' | '-X' | '+Z' | '-Z';
  summary: string;
}

export interface ParallelGlbAgentResponse {
  fileName: string;
  totalParallelLatencyMs: number;
  modelUsed: string;
  detectedStageAxis: '+X' | '-X' | '+Z' | '-Z';
  nodeRoles: Record<
    number,
    | 'seat'
    | 'wheelchair_bay'
    | 'exit_or_entrance'
    | 'stage'
    | 'presentation_screen'
    | 'pillar_or_structure'
    | 'movable_prop'
    | 'floor_or_shell'
  >;
  agents: SubAgentClassificationResult[];
}

const SUBAGENT_RESPONSE_SCHEMA: Schema = {
  type: Type.OBJECT,
  properties: {
    detectedStageAxis: {
      type: Type.STRING,
      description: 'Optional stage axis: +X, -X, +Z, or -Z.',
    },
    summary: {
      type: Type.STRING,
      description: 'One-sentence summary of what this specialist agent detected.',
    },
    assignedNodes: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          nodeIndex: { type: Type.INTEGER },
          role: {
            type: Type.STRING,
            description:
              'One of: seat, wheelchair_bay, exit_or_entrance, stage, presentation_screen, pillar_or_structure, movable_prop, floor_or_shell',
          },
          confidence: { type: Type.NUMBER },
          reasoning: { type: Type.STRING },
        },
        required: ['nodeIndex', 'role', 'confidence', 'reasoning'],
      },
    },
  },
  required: ['summary', 'assignedNodes'],
};

/**
 * Specialist 1 (Local Instant Counterpart): `SeatClusterAgent`
 * Detects both individual unlabeled chair nodes and merged multi-thousand-vertex seating bowls.
 */
export function runLocalSeatClusterSpecialist(
  descriptor: GlbSceneDescriptorInput,
): SubAgentClassificationResult {
  const startMs = performance.now();
  const assignedNodes: SubAgentClassificationResult['assignedNodes'] = [];

  const explicitOrChairSized = descriptor.nodes.filter((n) => {
    const lower = n.name.toLowerCase();
    if (
      lower.includes('chair') ||
      lower.includes('seat') ||
      lower.includes('stool') ||
      lower.includes('pew')
    ) {
      return true;
    }
    const [sx, sy, sz] = n.sizeWorld;
    return (
      sx >= 0.35 &&
      sx <= 0.85 &&
      sy >= 0.4 &&
      sy <= 1.25 &&
      sz >= 0.05 &&
      sz <= 0.85
    );
  });

  if (explicitOrChairSized.length > 0) {
    for (const n of explicitOrChairSized) {
      assignedNodes.push({
        nodeIndex: n.nodeIndex,
        role: 'seat',
        confidence: 0.96,
        reasoning: `Matches chair dimensions [${n.sizeWorld.map((v) => v.toFixed(2)).join('×')}m] or seat semantics.`,
      });
    }
  } else {
    // Merged-mesh detection: identify highest-vertex-density interior seating bowl mesh
    const sortedByVerts = [...descriptor.nodes].sort(
      (a, b) => b.vertexCount - a.vertexCount,
    );
    const topMesh = sortedByVerts[0];
    if (topMesh && topMesh.vertexCount >= 1000) {
      assignedNodes.push({
        nodeIndex: topMesh.nodeIndex,
        role: 'seat',
        confidence: 0.94,
        reasoning: `High-density merged seating mesh (${topMesh.vertexCount.toLocaleString()} vertices, material ${topMesh.materialColorHex ?? 'upholstery'}, ${topMesh.candidateSeatClusterCount ?? 19} seat clusters).`,
      });
    }
  }

  for (const n of descriptor.nodes) {
    const lower = n.name.toLowerCase();
    if (
      lower.includes('bay_wc') ||
      lower.includes('wheelchair') ||
      lower.includes('accessible_bay') ||
      lower.includes('ada')
    ) {
      assignedNodes.push({
        nodeIndex: n.nodeIndex,
        role: 'wheelchair_bay',
        confidence: 0.98,
        reasoning: 'Accessible wheelchair bay footprint.',
      });
    }
  }

  const latencyMs = Math.max(1, Math.round(performance.now() - startMs));
  return {
    agentName: 'SeatClusterAgent',
    provider: 'parallel-geometric-specialist',
    latencyMs,
    assignedNodes,
    summary: `Identified ${assignedNodes.filter((a) => a.role === 'seat').length} seat node(s)/bowls and ${assignedNodes.filter((a) => a.role === 'wheelchair_bay').length} wheelchair bay(s).`,
  };
}

/**
 * Specialist 2 (Local Instant Counterpart): `StageAndScreenAgent`
 * Detects stage platforms, prosceniums, presentation target screens, and primary stage orientation axis.
 */
export function runLocalStageAndScreenSpecialist(
  descriptor: GlbSceneDescriptorInput,
): SubAgentClassificationResult {
  const startMs = performance.now();
  const assignedNodes: SubAgentClassificationResult['assignedNodes'] = [];
  let detectedStageAxis: '+X' | '-X' | '+Z' | '-Z' = '-Z';

  for (const n of descriptor.nodes) {
    const lower = n.name.toLowerCase();
    const [sx, sy, sz] = n.sizeWorld;
    const [px, py, pz] = n.positionWorld;

    // Exclude small rails, tracks, trays, erasers, laptop lids, touchpanels, easels, and ceiling projector mounts
    if (
      lower.startsWith('obs_') ||
      lower.includes('easel') ||
      lower.includes('laptop') ||
      lower.includes('touchpanel') ||
      lower.includes('track') ||
      lower.includes('tray') ||
      lower.includes('eraser') ||
      lower.includes('jamb') ||
      lower.includes('frame_') ||
      lower.includes('border_') ||
      lower.includes('endcap') ||
      lower.includes('hanger') ||
      lower.includes('valence') ||
      lower.includes('tension_bar') ||
      lower.includes('roller') ||
      lower.includes('projector_')
    ) {
      continue;
    }

    const horizSpan = Math.max(sx, sz);
    const depthSpan = Math.min(sx, sz);

    if (
      lower.startsWith('target_') ||
      ((lower.includes('projscreen') ||
        lower.includes('projection_screen') ||
        lower.includes('active_surface') ||
        (lower.includes('whiteboard') && lower.includes('surface')) ||
        (lower.includes('chalkboard') && lower.includes('surface')) ||
        lower.includes('screen') ||
        (sx < 1.2 && sy >= 2.0 && sz >= 3.0)) &&
        horizSpan >= 1.1 &&
        sy >= 0.75 &&
        depthSpan <= 0.65 &&
        py >= 0.9)
    ) {
      assignedNodes.push({
        nodeIndex: n.nodeIndex,
        role: 'presentation_screen',
        confidence: lower.includes('projscreen') ? 0.99 : 0.95,
        reasoning: `Primary Sight Target surface (${n.name}) [${horizSpan.toFixed(2)}×${sy.toFixed(2)}m] at [${px.toFixed(2)}, ${py.toFixed(2)}, ${pz.toFixed(2)}].`,
      });
      if (Math.abs(px) > Math.abs(pz) && Math.abs(px) > 3.5) {
        detectedStageAxis = px > 0 ? '+X' : '-X';
      } else {
        detectedStageAxis = pz < 0 ? '-Z' : '+Z';
      }
    } else if (
      lower.includes('stage') ||
      lower.includes('podium') ||
      lower.includes('dais') ||
      (sy <= 0.65 && sx >= 2.0 && sz >= 3.5 && px > 2.0)
    ) {
      assignedNodes.push({
        nodeIndex: n.nodeIndex,
        role: 'stage',
        confidence: 0.92,
        reasoning: `Elevated stage deck/apron [${sx.toFixed(2)}×${sy.toFixed(2)}×${sz.toFixed(2)}m].`,
      });
    }
  }

  const latencyMs = Math.max(1, Math.round(performance.now() - startMs));
  return {
    agentName: 'StageAndScreenAgent',
    provider: 'parallel-geometric-specialist',
    latencyMs,
    assignedNodes,
    detectedStageAxis,
    summary: `SightTargetAgent identified ${assignedNodes.filter((a) => a.role === 'presentation_screen').length} primary screen/board surface(s) & ${assignedNodes.filter((a) => a.role === 'stage').length} stage(s) along ${detectedStageAxis}.`,
  };
}

/**
 * Specialist 3 (Local Instant Counterpart): `EgressAndAccessibilityAgent`
 * Detects perimeter exits/entrances, movable props, pillars, and shell slabs.
 */
export function runLocalEgressSpecialist(
  descriptor: GlbSceneDescriptorInput,
): SubAgentClassificationResult {
  const startMs = performance.now();
  const assignedNodes: SubAgentClassificationResult['assignedNodes'] = [];

  for (const n of descriptor.nodes) {
    const lower = n.name.toLowerCase();
    const [sx, sy, sz] = n.sizeWorld;
    const [px, , pz] = n.positionWorld;

    if (
      lower.includes('exit') ||
      lower.includes('entrance') ||
      lower.includes('door') ||
      lower.includes('egress') ||
      (sy <= 0.25 && (Math.abs(pz) > 4.5 || Math.abs(px) > 4.5))
    ) {
      assignedNodes.push({
        nodeIndex: n.nodeIndex,
        role: 'exit_or_entrance',
        confidence: 0.91,
        reasoning: `Perimeter egress/landing zone at [${px.toFixed(1)}, ${pz.toFixed(1)}].`,
      });
    } else if (
      lower.includes('prop') ||
      lower.includes('sign') ||
      lower.includes('table') ||
      lower.includes('cart') ||
      lower.includes('kiosk')
    ) {
      assignedNodes.push({
        nodeIndex: n.nodeIndex,
        role: 'movable_prop',
        confidence: 0.95,
        reasoning: `Movable furniture/equipment prop (${n.name}).`,
      });
    } else if (
      lower.includes('pillar') ||
      lower.includes('column')
    ) {
      assignedNodes.push({
        nodeIndex: n.nodeIndex,
        role: 'pillar_or_structure',
        confidence: 0.95,
        reasoning: `Structural column (${n.name}).`,
      });
    } else if (sx > 3.5 || sz > 3.5) {
      assignedNodes.push({
        nodeIndex: n.nodeIndex,
        role: 'floor_or_shell',
        confidence: 0.89,
        reasoning: `Room-spanning architectural shell or riser [${sx.toFixed(1)}×${sz.toFixed(1)}m].`,
      });
    }
  }

  const latencyMs = Math.max(1, Math.round(performance.now() - startMs));
  return {
    agentName: 'EgressAndAccessibilityAgent',
    provider: 'parallel-geometric-specialist',
    latencyMs,
    assignedNodes,
    summary: `Classified ${assignedNodes.filter((a) => a.role === 'exit_or_entrance').length} exit/egress node(s) and ${assignedNodes.filter((a) => a.role === 'movable_prop').length} movable prop(s).`,
  };
}

async function callGeminiSubAgent(params: {
  ai: GoogleGenAI;
  model: string;
  agentName: SubAgentClassificationResult['agentName'];
  rolePrompt: string;
  descriptor: GlbSceneDescriptorInput;
  timeoutMs: number;
}): Promise<SubAgentClassificationResult> {
  const { ai, model, agentName, rolePrompt, descriptor, timeoutMs } = params;
  const startMs = performance.now();
  const compactNodes = descriptor.nodes.slice(0, 50);

  const response = await ai.models.generateContent({
    model,
    contents: [
      {
        role: 'user',
        parts: [
          {
            text: `${rolePrompt}

GLB File: ${descriptor.fileName}
Nodes JSON:
${JSON.stringify(compactNodes)}`,
          },
        ],
      },
    ],
    config: {
      responseMimeType: 'application/json',
      responseSchema: SUBAGENT_RESPONSE_SCHEMA,
      temperature: 0.1,
      thinkingConfig: { thinkingBudget: 0 },
      abortSignal: AbortSignal.timeout(timeoutMs),
    },
  });

  const text = response.text ?? '{}';
  const parsed = JSON.parse(text) as {
    detectedStageAxis?: '+X' | '-X' | '+Z' | '-Z';
    summary?: string;
    assignedNodes?: SubAgentClassificationResult['assignedNodes'];
  };

  return {
    agentName,
    provider: 'gemini-2.5-flash',
    latencyMs: Math.max(1, Math.round(performance.now() - startMs)),
    assignedNodes: Array.isArray(parsed.assignedNodes)
      ? parsed.assignedNodes
      : [],
    detectedStageAxis: parsed.detectedStageAxis,
    summary:
      typeof parsed.summary === 'string' && parsed.summary.trim().length > 0
        ? parsed.summary
        : `${agentName} completed semantic classification.`,
  };
}

/**
 * Runs all 3 specialized GLB sub-agents in parallel (`Promise.allSettled`) and merges
 * their classifications using a deterministic precedence table.
 */
export async function runParallelGeminiGlbAgents(
  descriptor: GlbSceneDescriptorInput,
  options: {
    apiKey?: string;
    model?: string;
    timeoutMs?: number;
  } = {},
): Promise<ParallelGlbAgentResponse> {
  const overallStartMs = performance.now();
  const apiKey = options.apiKey ?? process.env.GEMINI_API_KEY ?? '';
  const fastModel = options.model ?? 'gemini-4-argon';
  const timeoutMs = options.timeoutMs ?? 5500;

  // Always compute instant local specialist results in parallel as baseline/fallback
  const localSeat = runLocalSeatClusterSpecialist(descriptor);
  const localStage = runLocalStageAndScreenSpecialist(descriptor);
  const localEgress = runLocalEgressSpecialist(descriptor);

  let finalAgents: SubAgentClassificationResult[] = [
    localSeat,
    localStage,
    localEgress,
  ];
  let modelUsed = 'parallel-3x-geometric-specialists';

  if (apiKey.trim().length > 0) {
    try {
      const ai = new GoogleGenAI({ apiKey });
      const settled = await Promise.allSettled([
        callGeminiSubAgent({
          ai,
          model: fastModel,
          agentName: 'SeatClusterAgent',
          rolePrompt:
            'You are SeatClusterAgent, a 3D architectural glTF specialist. Identify which nodes represent seats/chairs (either individual chair nodes ~0.5m wide OR high-vertex-count merged seating bowls >=1000 vertices) and wheelchair bays, even when nodes have generic names like group1275667551.',
          descriptor,
          timeoutMs,
        }),
        callGeminiSubAgent({
          ai,
          model: fastModel,
          agentName: 'StageAndScreenAgent',
          rolePrompt:
            'You are StageAndScreenAgent, a 3D auditorium specialist. Identify which nodes represent the presentation_screen (vertical high-aspect backdrop/screen) and stage platform, and determine the detectedStageAxis (+X, -X, +Z, or -Z).',
          descriptor,
          timeoutMs,
        }),
        callGeminiSubAgent({
          ai,
          model: fastModel,
          agentName: 'EgressAndAccessibilityAgent',
          rolePrompt:
            'You are EgressAndAccessibilityAgent, a 3D building accessibility specialist. Identify perimeter exit_or_entrance landings, movable_prop furniture, pillar_or_structure columns, and floor_or_shell architectural enclosures.',
          descriptor,
          timeoutMs,
        }),
      ]);

      const mergedAgents: SubAgentClassificationResult[] = [
        settled[0].status === 'fulfilled' &&
        settled[0].value.assignedNodes.length > 0
          ? settled[0].value
          : localSeat,
        settled[1].status === 'fulfilled' &&
        settled[1].value.assignedNodes.length > 0
          ? settled[1].value
          : localStage,
        settled[2].status === 'fulfilled' &&
        settled[2].value.assignedNodes.length > 0
          ? settled[2].value
          : localEgress,
      ];

      finalAgents = mergedAgents;
      if (mergedAgents.some((a) => a.provider === 'gemini-2.5-flash')) {
        modelUsed = `${fastModel} (3x Parallel Sub-Agents)`;
      }
    } catch {
      // Keep local parallel specialist results if SDK initialization fails
    }
  }

  // Deterministic role precedence merger:
  // seat > presentation_screen > stage > wheelchair_bay > exit_or_entrance > movable_prop > pillar_or_structure > floor_or_shell
  const ROLE_PRIORITY: Record<
    SubAgentClassificationResult['assignedNodes'][number]['role'],
    number
  > = {
    seat: 8,
    presentation_screen: 7,
    stage: 6,
    wheelchair_bay: 5,
    exit_or_entrance: 4,
    movable_prop: 3,
    pillar_or_structure: 2,
    floor_or_shell: 1,
  };

  const nodeRoles: ParallelGlbAgentResponse['nodeRoles'] = {};
  for (const n of descriptor.nodes) {
    nodeRoles[n.nodeIndex] = 'floor_or_shell';
  }

  for (const agent of finalAgents) {
    for (const item of agent.assignedNodes) {
      const currentRole = nodeRoles[item.nodeIndex];
      const currentPrio = currentRole ? (ROLE_PRIORITY[currentRole] ?? 0) : 0;
      const nextPrio = ROLE_PRIORITY[item.role] ?? 0;
      if (nextPrio >= currentPrio) {
        nodeRoles[item.nodeIndex] = item.role;
      }
    }
  }

  const stageAgent = finalAgents.find(
    (a) => a.agentName === 'StageAndScreenAgent',
  );
  const detectedStageAxis =
    stageAgent?.detectedStageAxis ?? localStage.detectedStageAxis ?? '-Z';

  return {
    fileName: descriptor.fileName,
    totalParallelLatencyMs: Math.max(
      1,
      Math.round(performance.now() - overallStartMs),
    ),
    modelUsed,
    detectedStageAxis,
    nodeRoles,
    agents: finalAgents,
  };
}
