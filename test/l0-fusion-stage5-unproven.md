# L0-FUSION stage 5+ — what ships UNPROVEN, UNMEASURED or UNDECIDED

One place, so that nothing on it is mistaken for done. Written at stage 5.5a. Each item says
what IS known, what is not, and what would settle it. Nothing here is a claim of safety.

## Undecided — with the human. Nothing is built for any of these.

1. **(c1) stale after a numerically spent window, known reset passed.** Held forever; shown
   as `SPENT_RESET_PASSED`; "send now" is the only exit. god recommends a separate explicit
   post-reset state with one re-probe. No exit is built.
2. **(c2) a refusal with no known reset time.** Held forever; shown as
   `LIMITED_NO_KNOWN_RESET`. No exit is built.
3. **L0-S5-RESOLVED-UX — duplicate delivery after "resolved".** If the human presses Enter on
   our staged payload THEMSELVES and then clicks "resolved", the message is still queued and
   is delivered again; the gate cannot see it because the prompt is empty by then. Measured:
   while text is still on the prompt the gate does refuse (`PROMPT_DRAFT`, harness arm `int`).
   Options A/B/C are with the human.
4. **INTERFERED returns the recovery turn while the payload is still on the prompt**
   (successor mapping, GAP 1b). The ticket design failed toward ALREADY LAUNCHED where
   evidence ran out; the owner fails toward NOT LAUNCHED on every INTERFERED except
   `ENTER_WRITE_FAILED`. Same fact pattern as item 3; should be ruled with it.

## Unmeasured

5. **Multi-line erase, for every provider.** A multi-line payload is sent as one bracketed
   paste. Every MEASURED clear (`claude`, `codex`, `antigravity`: Ctrl-U, 900 ms) was
   measured with a SINGLE-LINE marker. Whether Ctrl-U erases a multi-line bracketed paste in
   each TUI is not measured. The design fails closed if it does not - the differential
   oracle reports `ERASE_NOT_VERIFIED` and the prompt is held for a person (harness arm
   `abn`) - so the cost of being wrong is a held prompt, not a wrong submit. Antigravity is
   the specific suspect: its capture repaints the prompt row in a way the others do not.
   *Settled by:* a multi-line capture per provider replayed through `tui-clear-matrix.ts`.
6. **Live provider TUIs.** The clear matrix replays CAPTURES. A capture is a fixture: a
   provider release can change what Ctrl-U does and no test here would notice until someone
   re-captures. The MEASURED rows are true as of their capture, not as of today.
7. **The capacity-freshness measurement** behind the revised L0-UNKNOWN ruling (85.5 % stale,
   ~24 % of mail held under option B) has MODERATE confidence by Dwight's own qualification:
   no provider/account filtering, whole-record `json.loads`. The ruling did not depend on
   the second decimal; nobody should quote it as if it did.
8. **`NO_STATE` is unreachable in production** as far as I can find (an agent with no reading
   maps to no pool = `NO_POOL`). It has a policy cell and tests, and no way to occur.

## Unproven

9. **`pty.ts` against a real node-pty process.** The fused harness restates `pty.ts`'s
   accounting as a double (node-pty cannot load in a page). Narrowed at 5.5a: the real owner
   now runs through the real wiring against the REAL `PtyManager` under node
   (`automatic-submit-wiring.test.cjs`, `REAL PtyManager: …`), so the generation, the
   timestamp and the incarnation it decides on are the production ones. What is still a
   fake is the OS process behind the session: no test spawns node-pty, so "node-pty accepted
   the bytes" is only ever simulated.
10. **The IPC line, end to end, in a running app.** `autoSubmit:submit`,
    `autoSubmit:resolveInterference`, `pty:promptState` and `autoSubmit:readScreen` are each
    pinned statically on both sides and exercised with the hop replaced by a function call.
    No test sends them through Electron IPC between a real main and a real renderer.
11. **The composer click** was listed by god as an item to record here. It is no longer
    unproven: stage 5.4d (`4e1ac8e0`) mounts the production composer and resolves through a
    TRUSTED Chromium click. What remains unproven about it is item 10, not the click.
12. **Grant return on every non-COMMIT outcome, in one place** (successor mapping, GAP 1).
    Each exit is individually tested; no single test enumerates the outcomes and proves none
    returns neither confirm nor cancel. Proposed for the deletion commit.
13. **A recovery turn can be held for up to 30 s** by a submission waiting at READY
    (`READY_TIMEOUT_MS`), because ADMIT precedes READY. Tested to be returned on timeout;
    not tested is whether 30 s of a RECOVERING pool's only turn is acceptable. It is the
    same order as the ticket TTL it replaces.
14. **The callee census has a stated limit:** a PTY smuggled in under an allowlisted
    non-PTY receiver NAME is invisible to a census of names. The no-alias check, the
    node-pty-importer check and the refusal of `write` taken as a value stand in its way;
    they do not close it.

## Disclosed defect in earlier pins' tests (found and fixed at 5.5a)

15. **The comment stripper used by my absence checks was two regexes, and it had a blind
    spot.** A `google/*` inside a line comment in `src/main/index.ts` opened a fake block
    comment that swallowed lines 3030-3428 - 399 lines, including the `pty:write` handler.
    Every ABSENCE check over `index.ts` from `811c5279` to `4e1ac8e0` was therefore looking
    at a file with a hole in it. PRESENCE checks were unaffected (they would have failed).
    Replaced with a parser-based stripper (`test/read-source.cjs` `codeOnly`); all 78
    affected tests were re-run against the whole file and **none had been hiding a
    violation**. The callee census does not strip at all: it walks the TypeScript AST.

## Retained residuals

16. **The Windows one-column residual** from `636b0482` is retained unchanged.
17. **`hiddenClaude`** spends turns with no capacity admission. Its own card
    (L0-HIDDENCLAUDE); declared at the site; not in this contract.
18. **Line endings.** The repo has `core.autocrlf=true` and no `.gitattributes`; every stage-5
    pin is verified in a fresh CRLF checkout because of it. Its own card.

## Not validated

19. **The validator is down.** As of this note no validator has signed `a1d31313`,
    `818e6e82`, `6d01797e`, `f9f155fa`, `2073142c`, `4e1ac8e0` or this pin. L0-FUSION-BUILD
    does not close until they are, and the deletion half of stage 5.5 waits for a signature
    on `l0-fusion-stage5-successor-mapping.md`.
