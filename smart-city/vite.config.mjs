/**
 * 智慧城市 showcase 的独立开发服务。
 *
 * 刻意不复用 site/vite.config.ts：那边有 SSG、文档路由与 404 兜底，加一个页面要改主项目。
 * 这里 root 就是本目录，主项目一行都不动；但要能 import 仓库里的 workspace 包与
 * site/src/examples 的现成特效，所以 fs.allow 放开到仓库根，并 dedupe three 保证单实例。
 *
 * 端口 5174：用户平时跑的 bun run dev 占着 5173，不抢端口。
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(DIR, '..');

/**
 * 内核重建的刷新闸门。
 *
 * 为什么不能简单地把 dist 从 watcher 里摘掉指望一个 reload 端点：
 * Vite 对没进 `optimizeDeps` 的工作区包（s3m-maplibre / s3m-three 就是）走的是
 * **模块图缓存的 transform 结果**。dist 不在 watcher 里 → 模块图永远不知道文件变了
 * → `/__city-reload` 让浏览器重新拉一遍，拉到的还是旧内容。症状就是"页面刷了但代码
 * 没变"，比不刷还容易误判。
 *
 * 也不能让 watcher 自由发挥：一次内核构建会连着写几十个 dist 文件，每次变更都
 * full reload，浏览器在构建期间会刷好几次，每次重跑遮罩和演出。
 *
 * 所以拆成两段：
 *   - 构建前 `POST /__city-build/start` → mute，`handleHotUpdate` 返回空数组，
 *     期间的变更不触发 HMR（模块图的失效由 Vite 自己照常做）；
 *   - 构建后 `POST /__city-build/end` → 解除 mute，`invalidateAll()` 把缓存的
 *     transform 结果全丢掉，再发**一次** full reload。
 *
 * dist 必须留在 watcher 里（见下面 `watch.ignored` 的注释），否则第一段就失效了。
 */
let building = false;

function reloadOnBuildDone() {
  return {
    name: 'city-reload-on-build',
    configureServer(server) {
      server.middlewares.use('/__city-build', (req, res) => {
        // connect 的 use(prefix) 会把前缀剥掉，这里拿到的是 '/start' / '/end'
        const path = (req.url || '').split('?')[0];
        if (path === '/start') {
          building = true;
        } else if (path === '/end') {
          building = false;
          // ★ 关键：不 invalidate 的话，浏览器拿到的还是构建前的 transform 缓存
          server.moduleGraph.invalidateAll();
          server.ws.send({ type: 'full-reload' });
        } else if (path === '/abort') {
          // 构建失败：解除静音但**不刷**，浏览器保持上一版（刷新只会拿到半成品）
          building = false;
        }
        res.statusCode = 204;
        res.end();
      });
    },
    handleHotUpdate(ctx) {
      // 构建期间静音：返回空数组，Vite 不往下传播，也就不会刷
      if (building) return [];
      return ctx.modules;
    },
  };
}

export default defineConfig({
  root: DIR,
  base: './',
  plugins: [reloadOnBuildDone()],
  server: {
    port: 5174,
    strictPort: false,
    fs: { allow: [ROOT] },
    // _tmp 里是十几万条抓取缓存，watcher 扫进去会白烧一遍 CPU。
    //
    // ★ dist **必须留在** watcher 里。工作区包没进 optimizeDeps，走的是模块图的
    //   transform 缓存；dist 一旦从 watcher 摘掉，Vite 就再也不知道文件变了，
    //   浏览器刷新也只能拿到旧代码。构建期间的多次刷新由上面 reloadOnBuildDone
    //   的 mute 闸门压掉，不靠摘 watcher。
    watch: {
      ignored: ['**/_tmp/**', '**/node_modules/**'],
    },
  },
  resolve: { dedupe: ['three'] },
  build: { target: 'es2022', outDir: 'dist' },
});
