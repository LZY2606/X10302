import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { Eta, EtaFileResolutionError, EtaParseError } from "../src/index";
import {
  canon,
  cleanupViews,
  instrument,
  makeViews,
  sortedTemplateKeys,
  writeFiles,
} from "./path-identity-utils";

afterEach(cleanupViews);

describe("path identity: nested relative includes", () => {
  it("resolves includes against the includer and shares one identity with top-level render", () => {
    const views = makeViews({
      "pages/home.eta": "Home[<%~ include('../shared/card') %>]",
      "shared/card.eta": "Card(<%~ include('./badge') %>)",
      "shared/badge.eta": "Badge",
    });
    const eta = new Eta({ views, cache: true });
    const stats = instrument(eta);

    expect(eta.render("pages/home", {})).toBe("Home[Card(Badge)]");
    // The same files, reached by different names, must reuse the cached identity.
    expect(eta.render("shared/card", {})).toBe("Card(Badge)");
    expect(eta.render("shared/badge", {})).toBe("Badge");

    const home = canon(path.join(views, "pages/home.eta"));
    const card = canon(path.join(views, "shared/card.eta"));
    const badge = canon(path.join(views, "shared/badge.eta"));

    // Cache-hit guard: each physical file was read and compiled exactly once.
    expect(stats.readsOf(home), `reads of ${home}`).toBe(1);
    expect(stats.readsOf(card), `reads of ${card}`).toBe(1);
    expect(stats.readsOf(badge), `reads of ${badge}`).toBe(1);
    expect(stats.compileCount(), "total compilations").toBe(3);

    // One physical file => one compiled-template identity.
    expect(sortedTemplateKeys(eta)).toEqual([badge, card, home].sort());

    // The include-relative resolution and the top-level resolution agree.
    const includeKey = `{"filename":${JSON.stringify(home)},"path":"../shared/card","views":${JSON.stringify(path.resolve(views))},"extension":".eta"}`;
    expect(
      eta.filepathCache[includeKey],
      "filepathCache entry for include('../shared/card')",
    ).toBe(card);
    expect(eta.resolvePath("shared/card")).toBe(card);
  });
});

describe("path identity: same name under different roots", () => {
  it("never shares cache entries across views roots, including root re-spellings", () => {
    const rootA = makeViews({ "index.eta": "root-A" });
    const rootB = makeViews({ "index.eta": "root-B" });
    const eta = new Eta({ views: rootA, cache: true });
    const stats = instrument(eta);

    expect(eta.render("index", {})).toBe("root-A");

    eta.configure({ views: rootB });
    expect(eta.render("index", {}), "after configure({views: rootB})").toBe(
      "root-B",
    );

    eta.configure({ views: rootA });
    expect(eta.render("index", {}), "after switching back to rootA").toBe(
      "root-A",
    );

    // A trailing separator spells the same root and must reuse the identity.
    eta.configure({ views: rootA + path.sep });
    expect(eta.render("index", {}), "views root with trailing separator").toBe(
      "root-A",
    );

    // withConfig shares the caches but not the identities.
    expect(
      eta.withConfig({ views: rootB }).render("index", {}),
      "withConfig({views: rootB})",
    ).toBe("root-B");

    const indexA = canon(path.join(rootA, "index.eta"));
    const indexB = canon(path.join(rootB, "index.eta"));
    expect(stats.readsOf(indexA), `reads of ${indexA}`).toBe(1);
    expect(stats.readsOf(indexB), `reads of ${indexB}`).toBe(1);
  });
});
