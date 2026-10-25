# Design Engineering Polish Checklist

Use this audit checklist when reviewing components or inspecting design implementations before shipping.

---

## 1. Surfaces & Spacing
- [ ] **Concentric Radii**: Is every nested element's radius computed as `outer_radius - padding`?
- [ ] **Elevation Contrast**: Does the surface stand out cleanly in both light mode and dark mode?
- [ ] **Image Outlines**: Do user-generated images have a subtle 1px outline to prevent bleeding into identical backgrounds?
- [ ] **Consistent Gaps**: Are gaps between cards and layout margins multiples of a base unit (e.g. 4px / 8px scale)?

---

## 2. Interactive States & Micro-Interactions
- [ ] **Hover Gating**: Are hover states wrapped in `@media (hover: hover) and (pointer: fine)` to prevent mobile tap artifacts?
- [ ] **Mechanical Press**: Do clickable buttons and cards compress subtly on `:active` (`scale(0.97)`)?
- [ ] **Accessible Focus**: Is `:focus-visible` styled with a high-contrast double-ring shadow?
- [ ] **Cursor Consistency**: Do interactive buttons use `cursor: pointer` while disabled items use `cursor: not-allowed` or `default`?

---

## 3. Optical Alignment & Typography
- [ ] **Centering vs Optical Weight**: Are asymmetrical icons (play buttons, arrows) nudged optically rather than mathematically?
- [ ] **Tabular Figures**: Do timers, prices, counters, and statistics tables use `font-variant-numeric: tabular-nums` to prevent horizontal jitter?
- [ ] **Line Heights on Headings**: Do large titles use tight line heights (`1.1`–`1.2`) to prevent loose vertical gaps?
- [ ] **Text Wrapping**: Are titles protected from orphan single words with `text-wrap: balance`?

---

## 4. Iconography
- [ ] **Stroke Weight Balance**: Does icon stroke weight match adjacent typography weight?
- [ ] **Color Inheritance**: Do SVG icons use `currentColor` rather than hardcoded hex colors?
- [ ] **Visual Bounding Boxes**: Are icons enclosed in consistent width/height bounding boxes (e.g. 16x16, 20x20) so alignments never drift?
- [ ] **RTL Support**: Are forward/back arrows and navigation chevrons flipped when `dir="rtl"`?

---

## 5. Performance & Motion Safety
- [ ] **GPU-Only Props**: Are animated properties strictly constrained to `transform` and `opacity`?
- [ ] **Reduced Motion**: Is motion bypassed when `prefers-reduced-motion: reduce` is active?
- [ ] **Transition Specificity**: Does `transition` explicitly target properties (e.g., `transition: transform 150ms, opacity 150ms`) rather than using `transition: all`?

