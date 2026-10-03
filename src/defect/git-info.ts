/**
 * Git context for a defect artifact, read without shelling out.
 *
 * ## Why this is not `git rev-parse`
 *
 * The collector must not depend on a git binary being present, and it must not
 * run a subprocess from a machine-readable pipeline. So the files are read
 * directly, which means every path shape git itself creates has to be handled
 * here — and one of them was not.
 *
 * In a linked worktree `.git` is a **file** holding `gitdir: <path>`, not a
 * directory. Reading `<root>/.git/HEAD` therefore fails, every shape check
 * misses, and the collector records `commit: null, branch: null` — silently, and
 * precisely in the situation where the work is isolated and its VCS context is
 * most worth having. A submodule's `.git` file has the same shape.
 *
 * ## Why a problem is reported rather than swallowed
 *
 * `commit: null` has two very different causes: there is no git here (legitimate,
 * a tarball export has no VCS context to record) and there is git here and this
 * code could not read it (a bug). Returning the same value for both is what made
 * the worktree case invisible for so long. So the two are separated: `problem` is
 * set only when git was found and could not be read.
 */
import { readFile, stat } from "node:fs/promises";
import path from "node:path";

/** A commit SHA, as git writes it: 40 lowercase hex characters. */
const SHA = /^[0-9a-f]{40}$/;

export interface GitInfo {
  commit: string | null;
  branch: string | null;
  /**
   * Why commit and branch are null, when they are null for any reason other
   * than there being no git here. Absent means "there is no git here", which
   * needs no explanation.
   */
  problem?: string;
}

/** Read a file, or return undefined. Never throws for a missing or unreadable path. */
async function readText(target: string): Promise<string | undefined> {
  try {
    return await readFile(target, "utf8");
  } catch {
    return undefined;
  }
}

/** True when `target` exists and is a directory. */
async function isDirectory(target: string): Promise<boolean> {
  try {
    return (await stat(target)).isDirectory();
  } catch {
    return false;
  }
}

interface GitDirs {
  /** Where this checkout's private files live, including HEAD. */
  gitDir: string;
  /** Where refs live. Same as gitDir unless this is a linked worktree. */
  commonDir: string;
  problem?: string;
}

/** Escape a string for literal use inside a RegExp. */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Locate the git directories for a checkout.
 *
 * `gitdir:` is followed, and `commondir` is honoured: a linked worktree has its
 * own HEAD but shares the ref store with the main repository, so the branch
 * ref is in the common directory and not in the worktree's own.
 */
async function locateGitDirs(root: string): Promise<GitDirs | undefined> {
  const dotGit = path.join(root, ".git");

  if (await isDirectory(dotGit)) {
    return { gitDir: dotGit, commonDir: dotGit };
  }

  const pointer = await readText(dotGit);
  if (pointer === undefined) {
    // No .git at all. Not a checkout, not an error.
    return undefined;
  }

  const target = /^gitdir:\s*(.+?)\s*$/m.exec(pointer)?.[1];
  if (target === undefined) {
    return {
      gitDir: dotGit,
      commonDir: dotGit,
      problem:
        `${dotGit} is a file but does not contain a "gitdir:" pointer, ` +
        "so this checkout's git directory could not be located",
    };
  }

  // A relative gitdir is resolved against the directory holding the pointer
  // file, which is what git itself does.
  const gitDir = path.resolve(root, target);
  if (!(await isDirectory(gitDir))) {
    return {
      gitDir,
      commonDir: gitDir,
      problem: `${dotGit} points at gitdir ${gitDir}, which is not a directory`,
    };
  }

  const commondir = await readText(path.join(gitDir, "commondir"));
  const commonDir = commondir === undefined ? gitDir : path.resolve(gitDir, commondir.trim());

  return { gitDir, commonDir };
}

/**
 * Resolve a branch ref to a commit, or explain why it could not be resolved.
 *
 * Loose refs first, then packed-refs: a branch moves to packed-refs after
 * enough commits, and a `branch: null` from a packed branch is the same bug
 * wearing a different hat.
 */
async function resolveRef(
  commonDir: string,
  ref: string,
  branch: string,
): Promise<{ commit: string | null; problem?: string }> {
  const loose = await readText(path.join(commonDir, ref));
  if (loose !== undefined) {
    const sha = loose.trim();
    if (SHA.test(sha)) return { commit: sha };
    return { commit: null, problem: `${ref} holds ${JSON.stringify(sha)}, which is not a SHA` };
  }

  const packed = await readText(path.join(commonDir, "packed-refs"));
  if (packed !== undefined) {
    // The ref name comes from HEAD, not from a filename, and a ref name may
    // legally contain a dot, so it is matched literally rather than as a
    // pattern: a name carrying regex syntax must not be able to change what is
    // searched for.
    const match = new RegExp(`^([0-9a-f]{40}) ${escapeRegExp(ref)}$`, "m").exec(packed);
    if (match?.[1] !== undefined) return { commit: match[1] };
  }

  return {
    commit: null,
    problem: `branch ${branch} has no ref at ${ref}, loose or in ${commonDir}/packed-refs`,
  };
}

/**
 * Read the commit and branch of the checkout containing `root`.
 *
 * Returns nulls rather than throwing: an artifact without VCS context is still
 * worth writing. `problem` distinguishes "no git here" from "git here and this
 * could not read it", so the caller can say which happened.
 */
export async function readGitInfo(root: string): Promise<GitInfo> {
  const dirs = await locateGitDirs(root);
  if (dirs === undefined) return { commit: null, branch: null };
  // A git directory that was located but not understood stops here. Reading on
  // would replace the real reason with a downstream symptom.
  if (dirs.problem !== undefined) return { commit: null, branch: null, problem: dirs.problem };

  const head = (await readText(path.join(dirs.gitDir, "HEAD")))?.trim();
  if (head === undefined) {
    return {
      commit: null,
      branch: null,
      problem: `${path.join(dirs.gitDir, "HEAD")} could not be read`,
    };
  }

  const branchRef = /^ref:\s*(refs\/heads\/.+)$/.exec(head);
  if (branchRef?.[1] !== undefined) {
    const branch = branchRef[1].slice("refs/heads/".length);
    const resolved = await resolveRef(dirs.commonDir, branchRef[1], branch);
    // The branch name comes from HEAD and is reported even when its ref could
    // not be resolved: "on gone, whose ref is missing" is more useful than
    // "on no branch", and `problem` says which of the two it is.
    return {
      commit: resolved.commit,
      branch,
      ...(resolved.problem === undefined ? {} : { problem: resolved.problem }),
    };
  }

  // Detached HEAD: the file holds the commit itself. A branch really is absent
  // here, so this is not a problem to report.
  if (SHA.test(head)) return { commit: head, branch: null };

  return {
    commit: null,
    branch: null,
    problem: `${path.join(dirs.gitDir, "HEAD")} holds ${JSON.stringify(head)}, which is neither a ref nor a SHA`,
  };
}
