# Animation Reference: Curves, Durations & Recipes

This reference provides exact curves, timing configurations, and copy-paste recipes following Emil Kowalski's animation specifications.

---

## 1. Standard Easing Curves

```css
:root {
  /* Default responsive ease-out: brisk start, elegant deceleration */
  --ease-out: cubic-bezier(0.16, 1, 0.3, 1);

  /* Subtle micro-interaction ease */
  --ease-micro: cubic-bezier(0.2, 0.8, 0.2, 1);

  /* Quick exit curve: starts immediately, leaves fast */
  --ease-in: cubic-bezier(0.7, 0, 0.84, 0);

  /* Smooth symmetrical transition (layout reflows) */
  --ease-in-out: cubic-bezier(0.65, 0, 0.35, 1);

  /* Standard duration tokens */
  --duration-micro: 120ms;
  --duration-overlay: 180ms;
  --duration-surface: 240ms;
  --duration-exit: 140ms;
}
```

---

## 2. Tested CSS Implementation Recipes

### Dialog / Modal Entrance & Exit
```css
.dialog {
  opacity: 1;
  transform: scale(1);
  transition: 
    opacity var(--duration-surface) var(--ease-out),
    transform var(--duration-surface) var(--ease-out);
  transform-origin: center center;
}

.dialog[data-state="closed"] {
  opacity: 0;
  transform: scale(0.96);
  transition: 
    opacity var(--duration-exit) var(--ease-in),
    transform var(--duration-exit) var(--ease-in);
  pointer-events: none;
}
```

### Modern Popover using CSS `@starting-style`
```css
.popover {
  opacity: 1;
  transform: scale(1) translateY(0);
  transition: 
    opacity 180ms var(--ease-out),
    transform 180ms var(--ease-out),
    display 180ms allow-discrete,
    overlay 180ms allow-discrete;
}

@starting-style {
  .popover:open {
    opacity: 0;
    transform: scale(0.95) translateY(-4px);
  }
}
```

### Interactive Button Press (Micro-interaction)
```css
.button {
  transition: transform 120ms var(--ease-micro);
  will-change: transform;
}

@media (hover: hover) and (pointer: fine) {
  .button:hover {
    transform: translateY(-1px);
  }
}

.button:active {
  transform: scale(0.97) translateY(0);
  transition-duration: 80ms;
}
```

### Dropdown Menu (Anchored Entrance)
```css
.dropdown-content {
  transform-origin: var(--radix-dropdown-menu-content-transform-origin, top center);
  opacity: 1;
  transform: scale(1);
  transition: 
    opacity 150ms var(--ease-out),
    transform 150ms var(--ease-out);
}

.dropdown-content[data-state="open"] {
  animation: dropdown-enter 150ms var(--ease-out);
}

.dropdown-content[data-state="closed"] {
  animation: dropdown-exit 100ms var(--ease-in);
}

@keyframes dropdown-enter {
  from {
    opacity: 0;
    transform: scale(0.95);
  }
  to {
    opacity: 1;
    transform: scale(1);
  }
}

@keyframes dropdown-exit {
  from {
    opacity: 1;
    transform: scale(1);
  }
  to {
    opacity: 0;
    transform: scale(0.97);
  }
}
```

---

## 3. Motion / Framer Motion Equivalents

When using React `motion`:

```typescript
// Dialog or Surface spring
export const dialogTransition = {
  type: "spring" as const,
  stiffness: 300,
  damping: 26,
  mass: 0.8,
};

export const dialogVariants = {
  initial: { opacity: 0, scale: 0.95 },
  animate: { opacity: 1, scale: 1, transition: dialogTransition },
  exit: { 
    opacity: 0, 
    scale: 0.97, 
    transition: { duration: 0.14, ease: [0.7, 0, 0.84, 0] } 
  },
};
```

