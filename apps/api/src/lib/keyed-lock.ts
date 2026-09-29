const lockTails = new Map<string, Promise<void>>();

export async function withKeyedLock<T>(key: string, action: () => Promise<T>): Promise<T> {
  const previous = lockTails.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.catch(() => undefined).then(() => current);
  lockTails.set(key, tail);

  await previous.catch(() => undefined);
  try {
    return await action();
  } finally {
    release();
    if (lockTails.get(key) === tail) {
      lockTails.delete(key);
    }
  }
}

export function keyedLockCountForTests(): number {
  return lockTails.size;
}
