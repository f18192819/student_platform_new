# Reader Design System

## Direction

The Reader is a content-first, adaptive study workspace. Its visual language
uses quiet blue-gray surfaces, restrained blue accents, compact controls, and
coordinated spatial motion. Production tools receive real layout space instead
of covering the document.

## Layout

- Desktop uses a four-slot workspace: related materials, reading stage, right
  inspector, and bottom history.
- At 1440px and above, left and right workspaces may coexist.
- Between 900px and 1439px, one full side workspace is shown at a time.
- Below 900px, workspace tools become touch-oriented bottom drawers.
- Related materials use 280-360px, chat uses 380-460px, and grading uses
  420-520px. The reading stage always receives the remaining width.
- Chat and grading share one right-side slot. Their content crossfades while
  the column width morphs.

## Interaction

- Hover previews a desktop workspace after 150ms; pointer departure closes an
  unpinned preview after 380ms.
- Click pins or closes a workspace. Interacting with grading pins it.
- Escape closes the active preview or the most recently opened workspace.
- The dock is positioned relative to the reading stage, not the viewport.
- PDF state remains mounted while the layout changes. Do not animate the PDF
  with transform scaling.

## Visual Tokens

Reader-specific colors, surfaces, borders, radii, shadows, and motion values
live as CSS custom properties on `.reader-workspace`. New Reader components
should consume those tokens and avoid introducing isolated card styles,
gradients, or arbitrary control heights.

## Accessibility

- Interactive controls require visible keyboard focus.
- Reduced-motion mode disables layout and content transitions.
- Mobile drawers use click interactions rather than hover-only behavior.
- Tool states are communicated through `aria-pressed`, labels, and badges.
