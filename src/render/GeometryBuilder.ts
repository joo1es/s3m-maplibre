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
import type { StyledMaterial } from './StyleMaterial.js';
import type {
  AttrDType,
  GeoPackageEntry,
  IndexPackage,
  ParsedTile,
  StyleUniforms,
  VertexAttribute,
} from '../core/types.js';

/* ------------------------------------------------------------------ 索引包类型 */

/**
 * S3M 规范里 `DrawPrimitiveType` 只到 10（多边形），但 iServer 实际发布的 v3 瓦片里
 * 会出现 **13**：它是数据自带的「棱线包」—— 索引是线段对，不是三角形。
 *
 * 这条是踩过坑才认出来的：把 13 当三角形画，每条棱线都会被连成一根几十上百米的尖刺，
 * 满屏都是放射状的三角面。按 LineSegments 画出来，正好是整片建筑轮廓线。
 */
export const LINE_PRIMITIVE = 13;

function isLinePrimitive(primitiveType: number): boolean {
  // 1 = 点，2 = 线段，3 = 折线，13 = 棱线包
  return primitiveType === LINE_PRIMITIVE || primitiveType === 2 || primitiveType === 3;
}

/* ------------------------------------------------------------------ 顶点流 */

function bytesPerElement(dtype: AttrDType): number {
  return dtype === 'u8' ? 1 : dtype === 'u16' ? 2 : 4;
}

function typedArray(dtype: AttrDType, buffer: ArrayBufferLike): Float32Array | Uint8Array | Uint16Array | Uint32Array {
  switch (dtype) {
    case 'u8':
      return new Uint8Array(buffer);
    case 'u16':
      return new Uint16Array(buffer);
    case 'u32':
      return new Uint32Array(buffer);
    default:
      return new Float32Array(buffer);
  }
}

function typedArrayOf(dtype: AttrDType, length: number): Float32Array | Uint8Array | Uint16Array | Uint32Array {
  switch (dtype) {
    case 'u8':
      return new Uint8Array(length);
    case 'u16':
      return new Uint16Array(length);
    case 'u32':
      return new Uint32Array(length);
    default:
      return new Float32Array(length);
  }
}

function toBufferAttribute(attr: VertexAttribute): THREE.BufferAttribute {
  const { data, stride, offsetInBytes, dtype = 'f32' } = attr;
  const components = attr.components ?? (attr as unknown as { comp?: number }).comp ?? 3;
  const bpe = bytesPerElement(dtype);
  const itemBytes = components * bpe;
  const actualStride = stride ?? itemBytes;
  const actualOffset = offsetInBytes ?? 0;
  const normalized = dtype === 'u8';

  // 非交错：整段直接铺开
  if (actualStride === itemBytes && actualOffset === 0) {
    const view = typedArray(dtype, data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
    return new THREE.BufferAttribute(view, components, normalized);
  }

  // 交错：逐元素抽取
  const count = Math.floor(data.byteLength / actualStride);
  const out = typedArrayOf(dtype, count * components);
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  for (let i = 0; i < count; i++) {
    const base = i * actualStride + actualOffset;
    for (let c = 0; c < components; c++) {
      const o = base + c * bpe;
      out[i * components + c] =
        dtype === 'u8'
          ? dv.getUint8(o)
          : dtype === 'u16'
            ? dv.getUint16(o, true)
            : dtype === 'u32'
              ? dv.getUint32(o, true)
              : dv.getFloat32(o, true);
    }
  }
  return new THREE.BufferAttribute(out, components, normalized);
}

function toIndex(indexPack: IndexPackage): THREE.BufferAttribute | null {
  const { indices, indexType, indexCount } = indexPack;
  if (!indices || indexCount === 0) return null;
  // 以字节宽度为准：S3M 的 indexType 在 MeshOpt 包里恒为 0，靠它会读错一半索引。
  const width = Math.floor(indices.byteLength / indexCount);
  const wide = width === 4 || (width !== 2 && (indexType === 1 || indexType === 3));
  const n = indexCount * (wide ? 4 : 2);
  if (n > indices.byteLength) return null;
  const buf = indices.buffer.slice(indices.byteOffset, indices.byteOffset + n);
  const view = wide ? new Uint32Array(buf) : new Uint16Array(buf);
  return new THREE.BufferAttribute(view, 1);
}

/** 把 u8 顶点色转成 float vec3，供着色器直接相乘 */
function toColorAttribute(attr: VertexAttribute | null, vertexCount: number): THREE.BufferAttribute {
  const out = new Float32Array(vertexCount * 3);
  if (!attr) {
    out.fill(1);
    return new THREE.BufferAttribute(out, 3);
  }
  const src = attr.data;
  const comp = attr.components ?? 4;
  const scale = attr.dtype === 'u8' ? 1 / 255 : 1;
  for (let i = 0; i < vertexCount; i++) {
    const o = i * comp;
    out[i * 3] = (src[o] ?? 255) * scale;
    out[i * 3 + 1] = (src[o + 1] ?? 255) * scale;
    out[i * 3 + 2] = (src[o + 2] ?? 255) * scale;
  }
  return new THREE.BufferAttribute(out, 3);
}

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
}

export interface BuildTileResult {
  group: THREE.Group;
  stats: TileBuildStats;
  objects: THREE.Object3D[];
}

interface CachedGeometry {
  geometry: THREE.BufferGeometry;
  pack: IndexPackage;
}

interface SkeletonInfo {
  indexPackages: IndexPackage[];
  instanced: boolean;
}

export async function buildTileObjects(
  tile: ParsedTile,
  options: BuildTileOptions = {}
): Promise<BuildTileResult> {
  const uniforms = options.uniforms ?? createSharedUniforms();
  const textureByCode = options.textureCache ?? new Map<string, THREE.Texture>();
  const group = new THREE.Group();
  const objects: THREE.Object3D[] = [];
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
  for (const [code, tex] of Object.entries(tile.textures ?? {})) {
    if (textureByCode.has(code)) continue;
    const { texture, decoded } = await createTexture(tex);
    if (texture) {
      textureByCode.set(code, texture);
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

  const makeMaterial = (code?: string): StyledMaterial => {
    const entry = materialList.find((e) => materialName(unwrapMaterial(e)) === code);
    const m = unwrapMaterial(entry);
    const units = materialUnits(m);
    const unit0 = units[0];
    let map = unit0 ? (textureByCode.get(materialName(unit0) ?? unit0.id ?? '') ?? null) : null;

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
    const alphaMode = m?.alphaMode;
    const transparent = alphaMode === 'AM_BLEND' || (diffuse.a ?? 1) < 0.999 || m?.transparentsorting === true;

    // S3M 的 shininess 是旧式 0~128 高光指数，粗略映射到粗糙度
    const roughness =
      typeof m?.shininess === 'number' && m.shininess > 0 ? Math.max(0.15, 1 - m.shininess / 128) : 0.95;

    const mat = createStyledMaterial({
      uniforms,
      map,
      color: new THREE.Color(diffuse.r ?? 1, diffuse.g ?? 1, diffuse.b ?? 1),
      side: resolveSide(m),
      transparent,
      opacity: diffuse.a ?? 1,
      roughness,
    });
    return mat;
  };

  // 3) 骨架 → 几何。顶点是「骨架局部坐标」，真正位置由引用它的 Geode 矩阵决定。
  const geoCache = new Map<string, CachedGeometry>();
  const skeletonInfo = new Map<string, SkeletonInfo>();

  for (const [name, geo] of Object.entries(tile.geoPackage ?? {})) {
    const vp = geo.vertexPackage;
    const positionAttr = vp.vertexAttributes.find((a) => a.semantic === 'position');
    if (!positionAttr) {
      stats.skipped.push(`${name} 无 position`);
      continue;
    }

    const vertexCount = vp.verticesCount || 0;
    const attributes: Record<string, THREE.BufferAttribute> = { position: toBufferAttribute(positionAttr) };
    let colorAttr: VertexAttribute | null = null;
    let batchAttr: VertexAttribute | null = null;

    for (const attr of vp.vertexAttributes) {
      if (attr.divisor !== undefined) continue; // 实例属性不进顶点流
      if (attr.semantic === 'position') continue;
      if (attr.semantic === 'color') colorAttr = attr;
      else if (attr.semantic === 'batchId') batchAttr = attr;
      else if (attr.semantic === 'normal') attributes.normal = toBufferAttribute(attr);
      else if (attr.semantic === 'uv') attributes.uv = toBufferAttribute(attr);
      else if (attr.semantic === 'uv2') attributes.uv1 = toBufferAttribute(attr);
    }

    // 着色器强依赖这两个 attribute，缺了就补默认值
    attributes.aColor = toColorAttribute(colorAttr, vertexCount);
    attributes.aBatchId = batchAttr
      ? toBufferAttribute(batchAttr)
      : new THREE.BufferAttribute(new Float32Array(vertexCount).fill(-1), 1);

    const instanced = vp.instanceIndex !== -1 && (vp.instanceMode === 16 || vp.instanceMode === 17);
    // 注意：indexPackages 属于 Skeleton（geoPackage[name]），不在 vertexPackage 里
    skeletonInfo.set(name, { indexPackages: geo.indexPackages ?? [], instanced });
    stats.vertices += vertexCount;

    (geo.indexPackages ?? []).forEach((pack, pi) => {
      const geometry = new THREE.BufferGeometry();
      for (const [k, v] of Object.entries(attributes)) geometry.setAttribute(k, v);
      const idx = toIndex(pack);
      if (idx) geometry.setIndex(idx);
      else geometry.setDrawRange(0, vertexCount);

      // 如果数据本身没有法线且是三角网格，必须在绑定了 index 之后计算法线
      // 绝不能在未索引的 attributes.position 上算，否则非连续顶点会导致法线朝向错乱甚至越界 NaN 导致死黑面
      if (!isLinePrimitive(pack.primitiveType) && !geometry.getAttribute('normal')) {
        geometry.computeVertexNormals();
      }

      geometry.computeBoundingBox();
      geometry.computeBoundingSphere();
      geoCache.set(`${name}|${pi}`, { geometry, pack });
    });
  }

  const IDENTITY = new THREE.Matrix4();

  interface CandidateMesh {
    cached: CachedGeometry;
    name: string;
    geo: GeoPackageEntry;
    matrix: THREE.Matrix4 | null;
  }

  const batchGroups = new Map<string, CandidateMesh[]>();

  const mergeBatchGeometries = (
    candidates: CandidateMesh[],
    material: StyledMaterial,
    tileRef: ParsedTile
  ): THREE.Mesh => {
    let totalVertices = 0;
    let totalIndices = 0;
    let hasNormal = false;
    let hasUv = false;
    let hasUv1 = false;
    let hasAColor = false;
    let hasABatchId = false;

    for (const c of candidates) {
      const g = c.cached.geometry;
      const vCount = g.attributes.position?.count ?? 0;
      totalVertices += vCount;
      totalIndices += g.index ? g.index.count : vCount;
      if (g.attributes.normal) hasNormal = true;
      if (g.attributes.uv) hasUv = true;
      if (g.attributes.uv1) hasUv1 = true;
      if (g.attributes.aColor) hasAColor = true;
      if (g.attributes.aBatchId) hasABatchId = true;
    }

    const mergedPos = new Float32Array(totalVertices * 3);
    const mergedNorm = hasNormal ? new Float32Array(totalVertices * 3) : null;
    const mergedUv = hasUv ? new Float32Array(totalVertices * 2) : null;
    const mergedUv1 = hasUv1 ? new Float32Array(totalVertices * 2) : null;
    const mergedColor = hasAColor ? new Float32Array(totalVertices * 3) : null;
    const mergedBatchId = hasABatchId ? new Float32Array(totalVertices) : null;

    const IndexArrayType = totalVertices > 65535 ? Uint32Array : Uint16Array;
    const mergedIndices = new IndexArrayType(totalIndices);

    let vertexOffset = 0;
    let indexOffset = 0;

    const tmpVec = new THREE.Vector3();
    const normalMatrix = new THREE.Matrix3();
    const geoByBatchId = new Map<number, GeoPackageEntry>();

    for (const c of candidates) {
      const g = c.cached.geometry;
      const vCount = g.attributes.position.count;
      const m = c.matrix;
      const hasTransform = m && !m.equals(IDENTITY);
      if (hasTransform && hasNormal) {
        normalMatrix.getNormalMatrix(m);
      }

      if (c.geo.pickInfo) {
        for (const entry of Object.values(c.geo.pickInfo)) {
          if (typeof entry.batchId === 'number' && entry.batchId >= 0) {
            geoByBatchId.set(entry.batchId, c.geo);
          }
        }
      }

      // 1. Position
      const posArr = g.attributes.position.array as ArrayLike<number>;
      for (let i = 0; i < vCount; i++) {
        const srcIdx = i * 3;
        const dstIdx = (vertexOffset + i) * 3;
        if (hasTransform) {
          tmpVec.set(posArr[srcIdx], posArr[srcIdx + 1], posArr[srcIdx + 2]).applyMatrix4(m);
          mergedPos[dstIdx] = tmpVec.x;
          mergedPos[dstIdx + 1] = tmpVec.y;
          mergedPos[dstIdx + 2] = tmpVec.z;
        } else {
          mergedPos[dstIdx] = posArr[srcIdx];
          mergedPos[dstIdx + 1] = posArr[srcIdx + 1];
          mergedPos[dstIdx + 2] = posArr[srcIdx + 2];
        }
      }

      // 2. Normal
      if (mergedNorm) {
        const normAttr = g.attributes.normal;
        if (normAttr) {
          const normArr = normAttr.array as ArrayLike<number>;
          for (let i = 0; i < vCount; i++) {
            const srcIdx = i * 3;
            const dstIdx = (vertexOffset + i) * 3;
            if (hasTransform) {
              tmpVec
                .set(normArr[srcIdx], normArr[srcIdx + 1], normArr[srcIdx + 2])
                .applyMatrix3(normalMatrix)
                .normalize();
              mergedNorm[dstIdx] = tmpVec.x;
              mergedNorm[dstIdx + 1] = tmpVec.y;
              mergedNorm[dstIdx + 2] = tmpVec.z;
            } else {
              mergedNorm[dstIdx] = normArr[srcIdx];
              mergedNorm[dstIdx + 1] = normArr[srcIdx + 1];
              mergedNorm[dstIdx + 2] = normArr[srcIdx + 2];
            }
          }
        }
      }

      // 3. UV
      if (mergedUv) {
        const uvAttr = g.attributes.uv;
        if (uvAttr) {
          const uvArr = uvAttr.array as ArrayLike<number>;
          for (let i = 0; i < vCount; i++) {
            mergedUv[(vertexOffset + i) * 2] = uvArr[i * 2];
            mergedUv[(vertexOffset + i) * 2 + 1] = uvArr[i * 2 + 1];
          }
        }
      }

      // 4. UV1
      if (mergedUv1) {
        const uv1Attr = g.attributes.uv1;
        if (uv1Attr) {
          const uvArr = uv1Attr.array as ArrayLike<number>;
          for (let i = 0; i < vCount; i++) {
            mergedUv1[(vertexOffset + i) * 2] = uvArr[i * 2];
            mergedUv1[(vertexOffset + i) * 2 + 1] = uvArr[i * 2 + 1];
          }
        }
      }

      // 5. aColor
      if (mergedColor) {
        const colAttr = g.attributes.aColor;
        if (colAttr) {
          const colArr = colAttr.array as ArrayLike<number>;
          for (let i = 0; i < vCount; i++) {
            mergedColor[(vertexOffset + i) * 3] = colArr[i * 3];
            mergedColor[(vertexOffset + i) * 3 + 1] = colArr[i * 3 + 1];
            mergedColor[(vertexOffset + i) * 3 + 2] = colArr[i * 3 + 2];
          }
        } else {
          for (let i = 0; i < vCount; i++) {
            mergedColor[(vertexOffset + i) * 3] = 1;
            mergedColor[(vertexOffset + i) * 3 + 1] = 1;
            mergedColor[(vertexOffset + i) * 3 + 2] = 1;
          }
        }
      }

      // 6. aBatchId
      if (mergedBatchId) {
        const bAttr = g.attributes.aBatchId;
        if (bAttr) {
          const bArr = bAttr.array as ArrayLike<number>;
          for (let i = 0; i < vCount; i++) {
            mergedBatchId[vertexOffset + i] = bArr[i];
          }
        } else {
          for (let i = 0; i < vCount; i++) {
            mergedBatchId[vertexOffset + i] = -1;
          }
        }
      }

      // 7. Indices
      if (g.index) {
        const idxArr = g.index.array as ArrayLike<number>;
        const iCount = g.index.count;
        for (let k = 0; k < iCount; k++) {
          mergedIndices[indexOffset + k] = idxArr[k] + vertexOffset;
        }
        indexOffset += iCount;
      } else {
        for (let k = 0; k < vCount; k++) {
          mergedIndices[indexOffset + k] = k + vertexOffset;
        }
        indexOffset += vCount;
      }

      vertexOffset += vCount;
    }

    const mergedGeo = new THREE.BufferGeometry();
    mergedGeo.setAttribute('position', new THREE.BufferAttribute(mergedPos, 3));
    if (mergedNorm) mergedGeo.setAttribute('normal', new THREE.BufferAttribute(mergedNorm, 3));
    if (mergedUv) mergedGeo.setAttribute('uv', new THREE.BufferAttribute(mergedUv, 2));
    if (mergedUv1) mergedGeo.setAttribute('uv1', new THREE.BufferAttribute(mergedUv1, 2));
    if (mergedColor) mergedGeo.setAttribute('aColor', new THREE.BufferAttribute(mergedColor, 3));
    if (mergedBatchId) mergedGeo.setAttribute('aBatchId', new THREE.BufferAttribute(mergedBatchId, 1));
    mergedGeo.setIndex(new THREE.BufferAttribute(mergedIndices, 1));
    mergedGeo.computeBoundingBox();
    mergedGeo.computeBoundingSphere();

    const mesh = new THREE.Mesh(mergedGeo, material);
    mesh.userData.skeletonName = candidates[0].name;
    mesh.userData.geoRef = candidates[0].geo;
    mesh.userData.tileRef = tileRef;
    mesh.userData.primitiveType = 4;
    mesh.userData.isBatched = true;
    mesh.userData.batchedCount = candidates.length;
    if (geoByBatchId.size > 0) {
      mesh.userData.geoByBatchId = geoByBatchId;
    }

    return mesh;
  };

  const placeObject = (
    cached: CachedGeometry,
    name: string,
    geo: GeoPackageEntry,
    matrix: THREE.Matrix4 | null
  ): THREE.Object3D => {
    const { geometry, pack } = cached;
    const material = makeMaterial(pack.passNames?.[0]);
    let object: THREE.Mesh | THREE.InstancedMesh;

    const info = skeletonInfo.get(name);
    const vp = geo.vertexPackage;

    // 棱线包：线段，不是三角面。默认隐藏，等 setEdges(true) 再显示
    if (isLinePrimitive(pack.primitiveType)) {
      const lines = new THREE.LineSegments(geometry, edgeLineMaterial);
      lines.visible = options.edges === true;
      lines.renderOrder = 2;
      lines.raycast = () => {};
      lines.userData.isEdgeLines = true;
      lines.userData.skeletonName = name;
      if (matrix && !matrix.equals(IDENTITY)) {
        matrix.decompose(lines.position, lines.quaternion, lines.scale);
      }
      group.add(lines);
      objects.push(lines);
      group.userData.hasNativeEdges = true;
      stats.edgeLines++;
      return lines;
    }

    if (info?.instanced && vp.instanceBuffer && vp.instanceCount > 0) {
      const instanced = new THREE.InstancedMesh(geometry, material, vp.instanceCount);
      instanced.instanceMatrix.setUsage(THREE.StaticDrawUsage);
      const m4 = new THREE.Matrix4();
      const color = new THREE.Color();
      const stride = vp.instanceMode;
      const f32 = new Float32Array(vp.instanceBuffer.buffer, vp.instanceBuffer.byteOffset, vp.instanceCount * stride);
      for (let i = 0; i < vp.instanceCount; i++) {
        const o = i * stride;
        // S3M 的实例矩阵同样是列主序，直接按 three 的存储顺序铺
        m4.fromArray(f32.subarray(o, o + 16));
        instanced.setMatrixAt(i, m4);
        if (stride === 17) {
          // 第 17 个 float 是打包成 RGBA 字节的颜色
          const packed = new Uint8Array(new Float32Array([f32[o + 16]]).buffer);
          color.setRGB(packed[0] / 255, packed[1] / 255, packed[2] / 255);
          instanced.setColorAt(i, color);
        }
      }
      instanced.instanceMatrix.needsUpdate = true;
      if (instanced.instanceColor) instanced.instanceColor.needsUpdate = true;
      instanced.frustumCulled = false;
      stats.instanced++;
      object = instanced;
    } else {
      object = new THREE.Mesh(geometry, material);
    }

    // 用 decompose 写回 position/quaternion/scale，而不是 matrix.copy + matrixAutoUpdate=false。
    // 后者在 three 的 updateMatrixWorld 链路里会被重算成单位矩阵，结果就是模型偏移几百米。
    if (matrix && !matrix.equals(IDENTITY)) {
      matrix.decompose(object.position, object.quaternion, object.scale);
    }

    object.userData.skeletonName = name;
    object.userData.geoRef = geo;
    object.userData.tileRef = tile;
    object.userData.primitiveType = pack.primitiveType;
    group.add(object);
    objects.push(object);

    stats.meshes++;
    if (pack.primitiveType === 4) stats.triangles += (pack.indexCount || 0) / 3;
    return object;
  };

  // 4) 按 Geode 摆放：一个骨架可能被多个 geode 以不同矩阵引用
  let placed = 0;
  for (const pageLod of tile.groupNode?.pageLods ?? []) {
    for (const geode of pageLod.geodes ?? []) {
      const m = geode.matrix;
      // S3M 的 matrix4d 是列主序（OpenGL 约定），平移在第 12/13/14 位，
      // 与 three 的 Matrix4.elements 布局一致 —— 必须用 fromArray 直接搬。
      // 用 set() 按行主序喂进去等于转置，平移会被塞进投影行，模型直接飞上天。
      const matrix = m && m.length === 16 ? new THREE.Matrix4().fromArray(m) : null;

      for (const name of geode.skeletonNames ?? []) {
        const info = skeletonInfo.get(name);
        if (!info) continue;
        const geo = tile.geoPackage[name];
        if (!geo) continue;
        const vp = geo.vertexPackage;
        for (let pi = 0; pi < info.indexPackages.length; pi++) {
          const cached = geoCache.get(`${name}|${pi}`);
          if (!cached) continue;

          // 棱线包或实例化网格：保持单独摆放
          if (
            isLinePrimitive(cached.pack.primitiveType) ||
            (info.instanced && vp.instanceBuffer && vp.instanceCount > 0)
          ) {
            placeObject(cached, name, geo, matrix);
            placed++;
            continue;
          }

          // 普通三角面网格：若开启合批，按材质进行分组收集
          if (options.batching !== false && cached.pack.primitiveType === 4) {
            const matKey = cached.pack.passNames?.[0] ?? '__default__';
            let list = batchGroups.get(matKey);
            if (!list) {
              list = [];
              batchGroups.set(matKey, list);
            }
            list.push({ cached, name, geo, matrix });
            placed++;
            continue;
          }

          placeObject(cached, name, geo, matrix);
          placed++;
        }
      }
    }
  }

  // 兜底：没有被任何 geode 引用的骨架，按单位矩阵渲染，避免整块消失
  if (placed === 0) {
    for (const [name, info] of skeletonInfo) {
      const geo = tile.geoPackage[name];
      if (!geo) continue;
      const vp = geo.vertexPackage;
      for (let pi = 0; pi < info.indexPackages.length; pi++) {
        const cached = geoCache.get(`${name}|${pi}`);
        if (!cached) continue;

        if (
          isLinePrimitive(cached.pack.primitiveType) ||
          (info.instanced && vp.instanceBuffer && vp.instanceCount > 0)
        ) {
          placeObject(cached, name, geo, null);
          continue;
        }

        if (options.batching !== false && cached.pack.primitiveType === 4) {
          const matKey = cached.pack.passNames?.[0] ?? '__default__';
          let list = batchGroups.get(matKey);
          if (!list) {
            list = [];
            batchGroups.set(matKey, list);
          }
          list.push({ cached, name, geo, matrix: null });
          continue;
        }

        placeObject(cached, name, geo, null);
      }
    }
  }

  // 执行同材质几何合批
  if (batchGroups.size > 0) {
    for (const [matKey, list] of batchGroups) {
      stats.originalMeshes = (stats.originalMeshes ?? 0) + list.length;
      if (list.length === 1) {
        placeObject(list[0].cached, list[0].name, list[0].geo, list[0].matrix);
      } else {
        const material = makeMaterial(matKey === '__default__' ? undefined : matKey);
        const batchedMesh = mergeBatchGeometries(list, material, tile);
        group.add(batchedMesh);
        objects.push(batchedMesh);
        stats.meshes++;
        for (const item of list) {
          stats.triangles += (item.cached.pack.indexCount || 0) / 3;
        }
      }
    }
  }

  if (!group.children.length) stats.skipped.push('tile 无可用几何');

  return { group, stats, objects };
}
