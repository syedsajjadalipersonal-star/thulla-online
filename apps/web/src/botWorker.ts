/// <reference lib="webworker" />
// Runs the bot off the main thread so the table stays smooth while it thinks.
import type { ThullaView } from '@thulla/engine';
import { chooseCard, type BotOptions } from '@thulla/bot';

interface Request {
  id: number;
  view: ThullaView;
  opts: BotOptions;
}

self.onmessage = (e: MessageEvent<Request>) => {
  const { id, view, opts } = e.data;
  let card = -1;
  try {
    card = chooseCard(view, opts);
  } catch {
    card = -1;
  }
  (self as unknown as Worker).postMessage({ id, card });
};
