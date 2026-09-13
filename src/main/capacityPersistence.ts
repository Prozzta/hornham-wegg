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
 *   - The limit EPOCH, as continuity identity only. This is the one derived
 *     structure that crosses, because `since` IS the continuity: re-deriving it
 *     after a restart would stamp a new epoch on a refusal that never ended. It is
 *     restored as an identity and is not permitted to classify - see `deriveState`.
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
import type { CapacityLimitEpoch, ProviderCapacityTracker } from './providerCapacityTracker';
import { RETENTION_CAPS } from './providerCapacityTracker';

/** Bumped only for a format change that an older reader must refuse. */
export const CAPACITY_STORE_VERSION = 1;

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
  epoch: CapacityLimitEpoch | null;
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
const nullableStr = (v: unknown): v is string | null => v === null || typeof v === 'string';
const nullableNum = (v: unknown): v is number | null => v === null || num(v);

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
  if (!str(o.poolKey) || !str(o.provider) || !str(o.accountScope) || !str(o.limitId)) return null;
  if (!str(o.source) || !(OBSERVATION_SOURCES as readonly string[]).includes(o.source)) return null;
  if (!num(o.observedAt) || !num(o.receivedAt)) return null;
  if (!nullableStr(o.streamId) || !nullableNum(o.sourceSequence)) return null;
  if (!nullableStr(o.providerAttributedLimitingWindowId)) return null;
  if (!nullableStr(o.providerReachedType) || !nullableStr(o.planType)) return null;
  if (!(o.ordinaryUsageAllowed === null || typeof o.ordinaryUsageAllowed === 'boolean')) return null;
  if (!Array.isArray(o.windows)) return null;
  for (const w of o.windows) {
    if (!isDict(w)) return null;
    if (!str(w.windowId) || !nullableNum(w.resetsAt)) return null;
    if (!nullableNum(w.usedPercent) || !nullableNum(w.remainingPercent)) return null;
    if (!nullableNum(w.windowMinutes) || !nullableStr(w.label)) return null;
    if (w.kind !== undefined && !nullableStr(w.kind)) return null;
  }

  const e = value.epoch;
  if (e === null || e === undefined) return { observation: o as unknown as CapacityObservation, epoch: null };
  if (!isDict(e)) return null;
  if (!num(e.since) || !num(e.evidenceAt)) return null;
  if (!nullableStr(e.attributedWindowId) || !nullableStr(e.reachedType)) return null;
  if (typeof e.permissionDenied !== 'boolean' || typeof e.hinted !== 'boolean') return null;
  if (!str(e.anchors) || !isDict(e.remaindersAtRefusal)) return null;
  for (const r of Object.values(e.remaindersAtRefusal)) if (!num(r)) return null;

  return {
    observation: o as unknown as CapacityObservation,
    epoch: e as unknown as CapacityLimitEpoch
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
    if (raw.length > CAPACITY_STORE_MAX_BYTES * 2) {
      console.warn('[capacity] durable store is oversized; ignoring it');
      return [];
    }
    const parsed: unknown = JSON.parse(raw);
    if (!isDict(parsed) || parsed.version !== CAPACITY_STORE_VERSION) return [];
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
    if (tracker.restore(entry.observation, entry.epoch).accepted) restored += 1;
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
