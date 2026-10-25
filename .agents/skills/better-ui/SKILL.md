---
name: better-ui
description: >-
  Design-engineering polish principles for product interfaces by Jakub Krehel. Use when building or reviewing surfaces, icons, micro-interactions, motion details, borders, shadows, optical alignment, or refining UI that feels off.
---

# Details That Make Interfaces Feel Better (Jakub Krehel Philosophy)

Great interfaces rarely come from a single flashy feature. They are the result of compounding micro-details—optical alignment, concentric curves, surface depth, tactile feedback, and restrained motion.

Apply these principles when building, polishing, or reviewing UI components.

---

## 1. The 10% Review Methodology

When reviewing or debugging an interface that "feels off":
1. **Slow it down**: Open DevTools Animations panel and replay transitions at **10% speed**. What feels slightly awkward at 100% speed becomes blatantly obvious at 10%.
2. **Walk every state**: Never stop at the default static view. Inspect:
   - **Hover**: Is feedback instantaneous and gated to fine pointers?
   - **Active (Press)**: Does it provide immediate mechanical compression?
   - **Focus-Visible**: Is there an accessible double-ring focus indicator?
   - **Loading**: Are skeleton shimmers smooth and layout-stable?
   - **Empty / Error**: Are zero-states optically centered with helpful next steps?
   - **Disabled**: Does it convey disabled state without low-contrast unreadability?

---

## 2. Core Principles & Design Rules

### A. Surfaces & Borders

#### 1. Concentric Border Radius
```text
┌──────────────────────────────────────────────┐
│ Outer Radius = Inner Radius + Padding        │
└──────────────────────────────────────────────┘
```
- **The Flaw**: Giving a card and its inner image or button the identical border radius (e.g. `16px`). This pinches the corners and creates awkward padding gaps.
- **The Fix**:
  ```css
  .card {
    padding: 12px;
    border-radius: 16px; /* Outer */
  }
  .card .inner-media {
    border-radius: 4px;  /* Inner = 16px - 12px = 4px */
  }
  ```

#### 2. Surface Depth: Shadows for Elevation, Borders for Structure
- Avoid harsh, opaque 1px borders as the sole divider between surfaces.
- Use layered, diffuse shadows for depth, and subtle alpha borders for structural contrast:
  ```css
  /* Layered elevation with high-contrast accessibility support */
  .surface-card {
    background: var(--bg-card);
    border: 1px solid rgba(0, 0, 0, 0.08); /* Transparent fallback */
    box-shadow: 
      0 1px 2px rgba(0, 0, 0, 0.05),
      0 4px 12px rgba(0, 0, 0, 0.05);
  }

  /* Dark mode equivalent */
  [data-theme="dark"] .surface-card {
    border: 1px solid rgba(255, 255, 255, 0.1);
    box-shadow: 
      0 1px 2px rgba(0, 0, 0, 0.4),
      0 8px 24px rgba(0, 0, 0, 0.3);
  }
  ```

#### 3. Image Contrast Outlines
- When rendering user-uploaded avatars, screenshots, or product images with white or transparent edges, they easily blend into light mode backgrounds.
- Add an inset or fine outline:
  ```css
  .content-image {
    outline: 1px solid rgba(0, 0, 0, 0.08);
    outline-offset: -1px;
  }
  [data-theme="dark"] .content-image {
    outline: 1px solid rgba(255, 255, 255, 0.12);
  }
  ```

---

### B. Tactile Micro-Interactions

#### 1. Button Press Scale
Give clickable controls a crisp, physical press state:
```css
.button {
  transition: transform 120ms cubic-bezier(0.2, 0.8, 0.2, 1);
}

.button:active {
  transform: scale(0.97);
}
```

#### 2. Double-Ring Focus Indicators
Ensure focus rings remain high-contrast regardless of background color:
```css
.interactive:focus-visible {
  outline: none;
  box-shadow: 
    0 0 0 2px var(--bg-surface),  /* Inner ring matching surface */
    0 0 0 4px var(--color-primary); /* Outer ring for sharp contrast */
}
```

#### 3. Optical Alignment
- **Triangles / Play Icons**: Geometric centers of triangles do not match their visual centers of mass. Nudge play icons `1px` or `2px` rightward inside circles.
- **Badges on Avatars**: Offset status pips so their center aligns with the border stroke rather than the raw bounding box edge.

---

### C. Iconography Polish

1. **Stroke Weight Matching**:
   - Pair `1.5px` or `2px` icon stroke weights with standard font weights (`400`–`500`). Heavy `3px` icons paired with body copy look mismatched.
2. **`currentColor` Inheritance**:
   - Always set icon `stroke` or `fill` to `currentColor`. When parent text colors shift on hover, focus, or dark mode, the icon updates automatically.
3. **Directional RTL Flipping**:
   - Flip directional icons in right-to-left locales (`[dir="rtl"] .icon-back { transform: scaleX(-1); }`).
   - Keep universal or symmetric icons un-flipped (magnifying glass, settings gear, media play).

---

## 3. Reference Checklist

For an exhaustive audit checklist covering typography, contrast, and layout spacing, see [Design Engineering Checklist](./references/design-engineering-checklist.md).

