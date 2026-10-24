# Brief for the Mac (Ahmed's machine and his Claude)

This is the whole context a Claude session on the Mac needs. Read it before changing anything.

## The one rule

**The engine is this repo: `github.com/FanterlinoMc/ghost-editor` (the "fork").** It is what production
renders with. Ahmed's old engine in the phantasic repo (`engine/core/` on `Ahmedmkarrar/phantasic`) is
**frozen**: do not commit to it any more. Everything in it up to 12 Oct was ported here by hand on
18-19 Oct (branch `engine/ahmed-rest`, production since 19 Oct). Two engines that drift apart are what
cost two days of hand-porting; it must not happen again.

## Where to start

```bash
git clone https://github.com/FanterlinoMc/ghost-editor.git && cd ghost-editor
git checkout engine/ahmed-rest          # = production (pinned 4388cd2) plus this brief and scripts/gate.sh
                                        # needs node 22+, ffmpeg/ffprobe; python3 with numpy + opencv for some tests
bash scripts/gate.sh                    # must print GATE: PASS before you change anything
```

If the gate fails on the Mac **before you change anything**, stop and report it (byte-identity
golden hashes were recorded on Windows; a platform difference has to be fixed first, not worked around).

## How work flows

1. One branch per piece of work, named `mac/<topic>` (e.g. `mac/lottie`, `mac/sound-pack`), from the
   newest `engine/ahmed-rest` (or `main` once it is moved there; the PC will say).
2. Small and often: push at least daily. A branch should be mergeable in under a day of review.
3. Before every push: `bash scripts/gate.sh` prints `GATE: PASS`.
4. Every new reel.json key, beat type, scene kind or caption style:
   - is **opt-in** (written to the page only when the key or beat is set), so existing reels stay
     byte-identical;
   - is documented in `references/reel-json.md` with its exact field list and types;
   - has a test in `scripts/*.test.mjs` that builds a small reel with it.
   The PC mirrors those field lists in the planner's validator (`engine/planner/validate.py` in the
   phantasic repo). If the field list is missing, the feature cannot ship.
5. Open a PR into the fork; its description is the hand-off (`.github/pull_request_template.md`).
   The PC (Fanterlino's laptop) is the only integrator: it merges and takes the change to release.
   The Mac never releases anything and needs no service keys.

## Never

- `node scripts/byte-identity.mjs --record` (rewrites the reference; only the PC does it, deliberately).
- Remove or rename fork-only features: `edit_truth`, sections (`SECTION_`), multi-source takes
  (`SOURCES`, `takeEndAt`), `layers`, `room`, `joins`, `motion` beats (`compileMotion`), blank reels,
  `style-path`. The gate counts them.
- Edit files the PC owns (below) in the same branch as engine work.
- Kill processes by name (`killall node`, `pkill -f ...`): only by PID you started.
- Paid API calls without the owner's say. No secrets in commits; this repo is **public**.
- Commit licensed audio, music, fonts or art to this repo (it is public, MIT). Assets go where the
  owner decides (see the plan); commit only manifests that point at them.

## The team and the checkpoints

The full rules, who owns which files, the seven quality checkpoints and the hand-off format are in
**`.claude/TEAM.md` in the phantasic repo** (clone it next to this one and read it). That file is the
single source; this brief only gets you started. The agents in this repo's `.claude/agents/`
(`engine`, `ingest-formats`, `reviewer`, `verifier`) follow it.

In short: the Mac owns this repo's engine files; the PC owns the planner and the studio. The contract
between the two is `references/reel-json.md`: for each new element the field list is agreed there
first (a small PR), then both sides build in parallel.

**Two rules the owner added on 24 Oct, both in TEAM.md — read §3, §4 and the model table in §1 before
your first hand-off:**

- **A hand-off is a pointer, not a report.** 30 lines at most. Test output means the single
  `GATE:`/`CHECK:` line plus every failure in full — never the list of passing tests. No file
  contents, no diffs, no listings: name the path and the sha. Cite a contract as `<file> §<section>`
  instead of explaining it again. Subagents answer in 300 words or fewer.
- **`STATE.md` in the phantasic repo is the status.** One row per branch. Edit your branch's row in
  the same commit that changes it, and read it instead of asking the PC where things stand. Entries in
  `MAC-FEEDBACK.md` and `MAC-TASKS.md` now go **newest first**, 20 lines each, so a reader can take
  the top and stop — or read only what is new with
  `git diff <sha>..origin/main -- MAC-FEEDBACK.md`.

Each agent file here now names its own model (`engine` and `reviewer` on Opus, `ingest-formats` and
`verifier` on Sonnet), so you do not pass one by hand. Use Haiku for lookups — finding a file, reading
a log, updating a `STATE.md` row.

## Current work for the Mac

See the vault note "Phantasic Next Stage — Two Machines (19 Oct)" (owner shares it). In short:
1. Push anything unpushed on the Mac (in either repo) so nothing is lost; say what it is.
2. Run the gate on `engine/ahmed-rest`; report PASS/FAIL.
3. Assets: list every audio pack, music bed, art and engraving file the templates use, with source and
   licence, so the owner can decide where they live. Do not commit them here.
4. Acceptance: render each template on the AI ROI clip and compare with the approved samples.
5. Then the element work (`mac/lottie` first), one PR per element.
