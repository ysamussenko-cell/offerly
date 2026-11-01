/** `npm run e2e:stand` — поднять стенд руками (dist + API на SQLite в памяти) и посмотреть экраны в браузере.
 *  Код входа показывается на экране; засев: `curl -X POST localhost:4180/__e2e/seed -d '{"email":"…"}'`. */
import { startStand } from './server';

startStand({ port: Number(process.env.PORT ?? 4180) }).then(s => console.log(`Стенд e2e: ${s.url} (Ctrl+C — остановить)`));
