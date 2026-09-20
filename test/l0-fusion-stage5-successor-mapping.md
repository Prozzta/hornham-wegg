# L0-FUSION stage 5 — successor mapping for the transitional ticket tests

**Status: SIGNED WITH CONDITIONS by Dwight (2026-09-20); this revision meets the conditions and is what he proves
and signs. Nothing listed here has been deleted, and nothing is deleted until he has.** Written at stage 5.5a
(`9eb9d38e`); updated at 5.6; **CORRECTED at the pin that carries this text** - see "Correction" below.

## What is transitional, and why

Until stage 5.3 the renderer delivered queued messages itself and held half a capacity
transaction: main minted an opaque **ticket** (`beginAutomaticDelivery`), the renderer asked
permission at the keystroke (`markAutomaticDeliveryWriting`) and reported the result
(`settleAutomaticDelivery`). The worker wake asked the same question without a ticket
(`maySubmitNow`), and the control snapshot used the boolean `holds`.

Since stage 5.3 **none of those five methods has a production caller** (pinned by
`the ticket machinery has NO production caller left` in `automatic-submit-wiring.test.cjs`).
Main's one submit owner admits, revalidates through `CapacityRuntime.revalidate` and
confirms in-process, inside one synchronous critical section. The methods survive only
because the 30 tests below still call them.

Three answers are possible for each test, and the difference matters:

- **HELD** — the same guarantee is asserted against the path that now runs. Named test.
- **BY CONSTRUCTION** — the hazard needed an out-of-process deliverer holding half a
  transaction. That party no longer exists. There is nothing left to test, and the row says
  what removed it (and which test pins *that*).
- **GAP** — the old test held something the new path does not visibly hold. **Two rows**
  when this was written; after stage 5.6 and the correction below, ONE: the closure half of row 30 (GAP 2). They are
  reported, not papered over.
- **SUPERSEDED BY RULING** - the old test held a property that a later ruling deliberately CHANGED. The row says what
  the new behaviour is and what proves THAT; it does not pretend the old property is still held. **Rows 3, 4, 22.**

Test files: `AS` = `automatic-submit.test.cjs` (killers `K.*`, each with census mutants),
`ASW` = `automatic-submit-wiring.test.cjs` (real `CapacityRuntime` + tracker; `KR.*` are the
`revalidate` killers with their own mutant census), `ASH` = `automatic-submit-harness.test.cjs`.

## A. `provider-capacity-delivery-death.test.cjs` — 19 tests

| # | Old test | Guarantee | Successor | Status |
|---|---|---|---|---|
| 1 | A15: a death AFTER the submit keystroke does NOT hand out a second recovery turn | once the Enter may have landed the turn stays spent | AS `criticalSectionNeverYields` + `commitsInOrder` (confirmLaunch runs in the same synchronous section as the Enter: there is no "after the Enter, before the confirm" for anything to die in); ASW `a RECOVERING pool: the owner's own reservation…` (asserts the turn IS spent after COMMIT) | HELD |
| 2 | A15: a death BEFORE the write DOES return the turn | an abandoned, untyped delivery gives the turn back | AS `stageFailureTypesNothingAndReturnsTheGrant`, `lateRefusalAborts`, `preStageHumanIsRefusalNotInterference`, `respawnInGapNeverReceivesTheEnter` (every pre-Enter exit asserts `cancelled.length === 1`) | HELD |
| 3 | A15: the two deaths reach DIFFERENT outcomes | the recorded fact, not a constant, decides | **SUPERSEDED BY RULING - not a same-property successor.** The old pair was "write began -> turn SPENT" against "write not begun -> turn RETURNED". After the G1b ruling the owner has THREE outcomes and a failed Enter is none of the old two: it is INTERFERED and its grant is HELD. What survives, and is proven, is only that the outcomes stay DISTINCT and are decided by what happened: AS `everyOutcomeAccountsForItsGrant` (confirmed / returned / held, each exactly once) and the mutants `a failed Enter confirmed as a launch` and `a failed Enter hands the turn back while our payload is on the prompt`, killer `enterFailureHoldsTheGrantForAHuman` | SUPERSEDED BY RULING |
| 4 | A15: a LIVE report of a failed write beats the inference from silence | ~~a known failure returns the turn~~ -> a known failed Enter is NOT a launch, and the turn is HELD for a person | **SUPERSEDED BY RULING.** The old guarantee - a reported failed write RETURNS the turn - **no longer holds and is not claimed**: our payload is still on a live prompt where a person can press Enter, so the grant is held as possibly launched until a human resolves it or the terminal dies. AS `enterFailureHoldsTheGrantForAHuman`; ASW `an Enter that THROWS is not a launch - and the recovery turn is HELD FOR A HUMAN, not handed back`. These prove the NEW behaviour; they are NOT evidence that a failed Enter returns the turn | SUPERSEDED BY RULING |
| 5 | A15: a mark is not a confirm | asking permission spends nothing | ASW `TOCTOU on revalidate: ownReservationIsNotARefusal` (revalidate is a read: asked, then the grant is still cancellable and then reports `CLAIM_GRANT_LOST`); ASW `FIX4`-equivalent below (#28) | HELD |
| 6 | A15: a mark for a RECLAIMED ticket cannot reach the reservation that replaced it | a stale claim cannot act on a newer reservation | ASW `KR.ownReservationIsNotARefusal` (a claim whose grant was handed back answers `REFUSE / CLAIM_GRANT_LOST`; mutant `a lost grant still authorises`) | HELD |
| 7 | A15: stopping the runtime reads the mark too | shutdown with a delivery in flight | there is no ticket for `stop()` to settle: grants live in the admission seam, in main's memory, and die with the process; restored pools come back `restoredUnconfirmed` = UNKNOWN (L0-TAIL tests) | BY CONSTRUCTION |
| 8 | A15: on an AVAILABLE pool the fix refuses nothing | the gate is not a throttle | ASW `L0-WAKE via the owner: a permitted wake types, in order`; AS `commitsInOrder`; AS `settleHoldsTheNextSubmission` | HELD |
| 9 | L0-FIX9: a LIVE ticket is granted permission to type | the gate is not a blanket refusal | ASW `KR.limitedAfterAdmission` (precondition arm: `ALLOW / AVAILABLE`), `KR.boundToOneTerminal` (own terminal allowed) | HELD |
| 10 | L0-FIX9: a SETTLED ticket refuses | a finished delivery cannot type again | AS `replayAfterCommitWritesNoSecondEnter`, `oneStableIdPerMessageDeliversAtMostOnce` | HELD |
| 11 | L0-FIX9: an EXPIRED ticket refuses, successor undisturbed | refusal is local to its claim | ASW `KR.ownReservationIsNotARefusal` (the stranger claim is refused while the holder is allowed); AS `differentPtysDoNotBlockEachOther` | HELD |
| 12 | L0-FIX9: granting permission twice is granting it once | idempotent, spends nothing | `revalidate` is asked more than once in every delivery - before STAGE and again at COMMIT (AS `unknownPolicyIsAppliedBeforeStage` / `…AtCommit`) and the launch is confirmed exactly once (AS `commitsInOrder`: `confirmed.length === 1`) | HELD |
| 13 | L0-FIX9: the ANSWER and the RECORD are the same act | no window between "may type" and "recorded as typing" | AS `criticalSectionNeverYields` (check → Enter → confirm in one synchronous function; mutant `an await between the final check and the Enter`) | HELD |
| 14 | L0-TOCTOU: LIMITED after the ticket was minted REFUSES | | ASW `KR.limitedAfterAdmission` (+ mutant `the epoch comparison dropped`); end to end: ASW `a limit arriving INSIDE the gap stops the Enter and erases the nudge` | HELD |
| 15 | L0-TOCTOU: RESERVE_ONLY refuses an ORDINARY turn | | ASW `KR.reserveOnlyAfterAdmission` (+ mutant `structural checks only - admission is never re-asked`) | HELD |
| 16 | L0-TOCTOU: readings moved to ANOTHER pool | | ASW `KR.poolMoved` (+ mutant `a moved pool goes unnoticed`) | HELD |
| 17 | L0-TOCTOU: a grant is bound to ONE terminal | | ASW `KR.boundToOneTerminal` (+ mutant `the terminal binding dropped`); and the request can no longer NAME a terminal at all: ASW `the one door: autoSubmit:submit names an AGENT and a CLASS, never a PTY` | HELD |
| 18 | L0-TOCTOU: a RECOVERING ticket is NOT refused by its own reservation | | ASW `KR.ownReservationIsNotARefusal` (+ mutants `the carve-out removed`, `the carve-out opened to strangers`) | HELD |
| 19 | L0-WAKE: the shared check answers for a claim that holds NO ticket | | every claim is ticketless now; ASW `revalidate keeps the verdict tri-state…` and all five `KR.*` | HELD |

## B. `provider-capacity-pin3.test.cjs` — 8 tests (PIN3/4)

| # | Old test | Successor | Status |
|---|---|---|---|
| 20 | TWO agents on one recovering pool cannot both be authorised | the reservation is made by `admit()` itself (unchanged, `provider-capacity-admission.test.cjs`); through the owner: ASW `KR.ownReservationIsNotARefusal` (second asker `REFUSE`) | HELD |
| 21 | the probe still does NOT spend | `provider-capacity-admission.test.cjs` probe tests (unchanged); the snapshot handler probes: ASW `the control snapshot is computed through the ONE resolver` | HELD |
| 22 | a CONFIRMED delivery spends the grant; ~~a failed one returns it~~ -> a failed one is HELD | **SUPERSEDED BY RULING (second half).** Confirmed spends: AS `commitsInOrder`; ASW `a RECOVERING pool: the owner’s own reservation is not a refusal of the owner`. A delivery whose Enter FAILED does **not** return the grant: it is HELD until a human resolves it ("already handled" confirms, "send queued message" returns) or the terminal dies (spent) - AS `enterFailureHoldsTheGrantForAHuman`, `interferedKeepsTheGrantInSuspense`, `alreadyHandledNeverTypesItAgain`, `sendAgainDeliversExactlyOnce`, `aDeadTerminalSpendsTheHeldGrant`; against the real admission seam ASW `grant in suspense (REAL admission): *`. Deliveries that never reached the Enter still return it (row 2) | HELD (first half) / SUPERSEDED BY RULING (second half) |
| 23 | an ABANDONED ticket returns its grant on MAIN's own expiry | **CLOSED at `4352578e`** (was GAP 1). There is no ticket and no out-of-process deliverer to abandon one; what the expiry protected - a grant that is never accounted for - is held by AS `everyOutcomeAccountsForItsGrant`: COMMITTED, three REFUSED, FAILED, ABORTED and three INTERFERED paths, each confirmed / returned / held exactly once, a held grant settled exactly once by its resolution; census mutants `INTERFERED returns the grant (G1b as it stood before the ruling)` and `an abort that could not verify its erase returns the grant`. The readiness timeout returns the grant: AS `noPtyAndNotReady`. (The seam's own 60 s abandonment of an UNHELD reservation is unchanged and still tested: ASW `aGrantHeldForAHumanOutlivesTheReservationTtl`, control arm) | HELD |
| 24 | a late settle for an already-expired ticket is a no-op | no settle message exists; the outcome is recorded against the request id: AS `replayAfterCommitWritesNoSecondEnter`, `mismatchedReplayRejects` | BY CONSTRUCTION |
| 25 | stopping the runtime settles outstanding tickets, no timer armed | as #7; the owner's timers are `unref`'d (`buildOwnerDeps`) | BY CONSTRUCTION |
| 26 | an AVAILABLE pool is authorised every time | as #8 | HELD |
| 27 | a LIMITED pool is refused and no ticket is minted to leak | ASW `a refused wake types NOTHING`; AS every REFUSE cell of `policyTableIsTotal` | HELD |

## C. `provider-capacity-runtime.test.cjs` — 3 tests (FIX4, `holds()`)

| # | Old test | Successor | Status |
|---|---|---|---|
| 28 | holds() reports a refusal WITHOUT spending the recovery turn | the snapshot uses `admission.probe` + `capacityGateOf`: ASW `the control snapshot is computed through the ONE resolver, and carries the evidence` | HELD |
| 29 | holds() is true exactly when an ordinary automatic start is refused | superseded on purpose: `holds` was `verdict === 'REFUSE'`, one of the four inequalities under which UNKNOWN proceeded unchosen. The successor is the ratified table: AS `unknownPolicyIsOneNamedValue`, `unknown mapping *`, `anOutlookNamesAHoldAndLiftsNothing` | HELD (stricter) |
| 30 | a RESERVE_ONLY pool holds ordinary work but not closure work | ordinary: ASW `KR.reserveOnlyAfterAdmission`. **Closure work: see GAP 2** | GAP (half) |

## Correction (rows 3, 4, 22, 23) - required by Dwight before he would sign

Dwight's audit of the 30 rows: rows 1, 5-21 and 24-29 CONFIRMED subject to their named successors / the absence
census; row 2 CONFIRMED (pre-Enter only); rows 7, 24, 25 BY CONSTRUCTION confirmed; row 30's ordinary half
confirmed, its closure half = the declared GAP 2; GAP 1 genuinely CLOSED. **He could not sign four rows as written:**
they described the OLD "the turn is returned" behaviour as though a successor still proved it, contradicting this
document's own 5.6 update. Those are properties CHANGED BY RULING, not same-property successors, and the table now
says so. The superseding authority, with dates:

- **The human, 2026-09-20 (card `L0-S5-RESOLVED-UX`, option B):** "Replace the single ambiguous "resolved" action
  with two explicit outcomes ... Do not attempt to infer which happened from the terminal prompt being empty. Prompt
  emptiness is not proof that the queued message was submitted. ... Keep the current INTERFERED protections: no timer;
  no automatic Enter; no automatic clear; no overwrite; no retry until human resolution".
- **Michael (god), 2026-09-20, ruling G1b:** "while INTERFERED our payload is on the prompt and a human may press
  Enter at any moment, so the evidence HAS run out: the grant is NOT returned at INTERFERED; it stays accounted as
  possibly-launched until the human resolves. 'Already handled - drop' CONFIRMS the launch (spent). 'Send queued
  message' returns that grant and the re-admission asks capacity afresh." Confirmed the same day for
  `ENTER_WRITE_FAILED` ("held rather than returned, every INTERFERED through one function - ACCEPTED; no exception
  wanted") and for a hold that outlives its terminal ("SPENT (fail toward launched) ... consistent with A15").

**The rows as they read BEFORE this correction, kept so the history is honest:**

> row 3, before:
> | 3 | A15: the two deaths reach DIFFERENT outcomes | the recorded fact, not a constant, decides | AS mutant `a failed Enter confirmed as a launch` (kills collapsing confirm/cancel into one) with killer `enterFailureHoldsTheGrantForAHuman` | HELD |

> row 4, before:
> | 4 | A15: a LIVE report of a failed write beats the inference from silence | a known failure returns the turn | AS `enterFailureHoldsTheGrantForAHuman`; ASW `an Enter that THROWS is not a launch - the recovery turn goes back` | HELD |

> row 22, before:
> | 22 | a CONFIRMED delivery spends the grant; a failed one returns it | AS `commitsInOrder`, `enterFailureHoldsTheGrantForAHuman`; ASW `a RECOVERING pool…` | HELD |

> row 23, before:
> | 23 | an ABANDONED ticket returns its grant on MAIN's own expiry | **see GAP 1** | GAP |


## Commitments of the deletion commit (conditions of the signature)

1. The five dead `CapacityRuntime` methods - `beginAutomaticDelivery`, `markAutomaticDeliveryWriting`,
   `settleAutomaticDelivery`, `maySubmitNow`, `holds` - and the 30 transitional tests are deleted **TOGETHER, in one
   commit**. GAP 2 is acceptable as BY CONSTRUCTION / no production caller **only on that condition**.
2. That commit adds a test asserting the five names are **ABSENT FROM ALL OF `src`** - not merely "no production
   caller" - over the parser-based `codeOnly` (`test/read-source.cjs`), never a regex stripper.
3. **Any future closure-work caller must add an explicit admission class and a cell in `READY_GATE_POLICY`.** Closure
   work may not reach the owner by borrowing `ORDINARY_TURN` or any existing class.
4. The suite counts are reported with their arithmetic (what left, what stayed), verified in a fresh CRLF checkout under
   BOTH provider environments.

## The two gaps

> **UPDATE, stage 5.6 (after this mapping was written).** GAP 1 is CLOSED: AS
> `everyOutcomeAccountsForItsGrant` enumerates the outcomes and proves each accounts for
> its grant exactly once. GAP 1b is RULED (god, consistent with A15 and the human's option
> B): the grant is NOT returned at INTERFERED; it is held as possibly launched
> (`holdGrantForHuman`, which no timer abandons) until a person resolves - "already handled"
> confirms it, "send queued message" returns it - or the terminal dies (spent). Rows 2-4
> and 22 read accordingly: a failed Enter no longer returns the turn, it HOLDS it
> (AS `enterFailureHoldsTheGrantForAHuman`, ASW `an Enter that THROWS...HELD FOR A HUMAN`).
> GAP 2 stands. The text below is kept as written.

**GAP 1 — a delivery that never finishes (row 23).** The ticket had a 30 s main-owned
expiry, so a deliverer that vanished returned its recovery turn. The owner has no such
expiry because its deliverer cannot vanish independently of main — but it CAN wait. ADMIT
comes BEFORE READY, so a submission parked at READY holds a RECOVERING pool's single turn
for up to `READY_TIMEOUT_MS` (30 s, the same order as the old ticket TTL), and an abort
holds it for up to two `SCREEN_ORACLE_TIMEOUT_MS`. Every exit I can find returns the grant:
the readiness timeout (AS `noPtyAndNotReady`: `a readiness timeout returns the grant`), and
rows 2 and 4. I have **not** found a leak. What is missing is a test that says so in one place: "for
every non-COMMIT outcome the grant is returned, and no outcome is reachable that returns
neither confirm nor cancel". I propose to add that as a killer (enumerating outcomes) in
the deletion commit, before the ticket tests go.

**GAP 1b — INTERFERED returns the turn while the payload is still on the prompt.** Related,
and a design question rather than a missing test. A15's rule was *"where the evidence
genuinely runs out we fail toward ALREADY LAUNCHED, because a missed turn is visible and
recoverable and a duplicate send is neither."* On INTERFERED (`HUMAN_INPUT_AFTER_STAGE` and
every abort-side INTERFERED) the owner calls `cancelGrant` — it fails toward NOT LAUNCHED —
while our payload sits on the prompt where the human may press Enter on it. If they do, a
turn is launched on a RECOVERING pool whose single turn has been handed back, and admission
can grant it again to another agent. Only `ENTER_WRITE_FAILED` keeps the turn. The
counter-argument: a human pressing Enter is a human turn, which capacity never gates. This
is the same fact pattern as the open card L0-S5-RESOLVED-UX (the human submits our payload
themselves) and should be ruled with it. **Nothing is changed here.**

**GAP 2 — closure work (row 30).** `WorkClass` has a closure class that RESERVE_ONLY still
allows. No production caller submits closure work through the owner (every admission class
maps to `ORDINARY_TURN`), so the owner path neither offers nor tests it. The admission
seam's own closure tests are untouched and stay. If closure work is ever automated it needs
an admission class and a cell in `READY_GATE_POLICY`; until then the old test's second half
has no successor **because it has no caller**. Recorded, not built.

## What the deletion commit would contain (NOT done)

1. Delete rows 1–19, 20–27 and 28–30 and the five methods, the `PendingDelivery` type,
   `AUTO_DELIVERY_TTL_MS`, `pending`, `ticketSeq` and `expireAutomaticDelivery`.
2. Keep `DeliveryClaim`, `CLAIM_REASON` and `revalidate`.
3. ~~Add the GAP 1 killer first, in the same commit~~ - DONE EARLIER, at `4352578e`
   (`everyOutcomeAccountsForItsGrant`), so grant accounting is already pinned before anything is deleted.
4. Turn `the ticket machinery has NO production caller left` into "is gone": the five names
   appear nowhere in `src` (see "Commitments of the deletion commit" above - it is a condition of the signature).
