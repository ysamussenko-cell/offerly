/** Версия приложения — единственный источник package.json; сборщик (esbuild в wrangler и Vite) встраивает поле при сборке.
 *  Её читают точка входа Pages (functions/api/[[route]].ts → /api/health) и Worker рассылки. Поднимать — `npm run release:version -- X.Y.Z`. */
import { version } from '../../package.json';

export const VERSION: string = version;
