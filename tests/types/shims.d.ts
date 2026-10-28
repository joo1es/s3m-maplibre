/**
 * 测试专用的环境类型垫片（仅 tests/tsconfig.json 纳入，不影响发布代码）。
 * 这里只兜底「没有自带 .d.ts 的导入」——运行时由 bun 解析，类型上给 any 即可。
 */

// 仓库内的发布辅助脚本（.mjs，无类型声明）
declare module '../../tools/release-plan.mjs' {
  const plan: any;
  export default plan;
  export const formatVersion: any;
  export const parseVersion: any;
  export const tagNames: any;
  export const validateSync: any;
}

// 第三方 loader 的子路径入口（官方未带类型）
declare module '@supermapgis/s3m-content-loader/source/S3MBlockBufferLoader.js' {
  const S3MBlockBufferLoader: any;
  export default S3MBlockBufferLoader;
}
