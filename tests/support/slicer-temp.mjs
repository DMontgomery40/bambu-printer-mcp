import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

// Only serial installed-slicer tests use this scope. Keep vendor scratch out of the
// suite TMPDIR without exempting it (or unrelated fixture leaks) from the guard.
export async function withSlicerTemp(run) {
  const keys = ['TMPDIR', 'TMP', 'TEMP'];
  const saved = keys.map(key => process.env[key]);
  const directory = await mkdtemp(join(tmpdir(), 'slicer-scratch-'));
  try {
    for (const key of keys) process.env[key] = directory;
    return await run();
  } finally {
    keys.forEach((key, index) => {
      if (saved[index] === undefined) delete process.env[key];
      else process.env[key] = saved[index];
    });
    await rm(directory, {recursive: true, force: true});
  }
}
