import { runCommand } from "./grok.js";

async function git(cwd, args, opts = {}) {
  return runCommand("git", args, { cwd, allowFail: true, ...opts });
}

export async function gitStatus(cwd) {
  const [root, branch, status, remote, ahead] = await Promise.all([
    git(cwd, ["rev-parse", "--show-toplevel"]),
    git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]),
    git(cwd, ["status", "--porcelain"]),
    git(cwd, ["remote", "get-url", "origin"]),
    git(cwd, ["status", "-sb"]),
  ]);

  if (root.code !== 0) {
    return {
      isRepo: false,
      error: root.stderr.trim() || "Not a git repository",
    };
  }

  const files = (status.stdout || "")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => ({
      code: line.slice(0, 2),
      path: line.slice(3),
    }));

  const short = (ahead.stdout || "").split(/\r?\n/)[0] || "";
  const tracking = /\[([^\]]+)\]/.exec(short)?.[1] || null;

  return {
    isRepo: true,
    root: (root.stdout || "").trim(),
    branch: (branch.stdout || "").trim(),
    remote: remote.code === 0 ? (remote.stdout || "").trim() : null,
    tracking,
    dirty: files.length > 0,
    files,
    short,
  };
}

export async function gitCommitAll(cwd, message) {
  const status = await gitStatus(cwd);
  if (!status.isRepo) throw new Error(status.error || "Not a git repo");

  await git(cwd, ["add", "-A"]);
  const commit = await git(cwd, ["commit", "-m", message]);
  if (commit.code !== 0) {
    const msg = (commit.stderr || commit.stdout || "").trim();
    if (/nothing to commit/i.test(msg)) {
      return { ok: true, noop: true, message: "Nothing to commit", status: await gitStatus(cwd) };
    }
    throw new Error(msg || "Commit failed");
  }
  return {
    ok: true,
    stdout: commit.stdout,
    status: await gitStatus(cwd),
  };
}

export async function gitPush(cwd, { setUpstream = false } = {}) {
  const status = await gitStatus(cwd);
  if (!status.isRepo) throw new Error(status.error || "Not a git repo");

  const args = setUpstream || !status.tracking ? ["push", "-u", "origin", "HEAD"] : ["push"];
  const result = await git(cwd, args, { timeoutMs: 180_000 });
  if (result.code !== 0) {
    throw new Error((result.stderr || result.stdout || "Push failed").trim());
  }
  return {
    ok: true,
    stdout: result.stdout,
    stderr: result.stderr,
    status: await gitStatus(cwd),
  };
}

export async function createPullRequest(cwd, { title, body } = {}) {
  const status = await gitStatus(cwd);
  if (!status.isRepo) throw new Error(status.error || "Not a git repo");

  const prTitle = (title || `Updates from ${status.branch}`).trim();
  const prBody =
    body ||
    `## Summary\n- Changes pushed from GrokBuildUI\n\n## Test plan\n- [ ] Review diff\n- [ ] Smoke test\n`;

  // Ensure branch is on remote first
  await gitPush(cwd, { setUpstream: true });

  const result = await runCommand(
    "gh",
    ["pr", "create", "--title", prTitle, "--body", prBody],
    { cwd, allowFail: true, timeoutMs: 120_000 },
  );

  if (result.code !== 0) {
    const combined = `${result.stderr}\n${result.stdout}`;
    if (/already exists/i.test(combined)) {
      const view = await runCommand("gh", ["pr", "view", "--json", "url", "-q", ".url"], {
        cwd,
        allowFail: true,
      });
      return {
        ok: true,
        alreadyExists: true,
        url: (view.stdout || "").trim() || null,
        stdout: result.stdout,
        stderr: result.stderr,
      };
    }
    throw new Error((result.stderr || result.stdout || "PR create failed").trim());
  }

  const url = (result.stdout || "").trim().split(/\r?\n/).filter(Boolean).pop();
  return { ok: true, url, stdout: result.stdout };
}
