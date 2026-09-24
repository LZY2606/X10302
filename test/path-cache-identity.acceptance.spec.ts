import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  Eta,
  EtaFileResolutionError,
  EtaParseError,
  EtaRuntimeError,
} from "../src/index";
import {
  createIdentityFixture,
  type IdentityFixture,
  readsOf,
  withReadCounter,
} from "./cache-identity.helpers";

/**
 * Acceptance story: render, include, layout and the precompile entry
 * (compile + loadTemplate) all compute template name / views root /
 * extension / cache key through a single path-resolution pipeline, so one
 * file has exactly one identity and different files never share a cache slot.
 *
 * The story runs the same batch of inputs through varied order, cache state
 * and scheduling, injects failures mid-way, and verifies that no partial or
 * shared state is left behind and that identical retries are stable.
 */

let fx: IdentityFixture;

beforeAll(() => {
  fx = createIdentityFixture();
});

afterAll(() => {
  fx.cleanup();
});

describe("acceptance: unified path resolution and cache identity across all entries", () => {
  it("phase 1: precompile, render, include and layout share one cache identity per file", () => {
    const { eta, reads } = withReadCounter({
      views: fx.viewsA,
      cache: true,
    });

    // --- Precompile entry: compile + loadTemplate under the canonical key
    // produced by the same resolvePath the render entries use.
    const widgetKey = eta.resolvePath("sub/widget", {});
    expect(widgetKey, "resolvePath returns the canonical identity").toBe(
      fx.canonical("sub", "widget.eta"),
    );
    eta.loadTemplate(
      widgetKey,
      eta.compile(fs.readFileSync(widgetKey, "utf8")),
    );

    // --- Render entry: served from the precompiled identity, zero disk reads.
    expect(eta.render("sub/widget", { name: "P" })).toBe("A:sub/widget(P)");
    expect(
      readsOf(reads, fx.canonical("sub", "widget.eta")),
      "precompiled identity serves render without touching disk",
    ).toBe(0);

    // --- Include entry: the nested include chain reuses the same identity.
    const indexOut = eta.render("index", { name: "I" });
    expect(indexOut).toBe("A:index[A:sub/page[A:sub/widget(I)]]");
    expect(
      readsOf(reads, fx.canonical("sub", "widget.eta")),
      "include reuses the precompiled identity",
    ).toBe(0);
    expect(readsOf(reads, fx.canonical("index.eta"))).toBe(1);
    expect(readsOf(reads, fx.canonical("sub", "page.eta"))).toBe(1);

    // --- Layout entry: layout resolution goes through the same pipeline.
    expect(eta.render("with-layout", { name: "L" })).toBe("M[L:L]");
    expect(readsOf(reads, fx.canonical("layout-main.eta"))).toBe(1);

    // --- Caller-visible results and internal invariants, recorded.
    const invariantKeys = eta.templatesSync.keys().sort();
    expect(
      invariantKeys,
      "every cached identity is a canonical path inside the views root",
    ).toEqual(
      [
        "index.eta",
        "layout-main.eta",
        "with-layout.eta",
        path.join("sub", "page.eta"),
        path.join("sub", "widget.eta"),
      ]
        .map((rel) => fx.canonical(rel))
        .sort(),
    );
    // One file, one identity: no key appears twice, none points outside.
    expect(new Set(invariantKeys).size).toBe(invariantKeys.length);
  });

  it("phase 2: the same batch under varied order, cache state and scheduling agrees", async () => {
    const batch: Array<[string, object]> = [
      ["index", { name: "B" }],
      ["with-layout", { name: "B" }],
      ["sub/widget", { name: "B" }],
      ["shared", {}],
    ];

    // Reference run: cold, forward, synchronous.
    const reference = withReadCounter({ views: fx.viewsA, cache: true });
    const expected: Record<string, string> = {};
    for (const [name, data] of batch) {
      expected[name] = reference.eta.render(name, data);
    }

    // Varied run: reversed order, async scheduling, pre-warmed cache.
    const varied = withReadCounter({ views: fx.viewsA, cache: true });
    // Pre-warm one entry through the same (async) store the batch will use.
    await varied.eta.renderAsync("shared", {});
    const reversed = [...batch].reverse();
    const actualEntries = await Promise.all(
      reversed.map(
        async ([name, data]) =>
          [name, await varied.eta.renderAsync(name, data)] as const,
      ),
    );
    const actual = Object.fromEntries(actualEntries);

    expect(actual, "varied order/scheduling/cache-state outputs").toEqual(
      expected,
    );
    expect(
      varied.eta.filepathCache,
      "resolution cache is order-independent",
    ).toEqual(reference.eta.filepathCache);
    expect(
      readsOf(varied.reads, fx.canonical("shared.eta")),
      "pre-warmed entry read exactly once",
    ).toBe(1);
  });

  it("phase 3: failures leave no partial state and identical retries are stable", () => {
    const { eta, reads } = withReadCounter({
      views: fx.viewsA,
      cache: true,
    });

    // Establish some persisted/shared state first.
    expect(eta.render("index", { name: "F" })).toBe(
      "A:index[A:sub/page[A:sub/widget(F)]]",
    );
    const cacheSnapshot = { ...eta.filepathCache };
    const templateKeysSnapshot = eta.templatesSync.keys().sort();
    const readsSnapshot = reads.length;

    // --- Failure 1: missing template (recoverable later).
    expect(() => eta.render("missing", {})).toThrow(EtaFileResolutionError);
    // --- Failure 2: traversal out of the views root.
    expect(() => eta.render("../secret", {})).toThrow(EtaFileResolutionError);
    // --- Failure 3: corrupt input (damaged template source).
    fs.writeFileSync(path.join(fx.viewsA, "broken.eta"), "<% if ( %>");
    expect(() => eta.render("broken", {})).toThrow(EtaParseError);
    // --- Failure 4: resource budget exhausted inside readFile — the causal
    // error must propagate unwrapped.
    const emfile = Object.assign(new Error("too many open files"), {
      code: "EMFILE",
    });
    const original = eta.readFile;
    eta.readFile = () => {
      throw emfile;
    };
    let causal: unknown;
    try {
      eta.render("shared", {});
    } catch (err) {
      causal = err;
    }
    eta.readFile = original;
    expect(causal, "resource-exhaustion error propagates as-is").toBe(emfile);
    // --- Failure 5: caller cancellation from template data keeps its cause.
    class Cancelled extends Error {
      override name = "Cancelled";
    }
    fs.writeFileSync(path.join(fx.viewsA, "cancel.eta"), "<% it.abort() %>");
    const cancelErr = new Cancelled("cancelled by caller");
    let cancelled: unknown;
    try {
      eta.render("cancel", {
        abort: () => {
          throw cancelErr;
        },
      });
    } catch (err) {
      cancelled = err;
    }
    expect(cancelled, "cancellation error propagates as-is").toBe(cancelErr);

    // --- No partial updates to persisted/shared state.
    // Every entry that existed before the failures is preserved untouched.
    expect(
      eta.filepathCache,
      "pre-existing filepath cache entries untouched by failures",
    ).toMatchObject(cacheSnapshot);
    // The only new resolution entries belong to files that were successfully
    // resolved during the failed renders; rejected/missing inputs leave none.
    const newCacheKeys = Object.keys(eta.filepathCache).filter(
      (k) => !(k in cacheSnapshot),
    );
    expect(
      newCacheKeys.every(
        (k) =>
          k.includes("broken") || k.includes("cancel") || k.includes("shared"),
      ),
      `only successfully resolved files gained cache entries: ${newCacheKeys}`,
    ).toBe(true);
    expect(
      Object.keys(eta.filepathCache).some(
        (k) => k.includes("missing") || k.includes("secret"),
      ),
      "failed/rejected resolutions leave no cache residue",
    ).toBe(false);
    // 'cancel' compiled fine (its failure happens at call time), so it is the
    // only admissible new identity; nothing else may appear or disappear.
    const keysAfter = eta.templatesSync.keys().sort();
    expect(
      keysAfter.filter((k) => !templateKeysSnapshot.includes(k)),
      "only fully-compiled templates may be added",
    ).toEqual([fx.canonical("cancel.eta")]);
    expect(
      templateKeysSnapshot.every((k) => keysAfter.includes(k)),
      "no previously cached identity was evicted or rewritten",
    ).toBe(true);
    // The EMFILE-injected render never reached the disk.
    expect(
      readsOf(reads, fx.canonical("shared.eta")),
      "failed render did not count as a cache population",
    ).toBe(0);

    // --- Identical retries are stable.
    expect(() => eta.render("missing", {})).toThrow(/Could not find template/);
    expect(() => eta.render("../secret", {})).toThrow(
      /is not in the views directory/,
    );
    expect(() => eta.render("broken", {})).toThrow(EtaParseError);

    // --- Recovery: creating the missing file makes the same input succeed.
    fs.writeFileSync(path.join(fx.viewsA, "missing.eta"), "A:recovered");
    const readsBeforeRecovery = readsOf(reads, fx.canonical("missing.eta"));
    expect(eta.render("missing", {})).toBe("A:recovered");
    expect(eta.render("missing", {})).toBe("A:recovered");
    expect(
      readsOf(reads, fx.canonical("missing.eta")) - readsBeforeRecovery,
      "recovery populates the cache exactly once, then serves from it",
    ).toBe(1);

    // --- Previously successful renders are byte-identical afterwards.
    expect(eta.render("index", { name: "F" })).toBe(
      "A:index[A:sub/page[A:sub/widget(F)]]",
    );
    // Cache-hit guards per file: cached templates are never re-read, failed
    // compilations are re-attempted (no negative caching), recovery reads once.
    expect(readsOf(reads, fx.canonical("index.eta"))).toBe(1);
    expect(readsOf(reads, fx.canonical("cancel.eta"))).toBe(1);
    expect(
      readsOf(reads, fx.canonical("broken.eta")),
      "each failed compile re-reads; nothing half-cached",
    ).toBe(2);
    expect(
      reads.length - readsSnapshot,
      "total disk reads after the failure batch",
    ).toBe(6);
  });

  it("phase 4: diagnostics and error layering do not alter successful returns", () => {
    const plain = new Eta({ views: fx.viewsA });
    const debug = new Eta({ views: fx.viewsA, debug: true });

    // debug=true adds diagnostics on failure but must not change success.
    expect(debug.render("index", { name: "D" })).toBe(
      plain.render("index", { name: "D" }),
    );

    // Error layering: runtime failures carry the original cause.
    fs.writeFileSync(
      path.join(fx.viewsA, "runtime-fail.eta"),
      "<% it.boom() %>",
    );
    const cause = new TypeError("boom");
    let runtime: unknown;
    try {
      debug.render("runtime-fail", {
        boom: () => {
          throw cause;
        },
      });
    } catch (err) {
      runtime = err;
    }
    expect(runtime).toBeInstanceOf(EtaRuntimeError);
    expect((runtime as Error).cause, "original cause preserved").toBe(cause);
  });
});
