import { createPlatform } from './platform.mjs';

/**
 * 把 Node 平台层挂到 Vite dev / preview 的 /__api 下。
 * Tauri 构建时由 Rust `commands/*` 提供同样的命令。
 */
export function platformPlugin() {
  let platform = null;
  const ensure = () => (platform ??= createPlatform());

  const middleware = (req, res, next) => {
    if (!req.url || !req.url.startsWith('/__api/')) {
      next();
      return;
    }
    ensure()
      .handle(req, res)
      .catch((error) => {
        res.statusCode = 500;
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.end(
          JSON.stringify({
            ok: false,
            error: { message: error instanceof Error ? error.message : '平台层异常', code: 500 },
          }),
        );
      });
  };

  return {
    name: 'qmusic-platform',
    configureServer(server) {
      server.middlewares.use(middleware);
    },
    configurePreviewServer(server) {
      server.middlewares.use(middleware);
    },
  };
}
