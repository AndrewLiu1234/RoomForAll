import React, { useMemo, useState } from 'react';
import { createDevFixtureSnapshot } from './shared/index.js';
import { evaluateScene } from './evaluation/index.js';

export function App(): React.ReactElement {
  const snapshot = useMemo(() => createDevFixtureSnapshot(), []);
  const evaluation = useMemo(() => evaluateScene(snapshot), [snapshot]);
  const [selectedAttendeeId, setSelectedAttendeeId] = useState<string>(
    snapshot.roster[0]?.attendeeId ?? '',
  );

  const selectedAttendee = snapshot.roster.find(
    (a) => a.attendeeId === selectedAttendeeId,
  );
  const selectedEval = selectedAttendeeId
    ? evaluation.attendees[selectedAttendeeId]
    : undefined;

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '340px 1fr', minHeight: '100vh' }}>
      <aside
        style={{
          padding: '20px',
          borderRight: '1px solid #262936',
          background: '#151821',
        }}
      >
        <h1 style={{ fontSize: '1.25rem', margin: '0 0 6px 0' }}>VenuePilot</h1>
        <p style={{ fontSize: '0.82rem', color: '#9ca3af', margin: '0 0 16px 0' }}>
          Scene: <code>{snapshot.sceneId}</code> ({snapshot.sceneHash})
        </p>

        <h2 style={{ fontSize: '0.95rem', margin: '0 0 8px 0' }}>
          Frozen Roster ({evaluation.occupiedCount} / {evaluation.capacityCount} places)
        </h2>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
          {snapshot.roster.map((member) => {
            const isSelected = member.attendeeId === selectedAttendeeId;
            return (
              <button
                key={member.attendeeId}
                type="button"
                onClick={() => setSelectedAttendeeId(member.attendeeId)}
                style={{
                  textAlign: 'left',
                  padding: '10px 12px',
                  borderRadius: '6px',
                  border: isSelected ? '1px solid #60a5fa' : '1px solid #2e3346',
                  background: isSelected ? '#1e293b' : '#1a1e29',
                  color: '#f3f4f6',
                  cursor: 'pointer',
                }}
              >
                <div style={{ fontWeight: 600 }}>{member.label}</div>
                <div style={{ fontSize: '0.78rem', color: '#9ca3af' }}>
                  Place: {member.assignedPlaceId} · Profile: {member.profileId}
                </div>
              </button>
            );
          })}
        </div>
      </aside>

      <main style={{ padding: '24px' }}>
        <h2 style={{ marginTop: 0 }}>
          {selectedAttendee ? selectedAttendee.label : 'Select an Attendee'}
        </h2>
        {selectedEval && (
          <div
            style={{
              padding: '16px',
              borderRadius: '8px',
              border: '1px solid #262936',
              background: '#151821',
              maxWidth: '560px',
            }}
          >
            <p style={{ margin: '0 0 8px 0' }}>
              Sampled Visibility:{' '}
              <strong>
                {selectedEval.visibleSamples} / {selectedEval.totalSamples}
              </strong>{' '}
              ({Math.round(selectedEval.sampledVisibility * 100)}%)
            </p>
            <p style={{ margin: '0 0 8px 0' }}>
              Modeled Route: <strong>{selectedEval.routeStatus}</strong>
            </p>
            <p style={{ margin: 0 }}>
              Eye World Position:{' '}
              <code>[{selectedEval.eyePositionWorld.map((v) => v.toFixed(2)).join(', ')}]</code>
            </p>
          </div>
        )}
      </main>
    </div>
  );
}
export default App;
