---
name: animate
description: >-
  Build UI animations from scratch following Emil Kowalski's animation philosophy. Use when asked to animate components, add UI motion, create transitions, or make an interface feel responsive and alive.
---

# Building Animations (Emil Kowalski Philosophy)

A construction skill for frontend motion. It does **one** thing: turn a request for animation into a production-ready UI implementation that adheres to high design-engineering standards. 

Rather than treating motion as decorative flair, treat it as functional interaction design.

---

## 1. Operating Rules

1. **Run the sequence in order.** Steps 1 and 2 gate everything. Do not pick a curve or library until you know whether the element should animate at all.
2. **Never present motion as a menu of options.** Make the design call, state the single-line justification, and write the code.
3. **No guessed or arbitrary values.** Every easing curve, duration, and spring config must come from the standard tables below.
4. **Extend codebase tokens.** If the project already defines design tokens (e.g. `--ease-out`, `--duration-fast`), reuse and align with them.

---

## 2. The 6-Step Construction Sequence

```text
┌──────────────────────┐     ┌──────────────────────┐     ┌──────────────────────┐
│ 1. Frequency Gate    │ ──> │ 2. Name Purpose      │ ──> │ 3. Cheapest Tool     │
│ Does it animate?     │     │ Why does it move?    │     │ CSS vs WAAPI vs Lib  │
└──────────────────────┘     └──────────────────────┘     └──────────────────────┘
            │
            ▼
┌──────────────────────┐     ┌──────────────────────┐     ┌──────────────────────┐
│ 4. GPU-Only Props    │ ──> │ 5. Easing & Timing   │ ──> │ 6. Interruption      │
│ Transform & Opacity  │     │ No ease-in, <300ms   │     │ Reduced motion check │
└──────────────────────┘     └──────────────────────┘     └──────────────────────┘
```

### Step 1: Should it animate at all? (The Frequency Test)
- **High-Frequency Actions (100+ times/day per user)**:
  - Type-ahead autocomplete suggestions, selecting rows in dense data tables, switching utility tabs, rapid checkbox toggling.
  - **Verdict**: **No animation**. Instant state change only. Motion on high-frequency controls causes fatigue and cognitive drag.
- **Low-to-Medium Frequency Actions (<20 times/day)**:
  - Modals, popovers, dropdown menus, drawers/sheets, toasts, page navigation, accordion expands.
  - **Verdict**: **Animate**.
- **Keyboard Shortcuts**:
  - `Cmd+K` palette trigger, `Escape` to close, `Enter` to submit.
  - **Verdict**: **Instant entrance** (no entrance animation; exit animation is acceptable if brief).

*If the test says no, stop. State the frequency rationale and write zero motion code.*

### Step 2: Name the Purpose
Before writing code, identify the specific purpose of the motion:
1. **Feedback**: Button compresses slightly or a toggle slides to confirm user action.
2. **Spatial Consistency**: Modal scales outward from the button that triggered it; a drawer slides from its screen edge.
3. **State Indication**: Chevron rotates $180^\circ$ to indicate collapsed vs expanded state.
4. **Preventing Jarring Change**: Filtered grid items smoothly rearrange via layout transitions instead of popping.
5. **Delight**: **Rare tier only** (first-run onboarding or task completion celebration). *Never invoke "delight" to justify a bouncy dropdown or sluggish tooltip.*

### Step 3: Pick the Cheapest Tool
Use the lowest-overhead tool that fulfills the requirement:
1. **CSS Transitions** (`transition: opacity 150ms ease, transform 150ms ease`): Default choice for hover, focus, active, and class-based visibility toggles.
2. **CSS `@starting-style`**: For animating entering DOM elements (dialogs, popovers) in modern browsers without JavaScript overhead.
3. **CSS Keyframes**: For continuous periodic motion (spinners, skeleton shimmer).
4. **Web Animations API (WAAPI)**: When values are driven dynamically by pointer coordinates or gestures without React state rerenders.
5. **Motion (`framer-motion` / Motion)**: Only when layout reflow animations (`layoutId`), complex shared element transitions, or gesture drag physics are strictly required. Never import `<motion.div>` if a CSS transition suffices.

### Step 4: Animate Cheap (GPU-Composited) Properties Only
- **Permitted**: `transform` (`translate`, `scale`, `rotate`) and `opacity`.
- **Forbidden on main thread**: `width`, `height`, `top`, `left`, `margin`, `padding`, `flex-basis`, or raw `box-shadow` transitions.
- **The Anti-`scale(0)` Rule**:
  - Never enter or exit from `scale(0)`. Physical objects in the real world do not pop into existence from a mathematical singularity.
  - Instead, enter from `scale(0.94)` to `scale(0.97)` paired with `opacity: 0`.
- **Transform Origin**:
  - Always set `transform-origin` to match the trigger anchor (e.g. `top center` for a dropdown under a button, or the exact cursor click point).

### Step 5: Curve & Duration Standards

| Interaction Type | Duration | Easing Curve (CSS) | Spring Equivalent |
| :--- | :--- | :--- | :--- |
| **Micro-interactions** (toggles, buttons, tabs) | `100ms – 150ms` | `cubic-bezier(0.16, 1, 0.3, 1)` | `stiffness: 400, damping: 30` |
| **Small overlays** (dropdowns, tooltips, menus) | `150ms – 200ms` | `cubic-bezier(0.16, 1, 0.3, 1)` | `stiffness: 350, damping: 25` |
| **Medium surfaces** (dialogs, sheets, modals) | `200ms – 280ms` | `cubic-bezier(0.16, 1, 0.3, 1)` | `stiffness: 300, damping: 25` |
| **Large transitions** (full-page drawers, hero zooms) | `280ms – 360ms` | `cubic-bezier(0.16, 1, 0.3, 1)` | `stiffness: 260, damping: 24` |

- **No `ease-in` on UI Entrances**: Entering objects must decelerate (`ease-out`). An `ease-in` entrance starts sluggishly right when the user is waiting, making the app feel unresponsive.
- **Exits are Brisk**: Exits should run ~30% faster than entrances (e.g., if entrance is `200ms`, exit is `140ms`) because the user has already decided to dismiss.

### Step 6: Interruption, Touch Safety & Accessibility

#### 1. Interruption Safety
If a user closes a surface while it is halfway through opening, the animation must smoothly reverse from its current in-flight coordinates rather than jumping to 0%.

#### 2. Hover Gating (Touch Screens)
Ensure hover effects never stick on mobile taps:
```css
@media (hover: hover) and (pointer: fine) {
  .btn:hover {
    transform: translateY(-1px);
  }
}
```

#### 3. Reduced Motion
Respect user accessibility settings unconditionally:
```css
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
  }
}
```

---

## 3. Reference
For detailed easing definitions and code recipes, see [Curves & Durations](./references/curves-and-durations.md).

