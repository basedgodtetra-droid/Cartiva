export class ComparisonRunSupersededError extends Error {
  constructor() {
    super("This comparison was superseded by a newer shopper action.");
    this.name = "ComparisonRunSupersededError";
  }
}

export interface ComparisonRun {
  readonly epoch: number;
  readonly signal: AbortSignal;
  isCurrent(): boolean;
  assertCurrent(): void;
  ifCurrent(action: () => void): boolean;
}

export interface ComparisonRunCoordinator {
  start(): ComparisonRun;
  invalidate(): void;
}

/**
 * Owns the one comparison run allowed to affect shopper-visible state.
 * Starting, editing, or cancelling advances the epoch and aborts prior work.
 */
export function createComparisonRunCoordinator(): ComparisonRunCoordinator {
  let epoch = 0;
  let activeController: AbortController | undefined;

  const invalidate = () => {
    epoch += 1;
    activeController?.abort();
    activeController = undefined;
  };

  return {
    start() {
      epoch += 1;
      activeController?.abort();
      const runEpoch = epoch;
      const controller = new AbortController();
      activeController = controller;
      const isCurrent = () => (
        epoch === runEpoch
        && activeController === controller
        && !controller.signal.aborted
      );
      return {
        epoch: runEpoch,
        signal: controller.signal,
        isCurrent,
        assertCurrent() {
          if (!isCurrent()) throw new ComparisonRunSupersededError();
        },
        ifCurrent(action) {
          if (!isCurrent()) return false;
          action();
          return true;
        },
      };
    },
    invalidate,
  };
}

export function isComparisonRunSuperseded(error: unknown) {
  return error instanceof ComparisonRunSupersededError;
}
