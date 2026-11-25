import { test } from "node:test";
import assert from "node:assert/strict";
import { isRelevant } from "../src/core/watch-filter.js";

const local = { root: "C:/Repo", gitDir: "C:/Repo/.git", commonDir: "C:/Repo/.git" };

test("Windows verbatim paths (as Herdr's watchFolder reports them) match Git's paths", () => {
  assert.equal(isRelevant("\\\\?\\C:\\Repo\\a.txt", local), true);
  assert.equal(isRelevant("\\\\?\\c:\\repo\\.git\\index", local), true);
  assert.equal(isRelevant("\\\\?\\C:\\Repo\\.git\\index.lock", local), false);
  assert.equal(isRelevant("\\\\?\\C:\\Elsewhere\\a.txt", local), false);
});

test("verbatim UNC paths match Git's //server/share paths", () => {
  const unc = { root: "//srv/share/repo", gitDir: "//srv/share/repo/.git", commonDir: "//srv/share/repo/.git" };
  assert.equal(isRelevant("\\\\?\\UNC\\srv\\share\\repo\\a.txt", unc), true);
  assert.equal(isRelevant("\\\\srv\\share\\repo\\a.txt", unc), true);
});
