type PartialTest = { name: string; result: () => { state: string } };
type PartialModule = { children?: { allTests?: () => Iterable<PartialTest> } };

// Prints an explicit PARTIAL line for T-09. Vitest has no partial state, and a green
// FTS result must stay distinguishable from the vector-deletion half, which is M2.
export default class PartialReporter {
  onTestRunEnd(modules: ReadonlyArray<PartialModule>): void {
    let saw = false;
    let failed = false;
    for (const mod of modules) {
      const tests = mod.children?.allTests?.() ?? [];
      for (const test of tests) {
        if (!test.name.startsWith("T-09")) continue;
        saw = true;
        if (test.result().state === "failed") failed = true;
      }
    }
    if (!saw) return;
    if (failed) {
      console.log("\nT-09 FAILED — the FTS half did not pass.\n");
      return;
    }
    console.log("\nT-09 PARTIAL — FTS covered (search empty, stub read, history kept, chunk ids queued). Vector deletion deferred to M2.\n");
  }
}
