import path from "node:path";
import fs from "node:fs";
import { describe, expect, it } from "vitest";

import { Eta } from "../src/index";

const viewsDir = path.join(__dirname, "templates");

const eta = new Eta({ views: viewsDir, cache: true });

describe("Filepath caching", () => {
  it("Filepath caching works as expected", async () => {
    // This test renders templates/has-include.eta with caching enabled, then checks to make sure
    // `config.filepathCache` contains the expected result afterward

    const templateResult = eta.render("has-include", {});

    expect(templateResult).toEqual(
      `This is the outermost template. Now we'll include a partial

===========================================================
This is a partial.
Hi Test Runner`,
    );

    // The cache is indexed by {filename, path, views, extension} (JSON.stringify ignores keys with undefined as their value)
    // and each entry maps to the canonical (realpath) location of the template file.

    // Filepath caching is based on the premise that given the same path, includer filename, root directory, and views directory (or directories)
    // the getPath function will always return the same result (assuming that caching is enabled and we're not expecting the templates to change)

    const resolvedViews = path.resolve(viewsDir);
    const canonical = (name: string) => fs.realpathSync(path.join(viewsDir, name));

    const pathToHasInclude = `{"path":"has-include","views":${JSON.stringify(resolvedViews)},"extension":".eta"}`;

    const pathToPartial = `{"filename":${JSON.stringify(canonical("has-include.eta"))},"path":"./partial","views":${JSON.stringify(resolvedViews)},"extension":".eta"}`;

    const pathToSimple = `{"filename":${JSON.stringify(canonical("partial.eta"))},"path":"./simple","views":${JSON.stringify(resolvedViews)},"extension":".eta"}`;

    expect(eta.filepathCache).toEqual({
      [pathToHasInclude]: canonical("has-include.eta"),
      [pathToPartial]: canonical("partial.eta"),
      [pathToSimple]: canonical("simple.eta"),
    });
  });
});

describe("file handling errors", () => {
  const eta = new Eta({ views: viewsDir });

  it("throws if accessing a file outside the views directory", () => {
    expect(() => {
      eta.render("../../sensitive-file.json", {});
    }).toThrow();
  });

  it("throws if accessing a partial outside the views directory", () => {
    expect(() => {
      eta.render("out-of-views-dir", {});
    }).toThrow();
  });

  it("throws if template doesn't exist", () => {
    expect(() => {
      eta.render("nonexistent.eta", {});
    }).toThrow(/Could not find template/);
  });

  it("throws if views directory isn't defined", () => {
    const testEta = new Eta();

    expect(() => {
      testEta.render("simple.eta", {});
    }).toThrow();
  });
});

describe("filepath default extension tests", () => {
  console.log("Templates are in ", viewsDir);

  it("works with defaultExtension", async () => {
    const eta = new Eta({
      views: viewsDir,
      cache: true,
      defaultExtension: ".tmpl",
    });
    const templateResult = await eta.render("template-extn", {
      name: "TMPL Run",
    });

    expect(templateResult).toEqual(`Hi TMPL Run`);
  });

  it("works with no extension", async () => {
    const eta = new Eta({ views: viewsDir, cache: true, defaultExtension: "" });
    const templateResult = await eta.render("template-without-extn", {
      name: "TMPL Run",
    });

    expect(templateResult).toEqual(`Hi TMPL Run`);
  });
});
