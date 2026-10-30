import { lstatSync, readdirSync } from 'node:fs';
import path from 'node:path';

/** Discover vendor subfolders without following links into another profile tree. */
export function profileJsonFiles(directory: string): string[] {
  let entries;
  try {
    if (lstatSync(directory).isSymbolicLink()) return [];
    entries = readdirSync(directory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  const files = entries.filter(entry => entry.isFile() && entry.name.endsWith('.json'))
    .map(entry => path.join(directory, entry.name));
  for (const entry of entries) {
    if (entry.isDirectory()) files.push(...profileJsonFiles(path.join(directory, entry.name)));
  }
  return files;
}
