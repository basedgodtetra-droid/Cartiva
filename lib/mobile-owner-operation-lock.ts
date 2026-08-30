import "./server-only-guard";

type OwnerLockGlobal = typeof globalThis & {
  __cartivaMobileOwnerOperationLocks?: Map<string, Promise<void>>;
};

function locks() {
  const globalState = globalThis as OwnerLockGlobal;
  globalState.__cartivaMobileOwnerOperationLocks ??= new Map();
  return globalState.__cartivaMobileOwnerOperationLocks;
}

/**
 * Serializes sensitive operations for one temporary mobile owner. The
 * supported file-backed deployment is exactly one process; shared/serverless
 * deployments must replace this with a transactional distributed lock.
 */
export function withMobileOwnerOperationLock<T>(
  ownerId: string,
  operation: () => Promise<T>,
) {
  if (!/^[a-f0-9]{64}$/.test(ownerId)) {
    return Promise.reject(new Error("A valid mobile session owner is required."));
  }
  const ownerLocks = locks();
  const previous = ownerLocks.get(ownerId) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(operation);
  const settled = current.then(() => undefined, () => undefined);
  ownerLocks.set(ownerId, settled);
  return current.finally(() => {
    if (ownerLocks.get(ownerId) === settled) ownerLocks.delete(ownerId);
  });
}

export function resetMobileOwnerOperationLocksForTests() {
  delete (globalThis as OwnerLockGlobal).__cartivaMobileOwnerOperationLocks;
}
