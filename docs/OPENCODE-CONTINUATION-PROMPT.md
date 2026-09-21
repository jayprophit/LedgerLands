# OpenCode Continuation Prompt

Work inside:

`C:\Users\jpowe\Desktop\Projects\LedgerLands`

This is a first-class Aetherius OS application and must have its own Git repository and GitHub repository: `jayprophit/LedgerLands`.

Do not restart the project. Inspect the repository supplied from ChatGPT, run the full verification suite, repair anything failing, then continue through production implementation.

Mandatory loop:

UNDERSTAND -> OBSERVE -> RETRIEVE CONTEXT -> READ TODO -> PLAN -> SEARCH EXISTING IMPLEMENTATION -> BUILD ONE BOUNDED UNIT -> RUN -> MEASURE -> TEST -> VERIFY -> CRITIQUE -> DIAGNOSE -> ADAPT -> RETEST -> RECORD -> COMMIT -> PUSH -> VERIFY REMOTE -> UPDATE TODO -> SELECT NEXT UNBLOCKED TASK -> CONTINUE.

Requirements:

- keep all source under `C:\Users\jpowe\Desktop\Projects\LedgerLands`;
- add LedgerLands to `C:\Users\jpowe\Desktop\Projects\BUILD-TODO.md` as an Aetherius P12/application workstream without deleting existing TODOs;
- integrate through Aetherius Application Registry/shared providers, not by copying LedgerLands source into Aetherius-OS;
- patch Aetherius-OS only for generic application registration/discovery/integration needed to launch `com.aetherius.ledgerlands`;
- use Aetherius Identity, Policy, File/Storage, Settings, Search and Notifications where stable;
- keep financial/real-value capabilities disabled until security/compliance gates are implemented;
- preserve the deterministic game engine boundary;
- build tests before claiming features complete;
- create commits at verified milestones;
- push to `jayprophit/LedgerLands` and verify the remote commit;
- if the GitHub repository does not yet exist, create it using the authenticated GitHub CLI/account, then set `origin` and push `main`;
- do not stop after one task while executable TODOs remain.

Immediate next tasks after verification:

1. Persist MatchStore and event log to PostgreSQL.
2. Add auction/mortgage/trading rules and tests.
3. Add rankings/seasons/tournaments/quests.
4. Add replay/spectator API.
5. Complete Aetherius provider adapters.
6. Add desktop packaging and Aetherius launcher verification.
7. Build testnet blockchain adapters only after the game/ledger foundation passes.
