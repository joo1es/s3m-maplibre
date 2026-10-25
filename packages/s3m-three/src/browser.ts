/**
 * 浏览器直引包的入口（由 vite.browser.config.ts 使用）。
 *
 * 做两件事：
 *   1. 页面里还没有全局 THREE 时，把本包用到的那份挂上去（内置版就是打进来那份，
 *      外置版就是页面原本那个）——所以用户不需要、也不应该再引第二份；
 *   2. 显式把 API 挂到 window.S3M。
 *
 * 第 2 步不能省：vite 生成的 `var S3M = (function(){…})()` 在被 `import()` 当模块加载时
 * 只存在于模块作用域，不会变成 window.S3M。classic script 和动态 import 两种加载方式
 * 都要能用，所以自己赋值一次。
 */
import * as THREE from 'three';
import * as api from './index.js';

const g = globalThis as typeof globalThis & { THREE?: unknown; S3M?: unknown };
if (!g.THREE) g.THREE = THREE;
g.S3M = api;

export * from './index.js';
export { default } from './index.js';
