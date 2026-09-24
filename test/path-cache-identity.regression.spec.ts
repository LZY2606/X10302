import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { EtaFileResolutionError } from "../src/index";
import {
  createIdentityFixture,
  type IdentityFixture,
  readsOf,
  withReadCounter,
} from "./cache-identity.helpers";

/**
 * Regression contract: template path resolution & cache identity unification.
 *
 * Group "fixed inputs" pins the observable semantics of render/include/layout
 * for template names, views roots, extensions and cache keys.
 * Group "order stability" changes only enumeration/scheduling conditions that
 * must not affect the result.
 */

let fx: IdentityFixture;

beforeAll(() => {
  fx = createIdentityFixture();
});

afterAll(() => {
  fx.cleanup();
});

describe("template/include/cache-key identity (fixed inputs)", () => {
  it("resolves relative nested includes against the includer directory, not the views root", () => {
    const { eta, reads } = withReadCounter({
      views: fx.viewsA,
      cache: true,
    });

    const out = eta.render("index", { name: "N" });

    expect(out, "nested include output").toBe(
      "A:index[A:sub/page[A:sub/widget(N)]]",
    );
    // The shadow file at the views root must never be touched.
    expect(
      readsOf(reads, fx.canonical("widget.eta")),
      "root-level widget.eta must not be read for a nested './widget' include",
    ).toBe(0);
    expect(
      readsOf(reads, fx.canonical("sub", "widget.eta")),
      "sub/widget.eta read count",
    ).toBe(1);
  });

  it("gives same-named templates in different views roots distinct identities", () => {
    const { eta, reads } = withReadCounter({
      views: fx.viewsA,
      cache: true,
    });

    expect(eta.render("page", {})).toBe("A:root/page");

    const etaB = eta.withConfig({ views: fx.viewsB });
    expect(etaB.render("page", {})).toBe("B:page");

    // Same template name, different roots: two distinct cache identities.
    const keys = eta.templatesSync.keys();
    expect(keys, "template store keys").toContain(fx.canonical("page.eta"));
    expect(
      keys.some(
        (k) => k.endsWith("page.eta") && k !== fx.canonical("page.eta"),
      ),
      "a second, distinct identity for views-b/page.eta",
    ).toBe(true);

    // Re-rendering through the original root is unaffected (no pollution).
    expect(eta.render("page", {})).toBe("A:root/page");
    expect(readsOf(reads, fx.canonical("page.eta"))).toBe(1);
  });

  it("unifies extension omission, dot-prefix and Windows/POSIX separator spellings into one identity", () => {
    const { eta, reads } = withReadCounter({
      views: fx.viewsA,
      cache: true,
    });

    const expected = "A:sub/widget(W)";
    // Both `/` and `\` are accepted as separators and denote the same template.
    for (const spelling of [
      "sub/widget",
      "sub/widget.eta",
      "./sub/widget",
      "sub\\widget",
      "sub\\widget.eta",
    ]) {
      expect(eta.render(spelling, { name: "W" }), `spelling: ${spelling}`).toBe(
        expected,
      );
    }

    const canonicalWidget = fx.canonical("sub", "widget.eta");
    expect(
      readsOf(reads, canonicalWidget),
      "same file read once across all spellings",
    ).toBe(1);
    expect(
      eta.templatesSync.keys().filter((k) => k === canonicalWidget),
      "exactly one compiled-template identity for sub/widget.eta",
    ).toHaveLength(1);
  });

  it("rejects path traversal outside the views root, repeatably and in the resolution error layer", () => {
    const { eta } = withReadCounter({ views: fx.viewsA, cache: true });

    for (const traversal of ["../secret", "sub/../../secret", "/../secret"]) {
      for (let attempt = 0; attempt < 2; attempt++) {
        let caught: unknown;
        try {
          eta.render(traversal, {});
        } catch (err) {
          caught = err;
        }
        expect(
          caught,
          `traversal '${traversal}' (attempt ${attempt + 1})`,
        ).toBeInstanceOf(EtaFileResolutionError);
        expect((caught as Error).message).toMatch(
          /is not in the views directory/,
        );
      }
    }

    // No resolution state may be left behind for the rejected inputs.
    expect(
      Object.keys(eta.filepathCache).some((k) => k.includes("secret")),
      "filepathCache must not contain rejected traversal entries",
    ).toBe(false);
    expect(
      eta.templatesSync.keys().some((k) => k.includes("secret")),
      "template store must not contain rejected traversal entries",
    ).toBe(false);

    // Legal paths keep working after the rejections.
    expect(eta.render("shared", {})).toBe("A:shared");
  });

  it("rejects include-based traversal from a template inside the views root", () => {
    const { eta } = withReadCounter({ views: fx.viewsA, cache: true });
    // out-of-views-dir style: a legal template whose include escapes the root.
    fs.writeFileSync(
      path.join(fx.viewsA, "trav-include.eta"),
      "<%~ include('../../secret') %>",
    );

    expect(() => eta.render("trav-include", {})).toThrow(
      EtaFileResolutionError,
    );
    // Repeatable: same input, same error layer.
    expect(() => eta.render("trav-include", {})).toThrow(
      EtaFileResolutionError,
    );
  });

  it("follows symlinks within the views root into one identity, rejects symlinks escaping it", () => {
    if (!fx.symlinks) return; // environment cannot create symlinks

    const { eta, reads } = withReadCounter({
      views: fx.viewsA,
      cache: true,
    });

    expect(eta.render("shared", {})).toBe("A:shared");
    expect(eta.render("alias-shared", {})).toBe("A:shared");

    // The alias and the target are the same file: a single identity.
    expect(
      readsOf(reads, fx.canonical("shared.eta")),
      "symlink alias shares the target's cache identity",
    ).toBe(1);
    expect(
      eta.templatesSync.keys().filter((k) => k.endsWith("shared.eta")),
      "no separate identity for the alias",
    ).toHaveLength(1);

    // A symlink escaping the views root is rejected in the resolution layer.
    expect(() => eta.render("escape-link", {})).toThrow(EtaFileResolutionError);
    expect(() => eta.render("escape-link", {})).toThrow(
      /is not in the views directory/,
    );
  });

  it("treats config changes as new identities without polluting old entries", () => {
    const { eta, reads } = withReadCounter({
      views: fx.viewsA,
      cache: true,
    });

    expect(eta.render("shared", {})).toBe("A:shared");
    const filepathCacheBefore = { ...eta.filepathCache };
    const templateKeysBefore = eta.templatesSync.keys();

    // Switching defaultExtension must resolve a different file: new identity.
    const etaTmpl = eta.withConfig({ defaultExtension: ".tmpl" });
    expect(etaTmpl.render("shared", {})).toBe("A:shared-tmpl");

    // Old entries are untouched, not rewritten.
    expect(
      eta.filepathCache,
      "entries created under the old config remain intact",
    ).toMatchObject(filepathCacheBefore);
    expect(eta.templatesSync.keys()).toEqual(
      expect.arrayContaining(templateKeysBefore),
    );

    // The old identity still serves the old file without re-reading.
    expect(eta.render("shared", {})).toBe("A:shared");
    expect(readsOf(reads, fx.canonical("shared.eta"))).toBe(1);

    // Same for switching the views root on a live instance.
    eta.configure({ views: fx.viewsB });
    expect(eta.render("page", {})).toBe("B:page");
    eta.configure({ views: fx.viewsA });
    expect(eta.render("page", {})).toBe("A:root/page");
    expect(readsOf(reads, fx.canonical("page.eta"))).toBe(1);
  });

  it("serves concurrent first loads from a single cache population", async () => {
    const { eta, reads } = withReadCounter({
      views: fx.viewsA,
      cache: true,
    });

    const [a, b, c] = await Promise.all([
      eta.renderAsync("shared", {}),
      eta.renderAsync("shared", {}),
      eta.renderAsync("shared", {}),
    ]);

    expect([a, b, c]).toEqual(["A:shared", "A:shared", "A:shared"]);
    expect(
      readsOf(reads, fx.canonical("shared.eta")),
      "concurrent first loads populate the cache exactly once",
    ).toBe(1);

    // Sync first loads behave the same.
    const sync = withReadCounter({ views: fx.viewsA, cache: true });
    sync.eta.render("shared", {});
    sync.eta.render("shared", {});
    expect(readsOf(sync.reads, fx.canonical("shared.eta"))).toBe(1);
  });

  it("keeps render semantics with cacheFilepaths: false while leaving filepathCache empty", () => {
    const { eta, reads } = withReadCounter({
      views: fx.viewsA,
      cache: true,
      cacheFilepaths: false,
    });

    expect(eta.render("index", { name: "N" })).toBe(
      "A:index[A:sub/page[A:sub/widget(N)]]",
    );
    expect(eta.render("index", { name: "N" })).toBe(
      "A:index[A:sub/page[A:sub/widget(N)]]",
    );
    expect(eta.filepathCache, "filepath cache disabled").toEqual({});
    // Template cache still guards re-reads.
    expect(readsOf(reads, fx.canonical("index.eta"))).toBe(1);
  });
});

describe("order and scheduling stability", () => {
  const ops: Array<[string, object]> = [
    ["index", { name: "O" }],
    ["page", {}],
    ["sub/widget", { name: "W" }],
    ["shared", {}],
    ["with-layout", { name: "L" }],
  ];

  function runAll(
    eta: ReturnType<typeof withReadCounter>["eta"],
    order: Array<[string, object]>,
  ): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [name, data] of order) out[name] = eta.render(name, data);
    return out;
  }

  it("produces identical outputs and cache identities regardless of operation order", () => {
    const forward = withReadCounter({ views: fx.viewsA, cache: true });
    const reversed = withReadCounter({ views: fx.viewsA, cache: true });

    const outForward = runAll(forward.eta, ops);
    const outReversed = runAll(reversed.eta, [...ops].reverse());

    expect(outReversed, "outputs under reversed order").toEqual(outForward);
    expect(
      reversed.eta.templatesSync.keys().sort(),
      "compiled-template identities under reversed order",
    ).toEqual(forward.eta.templatesSync.keys().sort());
    expect(
      reversed.eta.filepathCache,
      "filepath resolution cache under reversed order",
    ).toEqual(forward.eta.filepathCache);
  });

  it("produces identical outputs and resolution caches under async scheduling", async () => {
    const sync = withReadCounter({ views: fx.viewsA, cache: true });
    const asyncRun = withReadCounter({ views: fx.viewsA, cache: true });

    const outSync = runAll(sync.eta, ops);

    const entries = await Promise.all(
      ops.map(async ([name, data]) => {
        // renderAsync is the async public entry over the same templates.
        const value = await asyncRun.eta.renderAsync(name, data);
        return [name, value] as const;
      }),
    );
    const outAsync = Object.fromEntries(entries);

    expect(outAsync, "outputs under async scheduling").toEqual(outSync);
    expect(
      asyncRun.eta.filepathCache,
      "filepath resolution cache under async scheduling",
    ).toEqual(sync.eta.filepathCache);
  });

  it("produces identical results on a pre-warmed cache", () => {
    const cold = withReadCounter({ views: fx.viewsA, cache: true });
    const warm = withReadCounter({ views: fx.viewsA, cache: true });

    // Pre-warm: load everything once.
    runAll(warm.eta, ops);
    const readsAfterWarm = warm.reads.length;

    const outCold = runAll(cold.eta, ops);
    const outWarm = runAll(warm.eta, ops);

    expect(outWarm, "outputs on a pre-warmed cache").toEqual(outCold);
    expect(
      warm.reads.length,
      "no additional reads once the cache is warm",
    ).toBe(readsAfterWarm);
  });
});
