/**
 * S3M 解析结果 → three.js 可渲染对象
 *
 * 职责边界：这里只做「数据 → BufferGeometry / Material」的搬运，
 * 不处理坐标系、不处理 LOD、不处理样式切换 —— 那些属于 S3MLayer。
 *
 * 三条约定，下游都依赖它：
 *   1. 几何一定有 `aBatchId`（单体编号）和 `aColor`（顶点色），没有就补零/补白，
 *      否则着色器里的 attribute 绑定会缺槽位。
 *   2. 每个 Mesh 独享一个材质实例，但 uniform 对象是全局共享的，
 *      所以既能逐单体高亮，又能一次改样式全场景生效。
 *   3. `userData` 上挂 `skeletonName / geoRef / tileRef`，供拾取后反查单体属性。
 */
import * as THREE from 'three';
import { createTexture } from './TextureFactory.js';
import { createSharedUniforms, createStyledMaterial } from './StyleMaterial.js';
import { isTransparentMaterial, minVertexAlpha } from './materialAlpha.js';
import type { StyledMaterial } from './StyleMaterial.js';
import { assembleTileGeometry, LINE_PRIMITIVE, POINT_PRIMITIVE } from '../core/TileGeometry.js';
import type { TileGeometryData, PrimitiveData } from '../core/TileGeometry.js';
import { decodeScale, decodeRotation } from '../core/GaussianSplat.js';
import { createSplatMaterial, createQuadGeometry, splatRaycast } from './SplatMaterial.js';
import { SPLAT_SIGMA } from '../core/SplatProjection.js';
import type {
  GeoPackageEntry,
  ParsedTile,
  StyleUniforms,
  VertexPackage,
} from '../core/types.js';

// 组装层下沉 core 后的对外 API 兼容：常量原住本文件
export { LINE_PRIMITIVE, POINT_PRIMITIVE };

function isLinePrimitive(primitiveType: number): boolean {
  // 1 = 点，2 = 线段，3 = 折线，13 = 棱线包
  return primitiveType === LINE_PRIMITIVE || primitiveType === 2 || primitiveType === 3;
}

function isPointPrimitive(primitiveType: number): boolean {
  return primitiveType === POINT_PRIMITIVE;
}

/* ------------------------------------------------------------ 高斯泼溅 */

let splatMaterial: THREE.ShaderMaterial | null = null;

/** 泼溅材质全瓦片共享：同一套 program / uniform，不为每块瓦片单独编译 */
function getSplatMaterial(): THREE.ShaderMaterial {
  splatMaterial ??= createSplatMaterial();
  return splatMaterial;
}

/**
 * 每帧同步绘图缓冲尺寸：顶点着色器的最小像素半径 / 抗锯齿低通都要拿它
 * 把 ndc 换算成像素。还没建过泼溅材质时什么都不做（不为了设置而创建）。
 */
export function setSplatViewport(width: number, height: number): void {
  if (splatMaterial) (splatMaterial.uniforms.uViewport!.value as THREE.Vector2).set(width, height);
}

/**
 * 点云包 → 实例化四边形（每个高斯一片）。
 *
 * 返回 `null` 表示这不是泼溅数据（缺 gsScale / gsRotation），调用方退回 `THREE.Points`。
 * 这样「有泼溅参数就画泼溅、没有就当点云」的分流只由数据决定，不靠外部开关。
 */
function buildSplatGeometry(
  prim: PrimitiveData,
  vp: VertexPackage
): { geo: THREE.InstancedBufferGeometry; sigma: number } | null {
  const scaleAttr = vp.vertexAttributes.find((a) => a.semantic === 'gsScale');
  const rotAttr = vp.vertexAttributes.find((a) => a.semantic === 'gsRotation');
  const posAttr = prim.attributes.position;
  if (!scaleAttr || !rotAttr || !posAttr) return null;

  // 泼溅参数是逐骨架的，合批不会发生在点云包上；取两者较小值兜住异常数据，
  // 宁可少画几个高斯，也不要读到越界内存
  const count = Math.min(
    vp.verticesCount,
    Math.floor(posAttr.array.length / posAttr.components)
  );
  if (count <= 0) return null;

  const scales = decodeScale(scaleAttr.data, scaleAttr.stride, scaleAttr.offsetInBytes, count);
  const quats = decodeRotation(rotAttr.data, rotAttr.stride, rotAttr.offsetInBytes, count);

  // 代表性半轴：抽样的最长轴中位数（米）。LOD 判据要拿它估「屏幕上高斯有多大」，
  // 见 core/SplatLod.ts。抽样上限 512，解码已经付过代价，这里不再逐点扫。
  const sigma = medianLongAxis(scales, count);

  const geo = createQuadGeometry();
  geo.instanceCount = count;
  geo.setAttribute(
    'iCenter',
    new THREE.InstancedBufferAttribute(posAttr.array as Float32Array, 3)
  );
  geo.setAttribute('iScale', new THREE.InstancedBufferAttribute(scales, 3));
  geo.setAttribute('iQuat', new THREE.InstancedBufferAttribute(quats, 4));

  // 颜色优先取 vp 的原始 color 流（u8×4，含 alpha）。
  // prim.attributes.aColor 现在也是 RGBA，但点云这条路径本来就要原始字节
  // （避免多一轮 float 转换），保持原样即可。
  const rgba = new Float32Array(count * 4);
  rgba.fill(1);
  const colorAttr = vp.vertexAttributes.find((a) => a.semantic === 'color');
  if (colorAttr && colorAttr.dtype === 'u8') {
    const comp = colorAttr.components ?? 4;
    // 异常包里 color 流可能比顶点数短：读不到的点保持默认白，不越界
    const n = Math.min(count, Math.floor(colorAttr.data.length / colorAttr.stride));
    for (let i = 0; i < n; i++) {
      const o = i * colorAttr.stride + colorAttr.offsetInBytes;
      rgba[i * 4] = colorAttr.data[o]! / 255;
      rgba[i * 4 + 1] = colorAttr.data[o + 1]! / 255;
      rgba[i * 4 + 2] = colorAttr.data[o + 2]! / 255;
      if (comp >= 4) rgba[i * 4 + 3] = colorAttr.data[o + 3]! / 255;
    }
  } else if (prim.attributes.aColor) {
    // 兜底：只有组装后的 RGB（0~1 float），alpha 补 1
    const src = prim.attributes.aColor;
    const comp = src.components ?? 4;
    for (let i = 0; i < count; i++) {
      for (let k = 0; k < Math.min(comp, 4); k++) rgba[i * 4 + k] = src.array[i * comp + k]!;
    }
  }
  geo.setAttribute('iColor', new THREE.InstancedBufferAttribute(rgba, 4));

  // 真实包围球：拾取要先用它做「射线有没有碰到这一块」的快速排除。
  // createQuadGeometry 里给的是空球（渲染靠 frustumCulled = false，不看它），
  // 留成 Infinity 的话每点一次要把所有瓦片的每个高斯都算一遍。
  //
  // 包围盒和最长轴在同一遍里扫完：10 万点的瓦片，多一遍就是几毫秒。
  const pos = posAttr.array;
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  let maxAxis = 0;
  for (let i = 0; i < count; i++) {
    const x = pos[i * 3]!;
    const y = pos[i * 3 + 1]!;
    const z = pos[i * 3 + 2]!;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
    if (z < minZ) minZ = z;
    if (z > maxZ) maxZ = z;
    const sx = scales[i * 3]!;
    const sy = scales[i * 3 + 1]!;
    const sz = scales[i * 3 + 2]!;
    if (sx > maxAxis) maxAxis = sx;
    if (sy > maxAxis) maxAxis = sy;
    if (sz > maxAxis) maxAxis = sz;
  }
  const box = new THREE.Box3();
  if (count > 0) {
    box.min.set(minX, minY, minZ);
    box.max.set(maxX, maxY, maxZ);
  }
  const sphere = new THREE.Sphere(new THREE.Vector3(), 0);
  if (!box.isEmpty()) box.getBoundingSphere(sphere);
  sphere.radius += SPLAT_SIGMA * maxAxis;
  geo.boundingSphere = sphere;

  return { geo, sigma };
}

/**
 * 最长轴的中位长度（米）。抽样上限 512 个，够稳且不拖慢瓦片构建。
 * 全部非正 / 非有限值时返回 0，调用方据此退回通用 LOD 判据。
 */
function medianLongAxis(scales: Float32Array, count: number): number {
  const step = Math.max(1, Math.floor(count / 512));
  const xs: number[] = [];
  for (let i = 0; i < count; i += step) {
    const m = Math.max(scales[i * 3]!, scales[i * 3 + 1]!, scales[i * 3 + 2]!);
    if (Number.isFinite(m) && m > 0) xs.push(m);
  }
  if (!xs.length) return 0;
  xs.sort((a, b) => a - b);
  return xs[xs.length >> 1]!;
}


/* ------------------------------------------------------------------ 图集 UV */

/**
 * S3MBLOCK 图集的 UV 一律用几何自带的 uv0 原值，这里不再做任何重算。
 *
 * 走过三轮弯路才定下来（每一条都不要再试）：
 *   1. 「按世界尺度 fract」—— uv0 是建模工具留下的逐岛坐标，不是世界投影，
 *      全局跨度 279 只是所有岛拼起来的包围盒，拿它除以瓦片尺寸算出的
 *      「1 个 uv 周期 = 1.65 m」是错的；
 *   2. 「按 binding 分组、逐面 0..1」—— 等于把作者排好的映射丢掉，
 *      一面墙强行铺一整张精灵，长墙被横向拉糊；
 *   3. 「按 uv 跨度 ÷ 精灵像素取整重复」—— 同上，而且依赖精灵像素尺寸这个
 *      与几何无关的量。
 *
 * 官方引擎的做法（iClient3D 12.1.1，VS 里 getUVMatrixForBatch / FS 里
 * czm_getTexColorForS3M）就是：fract(uv0) 直接乘子区域尺寸再平移到子区域，
 * 一个 uv 周期 = 一张精灵，作者在 uv0 里已经把重复次数写死了。
 * 唯一需要额外处理的是子区域右 1/3 那条内联 mip 链，见 StyleMaterial.s3mAtlasSample。
 */


/**
 * 点云共享材质：顶点色直接上屏，不受光照影响。
 * 固定像素尺寸（sizeAttenuation: false），远近点大小一致，高空浏览时不会缩成一团。
 */
let pointCloudMaterial: THREE.PointsMaterial | null = null;
function getPointCloudMaterial(): THREE.PointsMaterial {
  if (!pointCloudMaterial) {
    pointCloudMaterial = new THREE.PointsMaterial({
      size: 2,
      sizeAttenuation: false,
      vertexColors: true,
    });
  }
  return pointCloudMaterial;
}

/* ------------------------------------------------------------------ 顶点流 */

/** 顶点流解交错 / 法线 / 合批已下沉 core/TileGeometry.ts（Worker / 主线程共用） */

/** SuperMap 内置水面（`103.water`）的基色：偏深的青蓝，配合低粗糙度出一点天光反射 */
const WATER_COLOR = new THREE.Color(0x1d4e63);

/**
 * 棱线 / 高斯点云的绘制顺序基准。
 *
 * 三角面网格的 renderOrder 被钉成「文件里的材质序号」（见 materialIndexOf），
 * 是个从 0 开始的小整数；这两个覆盖层必须排在所有材质之后，
 * 否则会被某块瓦片的材质序号插到前面去。
 */
const EDGE_LINES_RENDER_ORDER = 1000;
const POINT_SPLAT_RENDER_ORDER = 1001;
/** 材质序号的上限，留出覆盖层的空间 */
const MAX_MATERIAL_RENDER_ORDER = 999;

/* ------------------------------------------------------------------ 材质描述 */

interface RawMaterialUnit {
  name?: string;
  id?: string;
  textureunitstate?: RawMaterialUnit;
  texmodmatrix?: number[];
  matrix?: number[];
  addressmode?: { u?: number; v?: number; w?: number };
}

interface RawMaterialDef {
  name?: string;
  id?: string;
  diffuse?: { r?: number; g?: number; b?: number; a?: number };
  shininess?: number;
  alphaMode?: string;
  alphaCutoff?: number;
  cullMode?: string;
  transparentsorting?: boolean;
  textureStates?: RawMaterialUnit[];
  textureunitstates?: RawMaterialUnit[];
}

type RawMaterialEntry = RawMaterialDef & { material?: RawMaterialDef };

/** 3.x 是 `{materials:[...]}`，1.x/2.x 是 `{material:[...]}`，桌面导出偶尔直接给数组 */
function resolveMaterialList(doc: unknown): RawMaterialEntry[] {
  if (!doc) return [];
  if (Array.isArray(doc)) return doc as RawMaterialEntry[];
  const o = doc as { materials?: unknown; material?: unknown };
  const list = o.materials ?? o.material;
  return Array.isArray(list) ? (list as RawMaterialEntry[]) : [];
}

function unwrapMaterial(entry: RawMaterialEntry | undefined): RawMaterialDef | undefined {
  return entry?.material ?? entry;
}

function materialName(m: RawMaterialDef | RawMaterialUnit | undefined): string | undefined {
  return m?.name ?? m?.id;
}

function materialUnits(m: RawMaterialDef | undefined): RawMaterialUnit[] {
  const raw = m?.textureStates ?? m?.textureunitstates ?? [];
  return raw.map((u) => u?.textureunitstate ?? u).filter((u): u is RawMaterialUnit => !!u);
}

/** 判断 4x4 矩阵是否为标准单位矩阵 */
function isIdentityMatrix4(m: number[]): boolean {
  if (m.length !== 16) return false;
  return (
    m[0] === 1 && m[1] === 0 && m[2] === 0 && m[3] === 0 &&
    m[4] === 0 && m[5] === 1 && m[6] === 0 && m[7] === 0 &&
    m[8] === 0 && m[9] === 0 && m[10] === 1 && m[11] === 0 &&
    m[12] === 0 && m[13] === 0 && m[14] === 0 && m[15] === 1
  );
}

/** cullMode：1.x 用 none/clockwise/backward，3.x 用 CULL_NONE / CULL_BACK / CULL_FRONT */
function resolveSide(m: RawMaterialDef | undefined): THREE.Side {
  const cull = String(m?.cullMode ?? '').toUpperCase();
  if (cull === 'CULL_BACK' || cull === 'BACKWARD') return THREE.FrontSide;
  if (cull === 'CULL_FRONT') return THREE.BackSide;
  return THREE.DoubleSide;
}

/* ------------------------------------------------------------------ 入口 */

export interface TileBuildStats {
  meshes: number;
  vertices: number;
  triangles: number;
  textures: number;
  instanced: number;
  /** 数据自带的棱线包（primitiveType 13）数量 */
  edgeLines: number;
  /** 合批前原有独立网格数 */
  originalMeshes?: number;
  /**
   * 该瓦片高斯的最长轴中位长度（米）。只有泼溅瓦片才有值，LOD 判据用它估
   * 「屏幕上一个高斯多大」，见 core/SplatLod.ts。
   */
  splatSigma?: number;
  /** 该瓦片的高斯实例数。泼溅瓦片才有值，LOD 判据用它算屏幕覆盖率 */
  splatCount?: number;
  /** 被跳过的东西，加载完可以直接在控制台看 */
  skipped: string[];
}

export interface BuildTileOptions {
  /** 全局共享 uniform；不传则本次构建自建一份（不推荐，样式将无法全局联动） */
  uniforms?: StyleUniforms;
  textureCache?: Map<string, THREE.Texture>;
  /** 是否显示数据自带的棱线包 */
  edges?: boolean;
  edgeColor?: THREE.ColorRepresentation;
  /**
   * 是否开启瓦片内同材质网格合批（默认 true）。
   * 对倾斜摄影、大网格切片瓦片可减少 90%+ DrawCall，显著提高渲染帧率。
   */
  batching?: boolean;
  /**
   * 是否剔除同单体共面重复三角形（默认 true）。
   *
   * 见 `AssembleOptions.dedupeCoincident`。只在主线程现场组装时生效——
   * 走 Worker 的路径在 Worker 里已经按默认值组装完了。
   */
  dedupeCoincident?: boolean;
  /**
   * Worker 侧已完成的纯数据几何组装（经典 .s3mb 路径由解析 Worker 顺带产出）。
   * 缺省时在主线程现场组装（core/TileGeometry 的同一份实现），两条路径产物一致。
   */
  assembled?: TileGeometryData;
  /**
   * 给三角面材质加 polygonOffset（深度偏移）。
   *
   * 用途：跨单体完全共面的重复面（如 `3D-BIMbuilding-2` 的 5136）深度值落在
   * 深度缓冲分辨率边缘时出斜向摩尔纹；给其中一方一个小偏移（负值 = 拉向相机）
   * 让每个像素稳定选边。这是**整个 mesh 粒度**的开关——该材质所有面都会偏移，
   * 偏移量随斜率/距离缩放，量级在微米级，正常相邻面不受影响。
   */
  polygonOffset?: { factor: number; units: number };
}

export interface BuildTileResult {
  group: THREE.Group;
  stats: TileBuildStats;
  objects: THREE.Object3D[];
  textureKeys?: string[];
}

export async function buildTileObjects(
  tile: ParsedTile,
  options: BuildTileOptions = {}
): Promise<BuildTileResult> {
  const uniforms = options.uniforms ?? createSharedUniforms();
  const textureByCode = options.textureCache ?? new Map<string, THREE.Texture>();
  const group = new THREE.Group();
  const objects: THREE.Object3D[] = [];
  const usedTextureKeys: string[] = [];
  const stats: TileBuildStats = {
    meshes: 0,
    vertices: 0,
    triangles: 0,
    textures: 0,
    instanced: 0,
    edgeLines: 0,
    skipped: [],
  };

  // 棱线包共用一份材质，颜色随 style.edgeColor 走
  const edgeLineMaterial = new THREE.LineBasicMaterial({
    color: new THREE.Color(options.edgeColor ?? '#1f2937'),
    transparent: true,
    opacity: 0.75,
    depthWrite: false,
  });
  group.userData.hasNativeEdges = false;

  // 1) 纹理
  //
  // 缓存 key 不能只用 atlas id：拼图（AtlasPack）是**逐块**做的，同一个 id 在 LOD 兄弟块里
  // 参与的拼图集合可能不同、落位也不同。只按 id 复用会把别块的排布拿过来，
  // 而 aAtlasRect 是本块的 —— 整块贴错图。带 packKey 的按「id#集合签名」隔离。
  const texKeyOf = (code: string): string => {
    const t = (tile.textures as Record<string, { packKey?: string }> | undefined)?.[code];
    return t?.packKey ? `${code}#${t.packKey}` : code;
  };

  for (const [code, tex] of Object.entries(tile.textures ?? {})) {
    // 同一个图集 id 会被很多瓦片共用：先到的那块可能只拿到内嵌缩略图（120x184），
    // 后面的块换成了高清版（240x304）。只按 id 判「缓存已有」会让高清永远进不来，
    // 满屏都是马赛克。所以尺寸变大时必须重解码并覆盖。
    const key = texKeyOf(code);
    const prev = textureByCode.get(key);
    if (prev) {
      const img = prev.image as { width?: number; height?: number } | undefined;
      const prevPixels = (img?.width ?? 0) * (img?.height ?? 0);
      if (prevPixels >= (tex.width ?? 0) * (tex.height ?? 0)) continue;
      textureByCode.delete(key);
    }
    const { texture, decoded } = await createTexture(tex);
    if (texture) {
      textureByCode.set(key, texture);
      usedTextureKeys.push(key);
      stats.textures++;
    } else {
      stats.skipped.push(`texture ${code} → ${decoded}`);
    }
  }

  // 2) 材质描述表
  //
  // 注意：这里**不做**材质池化。单体状态（隐藏 / 改色 / 抬高 / 选中）是按 mesh 写在
  // 材质自己的 uniform 上的（uBatchTex / uSelBatch），一旦多个 mesh 共用同一个材质实例，
  // 就是「81 个 mesh 抢一份 uniform，最后写的赢」——白模瓦片里按单体操作会大面积失效。
  // 材质对象本身很轻（program 由 customProgramCacheKey 复用），一栋一个不心疼。
  const materialList = resolveMaterialList(tile.materials);

  /**
   * 材质在文件里的序号。
   *
   * 用途：完全重合的两份面（实测 `3D-BIMbuilding-2` 里跨单体共面 48 组，顶点偏移中位数
   * 1 微米、最大 0.44 mm）深度相等，官方 `depthTest = LESS_OR_EQUAL`，
   * 结果是**后画的那份赢**。官方的提交顺序就是文件里的材质顺序
   * （每个 index package 一条 DrawCommand），所以这里把 renderOrder 钉成材质序号，
   * 让"谁在上"与官方一致，而且不随材质重建而变。
   *
   * 不能指望 three 自己的排序：不透明队列按 `program.id → material.id → z` 排，
   * 而 material.id 是创建顺序，`_rebuildStyledMaterials()` 换质感档位时会重新分配，
   * 顺序可能整体翻转 —— 同一场景换个画质，重合面的颜色就换了一个。
   */
  const materialIndexOf = (code?: string): number =>
    materialList.findIndex((e) => materialName(unwrapMaterial(e)) === code);

  const makeMaterial = (
    code?: string,
    hasAtlasRect = false,
    hasTexCoordZ = false,
    vertexAlphaMin = 1
  ): StyledMaterial => {
    const entry = materialList.find((e) => materialName(unwrapMaterial(e)) === code);
    const m = unwrapMaterial(entry);
    const units = materialUnits(m);
    const unit0 = units[0];
    let map = unit0 ? (textureByCode.get(texKeyOf(materialName(unit0) ?? unit0.id ?? '')) ?? null) : null;
    // S3MBLOCK 的烘焙图（unit1 / BakeTex）是光照烘焙，官方与 base 相乘；缺它建筑就是一片平白
    const unit1 = units[1];
    const noBake = (globalThis as { __S3M_NO_BAKE?: boolean }).__S3M_NO_BAKE === true;
    const secMap =
      hasAtlasRect && unit1 && !noBake
        ? (textureByCode.get(texKeyOf(materialName(unit1) ?? unit1.id ?? '')) ?? null)
        : null;

    // 检查并应用 texmodmatrix 纹理变换矩阵
    const texMod = unit0?.texmodmatrix ?? unit0?.matrix;
    if (map && Array.isArray(texMod) && texMod.length === 16 && !isIdentityMatrix4(texMod)) {
      map = map.clone();
      map.matrixAutoUpdate = false;
      // S3M texmodmatrix 为 4x4 列主序矩阵 [m0..m15]，对应 2D 仿射变换:
      // u' = m[0]*u + m[4]*v + m[12]
      // v' = m[1]*u + m[5]*v + m[13]
      // Three.js Matrix3.set 按行主序接收参数
      map.matrix.set(
        texMod[0], texMod[4], texMod[12],
        texMod[1], texMod[5], texMod[13],
        0,         0,         1
      );
    }

    // 纹理寻址模式（addressmode）
    if (map && unit0?.addressmode) {
      const u = unit0.addressmode.u;
      const v = unit0.addressmode.v;
      if (u !== undefined || v !== undefined) {
        if (map.matrixAutoUpdate) {
          map = map.clone();
        }
        if (u !== undefined) map.wrapS = u === 0 ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping;
        if (v !== undefined) map.wrapT = v === 0 ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping;
      }
    }

    const diffuse = m?.diffuse ?? { r: 1, g: 1, b: 1, a: 1 };
    // SuperMap 的内置水面：纹理单元 id 是 `103.water`，块里**根本没有像素**
    // （实测 Waters 的 s3mb 只有 1081 字节，textures = 0，材质 diffuse 还是纯白）。
    // 以前当白色漫反射渲染，整片湖就是一块白板。这里按内置水面材质上色。
    const isWater = [unit0, unit1].some((u) => /\.water$/i.test(String(materialName(u) ?? u?.id ?? '')));
    // 官方 isTransparent = (alphaMode === MASK || BLEND)，MASK 我们交给 alphaTest；
    // 另外顶点色 alpha < 1 也必须走混合（SMID 4421 就是这种）。见 render/materialAlpha.ts
    const transparent = isTransparentMaterial({
      alphaMode: m?.alphaMode,
      diffuseAlpha: diffuse.a ?? 1,
      transparentSorting: m?.transparentsorting === true,
      vertexAlphaMin,
      isWaterWithoutMap: isWater && !map,
    });

    // S3M 的 shininess 是旧式 0~128 高光指数，粗略映射到粗糙度
    const roughness =
      typeof m?.shininess === 'number' && m.shininess > 0 ? Math.max(0.15, 1 - m.shininess / 128) : 0.95;

    // 镂空图集（S3MBLOCK）：建筑照片是异形 alpha 抠图，轮廓顶点会采到 alpha=0 的像素，
    // 不丢弃的话就是成片的黑面。cutoff 取材质自带的 alphaCutoff（实测 0.01）。
    // rect 是图集里的原始子区域（含右 1/3 的内联 mip 列），不做任何裁切，
    // 这里保留 alphaTest 只为挡掉轮廓外的零星像素，不会再出现整面墙被抠空。
    const alphaTest = (map as THREE.Texture | null)?.userData?.s3mHasAlpha
      ? Math.max((m?.alphaCutoff as number) ?? 0, 0.01)
      : 0;

    const mat = createStyledMaterial({
      uniforms,
      map,
      color: isWater && !map ? WATER_COLOR.clone() : new THREE.Color(diffuse.r ?? 1, diffuse.g ?? 1, diffuse.b ?? 1),
      side: resolveSide(m),
      transparent,
      opacity: isWater && !map ? 0.86 : (diffuse.a ?? 1),
      roughness: isWater && !map ? 0.12 : roughness,
      alphaTest,
      atlas: hasAtlasRect && !!map,
      // uv 第三分量（custom0）：几何带了这条流，材质才走官方的「按 z 决定采样」分支
      texCoordZ: hasTexCoordZ && !!map,
      secMap,
    });
    // 用户配置的深度偏移（共面摩尔纹 / 重合面归属的人工定序，见 BuildTileOptions 注释）
    if (options.polygonOffset) {
      mat.polygonOffset = true;
      mat.polygonOffsetFactor = options.polygonOffset.factor;
      mat.polygonOffsetUnits = options.polygonOffset.units;
    }
    return mat;
  };

  // 3) 纯数据几何组装：Worker 解析时已顺带产出就直接用，否则主线程现场组装
  //    （core/TileGeometry 的同一份实现，两条路径产物一致）
  const assembled =
    options.assembled ??
    assembleTileGeometry(tile, {
      batching: options.batching !== false,
      dedupeCoincident: options.dedupeCoincident,
    });
  stats.vertices = assembled.stats.vertices;
  stats.edgeLines = assembled.stats.edgeLines;
  stats.instanced = assembled.stats.instanced;
  if (assembled.stats.originalMeshes != null) stats.originalMeshes = assembled.stats.originalMeshes;
  stats.skipped.push(...assembled.stats.skipped);

  const IDENTITY = new THREE.Matrix4();

  const packPrimitive = (prim: PrimitiveData): THREE.BufferGeometry => {
    const geometry = new THREE.BufferGeometry();
    for (const [k, a] of Object.entries(prim.attributes)) {
      if (a) geometry.setAttribute(k, new THREE.BufferAttribute(a.array, a.components, a.normalized));
    }
    if (prim.index) geometry.setIndex(new THREE.BufferAttribute(prim.index, 1));
    else geometry.setDrawRange(0, prim.vertexCount);
    geometry.boundingBox = new THREE.Box3(
      new THREE.Vector3(...prim.bounds.boxMin),
      new THREE.Vector3(...prim.bounds.boxMax)
    );
    geometry.boundingSphere = new THREE.Sphere(
      new THREE.Vector3(...prim.bounds.sphereCenter),
      prim.bounds.sphereRadius
    );
    return geometry;
  };

  for (const prim of assembled.primitives) {
    const geometry = packPrimitive(prim);
    const geoRef = tile.geoPackage[prim.geoNames[0]] ?? null;
    const vp = geoRef?.vertexPackage;
    const material = makeMaterial(
      prim.passNames[0],
      !!prim.attributes.aAtlasRect,
      !!prim.attributes.aTexCoordZ,
      minVertexAlpha(prim.attributes.aColor)
    );
    const matrix =
      prim.matrix && prim.matrix.length === 16 ? new THREE.Matrix4().fromArray(prim.matrix) : null;

    // 棱线包：线段，不是三角面。默认隐藏，等 setEdges(true) 再显示
    if (isLinePrimitive(prim.primitiveType)) {
      const lines = new THREE.LineSegments(geometry, edgeLineMaterial);
      lines.visible = options.edges === true;
      lines.renderOrder = EDGE_LINES_RENDER_ORDER;
      lines.raycast = () => {};
      lines.userData.isEdgeLines = true;
      lines.userData.skeletonName = prim.skeletonName;
      if (matrix && !matrix.equals(IDENTITY)) {
        matrix.decompose(lines.position, lines.quaternion, lines.scale);
      }
      group.add(lines);
      objects.push(lines);
      group.userData.hasNativeEdges = true;
      continue;
    }

    // 点云包：顶点即点，按 THREE.Points 渲染。索引只是点序号，直接走 drawRange。
    if (isPointPrimitive(prim.primitiveType)) {
      // 高斯泼溅：带 gsScale / gsRotation 的点云包不画点，画各向异性的高斯片。
      // 这两条流的量化格式见 core/GaussianSplat.ts 的头部（从官方 worker 读出来的）。
      const splat = vp ? buildSplatGeometry(prim, vp) : null;
      if (splat) {
        // 用 InstancedMesh 而不是裸 Mesh：它会正确设置 instanceCount 与
        // `_maxInstanceCount`，后者缺失时 three 会算出 NaN 个实例、一个像素都不画。
        // instanceMatrix 我们不用（位置全在 iCenter 里），但**不能**把 raycast 关掉：
        // 拾取结果的精确命中点要靠它，关掉就只能退回原点那个 2×2 方块的包围盒。
        const mesh = new THREE.InstancedMesh(splat.geo, getSplatMaterial(), splat.geo.instanceCount);
        mesh.raycast = splatRaycast;
        mesh.frustumCulled = false;
        mesh.renderOrder = POINT_SPLAT_RENDER_ORDER;
        // LOD 判据要用「这块瓦片的高斯有多大」，见 core/SplatLod.ts。
        // 多骨架取最大值：宁可判得更细，也别停在稀的粗层。
        if (splat.sigma > 0) stats.splatSigma = Math.max(stats.splatSigma ?? 0, splat.sigma);
        stats.splatCount = (stats.splatCount ?? 0) + splat.geo.instanceCount;
        // 与点云同样打标记：卸载 / 拾取 / 样式链路靠它放行
        mesh.userData.isPointCloud = true;
        mesh.userData.isGaussianSplat = true;
        mesh.userData.skeletonName = prim.skeletonName;
        mesh.userData.geoRef = geoRef;
        mesh.userData.tileRef = tile;
        mesh.userData.primitiveType = prim.primitiveType;
        if (matrix && !matrix.equals(IDENTITY)) {
          matrix.decompose(mesh.position, mesh.quaternion, mesh.scale);
        }
        group.add(mesh);
        objects.push(mesh);
        stats.meshes++;
        continue;
      }
      // PointsMaterial 的顶点色读内置 'color' 槽位，与 aColor 共享同一份 buffer
      if (!geometry.getAttribute('color')) {
        geometry.setAttribute('color', geometry.getAttribute('aColor')!);
      }
      const points = new THREE.Points(geometry, getPointCloudMaterial());
      // 点云不是 Mesh：viewer 的样式 / 拾取 / 卸载链路都靠这个标记放行
      points.userData.isPointCloud = true;
      points.userData.skeletonName = prim.skeletonName;
      points.userData.geoRef = geoRef;
      points.userData.tileRef = tile;
      points.userData.primitiveType = prim.primitiveType;
      if (matrix && !matrix.equals(IDENTITY)) {
        matrix.decompose(points.position, points.quaternion, points.scale);
      }
      group.add(points);
      objects.push(points);
      stats.meshes++;
      continue;
    }

    let object: THREE.Mesh | THREE.InstancedMesh;
    const instanced =
      !!vp &&
      vp.instanceIndex !== -1 &&
      (vp.instanceMode === 16 || vp.instanceMode === 17) &&
      !!vp.instanceBuffer &&
      (vp.instanceCount ?? 0) > 0;

    if (instanced && vp!) {
      // 逐实例的两条属性：
      //   aInstanceBatchId —— 单体控制位，着色器靠它查状态纹理（改色 / 隐藏 / 抬高）
      //   aInstanceIndex   —— 实例序号，拾取时编码进颜色，CPU 侧再映射回 SMID
      if (!geometry.getAttribute('aInstanceBatchId')) {
        const ids = vp!.instanceBatchIds;
        const batchIds =
          ids && ids.length === vp!.instanceCount ? ids.slice() : new Float32Array(vp!.instanceCount).fill(-1);
        geometry.setAttribute('aInstanceBatchId', new THREE.InstancedBufferAttribute(batchIds, 1));
        const index = new Float32Array(vp!.instanceCount);
        for (let i = 0; i < index.length; i++) index[i] = i;
        geometry.setAttribute('aInstanceIndex', new THREE.InstancedBufferAttribute(index, 1));
      }

      const instancedMesh = new THREE.InstancedMesh(geometry, material, vp!.instanceCount);
      instancedMesh.instanceMatrix.setUsage(THREE.StaticDrawUsage);
      const m4 = new THREE.Matrix4();
      const color = new THREE.Color();
      const stride = vp!.instanceMode;
      const f32 = new Float32Array(vp!.instanceBuffer!.buffer, vp!.instanceBuffer!.byteOffset, vp!.instanceCount * stride);
      for (let i = 0; i < vp!.instanceCount; i++) {
        const o = i * stride;
        // S3M 实例矩阵按 3x4 仿射矩阵（行主序）连续存储 12 个 float（Row3 隐式补齐），
        // 后续紧随 4 个 float 的 RGBA 颜色（stride >= 16）及可选 uint32 的 SMID（stride == 17）。
        // 若用 fromArray 直接按列主序填充 Matrix4，会将平移分量塞进底部的投影行 (w)，
        // 造成严重的透视奇点畸变（所有顶点拉扯成放射状尖锥）。
        m4.set(
          f32[o + 0], f32[o + 1], f32[o + 2], f32[o + 3],
          f32[o + 4], f32[o + 5], f32[o + 6], f32[o + 7],
          f32[o + 8], f32[o + 9], f32[o + 10], f32[o + 11],
          0, 0, 0, 1
        );
        instancedMesh.setMatrixAt(i, m4);
        if (stride >= 16) {
          const r = f32[o + 12];
          const g = f32[o + 13];
          const b = f32[o + 14];
          if (Number.isFinite(r) && Number.isFinite(g) && Number.isFinite(b)) {
            color.setRGB(r, g, b);
            instancedMesh.setColorAt(i, color);
          }
        }
      }
      instancedMesh.instanceMatrix.needsUpdate = true;
      if (instancedMesh.instanceColor) instancedMesh.instanceColor.needsUpdate = true;
      instancedMesh.frustumCulled = false;
      object = instancedMesh;
    } else {
      object = new THREE.Mesh(geometry, material);
    }

    // 用 decompose 写回 position/quaternion/scale，而不是 matrix.copy + matrixAutoUpdate=false。
    // 后者在 three 的 updateMatrixWorld 链路里会被重算成单位矩阵，结果就是模型偏移几百米。
    if (matrix && !matrix.equals(IDENTITY)) {
      matrix.decompose(object.position, object.quaternion, object.scale);
    }

    object.userData.skeletonName = prim.skeletonName;
    object.userData.geoRef = geoRef;
    object.userData.tileRef = tile;
    object.userData.primitiveType = prim.primitiveType;
    // 绘制顺序 = 文件材质顺序（见 materialIndexOf 的说明）。只在拿到了序号时钉，
    // 拿不到就保持 three 的默认 0，不影响其他数据。
    // 透明材质例外：共面定序解决的是「不透明面深度相等谁赢」，而透明物体的正确
    // 顺序是「远 → 近」，钉成材质序号反而会把近处玻璃画在远处之前。
    const matIdx = materialIndexOf(prim.passNames[0]);
    if (matIdx >= 0 && !material.transparent) {
      object.renderOrder = Math.min(matIdx, MAX_MATERIAL_RENDER_ORDER);
    }
    if (prim.batchedFrom != null && prim.batchedFrom > 1) {
      object.userData.isBatched = true;
      object.userData.batchedCount = prim.batchedFrom;
      // 合并产物按 batchId 反查 geoRef（拾取用）：原实现在合并时顺手建，这里从 geoNames 重建
      const geoByBatchId = new Map<number, GeoPackageEntry>();
      for (const gname of prim.geoNames) {
        const g = tile.geoPackage[gname];
        if (!g?.pickInfo) continue;
        for (const entry of Object.values(g.pickInfo)) {
          if (typeof entry.batchId === 'number' && entry.batchId >= 0) {
            geoByBatchId.set(entry.batchId, g);
          }
        }
      }
      if (geoByBatchId.size > 0) object.userData.geoByBatchId = geoByBatchId;
    }
    group.add(object);
    objects.push(object);

    stats.meshes++;
    if (prim.primitiveType === 4) stats.triangles += prim.indexCount / 3;
  }

  if (!group.children.length) stats.skipped.push('tile 无可用几何');

  group.userData.textureKeys = usedTextureKeys;
  return { group, stats, objects, textureKeys: usedTextureKeys };
}
