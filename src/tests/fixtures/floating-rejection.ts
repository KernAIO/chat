/**
 * A service process with one floating promise that rejects — the shape that used to end `chat`.
 *
 * Run with `KERN_GUARD=on` it must print `alive` and exit 0; with `KERN_GUARD=off` node must kill it,
 * which is what makes the first run evidence of the guard rather than of a lenient runtime.
 * `src/tests/resilience.test.ts` runs both.
 */
import { installUnhandledRejectionGuard } from '../../guards.js'

const logged: string[] = []
if (process.env.KERN_GUARD !== 'off')
  installUnhandledRejectionGuard({ error: (_fields, msg) => logged.push(msg) })

// nothing awaits this, and nothing catches it
void Promise.reject(new Error('the presence backend is unreachable'))

setTimeout(() => {
  process.stdout.write(`alive logged=${logged.length}\n`)
  process.exit(0)
}, 300)
