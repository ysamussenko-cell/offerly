import { createApp, type Env } from '../_lib/app';

const VERSION = '0.25.0';
const app = createApp(VERSION);

export const onRequest: PagesFunction<Env> = (ctx) => app.fetch(ctx.request, ctx.env, ctx as unknown as ExecutionContext);
