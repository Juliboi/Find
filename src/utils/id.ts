import 'react-native-get-random-values';

export function uid(prefix = 'id'): string {
  const bytes = new Uint8Array(8);
  if (typeof globalThis.crypto?.getRandomValues === 'function') {
    globalThis.crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  return `${prefix}_${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;
}
