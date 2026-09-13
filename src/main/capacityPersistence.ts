/**
 * Durable capacity observations, so a previously-known provider pool survives a
 * restart instead of vanishing until fresh activity happens to produce another
 * reading (L0-SEM section 8; authorised on L0-TAIL).
 *
 * WHAT THE DEFECT ACTUALLY WAS. Every app restart rebuilt `ProviderCapacityTracker`
 * from nothing, so a pool that had been observed - and, while the process lived,
 * correctly degraded to UNKNOWN as its reading aged - instead DISAPPEARED. C2.6
 * wants an unknown pool disclosed, not absent, and those are different answers: an
 * absent pool tells a caller nothing was ever seen, which was false.
 *
 * WHAT IS PERSISTED, AND WHAT IS DELIBERATELY NOT.
 *   - OBSERVATIONS, never derived verdicts. The projection is a conclusion this
 *     process drew; the observation is what the provider said. Restoring the former
 *     would replay a verdict, and the restart rules could not then re-decide it.
 *   - The limit epoch's `since`, AND NOTHING ELSE OF IT - a single number. Ruling 4
 *     requires the epoch IDENTITY to survive, because re-deriving it would stamp a
 *     new `since` on a refusal that never ended; but the first version of this file
 *     crossed the whole struct and claimed it was "identity only, forbidden from
 *     classifying". That was true of the GATE and not of the PAYLOAD, and the gate
 *     lifts: the first live reading cleared it and `nextEpoch` then consumed the
 *     restored anchors, remainders and reached type as though they had been
 *     observed here. A principle is not a payload. Now only the number crosses.
 *   - EVERY RETAINED POOL, including one whose evidence is itself restored. Skipping
 *     those recreated the very defect this file exists to fix: the store is written
 *     by whole-file replacement, so a clean quit with no telemetry in between
 *     rewrote it empty and the next restart had no pool at all.
 *   - NOT a cursor, NOT a presence record for a pool that was never seen, and NOT a
 *     fabricated timestamp or limit id. A clean first install has no file, restores
 *     nothing, and stays honestly absent. Inventing a pool to have something to show
 *     is the failure this whole design is organised against.
 *
 * NO CREDENTIAL MATERIAL CROSSES. An observation carries `accountScope`, which is a
 * hash of a credential LOCATION rather than credential bytes, and `streamId`, which
 * is a rollout file path. Both are identifiers the collection site already chose
 * precisely so that nothing secret is retained; this module adds no field of its own
 * and reads no credential file. A fixture asserts the serialized store against the
 * shapes a secret would take.
 *
 * WHERE IT LIVES. Under `app.getPath('userData')`, which MUNDER_DEV=1 has already
 * repointed at the Dev-isolated root by the time anything here runs, so F1 isolation
 * holds without this module knowing anything about it.
 */
import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import type { CapacityObservation } from '../shared/providerCapacity';
import { OBSERVATION_SOURCES } from '../shared/providerCapacity';
import { IDENTITY_LIMITS } from './capacityEnvelope';
import type { ProviderCapacityTracker } from './providerCapacityTracker';
import { RETENTION_CAPS } from './providerCapacityTracker';

/**
 * Bumped only for a format change that an older reader must refuse.
 *
 * 2: a pool carries `continuitySince`, a number, where version 1 carried the whole
 * derived `epoch` object. That was a real defect and not a tidy-up, so a v1 file is
 * refused outright rather than read leniently - the fields it holds are exactly the
 * unverified classifying facts this version exists to stop crossing.
 */
export const CAPACITY_STORE_VERSION = 2;

/**
 * The ceiling on the file itself, held at the collection's own retention cap.
 *
 * The store holds the same observations the collection holds, so the collection cap
 * is already the right bound and inventing a second, larger one here would let the
 * durable copy carry more than the live collection is ever allowed to.
 */
export const CAPACITY_STORE_MAX_BYTES = RETENTION_CAPS.maxCollectionBytes;

export interface PersistedCapacityPool {
  observation: CapacityObservation;
  /**
   * The `since` of a limit epoch open when the writing process exited, or null.
   *
   * A NUMBER, NOT AN EPOCH. It restores the pool's continuity identity and nothing
   * else: no attribution, no reached type, no anchors, no remainders, no recovery
   * hint. Classifying evidence is rebuilt from live facts or is absent.
   */
  continuitySince: number | null;
}

export interface PersistedCapacityStore {
  version: number;
  /**
   * When the store was written, for diagnostics ONLY.
   *
   * NOTHING AGES AGAINST THIS AND NOTHING MAY. Freshness after a restart is not a
   * function of how long the file sat there: a restored reading is unfresh at every
   * age, so a load that consulted this would be reconstructing the monotonic
   * deadline that the restart destroyed. It is written so a human reading the file
   * can tell when it was made.
   */
  savedAt: number;
  pools: PersistedCapacityPool[];
}

const isDict = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const str = (v: unknown): v is string => typeof v === 'string';
const nullableNum = (v: unknown): v is number | null => v === null || num(v);

/** The ceiling for retained strings that are not identities - `kind`, `label`,
 *  `planType`, `providerReachedType`. Generous enough for any real provider value
 *  and far short of anything that could matter to the per-pool byte cap. */
const FIELD_CHARS = 128;

const bounded = (v: unknown, max: number): v is string =>
  typeof v === 'string' && v.length > 0 && v.length <= max;
const nullableBounded = (v: unknown, max: number): v is string | null =>
  v === null || v === undefined || bounded(v, max);

/**
 * Structural validation of one persisted pool.
 *
 * WHY VALIDATE AT ALL, GIVEN THE TRACKER VALIDATES ITS OWN INPUT. The tracker bounds
 * IDENTITY and enforces the retention caps, which is the safety-bearing half, and it
 * would refuse a hostile identity whatever this function did. But it trusts the
 * SHAPE of what it is handed - a `windows` entry that is a string, a `resetsAt` that
 * is an object - because every other producer is a normalizer that already built the
 * struct. This file is the one input that a person can edit, so it is the one place
 * where the struct itself has to be earned rather than assumed.
 *
 * REJECTED WHOLE, NEVER REPAIRED. A partially-trusted observation is an observation
 * with a fabricated part, and section 13's reject-whole rule applies for the same
 * reason here: we cannot know which half the provider actually said.
 */
function validPool(value: unknown): PersistedCapacityPool | null {
  if (!isDict(value)) return null;
  const o = value.observation;
  if (!isDict(o)) return null;
  // Identity and every other retained string is LENGTH-BOUNDED here, not merely
  // typed. The tracker refuses an unbounded identity, but `provider`, `kind`,
  // `label`, `planType` and `providerReachedType` are retained and published
  // without being identities, so an open string check on this file - the one input
  // a person can edit - left a 300,000-character `kind` structurally "valid".
  if (!bounded(o.poolKey, IDENTITY_LIMITS.poolKeyChars)) return null;
  if (!bounded(o.provider, IDENTITY_LIMITS.identityChars)) return null;
  if (!bounded(o.accountScope, IDENTITY_LIMITS.identityChars)) return null;
  if (!bounded(o.limitId, IDENTITY_LIMITS.identityChars)) return null;
  if (!str(o.source) || !(OBSERVATION_SOURCES as readonly string[]).includes(o.source)) return null;
  if (!num(o.observedAt) || !num(o.receivedAt)) return null;
  if (!nullableBounded(o.streamId, IDENTITY_LIMITS.streamIdChars)) return null;
  if (!nullableNum(o.sourceSequence)) return null;
  if (!nullableBounded(o.providerAttributedLimitingWindowId, IDENTITY_LIMITS.identityChars)) return null;
  if (!nullableBounded(o.providerReachedType, FIELD_CHARS)) return null;
  if (!nullableBounded(o.planType, FIELD_CHARS)) return null;
  if (!(o.ordinaryUsageAllowed === null || typeof o.ordinaryUsageAllowed === 'boolean')) return null;
  if (!Array.isArray(o.windows) || o.windows.length > RETENTION_CAPS.maxWindowsPerPool) return null;
  for (const w of o.windows) {
    if (!isDict(w)) return null;
    if (!bounded(w.windowId, IDENTITY_LIMITS.identityChars) || !nullableNum(w.resetsAt)) return null;
    if (!nullableNum(w.usedPercent) || !nullableNum(w.remainingPercent)) return null;
    if (!nullableNum(w.windowMinutes) || !nullableBounded(w.label, FIELD_CHARS)) return null;
    if (w.kind !== undefined && !nullableBounded(w.kind, FIELD_CHARS)) return null;
    if (w.applicability !== undefined && !nullableBounded(w.applicability, FIELD_CHARS)) return null;
  }

  // CONTINUITY IS A NUMBER, AND THAT IS THE WHOLE OF IT. There is no epoch object
  // to validate any more, which is the point: the fields a v1 file carried here -
  // attribution, reached type, anchors, remainders, the recovery hint - are exactly
  // the unverified classifying facts that must not cross a restart.
  const since = value.continuitySince;
  if (!nullableNum(since)) return null;

  return {
    observation: o as unknown as CapacityObservation,
    continuitySince: (since as number | null) ?? null
  };
}

/**
 * Read the durable store. Returns an empty list for every failure there is -
 * no file, unreadable file, bad JSON, wrong version, wrong shape.
 *
 * NEVER THROWS AND NEVER PARTIALLY TRUSTS A FILE. A capacity store that cannot be
 * believed must leave the collection empty rather than half-populated, because the
 * observable difference between "restored nothing" and "restored some of it" is a
 * collection that silently claims to know about fewer pools than it has - and a
 * missing pool reads as never-seen, which is a statement we would not be entitled
 * to make. One bad entry discards the file, and the app starts as a clean install.
 */
export function loadCapacityStore(file: string): PersistedCapacityPool[] {
  try {
    if (!existsSync(file)) return [];
    const raw = readFileSync(file, 'utf8');
    // UTF-8 BYTES, NOT CHARACTERS, AND THE EXACT BOUND RATHER THAN A DOUBLED ONE.
    // `raw.length` counts UTF-16 code units - the same axis error this project
    // already fixed once in `byteLength` - and a 2x threshold silently admitted a
    // file twice the size the writer is allowed to produce. The serializer bounds
    // the whole document to this figure, so the reader can hold it to the same one.
    if (Buffer.byteLength(raw, 'utf8') > CAPACITY_STORE_MAX_BYTES) {
      console.warn('[capacity] durable store is larger than the collection cap; ignoring it');
      return [];
    }
    const parsed: unknown = JSON.parse(raw);
    if (!isDict(parsed) || parsed.version !== CAPACITY_STORE_VERSION) return [];
    // `savedAt` is diagnostic, but an unvalidated field in a validated file is a
    // field somebody will eventually read as though it had been checked.
    if (!num(parsed.savedAt)) return [];
    if (!Array.isArray(parsed.pools)) return [];
    if (parsed.pools.length > RETENTION_CAPS.maxPools) {
      console.warn('[capacity] durable store holds more pools than the retention cap; ignoring it');
      return [];
    }
    const out: PersistedCapacityPool[] = [];
    for (const entry of parsed.pools) {
      const ok = validPool(entry);
      if (!ok) {
        console.warn('[capacity] durable store has a malformed pool; ignoring the whole store');
        return [];
      }
      out.push(ok);
    }
    return out;
  } catch (e) {
    console.warn('[capacity] durable store unreadable; starting with no restored pools:', e);
    return [];
  }
}

/**
 * Serialize what the tracker currently holds, bounded by the collection cap.
 *
 * Pools are taken in the collection's own order until the next one would put the
 * file over the ceiling, and then it stops. The omitted pools are simply not in the
 * file - which restores as honestly absent, the same answer a pool that was never
 * seen gets. Trimming to fit by editing an observation is not available: a shortened
 * observation is a different observation.
 */
export function serializeCapacityStore(
  tracker: ProviderCapacityTracker,
  savedAt: number
): { text: string; written: number; omitted: number } {
  const all = tracker.persistable();
  const pools: PersistedCapacityPool[] = [];
  let omitted = 0;
  for (const entry of all) {
    const candidate = [...pools, entry];
    const text = JSON.stringify({ version: CAPACITY_STORE_VERSION, savedAt, pools: candidate });
    if (Buffer.byteLength(text, 'utf8') > CAPACITY_STORE_MAX_BYTES) {
      omitted = all.length - pools.length;
      break;
    }
    pools.push(entry);
  }
  const store: PersistedCapacityStore = { version: CAPACITY_STORE_VERSION, savedAt, pools };
  return { text: JSON.stringify(store), written: pools.length, omitted };
}

/**
 * Write the store atomically: a temp file and a rename, so a crash mid-write leaves
 * either the previous store or the new one and never a truncated file that the
 * loader would have to decide how much of to believe.
 */
export function saveCapacityStore(
  file: string,
  tracker: ProviderCapacityTracker,
  savedAt: number
): { written: number; omitted: number } {
  const { text, written, omitted } = serializeCapacityStore(tracker, savedAt);
  const tmp = `${file}.tmp`;
  try {
    writeFileSync(tmp, text, 'utf8');
    renameSync(tmp, file);
  } catch (e) {
    console.warn('[capacity] could not write the durable store:', e);
    try { if (existsSync(tmp)) unlinkSync(tmp); } catch { /* nothing further to do */ }
  }
  return { written, omitted };
}

/**
 * Re-admit a loaded store through the tracker's normal ingestion boundary.
 *
 * Returns how many pools were actually recreated. A restored observation can still
 * be refused - future-dated after a backwards clock move, or carrying an identity
 * this build will not retain - and a refusal here is the correct outcome, not a
 * failure to work around. The pool is then honestly absent.
 */
export function restoreCapacityStore(
  tracker: ProviderCapacityTracker,
  pools: readonly PersistedCapacityPool[]
): number {
  let restored = 0;
  for (const entry of pools) {
    if (tracker.restore(entry.observation, entry.continuitySince).accepted) restored += 1;
  }
  return restored;
}

/**
 * The store as the app uses it: load once at startup, and coalesce writes afterwards.
 *
 * WRITES ARE COALESCED BECAUSE THE COLLECTION MOVES ON EVERY HOOK. Capacity changes
 * as fast as agents take turns, and a synchronous file write per observation would
 * put disk I/O on the hook path for a file whose only reader runs at startup. The
 * delay costs nothing that matters: losing the last few seconds of observations to a
 * hard kill restores an older reading, which is unconfirmed on restore either way.
 */
export class CapacityStore {
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly file: string,
    private readonly tracker: ProviderCapacityTracker,
    private readonly coalesceMs = 5_000,
    private readonly now: () => number = Date.now
  ) {}

  /** Restore at startup. Returns how many pools came back. */
  restore(): number {
    return restoreCapacityStore(this.tracker, loadCapacityStore(this.file));
  }

  /** Note that the collection moved; the write happens once, shortly. */
  scheduleSave(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.saveNow();
    }, this.coalesceMs);
    if (typeof this.timer.unref === 'function') this.timer.unref();
  }

  /** Write immediately - used on quit, where a pending coalesced write would be lost. */
  saveNow(): { written: number; omitted: number } {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    return saveCapacityStore(this.file, this.tracker, this.now());
  }
}
