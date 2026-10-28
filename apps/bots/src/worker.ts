// One bot brain on its own thread, so several tables can be thought about at once.
import { parentPort } from 'node:worker_threads';
import type { ThullaView } from '@thulla/engine';
import { chooseCard, type BotOptions } from '@thulla/bot';

parentPort!.on('message', (req: { id: number; view: ThullaView; opts: BotOptions }) => {
  let card = -1;
  try {
    card = chooseCard(req.view, req.opts);
  } catch {
    card = -1;
  }
  parentPort!.postMessage({ id: req.id, card });
});
