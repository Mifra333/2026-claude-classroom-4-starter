import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";

/**
 * The throwaway directory a suite puts its SQLite file in, and the teardown
 * that manages to delete it again on Windows.
 *
 * POSIX unlinks a file whose handle is still open, so `rm` there has never
 * needed help. Windows refuses with EBUSY while any handle remains, and a
 * libSQL connection leaves one behind for longer than closing it suggests:
 * the native driver holds the database open until every prepared statement it
 * made has been finalised, and those are finalised by the garbage collector,
 * having no method to do it by hand. `@libsql/client` prepares one for every
 * statement it runs, including the `SELECT 1` probe it runs when the client is
 * created, so a client that closed cleanly still holds its file until a GC
 * happens to run.
 *
 * Hence the shape below: close the connection (each suite's own `afterAll`),
 * then collect, then delete. Closing alone is not enough, and waiting is not
 * either — nothing here allocates, so an idle process may never collect.
 */

/** No suite passes an absolute path; the OS decides where these live. */
export const makeTempDir = (prefix: string) => mkdtemp(join(tmpdir(), prefix));

/** The errors Windows reports for a file something still has open. */
const stillOpen = new Set(["EBUSY", "EPERM", "ENOTEMPTY"]);

let collect: (() => void) | null | undefined;

/**
 * `global.gc`, without running the whole suite under `--expose-gc`. The flag
 * is turned on just long enough to compile a reference to the function, which
 * goes on working after it is turned off again.
 *
 * Nothing guarantees a V8 will keep handing it over, so a refusal is not an
 * error here: it leaves the retries below as the only recourse, which is no
 * worse than where this started.
 */
function collectGarbage() {
  if (collect === undefined) {
    collect = null;
    try {
      setFlagsFromString("--expose-gc");
      const gc: unknown = runInNewContext("gc");
      if (typeof gc === "function") collect = gc as () => void;
    } finally {
      setFlagsFromString("--no-expose-gc");
    }
  }
  collect?.();
}

export async function removeTempDir(dir: string) {
  for (let attempt = 1; ; attempt++) {
    // Never on POSIX: there is nothing there for a collection to release, and
    // the first `rm` succeeds whatever is still open.
    if (process.platform === "win32") collectGarbage();

    try {
      await rm(dir, { recursive: true, force: true });
      return;
    } catch (error) {
      const { code } = error as NodeJS.ErrnoException;
      if (process.platform !== "win32" || !stillOpen.has(code ?? ""))
        throw error;

      // Out of attempts: the file outlived the process that made it, which the
      // OS will clear out of its own temp directory in time. Not a test result.
      if (attempt === 5) return;
      await sleep(20);
    }
  }
}
