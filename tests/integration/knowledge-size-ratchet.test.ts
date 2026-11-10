import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { collectKnowledgeSize, type KnowledgeSizeSource } from '../../src/lib/drift-sources.js';
import { evaluateKnowledgeSize } from '../../src/lib/drift-checker.js';
import { execute as check } from '../../src/services/check.service.js';
import { DEFAULT_KNOWLEDGE_TOKEN_BUDGET, type KnowledgeSizeBudget } from '../../src/types/config.js';

// Real git per test — the house timeout for git-bound suites (PB-010).
vi.setConfig({ testTimeout: 30_000 });

/**
 * REQ-LIB-111 / REQ-TESTS-148 — the knowledge-size ratchet measured against a real
 * repository: the merge-base read, the eol filter, symlinks, a project below the
 * repository root, and every way the base can fail to resolve.
 */

const BUDGET: KnowledgeSizeBudget = { ...DEFAULT_KNOWLEDGE_TOKEN_BUDGET, l1_per_file: 50, l2_per_module: 50, spec_per_file: 50, headroom: 1.0 };
const README = 'prospec/ai-knowledge/modules/x/README.md';

let root: string;
let project: string;
const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd, stdio: 'pipe', encoding: 'utf-8' });
const write = (rel: string, text: string): void => {
  mkdirSync(path.dirname(path.join(project, rel)), { recursive: true });
  writeFileSync(path.join(project, rel), text);
};
const collect = (ratchet: unknown, cwd = project, inWorkTree = true): KnowledgeSizeSource =>
  collectKnowledgeSize(cwd, path.join(cwd, 'prospec'), path.join(cwd, 'prospec', 'ai-knowledge'), BUDGET, [], ratchet, inWorkTree);
const itemAt = (src: KnowledgeSizeSource, rel: string) => src.items.find((i) => i.source_path === rel)!;
const findingAt = (src: KnowledgeSizeSource, rel: string) =>
  evaluateKnowledgeSize(src).findings.find((f) => f.source_path === rel && f.knowledge_size?.unit === 'tokens');

function initRepo(projectSubdir = ''): void {
  root = mkdtempSync(path.join(os.tmpdir(), 'size-ratchet-'));
  project = path.join(root, projectSubdir);
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.name', 'test');
  git(root, 'config', 'user.email', 'test@example.com');
  git(root, 'config', 'core.autocrlf', 'false');
  // `git init` derives this from the filesystem (true on macOS, false on Linux); pin it
  // so every case below takes the same branch on every platform.
  git(root, 'config', 'core.ignorecase', 'false');
  write('prospec/index.md', 'index\n');
  write(README, `${'A'.repeat(399)}\n`); // 400 chars → 100 tokens, over the 50 budget
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'base');
  git(root, 'branch', 'base');
}

describe('collectKnowledgeSize — size ratchet on a real repository', () => {
  beforeEach(() => initRepo());
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('adds no ratchet facts when the ratchet is not configured', () => {
    const src = collect(undefined);
    expect(src.ratchet).toBeUndefined();
    expect(src.items.every((i) => i.ratchet === undefined)).toBe(true);
  });

  it('resolves the merge-base and measures an over-budget file there', () => {
    const src = collect({ base: 'base' });
    expect(src.ratchet).toEqual({ status: 'resolved', base_ref: 'base', merge_base: git(root, 'rev-parse', 'base').trim() });
    expect(itemAt(src, README).ratchet).toEqual({ base: { tokens: 100, lines: 1 } });
    // within budget → not ratchet-measured, so no git read is spent on it
    expect(itemAt(src, 'prospec/index.md').ratchet).toBeUndefined();
    expect(findingAt(src, README)!.severity).toBe('warn');
  });

  it('fails a file that grew past its merge-base size, and returns to warn once it shrinks back', () => {
    write(README, `${'A'.repeat(399)}\n${'B'.repeat(40)}\n`);
    expect(findingAt(collect({ base: 'base' }), README)).toMatchObject({ severity: 'fail' });
    write(README, `${'A'.repeat(399)}\n`);
    expect(findingAt(collect({ base: 'base' }), README)).toMatchObject({ severity: 'warn' });
  });

  // R-8 pin: an L2 file within its token budget is a ratchet target on its line count alone.
  it('fails an L2 file whose line count grew past the line budget while its tokens stay in budget', () => {
    write(README, '\n'.repeat(120)); // 120 lines → 30 tokens, over readme_max_lines only
    git(root, 'commit', '-qam', 'long readme');
    git(root, 'branch', '-f', 'base');
    write(README, '\n'.repeat(130));
    const src = collect({ base: 'base' });
    const item = itemAt(src, README);
    expect(item.tokens).toBeLessThanOrEqual(BUDGET.l2_per_module);
    expect(item.ratchet).toEqual({ base: { tokens: 30, lines: 120 } });
    const lines = evaluateKnowledgeSize(src).findings.find((f) => f.source_path === README && f.knowledge_size?.unit === 'lines');
    expect(lines).toMatchObject({ severity: 'fail' });
  });

  it('fails a committed file that is new since the merge-base', () => {
    write('prospec/ai-knowledge/modules/y/README.md', 'C'.repeat(400));
    git(root, 'add', '.');
    git(root, 'commit', '-qm', 'new module');
    const src = collect({ base: 'base' });
    expect(itemAt(src, 'prospec/ai-knowledge/modules/y/README.md').ratchet).toEqual({ base: null });
    expect(findingAt(src, 'prospec/ai-knowledge/modules/y/README.md')).toMatchObject({ severity: 'fail' });
  });

  it('reads the base through the checkout filters, so a CRLF working tree is not growth', () => {
    const lines = Array.from({ length: 40 }, (_, i) => `line ${i} ${'A'.repeat(6)}`);
    write(README, `${lines.join('\n')}\n`);
    git(root, 'commit', '-qam', 'multi-line readme');
    git(root, 'branch', '-f', 'base');
    git(root, 'config', 'core.autocrlf', 'true');
    write(README, `${lines.join('\r\n')}\r\n`);
    const src = collect({ base: 'base' });
    const item = itemAt(src, README);
    expect(item.ratchet).toEqual({ base: { tokens: item.tokens, lines: item.lines } });
    expect(findingAt(src, README)).toMatchObject({ severity: 'warn' });
  });

  it.skipIf(process.platform === 'win32')('does not ratchet a symlinked knowledge file', () => {
    write('prospec/ai-knowledge/z-target.md', 'D'.repeat(400));
    mkdirSync(path.join(project, 'prospec/ai-knowledge/modules/z'), { recursive: true });
    symlinkSync('../../z-target.md', path.join(project, 'prospec/ai-knowledge/modules/z/README.md'));
    git(root, 'add', '.');
    git(root, 'commit', '-qm', 'symlinked module');
    const src = collect({ base: 'HEAD' });
    expect(itemAt(src, 'prospec/ai-knowledge/modules/z/README.md').ratchet).toMatchObject({ skipped: expect.stringContaining('symlink') });
    expect(findingAt(src, 'prospec/ai-knowledge/modules/z/README.md')).toMatchObject({ severity: 'warn' });
  });

  it('never ratchet-measures a growing over-budget Feature Spec (R-2)', () => {
    write('prospec/specs/features/a.md', 'F'.repeat(400));
    git(root, 'add', '.');
    git(root, 'commit', '-qm', 'spec');
    git(root, 'branch', '-f', 'base');
    write('prospec/specs/features/a.md', 'F'.repeat(800));
    const src = collect({ base: 'base' });
    expect(itemAt(src, 'prospec/specs/features/a.md').ratchet).toBeUndefined();
    expect(findingAt(src, 'prospec/specs/features/a.md')).toMatchObject({ severity: 'warn' });
  });

  it.skipIf(process.platform === 'win32')('skips a file that is a symlink only in the working tree (R-3)', () => {
    write('prospec/ai-knowledge/w-target.md', 'G'.repeat(800));
    rmSync(path.join(project, README));
    symlinkSync('../../w-target.md', path.join(project, README));
    const src = collect({ base: 'base' });
    expect(itemAt(src, README).ratchet).toEqual({ skipped: 'symlink on its path in the working tree' });
    expect(findingAt(src, README)).toMatchObject({ severity: 'warn' });
  });

  it.skipIf(process.platform === 'win32')('skips a file that was a symlink only at the merge-base (R-3)', () => {
    write('prospec/ai-knowledge/m-target.md', 'H'.repeat(400));
    rmSync(path.join(project, README));
    symlinkSync('../../m-target.md', path.join(project, README));
    git(root, 'add', '-A');
    git(root, 'commit', '-qm', 'readme becomes a symlink');
    git(root, 'branch', '-f', 'base');
    rmSync(path.join(project, README));
    write(README, 'I'.repeat(800));
    const src = collect({ base: 'base' });
    expect(itemAt(src, README).ratchet).toEqual({ skipped: 'symlink at the merge-base' });
    expect(findingAt(src, README)).toMatchObject({ severity: 'warn' });
  });

  // R-1 pin: the symlink sits on a parent directory, not on the file. ls-tree cannot
  // list a path through a symlink, so a leaf-only check read it as absent → false FAIL.
  it.skipIf(process.platform === 'win32')('does not ratchet a file reached through a symlinked parent directory', () => {
    write('prospec/ai-knowledge/shared/lib/README.md', 'E'.repeat(400));
    mkdirSync(path.join(project, 'prospec/ai-knowledge/modules'), { recursive: true });
    symlinkSync('../shared/lib', path.join(project, 'prospec/ai-knowledge/modules/lib'));
    git(root, 'add', '.');
    git(root, 'commit', '-qm', 'symlinked module directory');
    const src = collect({ base: 'HEAD' });
    const rel = 'prospec/ai-knowledge/modules/lib/README.md';
    expect(itemAt(src, rel).ratchet).toMatchObject({ skipped: expect.stringContaining('symlink') });
    expect(findingAt(src, rel)).toMatchObject({ severity: 'warn' });
  });

  // PR #406 review P1: a path the merge-base tree cannot list because an ancestor is a
  // link there is not new debt — the content was behind the link.
  it.skipIf(process.platform === 'win32')('skips a file whose parent directory was a symlink at the merge-base and is a real directory now', () => {
    write('prospec/ai-knowledge/real/README.md', 'A'.repeat(400));
    mkdirSync(path.join(project, 'prospec/ai-knowledge/modules'), { recursive: true });
    symlinkSync('../real', path.join(project, 'prospec/ai-knowledge/modules/lib'));
    git(root, 'add', '.');
    git(root, 'commit', '-qm', 'symlinked module directory');
    git(root, 'branch', '-f', 'base');
    unlinkSync(path.join(project, 'prospec/ai-knowledge/modules/lib')); // a symlink: rmSync refuses a link to a directory on Node 25
    write('prospec/ai-knowledge/modules/lib/README.md', 'A'.repeat(400));
    git(root, 'add', '-A');
    git(root, 'commit', '-qm', 'materialize the module directory');
    const rel = 'prospec/ai-knowledge/modules/lib/README.md';
    const src = collect({ base: 'base' });
    expect(src.ratchet).toMatchObject({ status: 'resolved' });
    expect(itemAt(src, rel).ratchet).toEqual({ skipped: 'prospec/ai-knowledge/modules/lib is a symlink at the merge-base' });
    expect(findingAt(src, rel)).toMatchObject({ severity: 'warn', knowledge_size: { ratchet_skipped: expect.stringContaining('symlink') } });
  });

  it('skips every file inside a knowledge base that is a submodule (gitlink) at the merge-base', () => {
    const sub = mkdtempSync(path.join(os.tmpdir(), 'size-ratchet-sub-'));
    try {
      git(sub, 'init', '-q', '-b', 'main');
      git(sub, 'config', 'user.name', 'test');
      git(sub, 'config', 'user.email', 'test@example.com');
      mkdirSync(path.join(sub, 'modules/lib'), { recursive: true });
      writeFileSync(path.join(sub, 'modules/lib/README.md'), 'A'.repeat(400));
      git(sub, 'add', '.');
      git(sub, 'commit', '-qm', 'knowledge');
      rmSync(path.join(project, 'prospec/ai-knowledge'), { recursive: true, force: true });
      git(root, 'rm', '-rq', '--cached', 'prospec/ai-knowledge');
      git(root, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', sub, 'prospec/ai-knowledge');
      git(root, 'commit', '-qm', 'knowledge base as a submodule');
      git(root, 'branch', '-f', 'base');
      const rel = 'prospec/ai-knowledge/modules/lib/README.md';
      const src = collect({ base: 'base' });
      expect(src.ratchet).toMatchObject({ status: 'resolved' });
      expect(itemAt(src, rel).ratchet).toEqual({ skipped: 'prospec/ai-knowledge is a gitlink at the merge-base' });
      expect(findingAt(src, rel)).toMatchObject({ severity: 'warn' });
    } finally {
      rmSync(sub, { recursive: true, force: true });
    }
  });

  it.each([
    ['a directory (040000)', () => {
      rmSync(path.join(project, README));
      write(`${README}/inner.md`, 'x\n');
      git(root, 'add', '-A');
    }, '040000'],
    ['a gitlink (160000)', () => {
      git(root, 'rm', '-q', '--cached', README);
      git(root, 'update-index', '--add', '--cacheinfo', `160000,${git(root, 'rev-parse', 'HEAD').trim()},${README}`);
    }, '160000'],
  ])('skips a file whose exact path was %s at the merge-base, and keeps the ratchet resolved', (_label, arrange, mode) => {
    arrange();
    git(root, 'commit', '-qm', 'readme path is not a regular file');
    git(root, 'branch', '-f', 'base');
    if (mode === '040000') rmSync(path.join(project, README), { recursive: true, force: true });
    else git(root, 'rm', '-q', '--cached', README);
    write(README, 'A'.repeat(400));
    const src = collect({ base: 'base' });
    expect(src.ratchet).toMatchObject({ status: 'resolved' });
    expect(itemAt(src, README).ratchet).toEqual({ skipped: `not a regular file at the merge-base (mode ${mode})` });
    expect(findingAt(src, README)).toMatchObject({ severity: 'warn' });
  });

  // PR #406 review P2: a case-only directory rename on a case-insensitive repository is
  // looked up under the index's own spelling. `core.ignorecase` is set explicitly, so the
  // case runs on a case-sensitive filesystem (Linux CI) as well.
  describe('with core.ignorecase', () => {
    const renameDir = (from: string, to: string): void => {
      const dir = path.join(project, 'prospec/ai-knowledge/modules');
      renameSync(path.join(dir, from), path.join(dir, `${from}.tmp`));
      renameSync(path.join(dir, `${from}.tmp`), path.join(dir, to));
    };

    it('measures a directory renamed only in case under its index path', () => {
      git(root, 'config', 'core.ignorecase', 'true');
      renameDir('x', 'X');
      const rel = 'prospec/ai-knowledge/modules/X/README.md';
      const src = collect({ base: 'base' });
      expect(itemAt(src, rel).ratchet).toEqual({ base: { tokens: 100, lines: 1 } });
      expect(findingAt(src, rel)).toMatchObject({ severity: 'warn' });
    });

    it('skips a file that more than one index path matches case-insensitively', () => {
      git(root, 'config', 'core.ignorecase', 'true');
      const blob = git(root, 'rev-parse', `HEAD:${README}`).trim();
      git(root, 'update-index', '--add', '--cacheinfo', `100644,${blob},prospec/ai-knowledge/modules/X/README.md`);
      const src = collect({ base: 'base' });
      expect(itemAt(src, README).ratchet).toMatchObject({ skipped: expect.stringContaining('more than one index path') });
      expect(findingAt(src, README)).toMatchObject({ severity: 'warn' });
    });

    it('keeps the exact-case lookup when core.ignorecase is false', () => {
      renameDir('x', 'X');
      const rel = 'prospec/ai-knowledge/modules/X/README.md';
      const src = collect({ base: 'base' });
      expect(itemAt(src, rel).ratchet).toEqual({ base: null });
      expect(findingAt(src, rel)).toMatchObject({ severity: 'fail' });
    });
  });

  it.each([
    ['an unknown ref', () => ({ base: 'no-such-ref' })],
    ['a base with no common ancestor', () => {
      git(root, 'checkout', '-q', '--orphan', 'island');
      git(root, 'commit', '-qm', 'island', '--allow-empty');
      git(root, 'checkout', '-q', 'main');
      return { base: 'island' };
    }],
  ])('is unresolvable for %s, keeping every item', (_label, arrange) => {
    const src = collect(arrange());
    expect(src.ratchet).toMatchObject({ status: 'unresolvable', reason: expect.any(String) });
    expect(itemAt(src, README).ratchet).toBeUndefined();
    const r = evaluateKnowledgeSize(src);
    expect(r.result.status).toBe('fail');
    expect(r.findings.find((f) => f.source_path === '.prospec.yaml')).toMatchObject({ severity: 'fail' });
  });

  it('is unresolvable in a shallow clone', () => {
    const clone = path.join(root, '..', `${path.basename(root)}-shallow`);
    git(os.tmpdir(), 'clone', '-q', '--depth', '1', `file://${root}`, clone);
    try {
      const src = collect({ base: 'HEAD' }, clone);
      expect(src.ratchet).toMatchObject({ status: 'unresolvable', reason: expect.stringContaining('shallow') });
    } finally {
      rmSync(clone, { recursive: true, force: true });
    }
  });

  it('is unresolvable outside a git work tree', () => {
    const src = collect({ base: 'base' }, project, false);
    expect(src.ratchet).toMatchObject({ status: 'unresolvable', reason: expect.stringContaining('git') });
  });
});

describe('collectKnowledgeSize — project below the repository root', () => {
  beforeEach(() => initRepo('sub'));
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('reads the merge-base path relative to the project, not the repository root', () => {
    write(README, `${'A'.repeat(399)}\n${'B'.repeat(40)}\n`);
    const src = collect({ base: 'base' });
    expect(itemAt(src, README).ratchet).toEqual({ base: { tokens: 100, lines: 1 } });
    expect(findingAt(src, README)).toMatchObject({ severity: 'fail' });
  });

  // Review R-9 pin: the project directory is a real directory at the merge-base, so a
  // file absent there is new debt — the project-directory lookup must not skip it.
  it('fails a committed file that is new since the merge-base', () => {
    write('prospec/ai-knowledge/modules/y/README.md', 'C'.repeat(400));
    git(root, 'add', '.');
    git(root, 'commit', '-qm', 'new module');
    const rel = 'prospec/ai-knowledge/modules/y/README.md';
    const src = collect({ base: 'base' });
    expect(itemAt(src, rel).ratchet).toEqual({ base: null });
    expect(findingAt(src, rel)).toMatchObject({ severity: 'fail' });
  });
});

// Review R-1 pin: the link sits on the project directory or above it, so no
// project-relative ancestor names it — the lookup must reach past the project prefix.
describe('collectKnowledgeSize — a link at the merge-base on the project directory or above it', () => {
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const linkAtBase = (projectSubdir: string, link: string, mode: string, kind: string): void => {
    initRepo(projectSubdir);
    // Replace `link` in the index only (the working tree keeps the real files), commit
    // that as the base, then commit the real directory back with identical content.
    git(root, '--literal-pathspecs', 'rm', '-rq', '--cached', link);
    const target = mode === '160000'
      ? git(root, 'rev-parse', 'HEAD').trim()
      : execFileSync('git', ['hash-object', '-w', '--stdin'], { cwd: root, input: 'elsewhere', encoding: 'utf-8' }).trim();
    git(root, 'update-index', '--add', '--cacheinfo', `${mode},${target},${link}`);
    git(root, 'commit', '-qm', `${link} as a ${kind}`);
    git(root, 'branch', '-f', 'base');
    git(root, '--literal-pathspecs', 'rm', '-q', '--cached', link);
    git(root, '--literal-pathspecs', 'add', link);
    git(root, 'commit', '-qm', `materialize ${link}`);
    const src = collect({ base: 'base' });
    expect(src.ratchet).toMatchObject({ status: 'resolved' });
    expect(itemAt(src, README).ratchet).toEqual({ skipped: `${link} is a ${kind} at the merge-base` });
    expect(findingAt(src, README)).toMatchObject({ severity: 'warn' });
  };

  it.each([
    ['the project directory is a gitlink', 'sub', 'sub', '160000', 'gitlink'],
    ['the project directory is a symlink', 'sub', 'sub', '120000', 'symlink'],
    ['a directory above the project is a symlink', 'outer/sub', 'outer', '120000', 'symlink'],
  ])('skips an unchanged over-budget file when %s at the merge-base', (_label, projectSubdir, link, mode, kind) => {
    linkAtBase(projectSubdir, link, mode, kind);
  });

  // Review R-1 (round 2) pin: a repository directory name is a path, never pathspec
  // magic — `:outer` would otherwise match `outer`, and `:!x` would fail the listing.
  it.skipIf(process.platform === 'win32').each([
    ['a magic-looking name', ':outer/sub', ':outer'],
    ['an exclude-magic name', ':!x/sub', ':!x'],
  ])('skips an unchanged over-budget file under %s that was a symlink at the merge-base', (_label, projectSubdir, link) => {
    linkAtBase(projectSubdir, link, '120000', 'symlink');
  });
});

// Review R-1 (round 3) pin: `:(literal)` is itself read literally under an inherited
// GIT_LITERAL_PATHSPECS=1 (a hook run by `git --literal-pathspecs commit`), so the
// ratchet's reads must not inherit the pathspec-mode variables.
describe('collectKnowledgeSize — under an inherited GIT_LITERAL_PATHSPECS=1', () => {
  afterEach(() => {
    delete process.env.GIT_LITERAL_PATHSPECS;
    rmSync(root, { recursive: true, force: true });
  });
  const collectLiteral = (ratchet: unknown): KnowledgeSizeSource => {
    process.env.GIT_LITERAL_PATHSPECS = '1';
    try {
      return collect(ratchet);
    } finally {
      delete process.env.GIT_LITERAL_PATHSPECS;
    }
  };

  it('keeps an unchanged over-budget file measured at the merge-base', () => {
    initRepo();
    const src = collectLiteral({ base: 'base' });
    expect(itemAt(src, README).ratchet).toEqual({ base: { tokens: 100, lines: 1 } });
    expect(findingAt(src, README)).toMatchObject({ severity: 'warn' });
  });

  it('still finds a project directory that was a symlink at the merge-base', () => {
    initRepo('sub');
    git(root, 'rm', '-rq', '--cached', 'sub');
    const blob = execFileSync('git', ['hash-object', '-w', '--stdin'], { cwd: root, input: 'elsewhere', encoding: 'utf-8' }).trim();
    git(root, 'update-index', '--add', '--cacheinfo', `120000,${blob},sub`);
    git(root, 'commit', '-qm', 'sub as a symlink');
    git(root, 'branch', '-f', 'base');
    git(root, 'rm', '-q', '--cached', 'sub');
    git(root, 'add', 'sub');
    git(root, 'commit', '-qm', 'materialize sub');
    const src = collectLiteral({ base: 'base' });
    expect(itemAt(src, README).ratchet).toEqual({ skipped: 'sub is a symlink at the merge-base' });
    expect(findingAt(src, README)).toMatchObject({ severity: 'warn' });
  });
});

// Review R-1 (round 2) pin: a knowledge path inside the project is a literal pathspec
// too, so a base directory spelled like magic is still found at the merge-base.
describe('collectKnowledgeSize — a knowledge directory spelled like pathspec magic', () => {
  beforeEach(() => initRepo());
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it.skipIf(process.platform === 'win32')('measures a file under `:kb` at the merge-base', () => {
    const rel = ':kb/ai-knowledge/modules/x/README.md';
    write(':kb/index.md', 'index\n');
    write(rel, `${'A'.repeat(399)}\n`);
    git(root, 'add', '.');
    git(root, 'commit', '-qm', 'magic-looking knowledge directory');
    git(root, 'branch', '-f', 'base');
    const src = collectKnowledgeSize(project, path.join(project, ':kb'), path.join(project, ':kb', 'ai-knowledge'), BUDGET, [], { base: 'base' }, true);
    expect(src.ratchet).toMatchObject({ status: 'resolved' });
    expect(itemAt(src, rel).ratchet).toEqual({ base: { tokens: 100, lines: 1 } });
    expect(findingAt(src, rel)).toMatchObject({ severity: 'warn' });
  });
});

describe('prospec check wires the configured ratchet through (REQ-SERVICES-065, US-1 Independent Test)', () => {
  beforeEach(() => {
    initRepo();
    write('.prospec.yaml', [
      'version: "1.0"',
      'project:',
      '  name: fixture',
      'knowledge:',
      '  base_path: prospec/ai-knowledge',
      '  token_budget:',
      '    # fixture-sized budget so a 100-token README is over it',
      '    l2_per_module: 50',
      '  size_ratchet:',
      '    base: base',
      '',
    ].join('\n'));
    git(root, 'add', '.');
    git(root, 'commit', '-qm', 'config');
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const sizeStatus = async () => {
    const result = await check({ cwd: project });
    if (result.kind !== 'report') throw new Error('expected a report');
    return {
      status: result.report.structural.checks.find((c) => c.id === 'knowledge-size')!.status,
      hasFail: result.hasFail,
    };
  };

  it('fails knowledge-size (and so --strict) when the over-budget README grows, and warns again once reverted', async () => {
    write(README, `${'A'.repeat(399)}\n${'B'.repeat(40)}\n`);
    expect(await sizeStatus()).toEqual({ status: 'fail', hasFail: true });
    write(README, `${'A'.repeat(399)}\n`);
    expect((await sizeStatus()).status).toBe('warn');
  });
});
