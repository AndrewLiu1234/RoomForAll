import React, { useEffect, useMemo, useState } from 'react';
import type {
  AttendeeAssignment,
  Evaluation,
  ProfileId,
  SceneSnapshot,
} from '../shared/index.js';

export interface RosterPanelProps {
  snapshot: SceneSnapshot;
  evaluation: Evaluation;
  selectedAttendeeId: string;
  isFrozen: boolean;
  onSelectAttendee: (attendeeId: string) => void;
  onChangePlaceAssignment: (attendeeId: string, newPlaceId: string) => void;
  onOpenProfileEditor: () => void;
  onAddAttendee?: (placeId: string, profileId: ProfileId) => void;
  onRemoveAttendee?: (attendeeId: string) => void;
  onRandomizeFourAttendees?: () => void;
}

export function RosterPanel({
  snapshot,
  evaluation,
  selectedAttendeeId,
  isFrozen,
  onSelectAttendee,
  onChangePlaceAssignment,
  onOpenProfileEditor,
  onAddAttendee,
  onRemoveAttendee,
  onRandomizeFourAttendees,
}: RosterPanelProps): React.ReactElement {
  const selectedAttendee = snapshot.roster.find(
    (a) => a.attendeeId === selectedAttendeeId,
  );
  const selectedEval = selectedAttendeeId
    ? evaluation.attendees[selectedAttendeeId]
    : undefined;
  const selectedProfile = selectedAttendee
    ? snapshot.profiles[selectedAttendee.profileId]
    : undefined;
  const selectedPlace = selectedAttendee
    ? snapshot.places.find((p) => p.id === selectedAttendee.assignedPlaceId)
    : undefined;

  const occupiedPlaceIds = useMemo(
    () => new Set(snapshot.roster.map((m) => m.assignedPlaceId)),
    [snapshot.roster],
  );

  const emptyPlaces = useMemo(
    () => snapshot.places.filter((p) => !occupiedPlaceIds.has(p.id)),
    [snapshot.places, occupiedPlaceIds],
  );

  const [newPlaceId, setNewPlaceId] = useState<string>(
    () => emptyPlaces[0]?.id ?? '',
  );
  const [newProfileId, setNewProfileId] =
    useState<ProfileId>('reference_adult');

  useEffect(() => {
    if (!emptyPlaces.some((p) => p.id === newPlaceId)) {
      const firstEmpty = emptyPlaces[0];
      setNewPlaceId(firstEmpty?.id ?? '');
      if (firstEmpty) {
        setNewProfileId(
          firstEmpty.kind === 'wheelchair_bay'
            ? 'wheelchair_user'
            : 'reference_adult',
        );
      }
    }
  }, [emptyPlaces, newPlaceId]);

  const targetEmptyPlace = emptyPlaces.find((p) => p.id === newPlaceId);
  const compatibleProfilesForNewSeat: ProfileId[] =
    targetEmptyPlace?.kind === 'wheelchair_bay'
      ? ['wheelchair_user']
      : ['reference_adult', 'shorter_seated', 'extra_legroom'];

  return (
    <aside
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: '14px',
        padding: '16px',
        borderRight: '1px solid var(--border-subtle)',
        background: 'var(--bg-surface)',
        overflowY: 'auto',
      }}
    >
      {/* Venue Source & Capacity Header */}
      <div className="vp-card-inner">
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            marginBottom: '6px',
          }}
        >
          <span
            style={{
              fontSize: '0.72rem',
              textTransform: 'uppercase',
              letterSpacing: '0.05em',
              color: 'var(--text-secondary)',
              fontWeight: 600,
            }}
          >
            Active 3D Venue Scene
          </span>
          <span className="vp-badge vp-badge-neutral mono">
            {snapshot.source.license}
          </span>
        </div>
        <div
          style={{ fontWeight: 600, fontSize: '0.88rem', marginBottom: '4px' }}
        >
          {snapshot.source.title}
        </div>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            fontSize: '0.75rem',
            color: 'var(--text-secondary)',
          }}
        >
          <span className="mono">{snapshot.sceneHash}</span>
          <span>
            Seated: <strong>{evaluation.occupiedCount}</strong> /{' '}
            <strong>{evaluation.capacityCount}</strong> places
          </span>
        </div>
      </div>

      {/* Add / Randomize People in Parsed Seats Card */}
      {!isFrozen && (onAddAttendee || onRandomizeFourAttendees) && (
        <div
          className="vp-card-inner"
          style={{
            border: '1px solid rgba(56, 189, 248, 0.3)',
            background: 'rgba(15, 23, 42, 0.72)',
            display: 'flex',
            flexDirection: 'column',
            gap: '8px',
          }}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
            }}
          >
            <span
              style={{
                fontSize: '0.78rem',
                fontWeight: 700,
                color: '#7dd3fc',
              }}
            >
              Manage People in Seats ({emptyPlaces.length} empty)
            </span>
            {onRandomizeFourAttendees && (
              <button
                type="button"
                className="vp-btn"
                style={{
                  padding: '3px 8px',
                  fontSize: '0.71rem',
                  borderColor: 'rgba(56, 189, 248, 0.45)',
                  color: '#bae6fd',
                }}
                onClick={onRandomizeFourAttendees}
                title="Spawn 4 people at random across the parsed seats"
              >
                Randomize 4 People
              </button>
            )}
          </div>

          {onAddAttendee && emptyPlaces.length > 0 ? (
            <div
              style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}
            >
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: '1fr 1fr',
                  gap: '6px',
                }}
              >
                <select
                  aria-label="Select empty seat"
                  value={newPlaceId}
                  onChange={(e) => {
                    const pid = e.target.value;
                    setNewPlaceId(pid);
                    const picked = emptyPlaces.find((p) => p.id === pid);
                    if (picked) {
                      setNewProfileId(
                        picked.kind === 'wheelchair_bay'
                          ? 'wheelchair_user'
                          : 'reference_adult',
                      );
                    }
                  }}
                  style={{
                    fontSize: '0.73rem',
                    padding: '4px 6px',
                    borderRadius: 'var(--radius-inner)',
                    border: '1px solid var(--border-subtle)',
                    background: 'var(--bg-surface-elevated)',
                    color: 'var(--text-primary)',
                  }}
                >
                  {emptyPlaces.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.label} ({p.kind === 'wheelchair_bay' ? 'Bay' : 'Seat'})
                    </option>
                  ))}
                </select>

                <select
                  aria-label="Select profile for new person"
                  value={
                    compatibleProfilesForNewSeat.includes(newProfileId)
                      ? newProfileId
                      : compatibleProfilesForNewSeat[0]!
                  }
                  onChange={(e) => setNewProfileId(e.target.value as ProfileId)}
                  style={{
                    fontSize: '0.73rem',
                    padding: '4px 6px',
                    borderRadius: 'var(--radius-inner)',
                    border: '1px solid var(--border-subtle)',
                    background: 'var(--bg-surface-elevated)',
                    color: 'var(--text-primary)',
                  }}
                >
                  {compatibleProfilesForNewSeat.map((profId) => (
                    <option key={profId} value={profId}>
                      {snapshot.profiles[profId]?.label ?? profId}
                    </option>
                  ))}
                </select>
              </div>

              <button
                type="button"
                className="vp-btn vp-btn-primary"
                style={{ width: '100%', padding: '5px 8px', fontSize: '0.75rem' }}
                onClick={() => {
                  if (!newPlaceId) return;
                  const chosenProfile = compatibleProfilesForNewSeat.includes(
                    newProfileId,
                  )
                    ? newProfileId
                    : compatibleProfilesForNewSeat[0]!;
                  onAddAttendee(newPlaceId, chosenProfile);
                }}
              >
                + Add Person to Selected Seat
              </button>
            </div>
          ) : (
            <div style={{ fontSize: '0.73rem', color: 'var(--text-muted)' }}>
              All {snapshot.places.length} parsed seats are currently occupied.
              Remove a person below to free a seat.
            </div>
          )}
        </div>
      )}

      {/* Roster Section Header */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
        }}
      >
        <div>
          <h2 style={{ margin: 0, fontSize: '0.92rem' }}>
            Guest Roster ({snapshot.roster.length})
          </h2>
          <p
            style={{
              margin: '2px 0 0 0',
              fontSize: '0.74rem',
              color: 'var(--text-secondary)',
            }}
          >
            {isFrozen
              ? 'Frozen during active/completed run'
              : 'Click a person or seat ring to inspect POV'}
          </p>
        </div>

        <button
          type="button"
          className="vp-btn"
          style={{ padding: '5px 10px', fontSize: '0.74rem' }}
          onClick={onOpenProfileEditor}
        >
          Edit 4 Profiles
        </button>
      </div>

      {/* Attendee Cards */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
        {snapshot.roster.map((member: AttendeeAssignment) => {
          const isSelected = member.attendeeId === selectedAttendeeId;
          const attEval = evaluation.attendees[member.attendeeId];
          const profile = snapshot.profiles[member.profileId];
          const place = snapshot.places.find(
            (p) => p.id === member.assignedPlaceId,
          );

          return (
            <div
              key={member.attendeeId}
              role="button"
              tabIndex={0}
              onClick={() => onSelectAttendee(member.attendeeId)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  onSelectAttendee(member.attendeeId);
                }
              }}
              className={`vp-roster-item vp-focusable ${
                isSelected ? 'vp-roster-item-active' : ''
              }`}
            >
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: '8px',
                }}
              >
                <span style={{ fontWeight: 600, fontSize: '0.86rem' }}>
                  {member.label}
                </span>
                <div
                  style={{ display: 'flex', alignItems: 'center', gap: '6px' }}
                >
                  {attEval && (
                    <span
                      className={`vp-badge ${
                        attEval.clearAndUsable
                          ? 'vp-badge-pass'
                          : 'vp-badge-fail'
                      }`}
                    >
                      {attEval.clearAndUsable
                        ? 'Clear & Usable'
                        : `${attEval.failedRequirements.length} Failed`}
                    </span>
                  )}
                  {!isFrozen && onRemoveAttendee && (
                    <button
                      type="button"
                      className="vp-btn"
                      style={{
                        padding: '2px 6px',
                        fontSize: '0.68rem',
                        borderColor: 'rgba(239, 68, 68, 0.4)',
                        color: '#fca5a5',
                      }}
                      title={`Remove ${member.label} from ${member.assignedPlaceId}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        onRemoveAttendee(member.attendeeId);
                      }}
                    >
                      Remove
                    </button>
                  )}
                </div>
              </div>

              <div
                style={{
                  fontSize: '0.74rem',
                  color: 'var(--text-secondary)',
                  display: 'flex',
                  justifyContent: 'space-between',
                }}
              >
                <span>{profile?.label ?? member.profileId}</span>
                {attEval && (
                  <span className="mono">
                    View: {attEval.visibleSamples}/{attEval.totalSamples} (
                    {Math.round(attEval.sampledVisibility * 100)}%)
                  </span>
                )}
              </div>

              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: '8px',
                  marginTop: '2px',
                }}
                onClick={(e) => e.stopPropagation()}
              >
                <span
                  style={{ fontSize: '0.73rem', color: 'var(--text-secondary)' }}
                >
                  Assigned Place:
                </span>
                <select
                  aria-label={`Assigned place for ${member.label}`}
                  disabled={isFrozen}
                  value={member.assignedPlaceId}
                  onChange={(e) =>
                    onChangePlaceAssignment(member.attendeeId, e.target.value)
                  }
                  style={{
                    fontSize: '0.75rem',
                    padding: '3px 8px',
                    borderRadius: 'var(--radius-inner)',
                    border: '1px solid var(--border-subtle)',
                    background: 'var(--bg-surface-elevated)',
                    color: 'var(--text-primary)',
                  }}
                >
                  {snapshot.places
                    .filter((p) =>
                      profile?.compatiblePlaceKinds.includes(p.kind),
                    )
                    .map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.label} (
                        {p.kind === 'wheelchair_bay'
                          ? 'Bay'
                          : `${p.seatHeightM}m`}
                        )
                      </option>
                    ))}
                </select>
              </div>
              {place && (
                <div
                  style={{
                    fontSize: '0.7rem',
                    color: 'var(--text-muted)',
                    display: 'flex',
                    justifyContent: 'space-between',
                  }}
                >
                  <span>
                    Footprint: {place.widthM.toFixed(2)}m ×{' '}
                    {place.depthM.toFixed(2)}m
                  </span>
                  <span>
                    {place.isAisle ? 'Aisle Place' : 'Interior Place'}
                  </span>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Selected Attendee Detailed Audit Breakdown */}
      {selectedAttendee && selectedEval && selectedProfile && (
        <div className="vp-card-inner" style={{ marginTop: '4px' }}>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              marginBottom: '8px',
            }}
          >
            <h3 style={{ margin: 0, fontSize: '0.84rem' }}>
              Modeled Checks: {selectedAttendee.label}
            </h3>
            <span
              className="mono"
              style={{ fontSize: '0.72rem', color: 'var(--text-secondary)' }}
            >
              Eye Y = {selectedEval.eyePositionWorld[1].toFixed(2)}m
            </span>
          </div>

          <div
            style={{
              display: 'grid',
              gridTemplateColumns: '1fr auto',
              gap: '6px',
              fontSize: '0.76rem',
            }}
          >
            <span>15×9 Target Visibility (&gt;=122/135):</span>
            <span
              className={`vp-badge ${
                selectedEval.isViewClear ? 'vp-badge-pass' : 'vp-badge-fail'
              }`}
            >
              {selectedEval.visibleSamples}/{selectedEval.totalSamples} (
              {Math.round(selectedEval.sampledVisibility * 100)}%)
            </span>

            <span>
              Modeled Route Clearance (&gt;=
              {selectedProfile.requiredRouteWidthM.toFixed(2)}m):
            </span>
            <span
              className={`vp-badge ${
                selectedEval.routeStatus === 'clear'
                  ? 'vp-badge-pass'
                  : 'vp-badge-fail'
              }`}
            >
              {selectedEval.routeStatus === 'clear'
                ? 'Route Clear'
                : 'Route Blocked'}
            </span>

            <span>
              Footprint Fit (
              {selectedProfile.requiredFootprintWidthM.toFixed(2)}×
              {selectedProfile.requiredFootprintDepthM.toFixed(2)}m):
            </span>
            <span
              className={`vp-badge ${
                selectedEval.footprintFitPass
                  ? 'vp-badge-pass'
                  : 'vp-badge-fail'
              }`}
            >
              {selectedEval.footprintFitPass ? 'Pass' : 'Fail'}
            </span>

            <span>
              Required Front Legroom (
              {selectedProfile.requiredFrontLegroomM.toFixed(2)}m):
            </span>
            <span
              className={`vp-badge ${
                selectedEval.legroomPass ? 'vp-badge-pass' : 'vp-badge-fail'
              }`}
            >
              {selectedEval.legroomPass ? 'Pass' : 'Fail'}
            </span>

            <span>
              Turning Space (
              {selectedProfile.requiredTurningCircleDiameterM > 0
                ? `${selectedProfile.requiredTurningCircleDiameterM.toFixed(2)}m`
                : 'N/A'}
              ):
            </span>
            <span
              className={`vp-badge ${
                selectedEval.turningSpacePass
                  ? 'vp-badge-pass'
                  : 'vp-badge-fail'
              }`}
            >
              {selectedEval.turningSpacePass ? 'Pass' : 'Fail'}
            </span>
          </div>

          {selectedPlace && (
            <div
              style={{
                marginTop: '8px',
                paddingTop: '8px',
                borderTop: '1px solid var(--border-subtle)',
                fontSize: '0.73rem',
                color: 'var(--text-secondary)',
              }}
            >
              {selectedProfile.eyeHeightMode === 'seat_offset' ? (
                <span>
                  Derived Eye Height: Seat{' '}
                  {selectedPlace.seatHeightM.toFixed(2)}m + Offset{' '}
                  {(selectedProfile.eyeOffsetAboveSeatM ?? 0.75).toFixed(2)}m ={' '}
                  <strong>{selectedEval.eyePositionWorld[1].toFixed(2)}m</strong>
                </span>
              ) : (
                <span>
                  Independent Wheelchair Eye Height:{' '}
                  <strong>{selectedEval.eyePositionWorld[1].toFixed(2)}m</strong>
                </span>
              )}
            </div>
          )}

          {selectedEval.failedRequirements.length > 0 && (
            <div
              style={{
                marginTop: '8px',
                padding: '8px',
                borderRadius: 'var(--radius-inner)',
                background: 'var(--color-danger-bg)',
                border: '1px solid rgba(239, 68, 68, 0.25)',
                fontSize: '0.74rem',
                color: '#fca5a5',
              }}
            >
              <div style={{ fontWeight: 600, marginBottom: '4px' }}>
                Failed Required Checks:
              </div>
              <ul style={{ margin: 0, paddingLeft: '16px' }}>
                {selectedEval.failedRequirements.map((req, idx) => (
                  <li key={idx}>{req}</li>
                ))}
              </ul>
            </div>
          )}

          {selectedEval.optionalPreferenceNotes.length > 0 && (
            <div
              style={{
                marginTop: '8px',
                padding: '8px',
                borderRadius: 'var(--radius-inner)',
                background: 'var(--color-warning-bg)',
                border: '1px solid rgba(245, 158, 11, 0.25)',
                fontSize: '0.73rem',
                color: '#fcd34d',
              }}
            >
              {selectedEval.optionalPreferenceNotes.map((note, idx) => (
                <div key={idx}>{note}</div>
              ))}
            </div>
          )}
        </div>
      )}
    </aside>
  );
}
