import { startMockSite } from './server.ts';

/** Starts the mock polling site for trying the bot by hand:  npm run mock */
const port = Number(process.env['PORT'] ?? 4173);
const site = await startMockSite(Number.isInteger(port) && port > 0 ? port : 4173);

process.stdout.write(`Mock polling site is running.

  Presenter controls:   ${site.presenterUrl}
  Participant page:     ${site.participantUrl('demo')}
  Plain form version:   ${site.genericUrl('room')}

In another terminal, point the bot at it:

  npm start -- ${site.participantUrl('demo')}

Press Ctrl+C to stop.
`);

const stop = (): void => {
  void site.close().then(() => process.exit(0));
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
