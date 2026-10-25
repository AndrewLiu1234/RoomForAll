import React, { useEffect, useMemo, useState } from 'react';
import type {
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

function formatShortPlaceLabel(placeId: string, fallbackLabel?: string): string {
  if (fallbackLabel) {
    const match = fallbackLabel.match(/\b(R\d+-C\d+|R\d+-\d+|W-?\d+|Bay\s*\d+)\b/i);
    if (match?.[1]) return match[1].toUpperCase();
  }
  return placeId
    .replace(/^place_/, '')
    .replace(/_/g, '-')
    .toUpperCase();
}

function parseCleanGuestName(rawLabel: string): string {
  const idx = rawLabel.indexOf('(');
  return idx > 0 ? rawLabel.slice(0, idx).trim() : rawLabel.trim();
}

function formatBlockerName(blockerId: string): string {
  const map: Record<string, string> = {
    obj_prop_welcome_sign: 'Welcome Sign',
    obj_prop_sign_01: 'Welcome Sign',
    obj_prop_catering_table: 'Literature Table',
    obj_prop_av_cart: 'AV Equipment Cart',
  };
  if (map[blockerId]) return map[blockerId];
  return blockerId
    .replace(/^obj_prop_/, '')
    .replace(/^obj_/, '')
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function humanizeRequirementText(
  req: string,
  primaryBlockerIds: string[],
  visPct: number,
): string {
  if (req === 'clear_view') {
    const blockers = primaryBlockerIds.map(formatBlockerName).join(', ');
    return blockers
      ? `Sightline obstructed by ${blockers} (${visPct}% visible)`
      : `Sightline below 90% threshold (${visPct}% visible)`;
  }
  if (req === 'front_legroom') {
    return 'Front legroom obstructed by nearby table or fixture';
  }
  if (req === 'turning_space') {
    return 'Wheelchair turning circle obstructed by adjacent equipment';
  }
  if (req === 'accessible_route') {
    return 'Step-free approach route narrower than required clearance';
  }
  if (req === 'footprint_fit') {
    return 'Assigned place dimensions smaller than required footprint';
  }
  return req
    .replace(/obj_prop_welcome_sign/g, 'Welcome Sign')
    .replace(/obj_prop_sign_01/g, 'Welcome Sign')
    .replace(/obj_prop_catering_table/g, 'Literature Table')
    .replace(/obj_prop_av_cart/g, 'AV Equipment Cart')
    .replace(/obj_prop_speaker_\d+/g, 'Stage Speaker');
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
  const [filterMode, setFilterMode] = useState<'all' | 'issues' | 'clear'>('all');

  const issueCount = useMemo(
    () =>
      snapshot.roster.filter(
        (m) => evaluation.attendees[m.attendeeId]?.clearAndUsable === false,
      ).length,
    [snapshot.roster, evaluation.attendees],
  );
  const clearCount = snapshot.roster.length - issueCount;

  // Sort roster so attendees with unmet checks appear first for effortless demo scanning
  const filteredRoster = useMemo(() => {
    const list = snapshot.roster.filter((member) => {
      const ev = evaluation.attendees[member.attendeeId];
      if (filterMode === 'issues') return ev ? !ev.clearAndUsable : false;
      if (filterMode === 'clear') return ev ? ev.clearAndUsable : true;
      return true;
    });

    return [...list].sort((a, b) => {
      const evA = evaluation.attendees[a.attendeeId];
      const evB = evaluation.attendees[b.attendeeId];
      const failA = evA && !evA.clearAndUsable ? 0 : 1;
      const failB = evB && !evB.clearAndUsable ? 0 : 1;
      if (failA !== failB) return failA - failB;
      return a.attendeeId.localeCompare(b.attendeeId);
    });
  }, [snapshot.roster, evaluation.attendees, filterMode]);

  const selectedAttendee = snapshot.roster.find(
    (a) => a.attendeeId === selectedAttendeeId,
  );
  const selectedEval = selectedAttendeeId
    ? evaluation.attendees[selectedAttendeeId]
    : undefined;
  const selectedProfile = selectedAttendee
    ? snapshot.profiles[selectedAttendee.profileId]
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
    <aside className="vp-rail-left" aria-label="Guest Roster">
      {/* Top Section: Roster Header & Filter Bar */}
      <div
        className="vp-section"
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: '10px',
          paddingBottom: '12px',
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: '8px',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <h2 className="vp-section-title">Guests</h2>
            <span className="vp-badge vp-badge-neutral tabular">
              {evaluation.occupiedCount}/{evaluation.capacityCount}
            </span>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
            {!isFrozen && onRandomizeFourAttendees && (
              <button
                type="button"
                className="vp-btn"
                style={{ padding: '4px 8px', fontSize: '0.71rem' }}
                onClick={onRandomizeFourAttendees}
                title="Spawn 4 people at random into the parsed 3D seats"
              >
                Randomize 4
              </button>
            )}
            <button
              type="button"
              className="vp-btn"
              style={{ padding: '4px 9px', fontSize: '0.73rem' }}
              onClick={onOpenProfileEditor}
            >
              <span>Profiles</span>
            </button>
          </div>
        </div>

        {/* Add Person to Any Empty Seat Controls */}
        {!isFrozen && onAddAttendee && emptyPlaces.length > 0 && (
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: '6px',
              padding: '8px',
              borderRadius: 'var(--radius-inner)',
              background: 'var(--bg-elevated)',
              border: '1px solid var(--border-subtle)',
            }}
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
                className="vp-select vp-focusable"
                style={{ fontSize: '0.72rem' }}
              >
                {emptyPlaces.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label}
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
                className="vp-select vp-focusable"
                style={{ fontSize: '0.72rem' }}
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
              style={{ width: '100%', padding: '4px 8px', fontSize: '0.73rem' }}
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
              + Add Person to Seat ({emptyPlaces.length} empty)
            </button>
          </div>
        )}

        {/* Filter Segmented Control */}
        <div
          className="vp-segmented"
          style={{ width: '100%', display: 'grid', gridTemplateColumns: '1fr 1fr 1fr' }}
          role="tablist"
          aria-label="Filter guests by status"
        >
          <button
            type="button"
            role="tab"
            aria-selected={filterMode === 'all'}
            className={`vp-segment-btn vp-focusable ${
              filterMode === 'all' ? 'vp-segment-btn-active' : ''
            }`}
            onClick={() => setFilterMode('all')}
          >
            All ({snapshot.roster.length})
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={filterMode === 'issues'}
            className={`vp-segment-btn vp-focusable ${
              filterMode === 'issues' ? 'vp-segment-btn-active' : ''
            }`}
            onClick={() => setFilterMode('issues')}
          >
            <span
              className={`vp-status-dot ${
                issueCount > 0 ? 'vp-status-dot-fail' : 'vp-status-dot-pass'
              }`}
              style={{ width: '6px', height: '6px' }}
            />
            Issues ({issueCount})
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={filterMode === 'clear'}
            className={`vp-segment-btn vp-focusable ${
              filterMode === 'clear' ? 'vp-segment-btn-active' : ''
            }`}
            onClick={() => setFilterMode('clear')}
          >
            Clear ({clearCount})
          </button>
        </div>
      </div>

      {/* Scrollable Compact Roster Rows */}
      <div className="vp-roster-scroll" role="list">
        {filteredRoster.length === 0 ? (
          <div
            style={{
              padding: '20px 12px',
              textAlign: 'center',
              fontSize: '0.76rem',
              color: 'var(--text-muted)',
            }}
          >
            No guests match this filter.
          </div>
        ) : (
          filteredRoster.map((member) => {
            const isSelected = member.attendeeId === selectedAttendeeId;
            const attEval = evaluation.attendees[member.attendeeId];
            const profile = snapshot.profiles[member.profileId];
            const place = snapshot.places.find(
              (p) => p.id === member.assignedPlaceId,
            );
            const isPass = attEval ? attEval.clearAndUsable : true;
            const visPct = attEval
              ? Math.round(attEval.sampledVisibility * 100)
              : 100;
            const seatCode = formatShortPlaceLabel(
              member.assignedPlaceId,
              place?.label,
            );
            const cleanName = parseCleanGuestName(member.label);

            return (
              <div
                key={member.attendeeId}
                role="listitem"
                onClick={() => onSelectAttendee(member.attendeeId)}
                className={`vp-roster-row vp-focusable ${
                  isSelected ? 'vp-roster-row-active' : ''
                }`}
                style={{ cursor: 'pointer' }}
              >
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '9px',
                    minWidth: 0,
                  }}
                >
                  <span
                    className={`vp-status-dot ${
                      isPass ? 'vp-status-dot-pass' : 'vp-status-dot-fail'
                    }`}
                  />
                  <div style={{ minWidth: 0 }}>
                    <div
                      style={{
                        fontWeight: isSelected ? 600 : 500,
                        fontSize: '0.81rem',
                        whiteSpace: 'nowrap',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                      }}
                    >
                      {cleanName}
                    </div>
                    <div
                      style={{
                        fontSize: '0.7rem',
                        color: 'var(--text-secondary)',
                        whiteSpace: 'nowrap',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                      }}
                    >
                      {profile?.label ?? member.profileId}
                    </div>
                  </div>
                </div>

                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '6px',
                    flexShrink: 0,
                  }}
                >
                  <span
                    className="mono"
                    style={{
                      fontSize: '0.7rem',
                      padding: '2px 6px',
                      borderRadius: '4px',
                      background: 'var(--bg-elevated)',
                      border: '1px solid var(--border-hairline)',
                      color: 'var(--text-secondary)',
                    }}
                  >
                    {seatCode}
                  </span>
                  <span
                    className="mono"
                    style={{
                      fontSize: '0.74rem',
                      fontWeight: 600,
                      minWidth: '36px',
                      textAlign: 'right',
                      color: isPass
                        ? 'var(--status-pass-text)'
                        : 'var(--status-fail-text)',
                    }}
                  >
                    {visPct}%
                  </span>
                  {!isFrozen && onRemoveAttendee && (
                    <button
                      type="button"
                      className="vp-btn"
                      style={{
                        padding: '1px 5px',
                        fontSize: '0.67rem',
                        color: 'var(--status-fail-text)',
                      }}
                      title={`Remove ${cleanName} from seat`}
                      onClick={(e) => {
                        e.stopPropagation();
                        onRemoveAttendee(member.attendeeId);
                      }}
                    >
                      ✕
                    </button>
                  )}
                </div>
              </div>
            );
          })
        )}
      </div>

      {/* Pinned Selected Guest Inspector */}
      {selectedAttendee && selectedEval && selectedProfile && (
        <div className="vp-inspector">
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: '8px',
            }}
          >
            <div style={{ minWidth: 0 }}>
              <div
                style={{
                  fontWeight: 600,
                  fontSize: '0.84rem',
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                }}
              >
                {parseCleanGuestName(selectedAttendee.label)}
              </div>
              <div style={{ fontSize: '0.72rem', color: 'var(--text-secondary)' }}>
                {selectedProfile.label} · Eye {selectedEval.eyePositionWorld[1].toFixed(2)}m
              </div>
            </div>

            <select
              aria-label={`Assigned seat for ${selectedAttendee.label}`}
              disabled={isFrozen}
              value={selectedAttendee.assignedPlaceId}
              onChange={(e) =>
                onChangePlaceAssignment(
                  selectedAttendee.attendeeId,
                  e.target.value,
                )
              }
              className="vp-select vp-focusable"
              style={{ maxWidth: '138px' }}
            >
              {snapshot.places
                .filter((p) =>
                  selectedProfile.compatiblePlaceKinds.includes(p.kind),
                )
                .map((p) => (
                  <option key={p.id} value={p.id}>
                    {formatShortPlaceLabel(p.id, p.label)} (
                    {p.kind === 'wheelchair_bay' ? 'Bay' : `${p.seatHeightM}m`})
                  </option>
                ))}
            </select>
          </div>

          {/* 2x2 Spatial Check Pills */}
          <div className="vp-check-grid">
            <div className="vp-check-pill">
              <span style={{ color: 'var(--text-secondary)' }}>Sightline</span>
              <span
                className="mono"
                style={{
                  fontWeight: 600,
                  color: selectedEval.isViewClear
                    ? 'var(--status-pass-text)'
                    : 'var(--status-fail-text)',
                }}
              >
                {Math.round(selectedEval.sampledVisibility * 100)}%
              </span>
            </div>

            <div className="vp-check-pill">
              <span style={{ color: 'var(--text-secondary)' }}>Route</span>
              <span
                style={{
                  fontWeight: 600,
                  color:
                    selectedEval.routeStatus === 'clear'
                      ? 'var(--status-pass-text)'
                      : 'var(--status-fail-text)',
                }}
              >
                {selectedEval.routeStatus === 'clear' ? 'Clear' : 'Blocked'}
              </span>
            </div>

            <div className="vp-check-pill">
              <span style={{ color: 'var(--text-secondary)' }}>Legroom</span>
              <span
                style={{
                  fontWeight: 600,
                  color: selectedEval.legroomPass
                    ? 'var(--status-pass-text)'
                    : 'var(--status-fail-text)',
                }}
              >
                {selectedEval.legroomPass ? 'Pass' : 'Blocked'}
              </span>
            </div>

            <div className="vp-check-pill">
              <span style={{ color: 'var(--text-secondary)' }}>
                {selectedProfile.requiredTurningCircleDiameterM > 0
                  ? 'Turn Pad'
                  : 'Footprint'}
              </span>
              <span
                style={{
                  fontWeight: 600,
                  color:
                    selectedEval.turningSpacePass && selectedEval.footprintFitPass
                      ? 'var(--status-pass-text)'
                      : 'var(--status-fail-text)',
                }}
              >
                {selectedEval.turningSpacePass && selectedEval.footprintFitPass
                  ? 'Pass'
                  : 'Blocked'}
              </span>
            </div>
          </div>

          {/* Concise Issue Callout when Unmet */}
          {selectedEval.failedRequirements.length > 0 && (
            <div
              style={{
                padding: '7px 9px',
                borderRadius: 'var(--radius-inner)',
                background: 'var(--status-fail-bg)',
                border: '1px solid var(--status-fail-border)',
                fontSize: '0.73rem',
                color: 'var(--status-fail-text)',
                display: 'flex',
                flexDirection: 'column',
                gap: '3px',
              }}
            >
              {selectedEval.failedRequirements.map((req, idx) => (
                <div key={idx}>
                  •{' '}
                  {humanizeRequirementText(
                    req,
                    selectedEval.primaryBlockerIds,
                    Math.round(selectedEval.sampledVisibility * 100),
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </aside>
  );
}
