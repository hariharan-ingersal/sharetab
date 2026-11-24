import { randomBytes } from 'crypto';
import { renameSync, unlinkSync, writeFileSync } from 'fs';
import { basename, dirname, join } from 'path';

/**
 * Replaces an OAuth credentials file in one step, readable only by its owner. The data goes
 * to a new file beside it (same directory, so the same filesystem), created exclusively with
 * mode 0600 and flushed, then renamed over the target. A reader sees the old file or the new
 * one, never a partial write. The result is 0600 whatever mode the old file had (a
 * `writeFileSync` mode only applies when it creates the file). Exclusive creation also refuses
 * a planted file or symlink at the temporary name.
 */
export function writeCredentialFile(path: string, data: string): void {
  const temp = join(dirname(path), `.${basename(path)}.${randomBytes(8).toString('hex')}.tmp`);
  try {
    writeFileSync(temp, data, { mode: 0o600, flag: 'wx', flush: true });
    renameSync(temp, path);
  } catch (error) {
    try {
      unlinkSync(temp);
    } catch {
      // Never created, or already renamed
    }
    throw error;
  }
}
