import React, { useEffect, useState } from 'react';
import {
  DEFAULT_PROFILE_REQUIREMENTS,
  type ProfileId,
  type ProfileRequirements,
} from '../shared/index.js';

export interface ProfileEditorModalProps {
  profiles: Record<ProfileId, ProfileRequirements>;
  isFrozen: boolean;
  onSaveProfiles: (updated: Record<ProfileId, ProfileRequirements>) => void;
  onClose: () => void;
}

const PROFILE_ORDER: ProfileId[] = [
  'shorter_seated',
  'wheelchair_user',
  'extra_legroom',
  'reference_adult',
];

export function ProfileEditorModal({
  profiles,
  isFrozen,
  onSaveProfiles,
  onClose,
}: ProfileEditorModalProps): React.ReactElement {
  const [draft, setDraft] = useState<Record<ProfileId, ProfileRequirements>>(
    () => structuredClone(profiles),
  );
  const [activeTab, setActiveTab] = useState<ProfileId>('shorter_seated');

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  const current = draft[activeTab];

  const updateField = <K extends keyof ProfileRequirements>(
    key: K,
    value: ProfileRequirements[K],
  ): void => {
    if (isFrozen) return;
    setDraft((prev) => ({
      ...prev,
      [activeTab]: {
        ...prev[activeTab],
        [key]: value,
      },
    }));
  };

  const inputStyle: React.CSSProperties = {
    width: '100%',
    padding: '7px 10px',
    borderRadius: 'var(--radius-inner)',
    border: '1px solid var(--border-subtle)',
    background: 'var(--bg-shell)',
    color: 'var(--text-primary)',
    fontSize: '0.82rem',
  };

  const labelStyle: React.CSSProperties = {
    display: 'block',
    fontSize: '0.74rem',
    fontWeight: 500,
    color: 'var(--text-secondary)',
    marginBottom: '5px',
  };

  return (
    <div
      className="vp-modal-backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="vp-modal-content"
        role="dialog"
        aria-modal="true"
        aria-labelledby="vp-profile-modal-title"
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'flex-start',
            justifyContent: 'space-between',
            marginBottom: '16px',
          }}
        >
          <div>
            <h2
              id="vp-profile-modal-title"
              style={{ margin: 0, fontSize: '1.02rem', fontWeight: 600 }}
            >
              Audience Accessibility &amp; Sightline Profiles
            </h2>
            <p
              style={{
                margin: '4px 0 0 0',
                fontSize: '0.77rem',
                color: 'var(--text-secondary)',
              }}
            >
              Configure eye height, route width, legroom, and turning clearance per group.
            </p>
          </div>
          <button
            type="button"
            className="vp-btn vp-btn-ghost"
            style={{ padding: '4px 8px' }}
            onClick={onClose}
          >
            Esc
          </button>
        </div>

        {/* Profile Selector Segmented Tabs */}
        <div
          className="vp-segmented"
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(4, minmax(0, 1fr))',
            width: '100%',
            marginBottom: '16px',
          }}
          role="tablist"
        >
          {PROFILE_ORDER.map((pid) => (
            <button
              key={pid}
              type="button"
              role="tab"
              aria-selected={activeTab === pid}
              className={`vp-segment-btn vp-focusable ${
                activeTab === pid ? 'vp-segment-btn-active' : ''
              }`}
              onClick={() => setActiveTab(pid)}
            >
              <span
                style={{
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                }}
              >
                {draft[pid].label}
              </span>
            </button>
          ))}
        </div>

        {/* Editable Fields for Selected Profile */}
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(2, 1fr)',
            gap: '14px',
            padding: '16px',
            borderRadius: 'var(--radius-card)',
            background: 'var(--bg-elevated)',
            border: '1px solid var(--border-hairline)',
            marginBottom: '18px',
          }}
        >
          <div style={{ gridColumn: '1 / -1' }}>
            <label style={labelStyle}>Profile Label</label>
            <input
              type="text"
              disabled={isFrozen}
              value={current.label}
              onChange={(e) => updateField('label', e.target.value)}
              style={inputStyle}
            />
          </div>

          {current.eyeHeightMode === 'seat_offset' ? (
            <div>
              <label style={labelStyle}>Seated Eye Offset Above Chair (m)</label>
              <input
                type="number"
                className="mono"
                step="0.02"
                min="0.30"
                max="1.10"
                disabled={isFrozen}
                value={current.eyeOffsetAboveSeatM ?? 0.75}
                onChange={(e) =>
                  updateField('eyeOffsetAboveSeatM', Number(e.target.value))
                }
                style={inputStyle}
              />
            </div>
          ) : (
            <div>
              <label style={labelStyle}>Wheelchair Eye Height Above Floor (m)</label>
              <input
                type="number"
                className="mono"
                step="0.02"
                min="0.80"
                max="1.50"
                disabled={isFrozen}
                value={current.independentEyeHeightM ?? 1.18}
                onChange={(e) =>
                  updateField('independentEyeHeightM', Number(e.target.value))
                }
                style={inputStyle}
              />
            </div>
          )}

          <div>
            <label style={labelStyle}>Minimum Front Legroom (m)</label>
            <input
              type="number"
              className="mono"
              step="0.05"
              min="0.10"
              max="1.20"
              disabled={isFrozen}
              value={current.requiredFrontLegroomM}
              onChange={(e) =>
                updateField('requiredFrontLegroomM', Number(e.target.value))
              }
              style={inputStyle}
            />
          </div>

          <div>
            <label style={labelStyle}>Minimum Route Width (m)</label>
            <input
              type="number"
              className="mono"
              step="0.05"
              min="0.50"
              max="1.80"
              disabled={isFrozen}
              value={current.requiredRouteWidthM}
              onChange={(e) =>
                updateField('requiredRouteWidthM', Number(e.target.value))
              }
              style={inputStyle}
            />
          </div>

          <div>
            <label style={labelStyle}>Turning Circle Diameter (m)</label>
            <input
              type="number"
              className="mono"
              step="0.05"
              min="0"
              max="2.50"
              disabled={isFrozen}
              value={current.requiredTurningCircleDiameterM}
              onChange={(e) =>
                updateField(
                  'requiredTurningCircleDiameterM',
                  Number(e.target.value),
                )
              }
              style={inputStyle}
            />
          </div>

          <div>
            <label style={labelStyle}>Minimum Seat Width (m)</label>
            <input
              type="number"
              className="mono"
              step="0.02"
              min="0.40"
              max="1.40"
              disabled={isFrozen}
              value={current.requiredFootprintWidthM}
              onChange={(e) =>
                updateField('requiredFootprintWidthM', Number(e.target.value))
              }
              style={inputStyle}
            />
          </div>

          <div>
            <label style={labelStyle}>Minimum Seat Depth (m)</label>
            <input
              type="number"
              className="mono"
              step="0.02"
              min="0.40"
              max="1.60"
              disabled={isFrozen}
              value={current.requiredFootprintDepthM}
              onChange={(e) =>
                updateField('requiredFootprintDepthM', Number(e.target.value))
              }
              style={inputStyle}
            />
          </div>

          <div
            style={{
              gridColumn: '1 / -1',
              paddingTop: '4px',
            }}
          >
            <label
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: '8px',
                fontSize: '0.79rem',
                color: 'var(--text-primary)',
                cursor: isFrozen ? 'not-allowed' : 'pointer',
              }}
            >
              <input
                type="checkbox"
                disabled={isFrozen}
                checked={current.prefersAisle}
                onChange={(e) => updateField('prefersAisle', e.target.checked)}
              />
              Prefers Aisle Seat (advisory preference)
            </label>
          </div>
        </div>

        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
          }}
        >
          <button
            type="button"
            className="vp-btn vp-btn-ghost"
            disabled={isFrozen}
            onClick={() => setDraft(structuredClone(DEFAULT_PROFILE_REQUIREMENTS))}
          >
            Reset Defaults
          </button>

          <div style={{ display: 'flex', gap: '8px' }}>
            <button type="button" className="vp-btn" onClick={onClose}>
              Cancel
            </button>
            <button
              type="button"
              className="vp-btn vp-btn-primary"
              disabled={isFrozen}
              onClick={() => {
                onSaveProfiles(draft);
                onClose();
              }}
            >
              Save &amp; Re-Evaluate
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
