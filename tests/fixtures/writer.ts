import { appendMessage } from '../../src/board/messages.js';

const [msgsDir, name, count] = process.argv.slice(2);
for (let i = 1; i <= Number(count); i += 1) {
  await appendMessage(msgsDir!, {
    id: `${name}-${i}`,
    ts: new Date().toISOString(),
    from: name!,
    to: ['reader'],
    text: `message ${i} from ${name} ${'x'.repeat(i % 97)}`,
  });
}
