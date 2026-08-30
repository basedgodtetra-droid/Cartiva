/**
 * Haptics are optional feedback. A device, simulator, browser, or OS policy can
 * reject them, so shopper actions must never await or depend on this promise.
 */
export function bestEffortHaptic(effect: () => Promise<unknown>) {
  try {
    void effect().catch(() => undefined);
  } catch {
    // Some platform shims can throw before returning a promise.
  }
}
