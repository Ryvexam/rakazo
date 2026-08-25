import koffi from "koffi";

/**
 * Resolve the current filesystem path of an open Windows directory handle.
 * After a rename/junction swap of the original pathname, this still returns the
 * path of the held inode, so subsequent mkdir/open under it stay contained.
 */
export function pathFromDirectoryFd(fd: number): string {
  const kernel32 = koffi.load("kernel32.dll");
  const msvcrt = koffi.load("msvcrt.dll");

  const GetFinalPathNameByHandleW = kernel32.func(
    "uint32_t __stdcall GetFinalPathNameByHandleW(void *hFile, void *lpszFilePath, uint32_t cchFilePath, uint32_t dwFlags)",
  );
  const getOsFhandle = msvcrt.func("intptr_t __cdecl _get_osfhandle(int fd)");

  const handle = getOsFhandle(fd);
  if (handle === -1n || handle === -1) {
    throw new Error("Path escapes the computer workspace");
  }

  const flags = 0; // VOLUME_NAME_DOS
  const size = GetFinalPathNameByHandleW(handle, null, 0, flags);
  if (size === 0) throw new Error("Path escapes the computer workspace");

  const buf = Buffer.alloc((size + 1) * 2);
  const written = GetFinalPathNameByHandleW(handle, buf, size + 1, flags);
  if (written === 0) throw new Error("Path escapes the computer workspace");

  let resolved = buf.toString("utf16le", 0, written * 2);
  // GetFinalPathNameByHandle returns \\?\C:\... or \\?\UNC\...
  if (resolved.startsWith("\\\\?\\UNC\\"))
    resolved = `\\\\${resolved.slice("\\\\?\\UNC\\".length)}`;
  else if (resolved.startsWith("\\\\?\\")) resolved = resolved.slice("\\\\?\\".length);
  return resolved;
}
