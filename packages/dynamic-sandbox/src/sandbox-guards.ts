/**
 * Runtime guard sources for the Dynamic Agent Studio code sandbox.
 *
 * These are embedded as string constants rather than shipped as .cjs/.py
 * asset files on purpose: the runner's build emits compiled JS only, so a
 * sibling asset file would not be copied into the image and the guard would
 * silently vanish in production — the worst possible failure mode for a
 * security control. As strings they are part of the compiled module.
 *
 * They provide the LOCAL tier of the two-tier sandbox (see code-sandbox.ts).
 * When a Docker daemon and a sandbox image are available, the kernel-level
 * controls Docker gives us (`--network none`, `--read-only`, a tmpfs scratch,
 * `--memory`, `--pids-limit`, `--cap-drop ALL`) are the real enforcement and
 * these guards are belt-and-braces on top. Without Docker they are the ONLY
 * enforcement for network and filesystem: interpreter-level, applied before a
 * single line of author code runs, ordinarily not bypassable from inside
 * script code (an author cannot un-require a blocked builtin or restore a
 * deleted import hook without the very modules that are blocked) — with one
 * exception each language needed a second hook for: Node's dynamic `import()`
 * has its own ESM resolution pipeline that never goes through `Module._load`,
 * so `require("net")` alone being blocked would not have stopped
 * `await import("node:net")`; a `module.register()` loader hook closes that
 * separately. Python's `subprocess`/`multiprocessing` being blocked at import
 * would not have stopped `os.system()`/`os.popen()`/`os.fork()`/the
 * `exec*`/`spawn*` family, which reach the OS directly without importing
 * anything — those are disabled unconditionally on `os` itself.
 *
 * What they cannot do is contain a native-code exploit of the interpreter
 * itself, or a spawning/network primitive neither language's guard above
 * accounts for — this is a blocklist, not a kernel boundary. That is exactly
 * why decision 5 keeps the whole feature behind DYNAMIC_CODE_STEPS_ENABLED
 * pending a security review, and why the Docker tier exists as the path to
 * real isolation.
 */

/** Loaded with `node --require` so it runs before the author's script. */
export const NODE_GUARD_SOURCE = String.raw`"use strict";
/* Karos dynamic-agent code-step guard (Node). Runs BEFORE author code. */
const path = require("node:path");
const Module = require("node:module");

const SCRATCH = process.env.KAROS_SANDBOX_SCRATCH;
if (!SCRATCH) {
  process.stderr.write("sandbox guard: KAROS_SANDBOX_SCRATCH missing\n");
  process.exit(97);
}

const fs = require("node:fs");
const origExistsSync = fs.existsSync.bind(fs);
const origRealpathSync = fs.realpathSync.bind(fs);

let SCRATCH_REAL;
try {
  SCRATCH_REAL = origRealpathSync(SCRATCH);
} catch {
  SCRATCH_REAL = path.resolve(SCRATCH);
}

function blocked(what) {
  return new Error(
    "Blocked in the dynamic code sandbox: " +
      what +
      ". A code step has no network access and may only write inside its own scratch directory.",
  );
}

/* ---------------- network / process-spawning modules ---------------- */
const BLOCKED_MODULES = new Set([
  "net",
  "dns",
  "dns/promises",
  "http",
  "https",
  "http2",
  "tls",
  "dgram",
  "child_process",
  "cluster",
  "worker_threads",
  "inspector",
  "inspector/promises",
]);

const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  const bare = typeof request === "string" && request.startsWith("node:") ? request.slice(5) : request;
  if (BLOCKED_MODULES.has(bare)) throw blocked('require("' + request + '")');
  return origLoad.apply(this, arguments);
};

/* dynamic import() never goes through Module._load — it has its own ESM
   resolution pipeline, reachable even from this CommonJS guard/script pair.
   module.register() installs a loader hook for that pipeline; the hook body
   travels as a data: URL so it needs its own copy of the blocklist (it runs
   in a separate loader realm with no access to this file's variables). */
try {
  const { register } = require("node:module");
  const { pathToFileURL } = require("node:url");
  const loaderSource =
    "const BLOCKED=new Set(" +
    JSON.stringify(Array.from(BLOCKED_MODULES)) +
    ");" +
    "export async function resolve(specifier,context,next){" +
    "const bare=specifier.startsWith('node:')?specifier.slice(5):specifier;" +
    "if(BLOCKED.has(bare)){throw new Error('Blocked in the dynamic code sandbox: import(\"'+specifier+'\"). A code step has no network access and may only write inside its own scratch directory.');}" +
    "return next(specifier,context);" +
    "}";
  register("data:text/javascript," + encodeURIComponent(loaderSource), pathToFileURL(__filename).href);
} catch (err) {
  throw blocked("dynamic code sandbox setup (" + (err && err.message) + ")");
}

/* ---------------- network globals ---------------- */
for (const name of ["fetch", "WebSocket", "XMLHttpRequest", "EventSource"]) {
  try {
    Object.defineProperty(globalThis, name, {
      configurable: false,
      writable: false,
      value: function () {
        throw blocked(name + "()");
      },
    });
  } catch {
    /* not present in this runtime — nothing to block */
  }
}

/* ---------------- filesystem writes ---------------- */
function assertWritable(target, label) {
  if (typeof target !== "string" && !(target instanceof URL) && !Buffer.isBuffer(target)) {
    // a file descriptor: already-open handles were checked when they were opened
    return;
  }
  const asPath = target instanceof URL ? target.pathname : String(target);
  const resolved = path.resolve(asPath);
  let probe = resolved;
  for (;;) {
    if (origExistsSync(probe)) break;
    const parent = path.dirname(probe);
    if (parent === probe) break;
    probe = parent;
  }
  let real;
  try {
    real = origRealpathSync(probe);
  } catch {
    real = probe;
  }
  const rel = path.relative(SCRATCH_REAL, real);
  if (rel !== "" && (rel.startsWith("..") || path.isAbsolute(rel))) {
    throw blocked(label + ' outside the scratch directory ("' + asPath + '")');
  }
}

const WRITE_FLAG = /[wax+]/;
function guardOne(obj, name, argIndex, opts) {
  const original = obj[name];
  if (typeof original !== "function") return;
  obj[name] = function (...args) {
    if (opts && opts.flagArg !== undefined) {
      const flags = args[opts.flagArg];
      const isWrite =
        typeof flags === "string" ? WRITE_FLAG.test(flags) : typeof flags === "number" ? flags !== 0 : false;
      if (!isWrite) return original.apply(this, args);
    }
    assertWritable(args[argIndex], name);
    return original.apply(this, args);
  };
}

for (const name of [
  "writeFile",
  "writeFileSync",
  "appendFile",
  "appendFileSync",
  "createWriteStream",
  "mkdir",
  "mkdirSync",
  "rm",
  "rmSync",
  "rmdir",
  "rmdirSync",
  "unlink",
  "unlinkSync",
  "truncate",
  "truncateSync",
  "chmod",
  "chmodSync",
  "symlink",
  "symlinkSync",
  "link",
  "linkSync",
  "mkdtemp",
  "mkdtempSync",
]) {
  guardOne(fs, name, 0);
}
/* rename/copyFile: both source and destination side matter for the destination */
for (const name of ["rename", "renameSync", "copyFile", "copyFileSync"]) {
  const original = fs[name];
  if (typeof original !== "function") continue;
  fs[name] = function (...args) {
    assertWritable(args[1], name);
    return original.apply(this, args);
  };
}
guardOne(fs, "open", 0, { flagArg: 1 });
guardOne(fs, "openSync", 0, { flagArg: 1 });

if (fs.promises) {
  for (const name of [
    "writeFile",
    "appendFile",
    "mkdir",
    "rm",
    "rmdir",
    "unlink",
    "truncate",
    "chmod",
    "symlink",
    "link",
    "mkdtemp",
  ]) {
    guardOne(fs.promises, name, 0);
  }
  for (const name of ["rename", "copyFile"]) {
    const original = fs.promises[name];
    if (typeof original !== "function") continue;
    fs.promises[name] = function (...args) {
      assertWritable(args[1], name);
      return original.apply(this, args);
    };
  }
  guardOne(fs.promises, "open", 0, { flagArg: 1 });
}
`;

/** Invoked as `python3 <guard.py> <step.py>`; runs the author's script via runpy. */
export const PYTHON_GUARD_SOURCE = String.raw`# Karos dynamic-agent code-step guard (Python). Runs BEFORE author code.
import builtins
import os
import runpy
import sys

SCRATCH = os.environ.get("KAROS_SANDBOX_SCRATCH")
if not SCRATCH:
    sys.stderr.write("sandbox guard: KAROS_SANDBOX_SCRATCH missing\n")
    raise SystemExit(97)
SCRATCH_REAL = os.path.realpath(SCRATCH)

_MESSAGE = (
    "Blocked in the dynamic code sandbox: {what}. A code step has no network "
    "access and may only write inside its own scratch directory."
)


def _blocked(what):
    return PermissionError(_MESSAGE.format(what=what))


# ---------------- network / process-spawning modules ----------------
BLOCKED_TOP = {
    "socket",
    "ssl",
    "urllib",
    "urllib2",
    "urllib3",
    "http",
    "httplib",
    "http2",
    "ftplib",
    "smtplib",
    "poplib",
    "imaplib",
    "telnetlib",
    "nntplib",
    "xmlrpc",
    "socketserver",
    "asyncio",
    "selectors",
    "requests",
    "httpx",
    "aiohttp",
    "websockets",
    "subprocess",
    "multiprocessing",
    "ctypes",
    "webbrowser",
}


class _ImportBlocker:
    def find_module(self, name, path=None):
        return self if name.split(".")[0] in BLOCKED_TOP else None

    def load_module(self, name):
        raise _blocked('import "%s"' % name)

    # PEP 451 path, which modern CPython prefers
    def find_spec(self, name, path=None, target=None):
        if name.split(".")[0] in BLOCKED_TOP:
            raise _blocked('import "%s"' % name)
        return None


sys.meta_path.insert(0, _ImportBlocker())
# Anything already imported before the hook went in must not stay reachable.
for _name in list(sys.modules):
    if _name.split(".")[0] in BLOCKED_TOP:
        del sys.modules[_name]


# ---------------- filesystem writes ----------------
def _assert_writable(target, label):
    if isinstance(target, int):
        return  # already-open descriptor
    try:
        as_path = os.fspath(target)
    except TypeError:
        return
    if isinstance(as_path, bytes):
        as_path = as_path.decode("utf-8", "replace")
    resolved = os.path.abspath(as_path)
    probe = resolved
    while not os.path.exists(probe):
        parent = os.path.dirname(probe)
        if parent == probe:
            break
        probe = parent
    real = os.path.realpath(probe)
    if real != SCRATCH_REAL and not real.startswith(SCRATCH_REAL + os.sep):
        raise _blocked('%s outside the scratch directory ("%s")' % (label, as_path))


_real_open = builtins.open


def _guarded_open(file, mode="r", *args, **kwargs):
    if any(flag in mode for flag in ("w", "a", "x", "+")):
        _assert_writable(file, "open()")
    return _real_open(file, mode, *args, **kwargs)


builtins.open = _guarded_open

_real_os_open = os.open


def _guarded_os_open(path, flags, *args, **kwargs):
    if flags & (os.O_WRONLY | os.O_RDWR | os.O_CREAT | os.O_APPEND | os.O_TRUNC):
        _assert_writable(path, "os.open()")
    return _real_os_open(path, flags, *args, **kwargs)


os.open = _guarded_os_open


def _wrap_single(module, name, index=0):
    original = getattr(module, name, None)
    if original is None:
        return

    def wrapper(*args, **kwargs):
        if len(args) > index:
            _assert_writable(args[index], name + "()")
        return original(*args, **kwargs)

    setattr(module, name, wrapper)


for _fn in ("remove", "unlink", "mkdir", "makedirs", "rmdir", "removedirs", "truncate", "chmod", "symlink", "link"):
    _wrap_single(os, _fn)
for _fn in ("rename", "replace"):
    _wrap_single(os, _fn, index=1)


# ---------------- process spawning ----------------
# subprocess/multiprocessing are blocked at import above, but os itself
# exposes process-spawning primitives (system(), popen(), the exec*/spawn*
# family, fork()) that never go through an import and so are untouched by
# the meta_path hook. Every one of these is disabled unconditionally, not
# gated on a path check like the fs wrappers above.
def _block_call(module, name):
    if not hasattr(module, name):
        return

    def _blocked_call(*_args, **_kwargs):
        raise _blocked("os.%s()" % name)

    setattr(module, name, _blocked_call)


for _fn in (
    "system",
    "popen",
    "posix_spawn",
    "posix_spawnp",
    "spawnl",
    "spawnle",
    "spawnlp",
    "spawnlpe",
    "spawnv",
    "spawnve",
    "spawnvp",
    "spawnvpe",
    "execl",
    "execle",
    "execlp",
    "execlpe",
    "execv",
    "execve",
    "execvp",
    "execvpe",
    "fork",
    "forkpty",
):
    _block_call(os, _fn)

# ---------------- hand off to the author's script ----------------
_script = sys.argv[1]
sys.argv = [_script]
runpy.run_path(_script, run_name="__main__")
`;
