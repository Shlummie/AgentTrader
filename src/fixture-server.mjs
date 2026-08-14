import { FixtureMarketData } from './fixtures.mjs';
import { startServer } from './server.mjs';

const port = Number.parseInt(process.env.AGENTTRADER_PORT || '4181', 10);
const { url } = await startServer({ port, market: new FixtureMarketData() });
process.stdout.write(`${JSON.stringify({ ok: true, fixtureOnly: true, url, pid: process.pid })}\n`);
