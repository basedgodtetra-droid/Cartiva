import { describe, expect, it, vi } from "vitest";
import {
  ComparisonRunSupersededError,
  createComparisonRunCoordinator,
  type ComparisonRun,
} from "@/mobile/src/state/comparison-run";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

async function finishRun(
  run: ComparisonRun,
  completion: Promise<string>,
  effects: {
    publish(value: string): void;
    navigate(value: string): void;
    report(value: string): void;
  },
) {
  const value = await completion;
  run.assertCurrent();
  run.ifCurrent(() => {
    effects.publish(value);
    effects.navigate(value);
    effects.report(value);
  });
  run.assertCurrent();
  return value;
}

describe("mobile comparison run generation", () => {
  it("prevents a late run A from overwriting or navigating after run B completes", async () => {
    const coordinator = createComparisonRunCoordinator();
    const completionA = deferred<string>();
    const completionB = deferred<string>();
    const publish = vi.fn();
    const navigate = vi.fn();
    const report = vi.fn();
    const effects = { publish, navigate, report };

    const runA = coordinator.start();
    const taskA = finishRun(runA, completionA.promise, effects);
    const runB = coordinator.start();
    const taskB = finishRun(runB, completionB.promise, effects);

    expect(runA.signal.aborted).toBe(true);
    expect(runA.ifCurrent(() => report("stale-progress"))).toBe(false);
    completionB.resolve("B");
    await expect(taskB).resolves.toBe("B");
    completionA.resolve("A");
    await expect(taskA).rejects.toBeInstanceOf(ComparisonRunSupersededError);

    expect(publish.mock.calls).toEqual([["B"]]);
    expect(navigate.mock.calls).toEqual([["B"]]);
    expect(report.mock.calls).toEqual([["B"]]);
  });

  it("prevents a deferred run from publishing after an edit or cancel invalidates it", async () => {
    const coordinator = createComparisonRunCoordinator();
    const completion = deferred<string>();
    const publish = vi.fn();
    const navigate = vi.fn();
    const report = vi.fn();
    const run = coordinator.start();
    const task = finishRun(run, completion.promise, { publish, navigate, report });

    coordinator.invalidate();
    expect(run.signal.aborted).toBe(true);
    expect(run.ifCurrent(() => report("stale-progress"))).toBe(false);
    completion.resolve("stale");

    await expect(task).rejects.toBeInstanceOf(ComparisonRunSupersededError);
    expect(publish).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
    expect(report).not.toHaveBeenCalled();

    const next = coordinator.start();
    expect(next.epoch).toBe(run.epoch + 2);
  });
});
