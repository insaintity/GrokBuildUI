import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const DEFAULTS = {
  projectPath: "",
  model: "",
  alwaysApprove: true,
  sessionMode: "continue",
  resumeSessionId: "",
  effort: "",
  noAutoUpdate: true,
  engine: "acp",
  autoFallback: true,
  recentProjects: [],
};

export function settingsPath() {
  return path.join(os.homedir(), ".grok-build-ui", "settings.json");
}

export function loadSettings() {
  const file = settingsPath();
  try {
    if (!fs.existsSync(file)) return { ...DEFAULTS };
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    return {
      ...DEFAULTS,
      ...raw,
      recentProjects: Array.isArray(raw.recentProjects) ? raw.recentProjects : [],
    };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveSettings(partial) {
  const current = loadSettings();
  const next = { ...current, ...partial };

  if (next.projectPath) {
    const list = [next.projectPath, ...(next.recentProjects || [])]
      .filter(Boolean)
      .filter((p, i, arr) => arr.findIndex((x) => x.toLowerCase() === p.toLowerCase()) === i)
      .slice(0, 8);
    next.recentProjects = list;
  }

  const file = settingsPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(next, null, 2), "utf8");
  return next;
}
