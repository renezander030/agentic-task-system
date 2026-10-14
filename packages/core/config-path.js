import os from 'node:os';
import path from 'node:path';

// Where ATS keeps per-user state: <XDG_CONFIG_HOME or ~/.config>/ats. Read on every
// call so a host or test can repoint it; modules that pin a path at load time
// call these at load time.
export function atsStateDir() {
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'ats');
}

// A state file's own environment override wins over the shared directory.
export function atsStatePath(envVar, fileName) {
  return process.env[envVar] || path.join(atsStateDir(), fileName);
}
