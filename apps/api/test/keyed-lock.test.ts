import { describe, expect, test } from "vitest";
import {
  keyedLockCountForTests,
  withKeyedLock,
} from "../src/lib/keyed-lock.js";

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

describe("withKeyedLock", () => {
  test("serializes work that uses the same key and releases the idle key", async () => {
    const firstEntered = deferred();
    const releaseFirst = deferred();
    const events: string[] = [];

    const first = withKeyedLock("orders.xlsx", async () => {
      events.push("first:start");
      firstEntered.resolve();
      await releaseFirst.promise;
      events.push("first:end");
    });
    await firstEntered.promise;

    const second = withKeyedLock("orders.xlsx", async () => {
      events.push("second:start");
      events.push("second:end");
    });

    await Promise.resolve();
    expect(events).toEqual(["first:start"]);
    expect(keyedLockCountForTests()).toBe(1);

    releaseFirst.resolve();
    await Promise.all([first, second]);

    expect(events).toEqual(["first:start", "first:end", "second:start", "second:end"]);
    expect(keyedLockCountForTests()).toBe(0);
  });

  test("allows work for different keys to overlap", async () => {
    const bothEntered = deferred();
    const release = deferred();
    const entered = new Set<string>();

    const work = (key: string) =>
      withKeyedLock(key, async () => {
        entered.add(key);
        if (entered.size === 2) bothEntered.resolve();
        await release.promise;
      });

    const pending = Promise.all([work("a.xlsx"), work("b.xlsx")]);
    await bothEntered.promise;
    expect([...entered].sort()).toEqual(["a.xlsx", "b.xlsx"]);
    release.resolve();
    await pending;
    expect(keyedLockCountForTests()).toBe(0);
  });
});
