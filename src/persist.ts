/** Folder + localStorage persistence. Chrome's File System Access API. */

const LS_FILES = "asbuilt:files";
const LS_BRANCH = "asbuilt:branch";

export function autosave(files: Map<string, string>, branch: string): void {
  try {
    localStorage.setItem(LS_FILES, JSON.stringify(Object.fromEntries(files)));
    localStorage.setItem(LS_BRANCH, branch);
  } catch {
    // quota or private mode: autosave is best-effort
  }
}

export function restore(): { files: Record<string, string>; branch: string } | null {
  try {
    const raw = localStorage.getItem(LS_FILES);
    if (raw === null) return null;
    const files = JSON.parse(raw) as Record<string, string>;
    if (Object.keys(files).length === 0) return null;
    return { files, branch: localStorage.getItem(LS_BRANCH) ?? "asbuilt" };
  } catch {
    return null;
  }
}

export function fsAccessSupported(): boolean {
  return typeof window !== "undefined" && "showDirectoryPicker" in window;
}

async function readDir(
  handle: FileSystemDirectoryHandle,
  prefix: string,
  out: Record<string, string>,
): Promise<void> {
  for await (const [name, entry] of handle.entries()) {
    if (entry.kind === "file" && name.endsWith(".abl")) {
      const file = await (entry as FileSystemFileHandle).getFile();
      out[`${prefix}${name}`] = await file.text();
    } else if (entry.kind === "directory" && !name.startsWith(".")) {
      await readDir(entry as FileSystemDirectoryHandle, `${prefix}${name}/`, out);
    }
  }
}

export async function openFolder(): Promise<{
  handle: FileSystemDirectoryHandle;
  files: Record<string, string>;
}> {
  const handle = await window.showDirectoryPicker({ mode: "readwrite" });
  const files: Record<string, string> = {};
  await readDir(handle, "", files);
  return { handle, files };
}

export async function writeFile(
  root: FileSystemDirectoryHandle,
  path: string,
  text: string,
): Promise<void> {
  const parts = path.split("/");
  let dir = root;
  for (const part of parts.slice(0, -1)) {
    dir = await dir.getDirectoryHandle(part, { create: true });
  }
  const fileHandle = await dir.getFileHandle(parts[parts.length - 1]!, { create: true });
  const writable = await fileHandle.createWritable();
  await writable.write(text);
  await writable.close();
}
