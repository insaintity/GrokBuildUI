import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadSettings, saveSettings } from "../server/settings.js";

test("saveSettings tracks recent projects uniquely", () => {
  const dir = path.join(os.tmpdir(), `gbu-settings-${Date.now()}`);
  // Monkeypatch via writing to real settings would pollute home — call save with paths
  // by temporarily swapping HOME.
  const prevHome = process.env.USERPROFILE || process.env.HOME;
  process.env.USERPROFILE = dir;
  process.env.HOME = dir;
  try {
    const a = saveSettings({ projectPath: "C:\\proj\\A", engine: "acp" });
    const b = saveSettings({ projectPath: "C:\\proj\\B" });
    const c = saveSettings({ projectPath: "C:\\proj\\A" });
    assert.equal(c.recentProjects[0], "C:\\proj\\A");
    assert.ok(c.recentProjects.includes("C:\\proj\\B"));
    assert.equal(c.engine, "acp");
    const loaded = loadSettings();
    assert.deepEqual(loaded.recentProjects.slice(0, 2), c.recentProjects.slice(0, 2));
    assert.ok(a.projectPath);
    assert.ok(b.projectPath);
  } finally {
    if (prevHome) {
      process.env.USERPROFILE = prevHome;
      process.env.HOME = prevHome;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
