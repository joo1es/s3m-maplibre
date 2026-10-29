/**
 * 单体自定义样式、专题图着色、业务过滤与状态纹理管理器
 *
 * 负责：
 * 1. 单体（SMID）自定义颜色、独立拔高、平移与显隐控制
 * 2. 专题图分析（按业务字段分段着色、连续插值着色、字段过滤、高度拉伸）
 * 3. 2 行状态纹理（uBatchTex）的烘焙与 GPU 上传：
 *    - Row 0: [R, G, B, elevation / hidden]
 *    - Row 1: [translationX, translationY, translationZ, opacity]
 *      约定：alpha 0 = 无单体透明覆盖（shader 不乘），(0,1) 开区间为实际透明度，
 *      opacity <= 0 等价 hidden（走 Row 0 的 -1 隐藏位）
 * 4. 批次冲突审计（auditBatches）
 */
import * as THREE from 'three';
import {
  resolveFeature,
  measureSegments,
  buildAttributes,
  pickEntryId,
} from '../core/FeatureInfo.js';
import type { AttributeQuery, AttributeRow } from '../core/AttributeQuery.js';
import type { StyledMaterial } from './StyleMaterial.js';
import { restoreBaseBlendState } from './StyleMaterial.js';

export interface GPUPathOptions {
  /** 绑定的路径索引 ID（0, 1, 2...） */
  pathId: number;
  /** 进度的运动速率（归一化进度/秒，例如 0.05 即 20 秒一圈；为 0 则靠 progress/phase 驱动） */
  speed?: number;
  /** 初始相位 / 进度偏移（0.0 ~ 1.0） */
  phase?: number;
  /** 循环模式：'loop'（循环，默认） | 'pingpong'（往返） | 'clamp'（单次到达终点停止） */
  loop?: 'loop' | 'pingpong' | 'clamp' | boolean;
  /** 是否根据路径切线自动旋转朝向（偏航角 yaw，默认 true） */
  autoHeading?: boolean;
}

export interface FeatureStyle {
  /** 自定义单体颜色 */
  color?: string;
  /** 自定义单体独立拔高高度（米，垂直方向） */
  elevation?: number;
  /** 自定义单体三维平移偏移量 [dx, dy, dz]（米） */
  translation?: [number, number, number];
  /** 自定义单体透明度（0~1，batch 粒度；<= 0 等价 hidden，1 / 不传 = 不覆盖） */
  opacity?: number;
  /** 是否隐藏该单体 */
  hidden?: boolean;
  /**
   * 单体姿态旋转。
   * 支持：
   * 1. 纯数字：绕 Z 轴（朝天方向）旋转弧度（最常用的建筑朝向）
   * 2. 数组 [rx, ry, rz]：欧拉角（弧度）
   * 3. 数组 [x, y, z, w]：四元数
   * 4. THREE.Euler | THREE.Quaternion | THREE.Matrix3 | THREE.Matrix4
   */
  rotation?:
    | number
    | [number, number, number]
    | [number, number, number, number]
    | THREE.Euler
    | THREE.Quaternion
    | THREE.Matrix3
    | THREE.Matrix4;
  /** 旋转中心轴心点 [px, py, pz]（局部坐标，默认 [0, 0, 0]） */
  pivot?: [number, number, number];
  /** GPU 路径动画配置 */
  gpuPath?: GPUPathOptions;
}

export type RotationMatrix9 = [
  number, number, number, // Row 0: R00, R01, R02
  number, number, number, // Row 1: R10, R11, R12
  number, number, number  // Row 2: R20, R21, R22
];

/**
 * 将各类旋转表示统一解析为 3x3 行优先矩阵数组
 */
export function resolveRotationMatrix(
  rot?:
    | number
    | [number, number, number]
    | [number, number, number, number]
    | THREE.Euler
    | THREE.Quaternion
    | THREE.Matrix3
    | THREE.Matrix4
    | null
): RotationMatrix9 | null {
  if (rot == null) return null;
  if (typeof rot === 'number') {
    const c = Math.cos(rot);
    const s = Math.sin(rot);
    return [
      c, -s, 0,
      s,  c, 0,
      0,  0, 1,
    ];
  }
  if (Array.isArray(rot)) {
    if (rot.length === 3) {
      const euler = new THREE.Euler(rot[0], rot[1], rot[2]);
      const m = new THREE.Matrix4().makeRotationFromEuler(euler);
      const e = m.elements;
      return [
        e[0], e[4], e[8],
        e[1], e[5], e[9],
        e[2], e[6], e[10],
      ];
    }
    if (rot.length === 4) {
      const q = new THREE.Quaternion(rot[0], rot[1], rot[2], rot[3]);
      const m = new THREE.Matrix4().makeRotationFromQuaternion(q);
      const e = m.elements;
      return [
        e[0], e[4], e[8],
        e[1], e[5], e[9],
        e[2], e[6], e[10],
      ];
    }
  }
  if (rot instanceof THREE.Euler) {
    const m = new THREE.Matrix4().makeRotationFromEuler(rot);
    const e = m.elements;
    return [
      e[0], e[4], e[8],
      e[1], e[5], e[9],
      e[2], e[6], e[10],
    ];
  }
  if (rot instanceof THREE.Quaternion) {
    const m = new THREE.Matrix4().makeRotationFromQuaternion(rot);
    const e = m.elements;
    return [
      e[0], e[4], e[8],
      e[1], e[5], e[9],
      e[2], e[6], e[10],
    ];
  }
  if (rot instanceof THREE.Matrix3) {
    const e = rot.elements;
    return [
      e[0], e[3], e[6],
      e[1], e[4], e[7],
      e[2], e[5], e[8],
    ];
  }
  if (rot instanceof THREE.Matrix4) {
    const e = rot.elements;
    return [
      e[0], e[4], e[8],
      e[1], e[5], e[9],
      e[2], e[6], e[10],
    ];
  }
  return null;
}

/**
 * 提取欧拉角 [rx, ry, rz]（弧度）用于动画插值
 */
export function extractEulerAngles(
  rot?:
    | number
    | [number, number, number]
    | [number, number, number, number]
    | THREE.Euler
    | THREE.Quaternion
    | THREE.Matrix3
    | THREE.Matrix4
    | null
): [number, number, number] {
  if (rot == null) return [0, 0, 0];
  if (typeof rot === 'number') return [0, 0, rot];
  if (Array.isArray(rot)) {
    if (rot.length === 3) return [rot[0], rot[1], rot[2]];
    if (rot.length === 4) {
      const q = new THREE.Quaternion(rot[0], rot[1], rot[2], rot[3]);
      const e = new THREE.Euler().setFromQuaternion(q);
      return [e.x, e.y, e.z];
    }
  }
  if (rot instanceof THREE.Euler) return [rot.x, rot.y, rot.z];
  if (rot instanceof THREE.Quaternion) {
    const e = new THREE.Euler().setFromQuaternion(rot);
    return [e.x, e.y, e.z];
  }
  if (rot instanceof THREE.Matrix3) {
    const m = new THREE.Matrix4().set(
      rot.elements[0], rot.elements[3], rot.elements[6], 0,
      rot.elements[1], rot.elements[4], rot.elements[7], 0,
      rot.elements[2], rot.elements[5], rot.elements[8], 0,
      0, 0, 0, 1
    );
    const e = new THREE.Euler().setFromRotationMatrix(m);
    return [e.x, e.y, e.z];
  }
  if (rot instanceof THREE.Matrix4) {
    const e = new THREE.Euler().setFromRotationMatrix(rot);
    return [e.x, e.y, e.z];
  }
  return [0, 0, 0];
}

export interface ColorByFieldOptions {
  field: string;
  colors?: string[] | { [key: string]: string };
  defaultColor?: string;
  nullColor?: string;
  ramp?: string[];
  stops?: number;
  smids?: number[];
}

export interface ThematicLegendEntry {
  color: string;
  label: string;
  count: number;
  min?: number;
  max?: number;
}

export interface ThematicResult {
  field: string;
  type: 'discrete' | 'continuous';
  matched: number;
  missing: number;
  legend: ThematicLegendEntry[];
}

export interface BatchConflict {
  datasetId: string;
  batchId: number;
  smids: number[];
}

export interface BatchAudit {
  smids: number;
  batches: number;
  conflicts: BatchConflict[];
  conflictingSmids: number;
}

export interface FieldFilterOptions {
  field: string;
  mode?: 'keep' | 'hide' | 'drop';
  values?: Array<string | number>;
  min?: number;
  max?: number;
  keep?: (value: string | number | null, row: AttributeRow) => boolean;
  onMissing?: 'keep' | 'hide' | 'drop';
  smids?: number[];
}

export interface FieldFilterResult {
  field: string;
  mode: 'keep' | 'hide' | 'drop';
  matched: number;
  hidden: number[];
}

export interface FieldElevationOptions {
  field: string;
  scale?: number;
  offset?: number;
  max?: number;
  map?: (value: number, range: { min: number; max: number }) => number;
  smids?: number[];
}

export interface FieldElevationResult {
  field: string;
  matched: number;
  missing: number;
  min: number;
  max: number;
  appliedMax: number;
}

export interface S3MFilter {
  include?: number[];
  exclude?: number[];
  predicate?: (attrs: { smid: number; [key: string]: unknown }) => boolean;
  minHeight?: number;
  maxHeight?: number;
}

function styledMaterialOf(mesh: THREE.Mesh): StyledMaterial | null {
  const m = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
  const styled = m as StyledMaterial | undefined;
  return styled?.userData?.isStyled ? styled : null;
}

function sampleRamp(stops: THREE.Color[], t: number): THREE.Color {
  if (stops.length < 2) return stops[0].clone();
  const clamped = Math.min(1, Math.max(0, t));
  const scaled = clamped * (stops.length - 1);
  const i = Math.min(stops.length - 2, Math.floor(scaled));
  return stops[i].clone().lerp(stops[i + 1], scaled - i);
}

function matchFieldValue(
  value: string | number | null,
  row: AttributeRow,
  options: FieldFilterOptions
): boolean {
  if (options.keep && !options.keep(value, row)) return false;
  if (options.values?.length) {
    const text = value == null ? '' : String(value);
    if (!options.values.some((v) => String(v) === text)) return false;
  }
  if (options.min != null || options.max != null) {
    const num = Number(value);
    if (!Number.isFinite(num)) return false;
    if (options.min != null && num < options.min) return false;
    if (options.max != null && num > options.max) return false;
  }
  if (!options.keep && !options.values?.length && options.min == null && options.max == null) {
    return value != null && String(value) !== '';
  }
  return true;
}

function formatNumber(v: number): string {
  if (!Number.isFinite(v)) return '—';
  const abs = Math.abs(v);
  if (abs >= 100) return v.toFixed(0);
  if (abs >= 10) return v.toFixed(1);
  return v.toFixed(2);
}

export class FeatureStyleManager {
  readonly featureStyles = new Map<number, FeatureStyle>();
  thematicColors = new Map<number, string>();
  thematicElevation = new Map<number, number>();
  thematicField: string | null = null;
  elevationField: string | null = null;

  filter: S3MFilter | null = null;
  fieldFilter: { field: string; mode: 'keep' | 'drop'; matched: Set<number> } | null = null;

  private readonly _meshBatchTextures = new WeakMap<
    THREE.Mesh,
    {
      texture: THREE.DataTexture;
      data: Float32Array;
      texture2?: THREE.DataTexture;
      data2?: Float32Array;
      width: number;
    }
  >();
  private readonly _markedMeshes = new Set<THREE.Mesh>();
  private _dirtyAll = false;
  private _flushScheduled = false;
  private _batchConflictWarned = false;

  constructor(
    private readonly _getLayerFloorHeight: () => number,
    private readonly _triggerRepaint: () => void,
    private readonly _onStyleChanged: () => void,
    private readonly _getAllMeshes?: () => Iterable<THREE.Mesh>,
    private readonly _applyOverrideHook?: (mesh: THREE.Mesh) => void,
    /**
     * 图层自身是否处于半透明状态。
     *
     * 以前这里读 `material.opacity` 来判断「要不要把 transparent 还原」——自从全局
     * 透明度改走共享 `uOpacity` 之后，`material.opacity` 不再等于图层透明度，
     * 再读它就会在图层半透明时把材质错判成不透明、把整层透明效果抹掉。
     */
    private readonly _isLayerTransparent: () => boolean = () => false
  ) {}

  setFeatureStyle(smid: number, style: FeatureStyle, meshes?: Iterable<THREE.Mesh>): void {
    this.featureStyles.set(smid, style);
    this.markOverridesDirty(meshes);
    this._onStyleChanged();
    this._triggerRepaint();
  }

  setFeaturesStyle(smids: number[], style: FeatureStyle, meshes?: Iterable<THREE.Mesh>): void {
    for (const smid of smids) {
      this.featureStyles.set(smid, style);
    }
    this.markOverridesDirty(meshes);
    this._onStyleChanged();
    this._triggerRepaint();
  }

  getFeatureStyle(smid: number): FeatureStyle | null {
    return this.featureStyles.get(smid) ?? null;
  }

  getFeatureEffectiveOffset(smid: number | null): {
    translation?: [number, number, number];
    elevation?: number;
    rotation?: FeatureStyle['rotation'];
    pivot?: [number, number, number];
  } {
    if (smid == null) return {};
    const st = this.featureStyles.get(smid);
    const elev = st?.elevation ?? this.thematicElevation.get(smid);
    return {
      translation: st?.translation,
      elevation: elev,
      rotation: st?.rotation,
      pivot: st?.pivot,
    };
  }

  getFeatureStyles(): Map<number, FeatureStyle> {
    return new Map(this.featureStyles);
  }

  removeFeatureStyle(smid: number, meshes?: Iterable<THREE.Mesh>): void {
    if (this.featureStyles.delete(smid)) {
      this.markOverridesDirty(meshes);
      this._onStyleChanged();
      this._triggerRepaint();
    }
  }

  clearFeatureStyles(): void {
    if (this.featureStyles.size > 0) {
      this.featureStyles.clear();
      this.markOverridesDirty();
      this._onStyleChanged();
      this._triggerRepaint();
    }
  }

  setThematicColors(colors: Map<number, string> | null, field = 'custom'): void {
    this.thematicColors = colors && colors.size > 0 ? new Map(colors) : new Map();
    this.thematicField = this.thematicColors.size > 0 ? field : null;
    this.markOverridesDirty();
    this._triggerRepaint();
  }

  clearThematicColors(): void {
    if (this.thematicColors.size === 0) return;
    this.thematicColors = new Map();
    this.thematicField = null;
    this.markOverridesDirty();
    this._triggerRepaint();
  }

  setThematicElevation(elevations: Map<number, number> | null, field = 'custom'): void {
    this.thematicElevation =
      elevations && elevations.size > 0
        ? new Map([...elevations].filter(([, h]) => Number.isFinite(h) && h > 0))
        : new Map();
    this.elevationField = this.thematicElevation.size > 0 ? field : null;
    this.markOverridesDirty();
    this._onStyleChanged();
    this._triggerRepaint();
  }

  clearThematicElevation(): void {
    if (this.thematicElevation.size === 0) return;
    this.thematicElevation = new Map();
    this.elevationField = null;
    this.markOverridesDirty();
    this._onStyleChanged();
    this._triggerRepaint();
  }

  setFilter(filter: S3MFilter | null, uniforms: any): void {
    this.filter = filter;
    if (filter && (filter.minHeight != null || filter.maxHeight != null)) {
      if (uniforms.uFilterMinZ) uniforms.uFilterMinZ.value = filter.minHeight ?? -99999;
      if (uniforms.uFilterMaxZ) uniforms.uFilterMaxZ.value = filter.maxHeight ?? 99999;
      if (uniforms.uFilterHeightActive) uniforms.uFilterHeightActive.value = 1;
    } else if (uniforms.uFilterHeightActive) {
      uniforms.uFilterHeightActive.value = 0;
    }
    this.markOverridesDirty();
    this._onStyleChanged();
    this._triggerRepaint();
  }

  clearFilter(uniforms: any): void {
    this.setFilter(null, uniforms);
  }

  async colorByField(
    options: ColorByFieldOptions,
    query: AttributeQuery | null,
    loadedSmids: number[]
  ): Promise<ThematicResult> {
    if (!query) {
      throw new Error('[s3m] 未配置业务属性数据源，先调用 setAttributeSource() 或构造时传 attributes');
    }
    const all = options.smids?.length ? [...new Set(options.smids)] : loadedSmids;
    if (!all.length) {
      this.clearThematicColors();
      return { field: options.field, type: 'discrete', matched: 0, missing: 0, legend: [] };
    }

    const rows: Map<number, AttributeRow> = await query.queryBySmids(all);
    const numericValues: Array<{ smid: number; val: number }> = [];
    const stringValues: Array<{ smid: number; val: string }> = [];

    for (const smid of all) {
      const r = rows.get(smid);
      const raw = r ? r[options.field] : undefined;
      if (raw == null || raw === '') continue;
      const num = Number(raw);
      if (Number.isFinite(num)) numericValues.push({ smid, val: num });
      else stringValues.push({ smid, val: String(raw) });
    }

    const isNumeric = numericValues.length >= stringValues.length && numericValues.length > 0;
    const colors = new Map<number, string>();
    const legend: ThematicLegendEntry[] = [];
    const defCol = options.defaultColor ?? '#64748b';
    const nullCol = options.nullColor ?? '#334155';

    if (isNumeric) {
      const vals = numericValues.map((v) => v.val);
      const min = Math.min(...vals);
      const max = Math.max(...vals);
      const span = max - min || 1;
      const stops = (options.ramp ?? ['#3b82f6', '#10b981', '#f59e0b', '#ef4444']).map(
        (c) => new THREE.Color(c)
      );
      const count = Math.max(2, options.stops ?? 5);

      for (let i = 0; i < count; i++) {
        const t0 = i / count;
        const t1 = (i + 1) / count;
        const col = sampleRamp(stops, (t0 + t1) / 2);
        const low = min + t0 * span;
        const high = min + t1 * span;
        legend.push({
          color: `#${col.getHexString()}`,
          label: `${formatNumber(low)} ~ ${formatNumber(high)}`,
          count: 0,
          min: low,
          max: high,
        });
      }

      for (const { smid, val } of numericValues) {
        const t = Math.min(1, Math.max(0, (val - min) / span));
        const idx = Math.min(count - 1, Math.floor(t * count));
        const c = legend[idx].color;
        colors.set(smid, c);
        legend[idx].count++;
      }
    } else {
      const distinct = new Map<string, number>();
      for (const { val } of stringValues) {
        distinct.set(val, (distinct.get(val) ?? 0) + 1);
      }
      const sorted = [...distinct.entries()].sort((a, b) => b[1] - a[1]);
      const palette = Array.isArray(options.colors)
        ? options.colors
        : ['#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899', '#06b6d4', '#84cc16'];
      const mapConfig = !Array.isArray(options.colors) && options.colors ? options.colors : null;

      for (let i = 0; i < sorted.length; i++) {
        const [val, cnt] = sorted[i];
        const c = mapConfig?.[val] ?? palette[i % palette.length];
        legend.push({ color: c, label: val, count: cnt });
      }
      const labelToColor = new Map(legend.map((e) => [e.label, e.color]));
      for (const { smid, val } of stringValues) {
        colors.set(smid, labelToColor.get(val) ?? defCol);
      }
    }

    let missing = 0;
    for (const smid of all) {
      if (!colors.has(smid)) {
        colors.set(smid, nullCol);
        missing++;
      }
    }
    if (missing > 0) {
      legend.push({ color: nullCol, label: '无数据 / 缺失', count: missing });
    }

    this.setThematicColors(colors, options.field);
    return {
      field: options.field,
      type: isNumeric ? 'continuous' : 'discrete',
      matched: all.length - missing,
      missing,
      legend,
    };
  }

  async filterByField(
    options: FieldFilterOptions,
    query: AttributeQuery | null,
    loadedSmids: number[]
  ): Promise<FieldFilterResult> {
    if (!query) {
      throw new Error('[s3m] 未配置业务属性数据源，先调用 setAttributeSource() 或构造时传 attributes');
    }
    const all = options.smids?.length ? [...new Set(options.smids)] : loadedSmids;
    const mode = options.mode ?? 'keep';
    const onMissing = options.onMissing ?? 'drop';
    const result: FieldFilterResult = { field: options.field, mode, matched: 0, hidden: [] };

    if (!all.length) {
      this.fieldFilter = null;
      this.markOverridesDirty();
      return result;
    }

    const rows: Map<number, AttributeRow> = await query.queryBySmids(all);
    const matched = new Set<number>();
    for (const smid of all) {
      const row = rows.get(smid);
      if (!row) {
        if (onMissing === 'keep') matched.add(smid);
        continue;
      }
      if (matchFieldValue(row[options.field] ?? null, row, options)) matched.add(smid);
    }
    result.matched = matched.size;
    const isKeep = mode === 'keep';
    this.fieldFilter = matched.size || isKeep ? { field: options.field, mode: isKeep ? 'keep' : 'drop', matched } : null;
    result.hidden = all.filter((smid) => (isKeep ? !matched.has(smid) : matched.has(smid)));

    this.markOverridesDirty();
    this._onStyleChanged();
    this._triggerRepaint();
    return result;
  }

  clearFieldFilter(): void {
    if (!this.fieldFilter) return;
    this.fieldFilter = null;
    this.markOverridesDirty();
    this._triggerRepaint();
  }

  async elevateByField(
    options: FieldElevationOptions,
    query: AttributeQuery | null,
    loadedSmids: number[]
  ): Promise<FieldElevationResult> {
    if (!query) {
      throw new Error('[s3m] 未配置业务属性数据源，先调用 setAttributeSource() 或构造时传 attributes');
    }
    const all = options.smids?.length ? [...new Set(options.smids)] : loadedSmids;
    const empty: FieldElevationResult = {
      field: options.field,
      matched: 0,
      missing: all.length,
      min: 0,
      max: 0,
      appliedMax: 0,
    };
    if (!all.length) {
      this.thematicElevation = new Map();
      this.elevationField = null;
      this.markOverridesDirty();
      return empty;
    }

    const rows: Map<number, AttributeRow> = await query.queryBySmids(all);
    const numeric = new Map<number, number>();
    for (const smid of all) {
      const value = Number(rows.get(smid)?.[options.field]);
      if (Number.isFinite(value)) numeric.set(smid, value);
    }
    if (numeric.size === 0) {
      this.thematicElevation = new Map();
      this.elevationField = null;
      this.markOverridesDirty();
      this._onStyleChanged();
      this._triggerRepaint();
      return empty;
    }

    const values = [...numeric.values()];
    const min = Math.min(...values);
    const max = Math.max(...values);
    const scale = options.scale ?? 1;
    const offset = options.offset ?? 0;
    const next = new Map<number, number>();
    let appliedMax = 0;
    for (const [smid, value] of numeric) {
      let height = options.map ? options.map(value, { min, max }) : value * scale + offset;
      if (!Number.isFinite(height)) continue;
      if (options.max != null && height > options.max) height = options.max;
      if (height <= 0) continue;
      next.set(smid, height);
      if (height > appliedMax) appliedMax = height;
    }

    this.thematicElevation = next;
    this.elevationField = options.field;
    this.markOverridesDirty();
    this._onStyleChanged();
    this._triggerRepaint();

    return {
      field: options.field,
      matched: next.size,
      missing: all.length - numeric.size,
      min,
      max,
      appliedMax,
    };
  }

  auditBatches(pickables: Iterable<{ datasetId: string; mesh: THREE.Mesh }>): BatchAudit {
    const conflicts: BatchConflict[] = [];
    const involved = new Set<number>();
    let batches = 0;

    for (const p of pickables) {
      const pickInfo = (p.mesh.userData as any).geoRef?.pickInfo;
      if (!pickInfo) continue;
      const byBatch = new Map<number, number[]>();
      for (const [key, entry] of Object.entries(pickInfo)) {
        const bId = pickEntryId(entry as any);
        if (bId < 0) continue;
        const smid = Number(key);
        const list = byBatch.get(bId);
        if (list) list.push(smid);
        else byBatch.set(bId, [smid]);
      }
      batches += byBatch.size;
      for (const [batchId, smids] of byBatch) {
        if (smids.length < 2) continue;
        for (const smid of smids) involved.add(smid);
        conflicts.push({ datasetId: p.datasetId, batchId, smids });
      }
    }

    return { smids: 0, batches, conflicts, conflictingSmids: involved.size };
  }

  private _bakeStylesIntoBuffer(
    data: Float32Array,
    width: number,
    pickInfo: Record<string, unknown>,
    mesh: THREE.Mesh,
    styleMap: Map<number, FeatureStyle>
  ): { hasActive: boolean; hasFade: boolean; conflicts: number } {
    const w = width;
    for (let i = 0; i < w; i++) {
      // Row 0: [R, G, B, elevation/hidden]
      data[i * 4 + 0] = -1;
      data[i * 4 + 1] = -1;
      data[i * 4 + 2] = -1;
      data[i * 4 + 3] = 0;

      // Row 1: [translationX, translationY, translationZ, opacity]
      const r1 = (w + i) * 4;
      data[r1 + 0] = 0;
      data[r1 + 1] = 0;
      data[r1 + 2] = 0;
      data[r1 + 3] = 0;

      // Row 2: [R00, R01, R02, pivot.x] (单位矩阵默认值)
      const r2 = (w * 2 + i) * 4;
      data[r2 + 0] = 1;
      data[r2 + 1] = 0;
      data[r2 + 2] = 0;
      data[r2 + 3] = 0;

      // Row 3: [R10, R11, R12, pivot.y]
      const r3 = (w * 3 + i) * 4;
      data[r3 + 0] = 0;
      data[r3 + 1] = 1;
      data[r3 + 2] = 0;
      data[r3 + 3] = 0;

      // Row 4: [R20, R21, R22, pivot.z]
      const r4 = (w * 4 + i) * 4;
      data[r4 + 0] = 0;
      data[r4 + 1] = 0;
      data[r4 + 2] = 1;
      data[r4 + 3] = 0;

      // Row 5: [pathId, speed, phase, modeFlag] (默认 -1 表示未绑定 GPU 路径)
      const r5 = (w * 5 + i) * 4;
      data[r5 + 0] = -1;
      data[r5 + 1] = 0;
      data[r5 + 2] = 0;
      data[r5 + 3] = 0;
    }

    let hasActive = false;
    const hiddenBatches = new Set<number>();
    const colorOfBatch = new Map<number, string>();
    const elevOfBatch = new Map<number, number>();
    const translationOfBatch = new Map<number, [number, number, number]>();
    const rotationOfBatch = new Map<number, RotationMatrix9>();
    const pivotOfBatch = new Map<number, [number, number, number]>();
    const gpuPathOfBatch = new Map<number, GPUPathOptions>();
    const opacityOfBatch = new Map<number, number>();
    const ownersOfBatch = new Map<number, number>();
    const filter = this.filter;
    const ud = mesh.userData as any;

    for (const [smidStr, entry] of Object.entries(pickInfo)) {
      const smid = Number(smidStr);
      const bId = pickEntryId(entry as any);
      if (bId < 0 || bId >= w) continue;
      ownersOfBatch.set(bId, (ownersOfBatch.get(bId) ?? 0) + 1);

      let hidden = false;
      if (filter) {
        if (filter.include && filter.include.length > 0 && !filter.include.includes(smid)) {
          hidden = true;
        }
        if (filter.exclude && filter.exclude.length > 0 && filter.exclude.includes(smid)) {
          hidden = true;
        }
        if (filter.predicate) {
          const { segments } = resolveFeature(ud.geoRef, bId);
          const box = measureSegments(mesh.geometry, segments);
          const attrs = buildAttributes({
            smid,
            box,
            triangles: 0,
            floorHeight: this._getLayerFloorHeight(),
          });
          if (!filter.predicate({ ...attrs, smid })) {
            hidden = true;
          }
        }
      }

      if (hidden) {
        hiddenBatches.add(bId);
        continue;
      }

      if (this.fieldFilter) {
        const inSet = this.fieldFilter.matched.has(smid);
        if (this.fieldFilter.mode === 'keep' ? !inSet : inSet) {
          hiddenBatches.add(bId);
          continue;
        }
      }

      const st = styleMap.get(smid);
      if (st?.hidden) {
        hiddenBatches.add(bId);
        continue;
      }

      // 单体独立透明度：<= 0 等价 hidden；(0,1) 写入状态纹理第 2 行 alpha；>= 1 不覆盖
      const fade = st?.opacity;
      if (fade != null) {
        if (fade <= 0) {
          hiddenBatches.add(bId);
          continue;
        }
        if (fade < 1 && !opacityOfBatch.has(bId)) opacityOfBatch.set(bId, fade);
      }

      const col = st?.color ?? this.thematicColors.get(smid);
      if (col && !colorOfBatch.has(bId)) colorOfBatch.set(bId, col);

      const elevation = st?.elevation ?? this.thematicElevation.get(smid);
      if (elevation != null && !elevOfBatch.has(bId)) elevOfBatch.set(bId, elevation);

      if (st?.translation && !translationOfBatch.has(bId)) {
        translationOfBatch.set(bId, st.translation);
      }

      if (st?.rotation != null && !rotationOfBatch.has(bId)) {
        const rotMat = resolveRotationMatrix(st.rotation);
        if (rotMat) rotationOfBatch.set(bId, rotMat);
      }
      if (st?.pivot && !pivotOfBatch.has(bId)) {
        pivotOfBatch.set(bId, st.pivot);
      }
      if (st?.gpuPath && !gpuPathOfBatch.has(bId)) {
        gpuPathOfBatch.set(bId, st.gpuPath);
      }
    }

    for (const bId of hiddenBatches) {
      data[bId * 4 + 3] = -1;
      hasActive = true;
    }

    const c = new THREE.Color();
    for (const [bId, col] of colorOfBatch) {
      if (hiddenBatches.has(bId)) continue;
      c.set(col);
      data[bId * 4 + 0] = c.r;
      data[bId * 4 + 1] = c.g;
      data[bId * 4 + 2] = c.b;
      hasActive = true;
    }

    for (const [bId, elevation] of elevOfBatch) {
      if (hiddenBatches.has(bId)) continue;
      data[bId * 4 + 3] = elevation;
      const r1 = (w + bId) * 4;
      data[r1 + 2] = elevation;
      hasActive = true;
    }

    for (const [bId, trans] of translationOfBatch) {
      if (hiddenBatches.has(bId)) continue;
      const r1 = (w + bId) * 4;
      data[r1 + 0] = trans[0];
      data[r1 + 1] = trans[1];
      data[r1 + 2] = trans[2] + (elevOfBatch.get(bId) ?? 0);
      hasActive = true;
    }

    // 单体独立透明度写在第 2 行 alpha：shader 里 0 = 无覆盖，不会误伤未设置的单体
    let hasFade = false;
    for (const [bId, fade] of opacityOfBatch) {
      if (hiddenBatches.has(bId)) continue;
      data[(w + bId) * 4 + 3] = fade;
      hasActive = true;
      hasFade = true;
    }

    for (const [bId, rot] of rotationOfBatch) {
      if (hiddenBatches.has(bId)) continue;
      const piv = pivotOfBatch.get(bId) ?? [0, 0, 0];
      const r2 = (w * 2 + bId) * 4;
      data[r2 + 0] = rot[0];
      data[r2 + 1] = rot[1];
      data[r2 + 2] = rot[2];
      data[r2 + 3] = piv[0];

      const r3 = (w * 3 + bId) * 4;
      data[r3 + 0] = rot[3];
      data[r3 + 1] = rot[4];
      data[r3 + 2] = rot[5];
      data[r3 + 3] = piv[1];

      const r4 = (w * 4 + bId) * 4;
      data[r4 + 0] = rot[6];
      data[r4 + 1] = rot[7];
      data[r4 + 2] = rot[8];
      data[r4 + 3] = piv[2];
      hasActive = true;
    }

    for (const [bId, piv] of pivotOfBatch) {
      if (rotationOfBatch.has(bId) || hiddenBatches.has(bId)) continue;
      data[(w * 2 + bId) * 4 + 3] = piv[0];
      data[(w * 3 + bId) * 4 + 3] = piv[1];
      data[(w * 4 + bId) * 4 + 3] = piv[2];
      hasActive = true;
    }

    // Row 5: 烘焙 GPU 路径动画参数 [pathId, speed, phase, modeFlag]
    for (const [bId, gp] of gpuPathOfBatch) {
      if (hiddenBatches.has(bId)) continue;
      const r5 = (w * 5 + bId) * 4;
      data[r5 + 0] = gp.pathId;
      data[r5 + 1] = gp.speed ?? 0;
      data[r5 + 2] = gp.phase ?? 0;

      let mode = 1; // 1 = loop (默认)
      if (gp.loop === 'clamp' || gp.loop === false) {
        mode = 2;
      } else if (gp.loop === 'pingpong') {
        mode = 3;
      }
      if (gp.autoHeading === false) {
        mode += 3; // 4=loop+noHeading, 5=clamp+noHeading, 6=pingpong+noHeading
      }
      data[r5 + 3] = mode;
      hasActive = true;
    }

    let conflicts = 0;
    for (const [bId, owners] of ownersOfBatch) {
      if (owners < 2) continue;
      if (
        !hiddenBatches.has(bId) &&
        !colorOfBatch.has(bId) &&
        !elevOfBatch.has(bId) &&
        !rotationOfBatch.has(bId) &&
        !gpuPathOfBatch.has(bId)
      ) {
        continue;
      }
      conflicts++;
    }

    return { hasActive, hasFade, conflicts };
  }

  applyOverridesToMesh(mesh: THREE.Mesh): void {
    const mat = styledMaterialOf(mesh);
    if (!mat) return;

    const ud = mesh.userData as any;
    const pickInfo = ud.geoRef?.pickInfo;

    const hasStyles =
      this.featureStyles.size > 0 || this.thematicColors.size > 0 || this.thematicElevation.size > 0;
    const filter = this.filter;
    const hasFilter =
      this.fieldFilter != null ||
      (filter != null &&
        ((filter.include?.length ?? 0) > 0 ||
          (filter.exclude?.length ?? 0) > 0 ||
          filter.predicate != null));

    if (!hasStyles && !hasFilter) {
      if (mat.userData.uBatchTexActive) {
        mat.userData.uBatchTexActive.value = 0;
      }
      // 单体淡化清除后，把材质 transparent 还原成「自身语义 || 全局透明度」
      // （只看全局透明度会把 alphaMode blend / 顶点 alpha 材质误关成不透明）
      if (mat.transparent && !this._isLayerTransparent()) restoreBaseBlendState(mat, false);
      return;
    }

    if (!pickInfo || Object.keys(pickInfo).length === 0) {
      if (mat.userData.uBatchTexActive) {
        mat.userData.uBatchTexActive.value = 0;
      }
      if (mat.transparent && !this._isLayerTransparent()) restoreBaseBlendState(mat, false);
      return;
    }

    let maxBatch = 0;
    for (const p of Object.values(pickInfo)) {
      const id = pickEntryId(p as any);
      if (id > maxBatch) maxBatch = id;
    }
    const width = Math.max(maxBatch + 1, 1);

    let record = this._meshBatchTextures.get(mesh);
    if (!record || record.width < width) {
      const data = new Float32Array(width * 6 * 4);
      const texture = new THREE.DataTexture(data, width, 6, THREE.RGBAFormat, THREE.FloatType);
      texture.minFilter = THREE.NearestFilter;
      texture.magFilter = THREE.NearestFilter;
      record = { texture, data, width };
      this._meshBatchTextures.set(mesh, record);
      mat.userData.uBatchTex.value = texture;
      mat.userData.uBatchTexWidth.value = width;
    }

    const { data, texture } = record;
    const { hasActive, hasFade, conflicts } = this._bakeStylesIntoBuffer(
      data,
      record.width,
      pickInfo,
      mesh,
      this.featureStyles
    );

    // 有淡化单体时整块材质要开混合才有透明效果；清除后还原为「自身语义 || 全局透明度」
    if (hasFade && !mat.transparent) mat.transparent = true;
    else if (!hasFade && mat.transparent && !this._isLayerTransparent()) restoreBaseBlendState(mat, false);

    if (conflicts > 0 && !this._batchConflictWarned) {
      this._batchConflictWarned = true;
      console.warn(
        `[s3m] 有 ${conflicts} 个单体状态写不进独立的 batch（多个 SMID 共用同一个 batchId，\n` +
          '  S3M 的单体化粒度只到 batch，无法单独隐藏/改色其中一部分）。\n' +
          '  当前规则：任一 SMID 需要隐藏则整批隐藏，颜色 / 抬高取首个。\n' +
          '  用 layer.auditBatches() 可以列出具体是哪些 SMID 共用了 batchId。'
      );
    }

    texture.needsUpdate = true;
    if (mat.userData.uBatchTexActive) {
      mat.userData.uBatchTexActive.value = hasActive ? 1 : 0;
    }
  }

  /**
   * 准备双纹理交叉淡化：烘焙目标样式到第二纹理 (uBatchTex2)
   */
  prepareCrossFade(targetStyles: Map<number, FeatureStyle>, meshes: Iterable<THREE.Mesh>): void {
    for (const mesh of meshes) {
      const mat = styledMaterialOf(mesh);
      if (!mat) continue;
      const ud = mesh.userData as any;
      const pickInfo = ud.geoRef?.pickInfo;
      if (!pickInfo || Object.keys(pickInfo).length === 0) continue;

      let maxBatch = 0;
      for (const p of Object.values(pickInfo)) {
        const id = pickEntryId(p as any);
        if (id > maxBatch) maxBatch = id;
      }
      const width = Math.max(maxBatch + 1, 1);

      let record = this._meshBatchTextures.get(mesh);
      if (!record || record.width < width) {
        const data = new Float32Array(width * 6 * 4);
        const texture = new THREE.DataTexture(data, width, 6, THREE.RGBAFormat, THREE.FloatType);
        texture.minFilter = THREE.NearestFilter;
        texture.magFilter = THREE.NearestFilter;
        record = { texture, data, width };
        this._meshBatchTextures.set(mesh, record);
        mat.userData.uBatchTex.value = texture;
        mat.userData.uBatchTexWidth.value = width;
      }

      if (!record.texture2 || !record.data2 || record.data2.length < record.width * 6 * 4) {
        const data2 = new Float32Array(record.width * 6 * 4);
        const texture2 = new THREE.DataTexture(data2, record.width, 6, THREE.RGBAFormat, THREE.FloatType);
        texture2.minFilter = THREE.NearestFilter;
        texture2.magFilter = THREE.NearestFilter;
        record.data2 = data2;
        record.texture2 = texture2;
      }

      // 确保当前纹理包含当前状态
      this._bakeStylesIntoBuffer(record.data, record.width, pickInfo, mesh, this.featureStyles);
      record.texture.needsUpdate = true;

      // 烘焙目标状态到 data2
      const res2 = this._bakeStylesIntoBuffer(record.data2, record.width, pickInfo, mesh, targetStyles);
      record.texture2.needsUpdate = true;

      mat.userData.uBatchTex2.value = record.texture2;
      mat.userData.uBatchTexActive.value = 1;
      if (res2.hasFade && !mat.transparent) mat.transparent = true;
    }
  }

  /**
   * 提交双纹理交叉淡化：将 targetStyles 回写到主状态，并将 data2 复制到 data
   */
  commitCrossFade(targetStyles: Map<number, FeatureStyle>, meshes: Iterable<THREE.Mesh>): void {
    this.featureStyles.clear();
    for (const [k, v] of targetStyles) {
      this.featureStyles.set(k, v);
    }
    for (const mesh of meshes) {
      const mat = styledMaterialOf(mesh);
      if (!mat) continue;
      const record = this._meshBatchTextures.get(mesh);
      if (!record || !record.data2 || !record.texture2) continue;

      record.data.set(record.data2);
      record.texture.needsUpdate = true;
      mat.userData.uBatchTex2.value = mat.userData.uBatchTex.value;
    }
    this._onStyleChanged();
    this._triggerRepaint();
  }

  /**
   * 取消交叉淡化并恢复单一纹理
   */
  cancelCrossFade(meshes: Iterable<THREE.Mesh>): void {
    for (const mesh of meshes) {
      const mat = styledMaterialOf(mesh);
      if (!mat) continue;
      mat.userData.uBatchTex2.value = mat.userData.uBatchTex.value;
    }
    this._triggerRepaint();
  }

  markOverridesDirty(subset?: Iterable<THREE.Mesh>, allMeshes?: Iterable<THREE.Mesh>): void {
    if (subset) {
      for (const m of subset) this._markedMeshes.add(m);
    } else if (allMeshes) {
      for (const m of allMeshes) this._markedMeshes.add(m);
    } else {
      this._dirtyAll = true;
      this._markedMeshes.clear();
    }
    if (this._flushScheduled) return;
    this._flushScheduled = true;
    queueMicrotask(() => this.flushOverrides());
  }

  disposeMesh(mesh: THREE.Mesh): void {
    this._markedMeshes.delete(mesh);
    const record = this._meshBatchTextures.get(mesh);
    if (record) {
      record.texture.dispose();
      record.texture2?.dispose();
      this._meshBatchTextures.delete(mesh);
    }
  }

  flushOverrides(): void {
    if (!this._flushScheduled && !this._dirtyAll && this._markedMeshes.size === 0) return;
    this._flushScheduled = false;
    const applyFn = this._applyOverrideHook ?? ((m: THREE.Mesh) => this.applyOverridesToMesh(m));
    if (this._dirtyAll) {
      this._dirtyAll = false;
      this._markedMeshes.clear();
      const list = this._getAllMeshes ? this._getAllMeshes() : [];
      for (const mesh of list) {
        applyFn(mesh);
      }
      this._triggerRepaint();
      return;
    }
    for (const mesh of this._markedMeshes) {
      applyFn(mesh);
    }
    this._markedMeshes.clear();
    this._triggerRepaint();
  }

  /**
   * 将单体绑定到 GPU 路径动画
   * @param smid 单体 ID
   * @param pathId GPUPathManager 中的路径索引
   * @param options 速度、初始相位、循环模式与自动转向配置
   * @param meshes 可选指定的网格集合，不传则全量生效
   */
  bindGPUPath(
    smid: number,
    pathId: number,
    options: Omit<GPUPathOptions, 'pathId'> = {},
    meshes?: Iterable<THREE.Mesh>
  ): void {
    const cur = this.getFeatureStyle(smid) ?? {};
    this.setFeatureStyle(
      smid,
      {
        ...cur,
        gpuPath: {
          pathId,
          speed: options.speed ?? 0,
          phase: options.phase ?? 0,
          loop: options.loop ?? 'loop',
          autoHeading: options.autoHeading ?? true,
        },
      },
      meshes
    );
  }

  /**
   * 解绑单体的 GPU 路径动画
   */
  unbindGPUPath(smid: number, meshes?: Iterable<THREE.Mesh>): void {
    const cur = this.getFeatureStyle(smid);
    if (!cur || !cur.gpuPath) return;
    const next = { ...cur };
    delete next.gpuPath;
    this.setFeatureStyle(smid, next, meshes);
  }

  /**
   * 直接设置单体在 GPU 路径上的归一化进度（0.0 ~ 1.0）
   * @param smid 单体 ID
   * @param progress 归一化进度 (0~1)
   * @param meshes 可选指定的网格集合
   */
  setGPUPathProgress(smid: number, progress: number, meshes?: Iterable<THREE.Mesh>): void {
    const cur = this.getFeatureStyle(smid);
    if (!cur?.gpuPath) return;
    this.setFeatureStyle(
      smid,
      {
        ...cur,
        gpuPath: {
          ...cur.gpuPath,
          speed: 0,
          phase: Math.min(1.0, Math.max(0.0, progress)),
        },
      },
      meshes
    );
  }
}
