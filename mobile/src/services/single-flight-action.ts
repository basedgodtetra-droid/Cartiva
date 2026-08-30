export function createSingleFlightAction() {
  let active = false;
  return {
    tryStart() {
      if (active) return false;
      active = true;
      return true;
    },
    reset() {
      active = false;
    },
    get active() {
      return active;
    },
  };
}
