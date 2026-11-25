/**
 * 图集纹理的**分带上传**（RGBA 大图专用）。
 *
 * 问题：图集纹理上传是同步的 `texImage2D`，一张 2048² 的 RGBA 图集是 16 MB，
 * 落在哪一帧哪一帧就掉（实测提交期单帧几十到几百毫秒）。
 *
 * 做法：不走 three 的整张上传，而是自己用原始 GL 先分配存储（`texImage2D(…, null)`），
 * 再按行带 `texSubImage2D` 逐帧填入。手感上等价于「后台把像素搬进显存」。
 *
 * 为什么不会出现「半张图」：
 *   1. 新建的纹理挂在还没进场景的瓦片上，`pump` 在 `render` 之前跑；
 *   2. 瓦片真正进场景前（S3MViewer 的 onTile 回调）会 `flushBandedUploads()` 兜底，
 *      把没传完的行同步补齐 —— 最坏情况退化成今天的整张上传，只是没更快，不会更错。
 *
 * 约定：同一张纹理只会被一个渲染器拥有（S3MViewer 与纹理一一对应）。
 * 多渲染器共享同一批纹理不在支持范围内；检测到已被别的上下文初始化时会放弃分带、
 * 交回 three 自己上传（见 `pumpBandedUploads` 里的 `__s3mBandedOwner`）。
 */
import * as THREE from 'three';

interface BandedRecord {
  tex: THREE.DataTexture;
  /** 下一次要上传的起始行 */
  row: number;
}

/** 待上传队列（按纹理对象去重） */
const pending = new Map<THREE.DataTexture, BandedRecord>();

/** 单帧默认预算：8 MB。超过这个量的等待下一帧，避免一帧里堆太多 texSubImage2D */
export const DEFAULT_BAND_BUDGET = 8 * 1024 * 1024;

/** 小于这个体积的纹理不值得分带（一次上传就够了，省掉 GL 状态折腾） */
export const MIN_BANDED_BYTES = 1024 * 1024;

/** 是否值得/可以分带：必须是 RGBA8 的 DataTexture，且足够大 */
export function shouldBandTexture(tex: THREE.Texture, byteLength: number): tex is THREE.DataTexture {
  if (!(tex as THREE.DataTexture).isDataTexture) return false;
  if (tex.type !== THREE.UnsignedByteType) return false;
  if ((tex.format ?? THREE.RGBAFormat) !== THREE.RGBAFormat) return false;
  return byteLength >= MIN_BANDED_BYTES;
}

/** 排进分带队列。真正的显存分配推迟到第一次 pump（那时才拿得到 renderer） */
export function queueBandedUpload(tex: THREE.DataTexture): void {
  const img = tex.image as { data?: ArrayBufferView; width?: number; height?: number } | undefined;
  if (!img?.data || !img.width || !img.height) return;
  if (pending.has(tex)) return;
  pending.set(tex, { tex, row: 0 });
  // 纹理被销毁（瓦片淘汰）时别把记录留在队列里 —— 否则这张 DataTexture 永远无法回收
  tex.addEventListener('dispose', () => pending.delete(tex));
}

export function hasPendingBandedUploads(): boolean {
  return pending.size > 0;
}

/** 这张纹理是否还在分带队列里（诊断 / 测试用） */
export function isBandedUploadPending(tex: THREE.Texture): boolean {
  return pending.has(tex as THREE.DataTexture);
}

/** 诊断：队列里还有多少纹理、合计多少字节没传 */
export function bandedUploadStats(): { textures: number; remainingRows: number } {
  let remainingRows = 0;
  for (const rec of pending.values()) remainingRows += (rec.tex.image?.height ?? 0) - rec.row;
  return { textures: pending.size, remainingRows };
}

/**
 * 把 unpack 状态设成这张纹理要的样子，**每次 texImage2D / texSubImage2D 之前都要调**。
 *
 * 这些是 GL 的全局状态，three 在它自己的上传路径里按每张纹理重设（`texture.flipY`、
 * `premultiplyAlpha`…）。我们绕过 three 直接 texSubImage2D 时如果只在分配时设一次，
 * 中间只要有任何别的纹理上传过（例如 WEBP 的 flipY = true），后面的行带就会被**竖着翻**，
 * 表现为图案错乱 / 同一块花纹重复。实测就是这么一副样子。
 */
function prepareUnpack(gl: WebGLRenderingContext | WebGL2RenderingContext, tex: THREE.Texture): void {
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, tex.premultiplyAlpha);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, tex.unpackAlignment);
  gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
  // WebGL2 专属的 unpack 参数：three 有可能为了别的上传把它们设成非 0（UNPACK_ROW_LENGTH
  // 尤其致命——它会让每行按更宽的步长读，图案整体错位）。
  const gl2 = gl as WebGL2RenderingContext;
  if (typeof gl2.UNPACK_ROW_LENGTH === 'number') {
    gl.pixelStorei(gl2.UNPACK_ROW_LENGTH, 0);
    gl.pixelStorei(gl2.UNPACK_IMAGE_HEIGHT, 0);
    gl.pixelStorei(gl2.UNPACK_SKIP_PIXELS, 0);
    gl.pixelStorei(gl2.UNPACK_SKIP_ROWS, 0);
  }
}

interface TextureProps {
  __webglInit?: boolean;
  __webglTexture?: WebGLTexture;
  __version?: number;
}

/** 给纹理分配空存储 + 设采样参数，并让 three 认为「已上传过」 */
function allocate(
  renderer: THREE.WebGLRenderer,
  tex: THREE.DataTexture,
  props: TextureProps
): WebGLTexture | null {
  const gl = renderer.getContext();
  const img = tex.image as { width: number; height: number };
  const state = renderer.state;
  const unit = Math.max(0, renderer.capabilities.maxTextures - 1);

  const glTex = props.__webglTexture ?? gl.createTexture();
  if (!glTex) return null;
  props.__webglTexture = glTex;

  state.activeTexture(gl.TEXTURE0 + unit);
  state.bindTexture(gl.TEXTURE_2D, glTex);

  prepareUnpack(gl, tex);

  const srgb = tex.colorSpace === THREE.SRGBColorSpace;
  const gl2 = gl as WebGL2RenderingContext;
  const internal = srgb ? (gl2.SRGB8_ALPHA8 ?? gl.RGBA) : (gl2.RGBA8 ?? gl.RGBA);
  gl.texImage2D(gl.TEXTURE_2D, 0, internal, img.width, img.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);

  // 与 configure()/configureAtlas() 写入的采样状态保持一致（three 只在它自己的
  // upload 路径里设参数，我们绕过它就必须自己设全）
  const wrapS = tex.wrapS === THREE.ClampToEdgeWrapping ? gl.CLAMP_TO_EDGE : gl.REPEAT;
  const wrapT = tex.wrapT === THREE.ClampToEdgeWrapping ? gl.CLAMP_TO_EDGE : gl.REPEAT;
  const min =
    tex.minFilter === THREE.LinearFilter
      ? gl.LINEAR
      : tex.minFilter === THREE.NearestFilter
        ? gl.NEAREST
        : tex.minFilter === THREE.NearestMipmapNearestFilter
          ? gl.NEAREST_MIPMAP_NEAREST
          : gl.LINEAR;
  const mag = tex.magFilter === THREE.NearestFilter ? gl.NEAREST : gl.LINEAR;
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrapS);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wrapT);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, min);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, mag);

  // 让 three 的 uploadTexture 直接返回：纹理版本与 source 版本都对上
  props.__webglInit = true;
  props.__version = tex.version;
  const sourceProps = renderer.properties.get(tex.source) as { __version?: number };
  sourceProps.__version = tex.source.version;

  // three 的 deleteTexture 只认它自己注册的 dispose 监听；这里补一个
  tex.addEventListener('dispose', () => {
    if (props.__webglTexture === glTex) {
      gl.deleteTexture(glTex);
      props.__webglTexture = undefined;
      props.__webglInit = false;
    }
  });
  (tex as unknown as { __s3mBandedOwner?: THREE.WebGLRenderer }).__s3mBandedOwner = renderer;

  return glTex;
}

/** 把一条记录上传若干行，返回本次上传的字节数（0 = 已完成或本次没排上） */
function uploadRows(
  renderer: THREE.WebGLRenderer,
  rec: BandedRecord,
  glTex: WebGLTexture,
  maxBytes: number
): number {
  const gl = renderer.getContext();
  const img = rec.tex.image as { data: Uint8Array; width: number; height: number };
  const rowBytes = img.width * 4;
  const rowsLeft = img.height - rec.row;
  const rows = Math.min(rowsLeft, Math.floor(maxBytes / rowBytes));
  if (rows <= 0) return 0;

  const unit = Math.max(0, renderer.capabilities.maxTextures - 1);
  renderer.state.activeTexture(gl.TEXTURE0 + unit);
  renderer.state.bindTexture(gl.TEXTURE_2D, glTex);

  const start = rec.row * rowBytes;
  const slice = new Uint8Array(img.data.buffer, img.data.byteOffset + start, rows * rowBytes);
  // 每次都重设：unpack 是全局状态，上一张纹理的上传会把它改掉（见 prepareUnpack）
  prepareUnpack(gl, rec.tex);
  gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, rec.row, img.width, rows, gl.RGBA, gl.UNSIGNED_BYTE, slice);

  rec.row += rows;
  return rows * rowBytes;
}

/**
 * 每帧调用：在预算内把待上传的图集像素搬进显存。
 * 返回本帧上传的字节数（诊断 / 预算自适应可用）。
 */
/**
 * 这个 renderer 是否真的能把纹理传进 GL。
 *
 * 单测 / 无头宿主里的 renderer 替身通常只有 `render` 等少数方法：遇到这种就直接跳过，
 * **不动队列**（纹理保持未初始化，three 首次渲染时会自己整张上传，行为与改动前一致）。
 */
function canUpload(renderer: THREE.WebGLRenderer | null | undefined): renderer is THREE.WebGLRenderer {
  if (!renderer) return false;
  const r = renderer as unknown as {
    getContext?: unknown;
    properties?: { get?: unknown };
    state?: { bindTexture?: unknown; activeTexture?: unknown };
    capabilities?: { maxTextures?: number };
  };
  return (
    typeof r.getContext === 'function' &&
    typeof r.properties?.get === 'function' &&
    typeof r.state?.bindTexture === 'function' &&
    typeof r.state?.activeTexture === 'function' &&
    typeof r.capabilities?.maxTextures === 'number'
  );
}

export function pumpBandedUploads(
  renderer: THREE.WebGLRenderer,
  budgetBytes: number = DEFAULT_BAND_BUDGET
): number {
  if (!pending.size || !canUpload(renderer)) return 0;
  const gl = renderer.getContext();
  let used = 0;

  for (const rec of [...pending.values()]) {
    const img = rec.tex.image as { data?: Uint8Array; width?: number; height?: number } | undefined;
    if (!img?.data || !img.width || !img.height) {
      pending.delete(rec.tex);
      continue;
    }
    const props = renderer.properties.get(rec.tex) as TextureProps;
    // 已被别的渲染上下文初始化过 → 放弃分带，交回 three（整张上传），行为与改动前一致
    const owner = (rec.tex as unknown as { __s3mBandedOwner?: THREE.WebGLRenderer }).__s3mBandedOwner;
    if (owner && owner !== renderer) {
      pending.delete(rec.tex);
      (rec.tex as unknown as { __s3mBandedOwner?: THREE.WebGLRenderer }).__s3mBandedOwner = undefined;
      rec.tex.needsUpdate = true;
      continue;
    }

    let glTex: WebGLTexture | null;
    try {
      glTex = props.__webglTexture ?? allocate(renderer, rec.tex, props);
    } catch {
      glTex = null;
    }
    if (!glTex) {
      pending.delete(rec.tex);
      rec.tex.needsUpdate = true;
      continue;
    }

    const bytes = uploadRows(renderer, rec, glTex, budgetBytes - used);
    used += bytes;
    if (rec.row >= img.height) pending.delete(rec.tex);
    if (used >= budgetBytes) break;
  }

  renderer.state.bindTexture(gl.TEXTURE_2D, null);
  return used;
}

/**
 * 同步补完所有待上传内容。
 *
 * 瓦片即将进场景时调用：保证它引用的纹理是完整的。最坏情况就是退化成整张上传，
 * 不会比改动前更慢；正常情况下这里没有待办，因为空闲帧已经搬完了。
 */
export function flushBandedUploads(renderer: THREE.WebGLRenderer): number {
  if (!pending.size || !canUpload(renderer)) return 0;
  const gl = renderer.getContext();
  let used = 0;
  for (const rec of [...pending.values()]) {
    const img = rec.tex.image as { data?: Uint8Array; width?: number; height?: number } | undefined;
    if (!img?.data || !img.width || !img.height) {
      pending.delete(rec.tex);
      continue;
    }
    const props = renderer.properties.get(rec.tex) as TextureProps;
    let glTex: WebGLTexture | null;
    try {
      glTex = props.__webglTexture ?? allocate(renderer, rec.tex, props);
    } catch {
      glTex = null;
    }
    if (!glTex) {
      pending.delete(rec.tex);
      rec.tex.needsUpdate = true;
      continue;
    }
    for (;;) {
      const bytes = uploadRows(renderer, rec, glTex, Number.POSITIVE_INFINITY);
      if (!bytes) break;
      used += bytes;
    }
    pending.delete(rec.tex);
  }
  renderer.state.bindTexture(gl.TEXTURE_2D, null);
  return used;
}
