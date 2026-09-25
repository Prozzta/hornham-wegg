/**
 * v1.1.45 unit #7 — delivering a capacity TOAST (the OS notification), aligned to the
 * design of record §13: a person is told on ENTRY to LIMITED and on the RETURN to ordinary
 * use, and on nothing else. Every other transition is a visual change on the strip (and the
 * #6 banner covers LIMITED entry in the app), so those intents are recorded STRIP_ONLY.
 *
 * WHICH transitions toast is decided once, by the presenter's `toastFor` (it also words
 * them). This function only applies the notifications setting and the platform, and says
 * what happened, so the notice lifecycle records it. It never decides and never retries.
 *
 * NO REPLAY is inherited, not added here: an intent only exists for a real transition the
 * CapacityNotifier observed (a first sighting after a restart is a baseline, correction 4),
 * and each one is delivered once.
 */
import type { NoticeDelivery } from '../shared/capacityStrip';

export interface CapacityToast { title: string; body: string }

export interface ToastDeps {
  notificationsOn: () => boolean;
  supported: () => boolean;
  show: (toast: CapacityToast) => void;
}

export function deliverCapacityToast(toast: CapacityToast | null, deps: ToastDeps): NoticeDelivery {
  if (!toast) return 'STRIP_ONLY';                 // §13: not a transition people are told about
  if (!deps.notificationsOn()) return 'SUPPRESSED';
  try {
    if (!deps.supported()) return 'UNSUPPORTED';
    deps.show(toast);
    return 'SHOWN';
  } catch { return 'UNSUPPORTED'; }
}
