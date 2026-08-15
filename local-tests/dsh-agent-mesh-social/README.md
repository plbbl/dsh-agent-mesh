# DSH Agent Mesh · Guizang social cards

Six 1080×1440 Rednote/Xiaohongshu cards for the GitHub release story of DSH
Agent Mesh.

- Style: Soviet Cold War BUILDING-SYSTEM × Guizang social-card production discipline.
- Evidence: sanitized local DSH screenshots in `assets/`.
- Source template: Guizang `template-swiss-card.html`.
- Rendered outputs: `output/xhs-01.png` through `output/xhs-06.png`.
- Visual language: original 1965–1982 public-system poster grammar — aged paper,
  navy infrastructure, red action marks, ochre supports, hard-edged platforms,
  small workers, and a compressed terrain foundation. No political emblems,
  random slogans, UI-card grid, gradients, or glossy effects.
- Render check: each poster is 1080×1440; the screenshots and all text stay inside
  the safe area; the post-render overlap and density review is recorded below.
- Automated check:

  ```bash
  GUIZANG_SKILL_ROOT=/path/to/guizang-social-card-skill
  node "$GUIZANG_SKILL_ROOT/validate-social-deck.mjs" . --style=soviet
  ```

  ```bash
  DSH_PLAYWRIGHT_MODULE=/path/to/playwright node render.cjs
  DSH_PLAYWRIGHT_MODULE=/path/to/playwright \
  node qa-layout.cjs
  ```

  Final result: `6/6 clean`, `0 fails`, `0 warns`; the custom geometry pass also
  reports no text/block intersections or out-of-board elements.

## Page plan

1. Cover: multiple coding CLIs enter one DSH conversation.
2. Problem: switching should not restart the work.
3. Architecture: DSH → Agent Mesh → native harnesses.
4. Interface evidence: the existing DSH model slot gains a harness/model menu.
5. Tool surface: discover, start/resume, handoff, and bounded route.
6. Takeaway: keep native behavior, add the connection layer.

## QA notes

- No text box intersects another text box, the footer, or the screenshot evidence
  frame in the final render.
- Page 04 uses the sanitized `dsh-model-menu.png` as evidence; it is contained
  rather than cropped so model names remain legible.
- The 4-band 3:4 review finds every page filled by title, system silhouette,
  evidence, rules, or footer; there is no unexplained lower void.
- The cards are intentionally a single BUILDING-SYSTEM package. The previous
  Swiss/IKB treatment is replaced rather than mixed into the new set.
