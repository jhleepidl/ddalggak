#!/usr/bin/env node
export { evaluateRoomNativeEnvironment as evaluateDogfoodEnvironment, checkRoomNativeDogfood as checkAntigravityDogfood } from './check_room_native_dogfood_readiness.js';
import { pathToFileURL } from 'node:url';
import { checkRoomNativeDogfood } from './check_room_native_dogfood_readiness.js';

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { await import('dotenv/config'); } catch {}
  const output = await checkRoomNativeDogfood();
  console.log(JSON.stringify(output, null, 2));
  process.exit(output.ready ? 0 : 1);
}
