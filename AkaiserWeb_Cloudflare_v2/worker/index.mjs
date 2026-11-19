import { createHandler } from '../src/core.mjs';
import { d1Store, cleanup } from './d1store.mjs';

let handler = null;

export default {
  // Only /api/* reaches the Worker (see wrangler.toml); the pages in public/ are served by Cloudflare directly.
  async fetch(req, env) {
    handler ||= createHandler(() => d1Store(env.DB), {
      maxDevices: parseInt(env.MAX_DEVICES || '5', 10),
      gachaOffsetMin: parseInt(env.GACHA_UTC_OFFSET_MIN || '0', 10),
    });
    return handler(req, { ip: req.headers.get('cf-connecting-ip') || undefined });
  },
  async scheduled(_event, env) {
    await cleanup(env.DB);
  },
};
