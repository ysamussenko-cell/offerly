import { createApp, type Env } from '../_lib/app';
import { VERSION } from '../_lib/version';

const app = createApp(VERSION);

export const onRequest: PagesFunction<Env> = (ctx) => app.fetch(ctx.request, ctx.env, ctx as unknown as ExecutionContext);
