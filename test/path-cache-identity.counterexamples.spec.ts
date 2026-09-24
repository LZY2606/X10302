import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { EtaFileResolutionError } from "../src/index";
import {
  createIdentityFixture,
  type IdentityFixture,
  probeCaseSensitivity,
  readsOf,
  withReadCounter,
} from "./cache-identity.helpers";

/**
 * Counterexamples for "template path resolution & cache identity
 * unification". Each step is a minimal input, entering only through Eta's
 * public entry points (render / renderAsync / withConfig / configure), that
 * would break a naive implementation (raw-string cache keys, lexical-only
 * containment, config-blind cache indexes, ...).
 *
 * Steps run in order against one shared instance; a recoverable failure is
 * injected mid-way and the suite verifies that legal-path behavior is
 * preserved and that the failure leaves no cache residue behind.
 */

let fx: IdentityFixture;
let eta: ReturnType<typeof withReadCounter>["eta"];
let reads: string[];

beforeAll(() => {
  fx = createIdentityFixture();
  const counted = withReadCounter({ views: fx.viewsA, cache: true });
  eta = counted.eta;
  reads = counted.reads;
});

afterAll(() => {
  fx.cleanup();
});

describe("counterexamples: one file, one identity (ordered steps)", () => {
  it("step 1: extension omission and separator variants of one file share a single cache identity", () => {
    const before = readsOf(reads, fx.canonical("sub", "widget.eta"));

    for (const spelling of ["sub/widget", "sub/widget.eta", "sub\\widget"]) {
      expect(eta.render(spelling, { name: "C" }), spelling).toBe(
        "A:sub/widget(C)",
      );
    }

    expect(
      readsOf(reads, fx.canonical("sub", "widget.eta")) - before,
      "three spellings, one disk read",
    ).toBe(1);
  });

  it("step 2: case-variant spellings follow the filesystem case-sensitivity policy", () => {
    const caseSensitive = probeCaseSensitivity();
    const before = readsOf(reads, fx.canonical("shared.eta"));

    if (caseSensitive) {
      // POSIX policy: SHARED.eta is a different (missing) file.
      expect(() => eta.render("SHARED", {})).toThrow(EtaFileResolutionError);
      expect(() => eta.render("SHARED", {})).toThrow(/Could not find template/);
    } else {
      // macOS/Windows policy: SHARED.eta IS shared.eta — same identity.
      expect(eta.render("SHARED", {})).toBe("A:shared");
      expect(
        readsOf(reads, fx.canonical("shared.eta")) - before,
        "case-variant spelling must not create a second identity",
      ).toBe(0);
    }
  });

  it("step 3: a symlink alias shares its target's identity; an escaping symlink is rejected", () => {
    if (!fx.symlinks) return;

    const before = readsOf(reads, fx.canonical("shared.eta"));
    eta.render("shared", {});
    eta.render("alias-shared", {});
    expect(
      readsOf(reads, fx.canonical("shared.eta")) - before,
      "alias and target compiled once",
    ).toBe(1);

    expect(() => eta.render("escape-link", {})).toThrow(EtaFileResolutionError);
  });

  it("step 4: injected recoverable failure — missing template leaves no cache residue", () => {
    // The file does not exist yet: resolution must fail in the resolution
    // layer, repeatably, without caching a negative or partial result.
    expect(() => eta.render("late", {})).toThrow(/Could not find template/);
    expect(() => eta.render("late", {})).toThrow(EtaFileResolutionError);

    expect(
      Object.keys(eta.filepathCache).some((k) => k.includes("late")),
      "failed resolution must not write filepathCache entries",
    ).toBe(false);
    expect(
      eta.templatesSync.keys().some((k) => k.includes("late")),
      "failed resolution must not write template cache entries",
    ).toBe(false);

    // Legal paths keep working while the failure is outstanding.
    expect(eta.render("shared", {})).toBe("A:shared");
  });

  it("step 5: after recovery the same input succeeds and carries no failure residue", () => {
    fs.writeFileSync(
      path.join(fx.viewsA, "late.eta"),
      "A:late(<%= it.name %>)",
    );

    const before = readsOf(reads, fx.canonical("late.eta"));
    expect(eta.render("late", { name: "R" })).toBe("A:late(R)");
    expect(eta.render("late", { name: "R" })).toBe("A:late(R)");

    // The successful renders read the file exactly once; the earlier failed
    // attempts left no phantom cache entries, counts, or temporary state.
    expect(
      readsOf(reads, fx.canonical("late.eta")) - before,
      "recovered render populates the cache exactly once",
    ).toBe(1);
    expect(
      eta.templatesSync.keys().filter((k) => k === fx.canonical("late.eta")),
      "single identity for the recovered template",
    ).toHaveLength(1);
  });

  it("step 6: traversal and root escape stay rejected after the failure/recovery cycle", () => {
    for (const bad of ["../secret", "sub/../../secret"]) {
      expect(() => eta.render(bad, {}), bad).toThrow(EtaFileResolutionError);
    }
    if (fx.symlinks) {
      expect(() => eta.render("escape-link", {})).toThrow(
        /is not in the views directory/,
      );
    }
    // Legal nested include chain still resolves against the includer.
    expect(eta.render("index", { name: "N" })).toBe(
      "A:index[A:sub/page[A:sub/widget(N)]]",
    );
  });

  it("step 7: switching defaultExtension creates a new identity and keeps old entries intact", () => {
    eta.render("shared", {});
    const cacheBefore = { ...eta.filepathCache };
    const readsBefore = readsOf(reads, fx.canonical("shared.eta"));

    const etaTmpl = eta.withConfig({ defaultExtension: ".tmpl" });
    expect(etaTmpl.render("shared", {})).toBe("A:shared-tmpl");

    expect(eta.filepathCache, "old entries unpolluted").toMatchObject(
      cacheBefore,
    );
    expect(eta.render("shared", {})).toBe("A:shared");
    expect(readsOf(reads, fx.canonical("shared.eta"))).toBe(readsBefore);
  });

  it("step 8: concurrent first loads of one template hit the disk once", async () => {
    const fresh = withReadCounter({ views: fx.viewsA, cache: true });

    const results = await Promise.all([
      fresh.eta.renderAsync("page", {}),
      fresh.eta.renderAsync("page", {}),
      fresh.eta.renderAsync("page", {}),
      fresh.eta.renderAsync("page", {}),
    ]);

    expect(results).toEqual([
      "A:root/page",
      "A:root/page",
      "A:root/page",
      "A:root/page",
    ]);
    expect(
      readsOf(fresh.reads, fx.canonical("page.eta")),
      "cache hit guard: exactly one read under concurrency",
    ).toBe(1);
  });
});
