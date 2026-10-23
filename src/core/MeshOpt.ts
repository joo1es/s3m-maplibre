/**
 * S3M v3 MeshOpt 几何压缩（Skeleton 的 MeshOpt 分支）
 *
 * 结构不是照着规范写的 —— 规范里的 CompressedDataPackage 描述已经落后于 v3.01 的实际数据，
 * 这里的布局是从真实瓦片逐字节标定出来的（见下方字段注释里的实测值）。
 *
 * 与官方 S3M_JS SDK 的差异：
 *   1. 官方 `parseMeshOptSkeleton` 在描述字符串后会多推进 4 字节，导致后续索引包全部错位
 *      （实测 v3.01 数据必然崩在 parseMeshOpIndexPackage）。这里按数据实际布局读。
 *   2. 官方把「源字节长度」当 meshopt 的 filter 参数传进去，等于不滤波；
 *      这里 normals 走八面体解码，UV/位置按各自的量化常量还原成 float。
 *
 * 量化公式（用 OBB 反推验证过，误差 0）：
 *   position = minVerticesValue + uint16 * vertCompressConstant
 *   texcoord = minTexCoordValue[i] + uint16 * texCoordCompressConstant[i]
 *   normal   = octDecode(int16 / 32767)
 */
import type { BinaryReader } from './BinaryReader.js';
import type { IndexPackage, VertexAttribute, VertexPackage } from './types.js';
import type { MeshoptDecoder } from '../vendor/meshopt_decoder.module.js';

/** 顶点语义是位标记，不是枚举序号 */
export const MeshOptSemantic = {
  POSITION: 0x1,
  POSITION_W: 0x2,
  NORMAL: 0x4,
  TANGENT: 0x8,
  TEXCOORD0: 0x10,
  TEXCOORD1: 0x20,
  COLOR: 0x40,
  COLOR1: 0x80,
  CUSTOM0: 0x200,
  CUSTOM1: 0x400,
  GS_SCALE: 0x20001,
  GS_ROTATION: 0x20002,
} as const;

/** 索引包里 primitiveType = 13 表示索引未压缩（直接 uint32 数组） */
const UNCOMPRESSED_INDEX = 0x0d;

let decoderPromise: Promise<MeshoptDecoder> | null = null;

/**
 * 懒加载 meshoptimizer（wasm 内联，约 22KB）。
 * 只有真正遇到 MeshOpt 瓦片时才会拉起来，v1/v2 与标准 v3 不受影响。
 */
export function loadMeshoptDecoder(): Promise<MeshoptDecoder> {
  if (!decoderPromise) {
    decoderPromise = import('../vendor/meshopt_decoder.module.js').then(async (mod) => {
      const decoder = mod.default;
      if (!decoder?.supported) throw new Error('[s3m] 当前环境不支持 WebAssembly，无法解码 MeshOpt 几何');
      await decoder.ready;
      return decoder;
    });
  }
  return decoderPromise;
}

/* ------------------------------------------------------------------ 八面体法线 */

function sign(v: number): number {
  return v < 0 ? -1 : 1;
}

/** meshopt 的八面体解码，把 [-1,1]² 还原成单位球面上的方向 */
function octDecode(x: number, y: number, out: Float32Array, o: number): void {
  let px = x;
  let py = y;
  const z = 1 - Math.abs(px) - Math.abs(py);
  if (z < 0) {
    const t = (1 - Math.abs(py)) * sign(px);
    py = (1 - Math.abs(px)) * sign(py);
    px = t;
  }
  const len = Math.hypot(px, py, z) || 1;
  out[o] = px / len;
  out[o + 1] = py / len;
  out[o + 2] = z / len;
}

/* ------------------------------------------------------------------ 工具 */

function f32Attribute(semantic: string, data: Float32Array, components: number): VertexAttribute {
  return {
    semantic,
    data: new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
    components,
    stride: components * 4,
    offsetInBytes: 0,
    dtype: 'f32',
  };
}

function u8Attribute(semantic: string, data: Uint8Array, components: number): VertexAttribute {
  return {
    semantic,
    data,
    components,
    stride: components,
    offsetInBytes: 0,
    dtype: 'u8',
  };
}

/** 每顶点字节数，对应 meshopt 解码目标的 stride */
function strideFor(semantic: number, compressOptions: number, customId: number): number {
  switch (semantic) {
    case MeshOptSemantic.NORMAL:
    case MeshOptSemantic.TEXCOORD0:
    case MeshOptSemantic.TEXCOORD1:
      return 4; // 2 × int16 / uint16
    case MeshOptSemantic.COLOR:
    case MeshOptSemantic.COLOR1:
      return 4; // RGBA8
    case MeshOptSemantic.CUSTOM0:
    case MeshOptSemantic.CUSTOM1:
      return 4 * Math.max(1, customId);
    case MeshOptSemantic.GS_SCALE:
    case MeshOptSemantic.GS_ROTATION:
      return compressOptions & 0x40 ? 4 : 4 * Math.max(1, customId);
    default:
      return 8; // Position：4 × uint16
  }
}

function decode(
  decoder: MeshoptDecoder,
  vertexCount: number,
  stride: number,
  source: Uint8Array
): Uint8Array {
  const size = vertexCount * stride;
  // 头读错时 vertexCount 会是天文数字，这里先拦一道，免得报「Invalid typed array length」这种没法定位的错
  if (!Number.isSafeInteger(size) || size > 64 * 1024 * 1024) {
    throw new Error(`[s3m] MeshOpt 流尺寸异常：${vertexCount} 顶点 × ${stride}B = ${size}B`);
  }
  const out = new Uint8Array(size);
  decoder.decodeVertexBuffer(out, vertexCount, stride, source, source.length);
  return out;
}

/* ------------------------------------------------------------------ 骨架 */

export interface MeshOptBlockInfo {
  vertexCount: number;
  compressOptions: number;
  /** 位置量化：value = min + uint16 * scale */
  minVertices: [number, number, number];
  vertScale: number;
  /** 两套纹理坐标量化常量 */
  texCoordScale: Array<[number, number]>;
  texCoordOffset: Array<[number, number]>;
  /** 各语义的解码字节数，便于排查 */
  streams: Array<{ semantic: string; bytes: number; stride: number }>;
}

const SEMANTIC_NAME: Record<number, string> = {
  [MeshOptSemantic.POSITION]: 'position',
  [MeshOptSemantic.POSITION_W]: 'positionW',
  [MeshOptSemantic.NORMAL]: 'normal',
  [MeshOptSemantic.TANGENT]: 'tangent',
  [MeshOptSemantic.TEXCOORD0]: 'uv',
  [MeshOptSemantic.TEXCOORD1]: 'uv2',
  [MeshOptSemantic.COLOR]: 'color',
  [MeshOptSemantic.COLOR1]: 'color2',
  [MeshOptSemantic.CUSTOM0]: 'custom0',
  [MeshOptSemantic.CUSTOM1]: 'custom1',
  [MeshOptSemantic.GS_SCALE]: 'gsScale',
  [MeshOptSemantic.GS_ROTATION]: 'gsRotation',
};

/**
 * 读取一个 MeshOpt 压缩的 Skeleton。
 *
 * 二进制布局（v3.01 实测）：
 * ```
 * uint32  compressOptions            // 0x13 = Position | Normal | TexCoord
 * uint32  blockCount                 // 实测恒为 1
 *   uint32  vertexCount
 *   float32 vertCompressConstant
 *   float64 minVerticesValue.xyz
 *   float64 texCoordCompressConstant[0].xy
 *   float64 minTexCoordValue[0].xy
 *   float64 texCoordCompressConstant[1].xy
 *   float64 minTexCoordValue[1].xy
 *   int32   attrCount
 *     int32  semantic                // 位标记
 *     int32  customId                // 仅 Custom0/Custom1/GSScale/GSRotation
 *     int32  compressedSize
 *     byte   data[compressedSize]
 *     pad4
 *   String  descript                // {"TextureCoordMatrix":1,"VertexWeight":0}
 *   pad4
 * ```
 */
export async function parseMeshOptSkeleton(r: BinaryReader, vp: VertexPackage): Promise<MeshOptBlockInfo> {
  const decoder = await loadMeshoptDecoder();

  const compressOptions = r.u32();
  vp.compressOptions = compressOptions;
  const blockCount = r.u32();

  const info: MeshOptBlockInfo = {
    vertexCount: 0,
    compressOptions,
    minVertices: [0, 0, 0],
    vertScale: 1,
    texCoordScale: [
      [0, 0],
      [0, 0],
    ],
    texCoordOffset: [
      [0, 0],
      [0, 0],
    ],
    streams: [],
  };

  for (let bi = 0; bi < blockCount; bi++) {
    const vertexCount = r.u32();
    const vertScale = r.f32();
    const minX = r.f64();
    const minY = r.f64();
    const minZ = r.f64();

    const texCoordScale: Array<[number, number]> = [];
    const texCoordOffset: Array<[number, number]> = [];
    for (let i = 0; i < 4; i++) {
      const a = r.f64();
      const b = r.f64();
      // 顺序是 scale0, offset0, scale1, offset1
      if (i % 2 === 0) texCoordScale.push([a, b]);
      else texCoordOffset.push([a, b]);
    }

    const attrCount = r.i32();
    const decodeThisBlock = bi === 0;

    if (decodeThisBlock) {
      info.vertexCount = vertexCount;
      info.vertScale = vertScale;
      info.minVertices = [minX, minY, minZ];
      info.texCoordScale = texCoordScale;
      info.texCoordOffset = texCoordOffset;
      vp.verticesCount = vertexCount;
    }

    for (let ai = 0; ai < attrCount; ai++) {
      const semantic = r.i32();
      let customId = 0;
      if (
        semantic === MeshOptSemantic.CUSTOM0 ||
        semantic === MeshOptSemantic.CUSTOM1 ||
        semantic === MeshOptSemantic.GS_SCALE ||
        semantic === MeshOptSemantic.GS_ROTATION
      ) {
        customId = r.i32();
      }
      const compressedSize = r.i32();
      const data = r.bytes(compressedSize);
      r.align4();

      if (!decodeThisBlock) continue;

      // 切线流我们不用（渲染里没有法线贴图通道），解不出来也不该拖垮整个瓦片：
      // 真实服务里带 PBR 的数据（如 SubwayStationCombined）都带这条流，之前直接抛错导致整套数据不可见
      if (semantic === MeshOptSemantic.TANGENT) {
        info.streams.push({ semantic: 'tangent', bytes: compressedSize, stride: 0 });
        continue;
      }

      const stride = strideFor(semantic, compressOptions, customId);
      let out: Uint8Array;
      try {
        out = decode(decoder, vertexCount, stride, data);
      } catch {
        // 纹理坐标偶尔是 float32 存储（stride 8），按量化格式解失败就退回
        if (semantic === MeshOptSemantic.TEXCOORD0 || semantic === MeshOptSemantic.TEXCOORD1) {
          out = decode(decoder, vertexCount, 8, data);
        } else {
          throw new Error(`[s3m] MeshOpt 属性解码失败（semantic=0x${semantic.toString(16)}）`);
        }
      }

      const name = SEMANTIC_NAME[semantic] ?? `semantic_0x${semantic.toString(16)}`;
      info.streams.push({
        semantic: name,
        bytes: compressedSize,
        stride: vertexCount > 0 ? out.byteLength / vertexCount : 0,
      });

      if (semantic === MeshOptSemantic.POSITION) {
        const u16 = new Uint16Array(out.buffer, out.byteOffset, vertexCount * 4);
        const pos = new Float32Array(vertexCount * 3);
        for (let i = 0; i < vertexCount; i++) {
          pos[i * 3] = minX + u16[i * 4] * vertScale;
          pos[i * 3 + 1] = minY + u16[i * 4 + 1] * vertScale;
          pos[i * 3 + 2] = minZ + u16[i * 4 + 2] * vertScale;
        }
        vp.vertexAttributes.push(f32Attribute('position', pos, 3));
      } else if (semantic === MeshOptSemantic.NORMAL) {
        const i16 = new Int16Array(out.buffer, out.byteOffset, vertexCount * 2);
        const nrm = new Float32Array(vertexCount * 3);
        for (let i = 0; i < vertexCount; i++) {
          octDecode(i16[i * 2] / 32767, i16[i * 2 + 1] / 32767, nrm, i * 3);
        }
        vp.vertexAttributes.push(f32Attribute('normal', nrm, 3));
      } else if (semantic === MeshOptSemantic.COLOR) {
        vp.vertexAttributes.push(u8Attribute('color', out, 4));
      } else if (semantic === MeshOptSemantic.COLOR1) {
        vp.vertexAttributes.push(u8Attribute('color2', out, 4));
      } else if (semantic === MeshOptSemantic.TEXCOORD0 || semantic === MeshOptSemantic.TEXCOORD1) {
        const slot = semantic === MeshOptSemantic.TEXCOORD0 ? 0 : 1;
        const scale = texCoordScale[slot] ?? [0, 0];
        const offset = texCoordOffset[slot] ?? [0, 0];
        const uv = new Float32Array(vertexCount * 2);
        if (out.byteLength === vertexCount * 8) {
          // 未量化：直接是 float32 对
          const src = new Float32Array(out.buffer, out.byteOffset, vertexCount * 2);
          uv.set(src);
        } else {
          const u16 = new Uint16Array(out.buffer, out.byteOffset, vertexCount * 2);
          for (let i = 0; i < vertexCount; i++) {
            uv[i * 2] = offset[0] + u16[i * 2] * scale[0];
            uv[i * 2 + 1] = offset[1] + u16[i * 2 + 1] * scale[1];
          }
        }
        vp.vertexAttributes.push(f32Attribute(slot === 0 ? 'uv' : 'uv2', uv, 2));
      }
      // tangent / custom / GS 系列暂不使用
    }

    const descript = r.string();
    r.align4();
    if (decodeThisBlock && descript) {
      try {
        vp.customVertexAttribute = JSON.parse(descript);
      } catch {
        vp.customVertexAttribute = descript;
      }
    }
  }

  // attrLocation 供老接口按名字查索引
  for (let i = 0; i < vp.vertexAttributes.length; i++) {
    vp.attrLocation[`a${vp.vertexAttributes[i].semantic}`] = i;
  }

  return info;
}

/* ------------------------------------------------------------------ 索引包 */

/**
 * MeshOpt 骨架的索引包。
 * 与标准骨架相比只多了一个 `compressedSize`，其余字段顺序一致；
 * primitiveType = 13 时索引未压缩，直接是 uint32 数组。
 */
export async function parseMeshOptIndexPackages(r: BinaryReader): Promise<IndexPackage[]> {
  const decoder = await loadMeshoptDecoder();
  const count = r.i32();
  const packs: IndexPackage[] = [];

  for (let i = 0; i < count; i++) {
    const indexCount = r.i32();
    if (indexCount < 1) continue;

    const declaredIndexType = r.u8();
    const useIndex = r.u8();
    const primitiveType = r.u8();
    r.skip(1);

    const size = r.i32();
    let indices: Uint8Array;

    if (primitiveType === UNCOMPRESSED_INDEX) {
      indices = r.bytes(size * 4);
      r.align4();
    } else {
      const src = r.bytes(size);
      r.align4();
      // meshopt 永远解成 uint32
      indices = new Uint8Array(indexCount * 4);
      decoder.decodeIndexBuffer(indices, indexCount, 4, src);
    }

    const passCount = r.i32();
    const passNames: string[] = [];
    for (let p = 0; p < passCount; p++) passNames.push(r.string());
    r.align4();

    // MeshOpt 包里的 indexType 字段不可信（实测恒为 0，而数据是 4 字节/索引）。
    // 以实际字节宽度为准写回 indexType，否则下游会按 uint16 读，索引值全错。
    const width = indexCount > 0 ? indices.byteLength / indexCount : 0;
    const indexType =
      width === 2 ? 0 : width === 4 ? 3 : declaredIndexType === 1 || declaredIndexType === 3 ? declaredIndexType : 0;
    packs.push({ indexCount, indexType, useIndex, primitiveType, indices, passNames });
  }

  return packs;
}
