/**
 * 浏览器直引包的入口（由 vite.browser.config.ts 使用）。
 *
 * 同 s3m-three：页面里没有全局 THREE 就挂一份（外置版挂的是页面原本那个，
 * 内置版挂的是打进来那份），然后显式把 API 挂到 window.S3MMapLibre。
 *
 * 显式赋值的原因：vite 生成的 `var S3MMapLibre = (function(){…})()` 在被 `import()`
 * 当模块加载时只存在于模块作用域，不会变成全局变量。
 */
import * as THREE from 'three';
import * as api from './index.js';

const g = globalThis as typeof globalThis & { THREE?: unknown; S3MMapLibre?: unknown };
if (!g.THREE) g.THREE = THREE;
g.S3MMapLibre = api;

export * from './index.js';
export { default } from './index.js';
