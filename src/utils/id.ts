export function createId(prefix: string): string {
  const cryptoRef: Crypto | undefined = globalThis.crypto;

  if (cryptoRef?.randomUUID) {
    return `${prefix}_${cryptoRef.randomUUID().replace(/-/g, "").slice(0, 20)}`;
  }

  if (cryptoRef?.getRandomValues) {
    const bytes = new Uint8Array(10);
    cryptoRef.getRandomValues(bytes);
    const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
    return `${prefix}_${hex}`;
  }

  const fallback = Math.random().toString(36).slice(2, 14);
  return `${prefix}_${Date.now().toString(36)}${fallback}`;
}
