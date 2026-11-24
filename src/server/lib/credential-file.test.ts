import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { writeCredentialFile } from './credential-file';

// F4, on the real filesystem: credentials replaced in one step, readable by their owner only
describe('writeCredentialFile', () => {
  let dir: string;
  let target: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'credential-file-'));
    target = join(dir, 'auth.json');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  // Windows has no POSIX permission bits to check
  const posix = process.platform !== 'win32';

  test('writes the data and leaves no temporary file', () => {
    writeCredentialFile(target, '{"tokens":1}');
    expect(readFileSync(target, 'utf8')).toBe('{"tokens":1}');
    expect(readdirSync(dir)).toEqual(['auth.json']);
  });

  test.runIf(posix)('a new file is readable by its owner only', () => {
    writeCredentialFile(target, 'x');
    expect(statSync(target).mode & 0o777).toBe(0o600);
  });

  test.runIf(posix)('replacing a file left readable by others makes it owner-only', () => {
    writeFileSync(target, 'old');
    chmodSync(target, 0o644);
    writeCredentialFile(target, 'new');
    expect(readFileSync(target, 'utf8')).toBe('new');
    expect(statSync(target).mode & 0o777).toBe(0o600);
  });

  test('a replacement that cannot land leaves what was there and no temporary file', () => {
    // A directory at the target refuses the rename on every platform
    mkdirSync(target);
    writeFileSync(join(target, 'keep'), 'kept');
    expect(() => writeCredentialFile(target, 'new')).toThrow();
    expect(readFileSync(join(target, 'keep'), 'utf8')).toBe('kept');
    expect(readdirSync(dir)).toEqual(['auth.json']);
  });

  test('a directory that is not there fails without creating anything', () => {
    expect(() => writeCredentialFile(join(dir, 'missing', 'auth.json'), 'x')).toThrow();
    expect(readdirSync(dir)).toEqual([]);
  });
});
