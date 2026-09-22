import { joinAgent } from '../../src/board/agents.js';

const [dir, id] = process.argv.slice(2);
try {
  await joinAgent({ id: id!, dir: dir! }, 'builder-1', false);
  process.exit(0);
} catch {
  process.exit(1);
}
