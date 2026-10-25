/**
 * Stream D — UI Components Barrel (`src/ui/index.ts`)
 * Exclusive ownership: Workstream D (`src/ui/`, `src/App.tsx`, `src/main.tsx`, `src/shared/`).
 */
export interface UIStreamState {
  selectedAttendeeId: string | null;
  activeRunId: string | null;
}

export * from './localEvaluatorFallback.js';
export * from './evidenceCaptureBridge.js';
export * from './apiClient.js';
export * from './VenueViewportStage.js';
export * from './ProfileEditorModal.js';
export * from './RosterPanel.js';
export * from './RunProgressBanner.js';
export * from './ComparisonPanel.js';
