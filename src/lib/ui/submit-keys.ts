export interface SubmitKeyStore {
  keyFor(operation: string, signature: string): string;
  clear(operation: string): void;
}

export function createSubmitKeyStore(): SubmitKeyStore {
  const keys = new Map<string, { signature: string; key: string }>();

  return {
    keyFor(operation, signature) {
      const existing = keys.get(operation);
      if (existing?.signature === signature) return existing.key;

      const key = crypto.randomUUID();
      keys.set(operation, { signature, key });
      return key;
    },
    clear(operation) {
      keys.delete(operation);
    },
  };
}
