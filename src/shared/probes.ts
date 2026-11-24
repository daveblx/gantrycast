/**
 * Multi-command probe posted to POST /api/servers/:id/exec.
 *
 * Shared by the renderer and the backend so that the command the interface
 * sends is byte-for-byte the command the server's allowlist permits. Keeping
 * two copies of this string is how the Prod Test button silently started
 * returning 403.
 */
export const PROD_TEST_COMMAND = [
  'echo "=== PROD TEST ==="',
  'uname -a',
  'echo "Node.js:"; node -v || echo "Not installed"',
  'echo "Docker:"; docker --version || echo "Not installed"',
  'echo "Disk usage:"; df -h / | tail -1',
  'echo "CPU info:"; nproc || echo "nproc not available"',
  'echo "Memory:"; free -h || cat /proc/meminfo | grep Mem',
].join(' && ');
