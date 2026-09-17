/**
 * Clean build output, and warn about a server already holding the port.
 *
 * A live demonstration reported two routes 404ing. Both route files were
 * present and both served correctly from a fresh build — the cause was a
 * previously started server still answering on the port with an older build.
 * That failure is indistinguishable from missing code in a browser, so this
 * removes the stale build output and says plainly if something is still
 * listening.
 *
 * Deliberately does NOT kill processes. Terminating something a developer
 * started, without being asked, is not this script's decision to make; naming
 * it and how to stop it is more useful and cannot go wrong.
 *
 * Cross-platform: Windows, macOS and Linux, using only Node built-ins.
 */
import { createServer } from 'node:net';
import { rm, access } from 'node:fs/promises';
import { join } from 'node:path';

const PORT = Number(process.env.PORT ?? process.env.EJE_PORT ?? 3000);

const exists = async (path) => {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
};

const portInUse = (port) =>
  new Promise((resolve) => {
    const server = createServer();
    server.once('error', (error) => resolve(error.code === 'EADDRINUSE'));
    server.once('listening', () => server.close(() => resolve(false)));
    server.listen(port, '0.0.0.0');
  });

const buildDir = join(process.cwd(), '.next');

if (await exists(buildDir)) {
  await rm(buildDir, { recursive: true, force: true });
  console.log('Removed .next — the next build cannot reuse stale route output.');
} else {
  console.log('No .next directory to remove.');
}

if (await portInUse(PORT)) {
  console.log('');
  console.log(`WARNING: something is already listening on port ${PORT}.`);
  console.log('  That is almost certainly an older server, and it will keep answering');
  console.log('  requests with the build it started from. Stop it before starting again:');
  console.log('');
  console.log('    Windows (PowerShell):  Get-Process node | Stop-Process -Force');
  console.log('    macOS / Linux:         pkill -f "next start"; pkill -f "next dev"');
  console.log('');
  console.log(`  Or start on a free port instead:  npm run start -- -p ${PORT + 1}`);
  process.exitCode = 1;
} else {
  console.log(`Port ${PORT} is free.`);
}
