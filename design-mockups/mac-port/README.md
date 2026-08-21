# Mac port layout studies

Two published design canvases exploring a native Mac client, drawn in the app's
own tokens (bg `#101c2e` lighter than surface `#0d1826`, gold used sparingly,
hairline separators, real rail widths and control heights).

- **Layouts** — 7 surfaces covering all 57 tools, each full screen (1728x1080)
  and windowed (1100x760) so the reflow is visible.
  https://claude.ai/code/artifact/54e90bb1-0c53-4dc1-a190-c0616119e225
- **Shells** — the same two surfaces in Tauri, Electron and native SwiftUI.
  https://claude.ai/code/artifact/9f5bd464-bf33-44c7-9a25-01a6fcc219af

## Regenerating

    python3 gen.py       # 15 artboards + canvas.json
    python3 shells.py    # 7 artboards + canvas-shells.json

Then seed with the `design` skill's `seed-canvas.mjs` and republish to the SAME
artifact URL, or the update creates a second artifact.

Type is a system stack: the canvas has no network egress, so Sora and Cinzel
cannot load and stand-ins carry their weight and proportion.
