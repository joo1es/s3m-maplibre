/**
 * 数据集配置的解析与判别：`.scp` 文本 → config 对象、数据集类别、经纬度范围、锚点。
 *
 * 全部是纯函数（`resolveAnchor` 只在 position 与 geoBounds 冲突时 `console.warn` 一次），
 * 从 `S3MTileset.ts` 原样搬出来（issue #27 的 P1 阶段），行为逐字未变。
 */
import type { Anchor } from '../core/types.js';
import type { AnchorOverride, DatasetKind, GeoBounds, SpatialReference } from './types.js';

export type { AnchorOverride, SpatialReference } from './types.js';

/** 每度对应的米数（等距圆柱近似），与 demo 里量测瓦片尺寸用的是同一套系数 */
const METERS_PER_DEG_LAT = 110540;
const METERS_PER_DEG_LON_EQUATOR = 111320;

/**
 * 判断 config.geoBounds 是不是一张「真的能用」的经纬度范围。
 *
 * 挡掉三种情况：字段缺失 / 非有限值；超出经纬度量级（OSGB 那类只给米制局部坐标的，
 * 反算不出来就是这种）；以及退化成一条线或一个点的全 0 框。
 * 退化框尤其危险：拿它去 fitBounds 会把视角甩到几内亚湾 (0,0)，
 * 拿它去校验 position 又会把唯一正确的 position 判成异常。
 */
export function usableGeoBounds(b: unknown): GeoBounds | null {
  if (!b || typeof b !== 'object') return null;
  const g = b as Partial<GeoBounds>;
  const v = [g.left, g.bottom, g.right, g.top];
  if (!v.every((n) => typeof n === 'number' && Number.isFinite(n))) return null;
  const { left, bottom, right, top } = g as GeoBounds;
  if (Math.abs(left) > 180 || Math.abs(right) > 180 || Math.abs(top) > 90 || Math.abs(bottom) > 90) return null;
  if (right === left && top === bottom) return null;
  return { left, bottom, right, top };
}

/** 兼容解析 JSON 与 XML 格式的 SuperMap .scp / config 配置文件（导出以便单测与自建数据集列表复用） */
export function parseConfigText(text: string): Record<string, unknown> {
  const trimmed = text.trim();
  if (trimmed.startsWith('<')) {
    const tagVal = (tag: string): string | null => {
      const m = new RegExp(`<(?:[a-zA-Z0-9_-]+:)?${tag}[^>]*>([^<]+)<\\/`, 'i').exec(trimmed);
      return m ? m[1].trim() : null;
    };
    const num = (tag: string): number => parseFloat(tagVal(tag) ?? '');
    const posX = num('X') || 0;
    const posY = num('Y') || 0;
    const posZ = num('Z') || 0;

    let left = num('Left');
    let right = num('Right');
    let top = num('Top');
    let bottom = num('Bottom');

    // SuperMapCache（OSGB 转出来的那类 XML）压根不给经纬度范围，只给
    // 「以 Position 为原点、局部 ENU 米制」的 BoundingBox。不反算的话 geoBounds 就是
    // 全 0：getBounds() 会把视角甩到几内亚湾，resolveAnchor 还会反过来把正确的
    // position 判成「与 geoBounds 不一致」而退回 (0,0)，位置错得彻彻底底。
    if (![left, right, top, bottom].every(Number.isFinite)) {
      const minX = num('MinX');
      const maxX = num('MaxX');
      const minY = num('MinY');
      const maxY = num('MaxY');
      if ([minX, maxX, minY, maxY].every(Number.isFinite) && posX && posY) {
        const kx = METERS_PER_DEG_LON_EQUATOR * Math.cos((posY * Math.PI) / 180);
        if (kx > 1e-6) {
          left = posX + minX / kx;
          right = posX + maxX / kx;
          bottom = posY + minY / METERS_PER_DEG_LAT;
          top = posY + maxY / METERS_PER_DEG_LAT;
        }
      }
    }

    const fileMatches = trimmed.matchAll(/<(?:[a-zA-Z0-9_-]+:)?FileName[^>]*>([^<]+)<\//gi);
    const tiles: Array<{ url: string }> = [];
    for (const m of fileMatches) {
      tiles.push({ url: m[1].trim() });
    }

    // SuperMapCache 用 MinHeight/MaxHeight 声明成果的高程范围（米）。
    // 不读出来的话 align: 'bottom' 无从计算 —— 这类 OSGB 数据的 z 是从 120m 起飞的，
    // 不贴地就会整片悬在地图上方，斜视下看起来像散在别处的碎片。
    const minH = num('MinHeight');
    const maxH = num('MaxHeight');

    return {
      fileType: tagVal('FileType') ?? undefined,
      // 地形/影像缓存的判别字段（见 classifyDatasetKind）：FileExtentName=Terrainz 是地形，
      // <sml:Type>Image</sml:Type> 是影像（影像的 FileExtentName 是 jpg_png 这种扩展名样式，不可靠）
      fileExtentName: tagVal('FileExtentName') ?? undefined,
      cacheType: tagVal('Type') ?? undefined,
      position: { x: posX, y: posY, z: posZ, units: 'Degree' },
      geoBounds: { left, right, top, bottom },
      heightRange: Number.isFinite(minH) || Number.isFinite(maxH) ? { min: minH, max: maxH } : undefined,
      rootTiles: tiles,
      tiles,
    };
  }
  return JSON.parse(trimmed) as Record<string, unknown>;
}

/**
 * 按 config 的类型标记识别数据集类别。
 *
 * 同一个 `…/datas/<名>/config` URL 底下可能是模型、地形、影像三种完全不同的缓存
 * （FORMAT-NOTES 第二章）。地形/影像是按 Level0 金字塔寻址的栅格缓存，**没有瓦片清单**，
 * 当模型加载只会一路走到「配置中缺少 root tile」，把「类型不支持」伪装成「配置缺字段」
 * （issue #7：混合服务第一个数据集 beijingdem 是 Terrainz 地形缓存）。
 *
 * 判别字段取自实测（supermapol 3D-OlympicGreen_Plan，2026-10-30）：
 *   地形 XML： FileExtentName = Terrainz
 *   影像 XML： FileExtentName = jpg_png（扩展名样式，不可靠）+ Type = Image
 *   模型 XML： FileType = OSGBFile / OSGBCacheFile，无 FileExtentName / Type
 *
 * 保守原则：只有认出确凿的非模型标记才判 terrain / imagery，其余（含 JSON 配置、
 * 无标记的 XML）一律 'model' —— 保证「认不出」时行为与旧版一致（不变式 ①）。
 */
export function classifyDatasetKind(config: Record<string, unknown> | null | undefined): DatasetKind {
  if (!config || typeof config !== 'object') return 'model';
  if (String(config.fileExtentName ?? '').trim().toLowerCase() === 'terrainz') return 'terrain';
  if (String(config.cacheType ?? '').trim().toLowerCase() === 'image') return 'imagery';
  return 'model';
}

/** 拼一句能区分 config 形态的上下文（FileExtentName / Type / fileType / dataType），供报错使用 */
export function configTypeHint(config: Record<string, unknown>): string {
  const parts: string[] = [];
  if (config.fileExtentName) parts.push(`FileExtentName=${config.fileExtentName}`);
  if (config.cacheType) parts.push(`Type=${config.cacheType}`);
  if (config.fileType) parts.push(`fileType=${config.fileType}`);
  if (config.dataType) parts.push(`dataType=${config.dataType}`);
  return parts.length ? parts.join(', ') : '无类型标记';
}

/** 从 configUrl 里抠出数据集名（…/datas/<名>/config）；抠不出就原样返回，报错时能对上服务里的数据集 */
export function datasetNameOf(configUrl: string): string {
  const m = /\/datas\/([^/?#]+)/i.exec(configUrl);
  if (!m) return configUrl;
  try {
    return decodeURIComponent(m[1]!);
  } catch {
    return m[1]!;
  }
}

/**
 * 定位锚点。规范里 position 是局部 ENU 坐标系原点，
 * 但实际数据里 position 偶尔是生产时的占位值（与 geoBounds 不符），
 * 所以这里做一次一致性检查，不一致就退回 geoBounds 中心。
 *
 * 前提是 geoBounds 真的可用：OSGB/SuperMapCache 这类配置只给米制局部包围盒，
 * 全 0 的退化框不能反过来否定一个正常的 position —— 那等于把模型甩到 (0,0)。
 */
export function resolveAnchor(config: Record<string, unknown>): Anchor {
  const raw = config.position as
    | {
        point3D?: { x: number; y: number; z?: number };
        x?: number;
        y?: number;
        z?: number;
        units?: string;
        unit?: string;
      }
    | undefined;
  const p = raw?.point3D ?? (raw as { x: number; y: number; z?: number } | undefined);
  const okP = !!p && Number.isFinite(p.x) && Number.isFinite(p.y);
  const b = usableGeoBounds(config.geoBounds);
  const centerLon = b ? (b.left + b.right) / 2 : undefined;
  const centerLat = b ? (b.bottom + b.top) / 2 : undefined;
  // ENU 原点在椭球面上，position.z 就是它的高度；用 heightRange.min 会引入垂直偏移
  const z = p?.z ?? 0;

  if (!okP) return { lon: centerLon ?? 0, lat: centerLat ?? 0, height: 0 };

  // 两种写法都得认：老数据是 position.units，v3.01 起改成了 position.unit
  const units = raw?.units ?? raw?.unit ?? 'Degree';
  if (units !== 'Degree') return { lon: p!.x!, lat: p!.y!, height: z };

  const offLon = centerLon === undefined ? 0 : Math.abs(p!.x! - centerLon);
  const offLat = centerLat === undefined ? 0 : Math.abs(p!.y! - centerLat);
  if (offLon > 0.5 || offLat > 0.5) {
    console.warn('[s3m] position 与 geoBounds 不一致，改用 geoBounds 中心作为锚点', {
      position: p,
      geoBounds: b,
    });
    return { lon: centerLon!, lat: centerLat!, height: z };
  }
  return { lon: p!.x!, lat: p!.y!, height: z };
}

/**
 * 读 .scp 的空间参考字段。
 *
 * 只做记录与判别：库不引 proj4、不做 EPSG 反算——按超图官方 JS SDK 的口径，
 * 投影由生产端负责，运行时最多按 `position.unit` 决定「要不要再投一次」
 * （S3M_JS/S3M_module/S3MTiles/S3MTilesLayer.js:410-425）。这里把信息暴露出来，
 * 让上层能识别「这份数据不是经纬度」，而不是等模型被摆到大西洋才纳闷。
 */
export function readSpatialReference(config: Record<string, unknown>): SpatialReference {
  const rawCrs = config.crs;
  const crs =
    typeof rawCrs === 'string' && rawCrs.trim()
      ? rawCrs.trim()
      : typeof rawCrs === 'number' && Number.isFinite(rawCrs)
        ? `epsg:${rawCrs}`
        : null;

  let epsg: number | null = null;
  if (crs) {
    const m = /^epsg\s*:\s*(\d+)/i.exec(crs);
    if (m) epsg = Number(m[1]);
  }

  const pos = config.position as { units?: unknown; unit?: unknown } | null | undefined;
  const rawUnit = pos?.units ?? pos?.unit;
  const unit = typeof rawUnit === 'string' && rawUnit.trim() ? rawUnit.trim() : null;

  const ext = config.extensions as { crs?: unknown } | null | undefined;
  const wkt = ext && typeof ext === 'object' && typeof ext.crs === 'string' ? ext.crs : null;

  // 只有明确的米制单位才算非地理数据；缺字段按旧行为（经纬度）兜底
  const isGeographic = unit === null || !/^(meter|metre|m)s?$/i.test(unit);
  return { crs, epsg, unit, wkt, isGeographic };
}

function normalizeOverride(o: AnchorOverride): Required<AnchorOverride> {
  const lon = o?.lon;
  const lat = o?.lat;
  const height = o?.height;
  if (typeof lon !== 'number' || !Number.isFinite(lon) || Math.abs(lon) > 180) {
    throw new RangeError('[s3m] anchorOverride.lon 必须是 [-180, 180] 内的有限数（度）');
  }
  if (typeof lat !== 'number' || !Number.isFinite(lat) || Math.abs(lat) > 90) {
    throw new RangeError('[s3m] anchorOverride.lat 必须是 [-90, 90] 内的有限数（度）');
  }
  if (height !== undefined && (typeof height !== 'number' || !Number.isFinite(height))) {
    throw new RangeError('[s3m] anchorOverride.height 必须是有限数（米）');
  }
  return { lon, lat, height: height ?? 0 };
}

/**
 * 把「没有地理参考」的数据整体挂到指定经纬度上：改写 position，并把 geoBounds
 * 一起搬过去，否则 `getBounds()` / `fitBounds()` 仍会拿原始米值当经纬度、把镜头
 * 甩到几内亚湾。
 *
 * 顶点不动：它们本来就是相对 position 原点的局部 ENU 米，换原点后照常使用。
 * 不修改入参，返回新 config —— App 还能拿原始 config 做诊断。
 */
export function applyAnchorOverride(
  config: Record<string, unknown>,
  override: AnchorOverride
): Record<string, unknown> {
  const { lon, lat, height } = normalizeOverride(override);
  const ref = readSpatialReference(config);
  const src = resolveAnchor(config);
  const b = usableGeoBounds(config.geoBounds);

  let geoBounds: unknown = config.geoBounds;
  if (b) {
    // 平面数据的框是米：相对原点的偏移按等距圆柱近似换算成度，与 OSGB XML
    // 的 BoundingBox 反算用同一套系数。地理数据的框本来就是度：只平移不缩放，
    // 否则跨度会被当成米压扁。
    const kx = METERS_PER_DEG_LON_EQUATOR * Math.max(Math.cos((lat * Math.PI) / 180), 1e-6);
    const ky = METERS_PER_DEG_LAT;
    const toDeg = (v: number, horizontal: boolean) =>
      ref.isGeographic ? v : v / (horizontal ? kx : ky);
    const cx = (b.left + b.right) / 2 - src.lon;
    const cy = (b.bottom + b.top) / 2 - src.lat;
    const hw = (b.right - b.left) / 2;
    const hh = (b.top - b.bottom) / 2;
    geoBounds = {
      left: lon + toDeg(cx - hw, true),
      right: lon + toDeg(cx + hw, true),
      bottom: lat + toDeg(cy - hh, false),
      top: lat + toDeg(cy + hh, false),
    };
  }

  return {
    ...config,
    position: { point3D: { x: lon, y: lat, z: height }, unit: 'Degree' },
    geoBounds,
  };
}
