/**
 * SCENARIO - CODEX-REDRAW-151 R-1 (Jim's audit). The open-terminal error floats in a
 * zero-height anchor so it cannot resize the terminal. It floats directly over the operator
 * controls, so it must (a) never take their clicks and (b) clear on its own.
 *
 * Mounts the PRODUCTION AgentDetailPanel for a live worker at the default 420 px sidebar
 * width, makes "open terminal" fail, and reports: what elementFromPoint hits at the top,
 * centre and bottom of every control-strip button while the error shows; the terminal
 * area's top edge before, during and after; and whether the error is gone after its 4 s.
 * Adapted from Jim's audit probe (codex151-audit/zz-jim-error-overlay.tsx).
 */
import { bridge } from './composer-bridge-stub';
import { createRoot } from 'react-dom/client';
import { AgentDetailPanel } from '../../../src/renderer/src/components/AgentDetailPanel';
import { useStore, type Agent } from '../../../src/renderer/src/store/store';

declare global { interface Window { __harnessRun: () => Promise<void>; harness: { report: (p: unknown) => void; click: (x: number, y: number) => Promise<boolean> } } }
const sleep = (ms: number) => new Promise<void>((r) => { setTimeout(r, ms); });
const cth = (window as unknown as { cth: Record<string, unknown> }).cth;
const ERR = 'spawn wt.exe ENOENT: the system terminal could not be started in C:/Users/someone/projects/a-rather-long-folder-name';
const extra: Record<string, (...a: unknown[]) => Promise<unknown>> = {
  controlSnapshot: () => Promise.resolve({ paused: false, halted: false, autoDeliveryPaused: false, gatedTools: [], pendingSteers: 0 }),
  openTerminalAt: () => Promise.resolve({ ok: false, error: ERR })
};
(window as unknown as { cth: unknown }).cth = new Proxy(cth, {
  get: (t, name: string) => extra[name] ?? (t as Record<string, unknown>)[name] ?? (() => Promise.resolve(undefined))
});

window.__harnessRun = async () => {
  const out: Record<string, unknown> = {};
  try {
    const agent = { id: 'a1', name: 'Alice', status: 'working', action: 'x', progress: 0, ptyId: 'pty-a1', provider: 'codex', cwd: 'C:/x',
      character: 'jim', accent: 'mint', description: 'worker', project: 'p', tmuxTarget: '' } as unknown as Agent;
    useStore.setState({ agents: [agent], selectedId: 'a1', messageQueues: { a1: [] } } as never);
    bridge.snapshot = { autoDeliveryPaused: false, capacityHold: false, capacityEvidence: null, interfered: null };
    createRoot(document.getElementById('root')!).render(
      <div style={{ width: 420, height: '100vh', display: 'flex', flexDirection: 'column' }}><AgentDetailPanel agent={agent} /></div>
    );
    await sleep(800);
    const termBtn = document.querySelector('[aria-label="Open a system terminal in this agent\'s folder"]')?.closest('button') as HTMLElement | null;
    out.foundOpenButton = !!termBtn;
    // The terminal area starts where the tab bar ends; its top edge moving = the grid moving.
    const tabsBottom = () => {
      const t = [...document.querySelectorAll('*')].find((e) => e.children.length === 0 && e.textContent?.trim() === 'TERMINAL');
      const bar = t?.closest('div');
      return bar ? Math.round(bar.getBoundingClientRect().bottom * 100) / 100 : -1;
    };
    const stripButtons = () => [...document.querySelectorAll('button')]
      .filter((b) => /block tools|allow tools|stop after this step|1:1|send/i.test(b.textContent ?? '') && b !== termBtn);
    const probe = () => stripButtons().map((b) => {
      const r = b.getBoundingClientRect();
      const pts = [[r.left + r.width / 2, r.top + 2], [r.left + r.width / 2, r.top + r.height / 2], [r.left + r.width / 2, r.bottom - 2]];
      return { label: (b.textContent ?? '').trim().slice(0, 24),
        hits: pts.map(([x, y]) => { const el = document.elementFromPoint(x, y); return el && (b === el || b.contains(el)) ? 'button' : (el?.getAttribute('role') ?? el?.tagName ?? 'none'); }) };
    });
    out.tabsBefore = tabsBottom();
    out.buttonsBefore = probe();
    termBtn?.click();
    await sleep(500);
    out.alertShown = !!document.querySelector('[role="alert"]');
    out.alertPointerEvents = (() => { const a = document.querySelector('[role="alert"]'); return a ? getComputedStyle(a).pointerEvents : null; })();
    out.tipCarriesError = (termBtn?.querySelector('[data-tip]')?.getAttribute('data-tip') ?? '').includes(ERR);
    out.tabsDuring = tabsBottom();
    out.buttonsDuring = probe();
    await sleep(4200); // past the 4 s reset
    out.alertShownAfter = !!document.querySelector('[role="alert"]');
    out.tabsAfter = tabsBottom();
    window.harness.report({ ok: true, ...out });
  } catch (e) {
    window.harness.report({ ok: false, error: String((e as Error)?.stack ?? e), ...out });
  }
};
