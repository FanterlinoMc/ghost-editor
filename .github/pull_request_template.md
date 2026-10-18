<!-- The hand-off (.claude/TEAM.md §3). Fill every line; write "none" rather than deleting one. -->

**Task:** <!-- plan step / id, and its "done when" -->

```
HANDOFF <branch> @ <short sha>
Gate:       <last 3 lines of scripts/gate.sh>
Review:     <reviewer verdict; each BLOCKER and how it was fixed>
New keys:   <new reel.json keys / beat types / scene kinds / caption styles, with exact fields>
New die():  <new build error messages, for the validator>
edit_truth: <shape unchanged | what changed>
Skipped:    <what was left out and why>
Needs:      <what the other machine or the owner must do>
```

**Checkpoints** (TEAM.md §2)
- [ ] CP1 spec written (field list in `references/reel-json.md` for engine features)
- [ ] CP2 built: opt-in, one test that fails if it breaks, own tests pass
- [ ] CP3 `reviewer`: PASS
- [ ] CP4 `verifier`: PASS (`CHECK: PASS` / `GATE: PASS`, claims re-run)
- [ ] CP5 lead: merged, validator mirrors new fields, staging deployed and answering
- [ ] CP6 owner: accepted on staging; production go-ahead given

🤖 Generated with [Claude Code](https://claude.com/claude-code)
