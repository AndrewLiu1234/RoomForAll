import React, { useState } from 'react';
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
  'reference_adult',
  'shorter_seated',
  'wheelchair_user',
  'extra_legroom',
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
            alignItems: 'center',
            justifyContent: 'space-between',
            marginBottom: '12px',
          }}
        >
          <div>
            <h2
              id="vp-profile-modal-title"
              style={{ margin: 0, fontSize: '1.05rem' }}
            >
              Audience Profile Requirements (PRD §5)
            </h2>
            <p
              style={{
                margin: '4px 0 0 0',
                fontSize: '0.78rem',
                color: 'var(--text-secondary)',
              }}
            >
              Explicit, editable needs per profile. Frozen during an active run.
            </p>
          </div>
          <button type="button" className="vp-btn" onClick={onClose}>
            Close
          </button>
        </div>

        {/* Profile Selector Tabs */}
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(2, 1fr)',
            gap: '6px',
            marginBottom: '16px',
          }}
        >
          {PROFILE_ORDER.map((pid) => (
            <button
              key={pid}
              type="button"
              className={`vp-btn ${activeTab === pid ? 'vp-btn-primary' : ''}`}
              style={{ justifyContent: 'flex-start', textAlign: 'left' }}
              onClick={() => setActiveTab(pid)}
            >
              <span>{draft[pid].label}</span>
            </button>
          ))}
        </div>

        {/* Editable Fields for Selected Profile */}
        <div
          className="vp-card-inner"
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(2, 1fr)',
            gap: '12px',
            marginBottom: '16px',
          }}
        >
          <div style={{ gridColumn: '1 / -1' }}>
            <label
              style={{
                display: 'block',
                fontSize: '0.75rem',
                color: 'var(--text-secondary)',
                marginBottom: '4px',
              }}
            >
              Profile Display Label
            </label>
            <input
              type="text"
              disabled={isFrozen}
              value={current.label}
              onChange={(e) => updateField('label', e.target.value)}
              style={{
                width: '100%',
                padding: '7px 10px',
                borderRadius: 'var(--radius-inner)',
                border: '1px solid var(--border-subtle)',
                background: 'var(--bg-surface)',
                color: 'var(--text-primary)',
              }}
            />
          </div>

          {current.eyeHeightMode === 'seat_offset' ? (
            <div>
              <label
                style={{
                  display: 'block',
                  fontSize: '0.75rem',
                  color: 'var(--text-secondary)',
                  marginBottom: '4px',
                }}
              >
                Eye Offset Above Chair Seat (m)
              </label>
              <input
                type="number"
                step="0.02"
                min="0.30"
                max="1.10"
                disabled={isFrozen}
                value={current.eyeOffsetAboveSeatM ?? 0.75}
                onChange={(e) =>
                  updateField('eyeOffsetAboveSeatM', Number(e.target.value))
                }
                style={{
                  width: '100%',
                  padding: '7px 10px',
                  borderRadius: 'var(--radius-inner)',
                  border: '1px solid var(--border-subtle)',
                  background: 'var(--bg-surface)',
                  color: 'var(--text-primary)',
                }}
              />
            </div>
          ) : (
            <div>
              <label
                style={{
                  display: 'block',
                  fontSize: '0.75rem',
                  color: 'var(--text-secondary)',
                  marginBottom: '4px',
                }}
              >
                Independent Wheelchair Eye Height (m)
              </label>
              <input
                type="number"
                step="0.02"
                min="0.80"
                max="1.50"
                disabled={isFrozen}
                value={current.independentEyeHeightM ?? 1.18}
                onChange={(e) =>
                  updateField('independentEyeHeightM', Number(e.target.value))
                }
                style={{
                  width: '100%',
                  padding: '7px 10px',
                  borderRadius: 'var(--radius-inner)',
                  border: '1px solid var(--border-subtle)',
                  background: 'var(--text-primary)',
                  color: '#0f172a',
                }}
              />
            </div>
          )}

          <div>
            <label
              style={{
                display: 'block',
                fontSize: '0.75rem',
                color: 'var(--text-secondary)',
                marginBottom: '4px',
              }}
            >
              Required Front Legroom (m)
            </label>
            <input
              type="number"
              step="0.05"
              min="0.10"
              max="1.20"
              disabled={isFrozen}
              value={current.requiredFrontLegroomM}
              onChange={(e) =>
                updateField('requiredFrontLegroomM', Number(e.target.value))
              }
              style={{
                width: '100%',
                padding: '7px 10px',
                borderRadius: 'var(--radius-inner)',
                border: '1px solid var(--border-subtle)',
                background: 'var(--bg-surface)',
                color: 'var(--text-primary)',
              }}
            />
          </div>

          <div>
            <label
              style={{
                display: 'block',
                fontSize: '0.75rem',
                color: 'var(--text-secondary)',
                marginBottom: '4px',
              }}
            >
              Required Footprint Width (m)
            </label>
            <input
              type="number"
              step="0.02"
              min="0.40"
              max="1.40"
              disabled={isFrozen}
              value={current.requiredFootprintWidthM}
              onChange={(e) =>
                updateField('requiredFootprintWidthM', Number(e.target.value))
              }
              style={{
                width: '100%',
                padding: '7px 10px',
                borderRadius: 'var(--radius-inner)',
                border: '1px solid var(--border-subtle)',
                background: 'var(--bg-surface)',
                color: 'var(--text-primary)',
              }}
            />
          </div>

          <div>
            <label
              style={{
                display: 'block',
                fontSize: '0.75rem',
                color: 'var(--text-secondary)',
                marginBottom: '4px',
              }}
            >
              Required Footprint Depth (m)
            </label>
            <input
              type="number"
              step="0.02"
              min="0.40"
              max="1.60"
              disabled={isFrozen}
              value={current.requiredFootprintDepthM}
              onChange={(e) =>
                updateField('requiredFootprintDepthM', Number(e.target.value))
              }
              style={{
                width: '100%',
                padding: '7px 10px',
                borderRadius: 'var(--radius-inner)',
                border: '1px solid var(--border-subtle)',
                background: 'var(--bg-surface)',
                color: 'var(--text-primary)',
              }}
            />
          </div>

          <div>
            <label
              style={{
                display: 'block',
                fontSize: '0.75rem',
                color: 'var(--text-secondary)',
                marginBottom: '4px',
              }}
            >
              Required Route Width (m)
            </label>
            <input
              type="number"
              step="0.05"
              min="0.50"
              max="1.80"
              disabled={isFrozen}
              value={current.requiredRouteWidthM}
              onChange={(e) =>
                updateField('requiredRouteWidthM', Number(e.target.value))
              }
              style={{
                width: '100%',
                padding: '7px 10px',
                borderRadius: 'var(--radius-inner)',
                border: '1px solid var(--border-subtle)',
                background: 'var(--bg-surface)',
                color: 'var(--text-primary)',
              }}
            />
          </div>

          <div>
            <label
              style={{
                display: 'block',
                fontSize: '0.75rem',
                color: 'var(--text-secondary)',
                marginBottom: '4px',
              }}
            >
              Required Turning Circle (m)
            </label>
            <input
              type="number"
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
              style={{
                width: '100%',
                padding: '7px 10px',
                borderRadius: 'var(--radius-inner)',
                border: '1px solid var(--border-subtle)',
                background: 'var(--bg-surface)',
                color: 'var(--text-primary)',
              }}
            />
          </div>

          <div
            style={{
              gridColumn: '1 / -1',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              paddingTop: '4px',
            }}
          >
            <label
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '8px',
                fontSize: '0.82rem',
                cursor: isFrozen ? 'not-allowed' : 'pointer',
              }}
            >
              <input
                type="checkbox"
                disabled={isFrozen}
                checked={current.prefersAisle}
                onChange={(e) => updateField('prefersAisle', e.target.checked)}
              />
              Prefers Aisle Place (optional preference — reported separately,
              does not block acceptance)
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
            className="vp-btn"
            disabled={isFrozen}
            onClick={() => setDraft(structuredClone(DEFAULT_PROFILE_REQUIREMENTS))}
          >
            Reset to Defaults
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
              Apply &amp; Re-Evaluate Preview
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
