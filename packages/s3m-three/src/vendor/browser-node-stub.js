/**
 * 浏览器构建（iife）的 node 内建模块占位。
 *
 * vendor 里的 emscripten 解码器（draco / crunch）带 Node 环境分支：
 * `if (ENVIRONMENT_IS_NODE) { fs = require('node:fs'); ... }`——浏览器里
 * 这个分支永远不执行，这里只需要让解析器有个落点、消除
 * 「Module "node:fs" has been externalized for browser compatibility」告警。
 * Node 环境不走这份 iife 产物（走 tsc 的 ESM 产物），不受影响。
 */
export default {};
