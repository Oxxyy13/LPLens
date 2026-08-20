# LPLens — agent bootstrap

Canonical MacSync instructions live in `MacSync/AGENTS.md`. Read the C3P0 note
for this project before doing anything here:
`C3P0 Brain/10-projects/lplens.md`.

Three project-specific rules that are easy to get wrong:

1. **This repo is public** (`github.com/Oxxyy13/LPLens`). Never put a credential
   in `extension/`. Keys belong in the options page (Advanced), which writes to
   `chrome.storage.local`. Dan's own copies are in `.env`, which is gitignored
   and excluded from Syncthing. `tools/package.mjs` aborts if a dev fence
   reappears, and `.git/hooks/pre-commit` blocks a commit containing a key.
   The hook is local to each clone and must be re-created after a fresh clone.
2. **`extension/` and the packaged build must stay byte-identical.**
   `node tools/package.mjs && diff -r extension build/lplens-<version>` is empty,
   and `README.md` tells the public to check exactly that. No bundler, no
   minifier, no build step.
3. **Never load the extension unpacked from inside MacSync.** It is a Syncthing
   tree; anything that can write there is writing code Chrome executes. Load
   from the machine-local mirror and re-sync after edits.

UI changes must be verified by rendering, not by `node --check` — several
user-visible defects have passed every Node-level check. The harness is
`docs/design/popup-live.html`.
