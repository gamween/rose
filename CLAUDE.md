# rose: working rules for coding agents

- `docs/spec.md` is the source of truth. Do not weaken it to make something pass. If the spec is wrong, fix it in a dedicated commit that explains why.
- Work autonomously. Do not ask the owner questions: pick the most professional option, record the decision and its reason in the progress file, continue.
- Working notes (progress, decisions, blockers, research) live outside the repo, in the folder named in `~/.config/rose/notes-path`. Read `Build - Progress.md` there at the start of every turn and update it before ending one. The repo only contains product code and product docs.
- Everything in the repo is in English. No dead code, no commented-out code, no TODO left behind, no placeholder UI.
- Secrets never enter git. Keys live in `~/.config/rose/*.env` or in Vercel env vars; `.env.example` documents every variable.
- Testnet only: NEAR testnet, Base Sepolia, Solana devnet. Never touch mainnet. Never make the GitHub repository public, never submit to the hackathon, never post anywhere on the owner's behalf.
- Verify every external fact live (addresses, versions, method names, byte layouts, gas) before relying on it and record the command in `docs/verification.md`.
- Git: small conventional commits, push to `gamween/rose` (private), PRs with squash-merge are allowed without asking.
- Quality bar: every button works end to end, every async action has loading, success and failure states with explorer links, every page is reviewed at 1470 px and 375 px.
- Reviews: after each milestone, run independent review passes with subagents on a different model (Fable 5.1, then Opus 5.5) focused on correctness, hallucinated APIs and drift from the spec; fix every blocker and major finding before moving on. Multi-agent workflows are allowed for fan-out work.
