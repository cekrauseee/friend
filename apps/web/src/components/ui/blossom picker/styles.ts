// Adapted from Nexvyn Blossom Picker: https://ui.nexvyn.dev/r/color-picker.json
// Copyright (c) 2026 Nexvyn UI. MIT with Commons Clause; see THIRD_PARTY_NOTICES.md.
export const blossomPickerStyles = `
.bcp-root {
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}

.bcp-container {
  position: absolute;
  display: flex;
  align-items: center;
  justify-content: center;
}

.bcp-petal {
  position: absolute;
  border-radius: 50%;
  border: none;
  padding: 0;
  background: none;
  cursor: pointer;
}

.bcp-petal:focus-visible { z-index: 1001 !important; outline: 2px solid var(--ring); outline-offset: 3px; }

.bcp-core {
  position: relative;
  border-radius: 50%;
  border: none;
  padding: 0;
  cursor: pointer;
}

.bcp-core:focus-visible { outline: 2px solid var(--ring); outline-offset: 3px; }
.bcp-slider-handle:focus-visible { outline: 2px solid var(--ring); outline-offset: 3px; }

.bcp-core:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.bcp-svg {
  position: absolute;
  pointer-events: none;
}

.bcp-slider-track {
  pointer-events: auto;
  cursor: pointer;
  touch-action: none;
}

.bcp-slider-handle {
  pointer-events: auto;
  cursor: grab;
  touch-action: none;
}

.bcp-slider-handle:active {
  cursor: grabbing;
}

.bcp-bg-wrapper {
  position: absolute;
  border-radius: 50%;
  pointer-events: none;
}

.bcp-bg-solid {
  position: absolute;
  top: 0;
  right: 0;
  bottom: 0;
  left: 0;
  border-radius: 50%;
  pointer-events: none;
}

@media (prefers-reduced-motion: reduce) {
  .bcp-root, .bcp-root * {
    transition-duration: 0ms !important;
    transition-delay: 0ms !important;
    animation-duration: 0ms !important;
  }
}
@media (forced-colors: active) {
  .bcp-petal:focus-visible, .bcp-core:focus-visible, .bcp-slider-handle:focus-visible { outline-color: Highlight; }
}
`
