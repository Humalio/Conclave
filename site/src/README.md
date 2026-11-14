# Landing site sources

`site/index.html` and `site/architecture.html` are generated. Edit the scripts here, not the HTML, then regenerate both pages from the repository root:

```bash
node site/src/gen-room.js
node site/src/gen-arch-page.js
```

| File | Makes |
|---|---|
| `gen-room.js` | `site/index.html`: the room hero, the three pillars and the closing. It takes the hero drawing and the armchair from `hero-room.html`. |
| `gen-arch-page.js` | `site/architecture.html`: the hub cutaway, how a call travels, trust levels, the tool cabinet and the stack. |
| `gen-arch.js`, `arch-lib.js` | The drawings for the architecture page, including the phone version of its hero. |

The pages have no scripts and no external requests. Fonts are self-hosted from `site/fonts` (Geist and Geist Mono, OFL). Colours follow the flat, warm palette in [docs/brand.md](../../docs/brand.md). Each page has a phone layout at 760 px and below.

The Pages workflow (`.github/workflows/pages.yml`) drops this folder before it publishes `site/`.
