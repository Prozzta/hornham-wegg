/**
 * ACTIVITY-LAG-151: is this `updateAgent` patch a no-op?
 *
 * `updateAgent` used to build a new `agents` array on every call, and App plus nine other
 * components subscribe to that array, so a patch that changed nothing re-rendered the whole
 * app. The hot writers are exactly the no-op ones: the pty parser's per-chunk
 * `{ status: 'working' }` while a turn runs, and every hook and statusline tick. Measured by
 * Jim: 300 whole-App renders for 300 output chunks, ~1.2-1.9 ms each.
 *
 * True when there is no such agent, or when every key in the patch is already `Object.is`
 * equal on it. Pure, so it is tested under node (the store itself needs a browser).
 */
export function isNoOpAgentPatch<A extends { id: string }>(agents: readonly A[], id: string, patch: Partial<A>): boolean {
  const current = agents.find((a) => a.id === id);
  if (!current) return true;
  for (const key of Object.keys(patch) as Array<keyof A>) {
    if (!Object.is(current[key], patch[key])) return false;
  }
  return true;
}
