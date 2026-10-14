export async function readJson<T>(path: string): Promise<T | null> {
  const file = Bun.file(path);
  return (await file.exists()) ? ((await file.json()) as T) : null;
}

/**
 * Write a file only the current user can read, creating parent directories.
 * `Bun.write`'s `mode` option only applies to file-to-file copies (Bun 1.4), hence the chmod.
 */
export async function writePrivate(path: string, contents: string): Promise<void> {
  await Bun.write(path, contents, { createPath: true });
  await Bun.$`chmod 600 ${path}`.quiet();
}

export const writeJsonPrivate = (path: string, value: unknown) => writePrivate(path, JSON.stringify(value, null, 2));
