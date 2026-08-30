type GetItem = (key: string) => Promise<string | null>;
type SetItem = (key: string, value: string, options?: unknown) => Promise<void>;
type DeleteItem = (key: string) => Promise<void>;

export const secureStoreTestDouble: {
  getItemAsync: GetItem;
  setItemAsync: SetItem;
  deleteItemAsync: DeleteItem;
} = {
  getItemAsync: async () => null,
  setItemAsync: async () => undefined,
  deleteItemAsync: async () => undefined,
};

export const WHEN_UNLOCKED_THIS_DEVICE_ONLY = "WHEN_UNLOCKED_THIS_DEVICE_ONLY";

export function getItemAsync(key: string) {
  return secureStoreTestDouble.getItemAsync(key);
}

export function setItemAsync(key: string, value: string, options?: unknown) {
  return secureStoreTestDouble.setItemAsync(key, value, options);
}

export function deleteItemAsync(key: string) {
  return secureStoreTestDouble.deleteItemAsync(key);
}
