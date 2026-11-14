/**
 * 数据集级水面特效（`*.water`）的解析。
 *
 * ## 这是什么文件
 *
 * S3M 里有**两层**水面信息，别混：
 *
 * | 来源 | 位置 | 说什么 |
 * |---|---|---|
 * | `103.water` | S3M 块里的纹理单元 id | 「这块几何是水」。块里没有像素（实测 1081 B、textures = 0） |
 * | `*.water` | 数据集 config 的 `extensions.attachFiles` | 「这片水长什么样」：颜色、菲涅尔、噪声、高程 |
 *
 * 以前只认前者，于是整片湖被一个拍脑袋的常量色涂平（见 `GeometryBuilder` 的 `WATER_COLOR`）。
 * 这个文件补上后者。
 *
 * ## 文件格式
 *
 * 纯 XML 文本，SuperMap 沿用了 Ogre3D 的 `SCPDescriptor` 序列化格式：
 *
 * ```xml
 * <SCPDescriptor>
 *   <FileType>WaterEffect</FileType>
 *   <WaterEffect>
 *     <AverageHeight>3.700006</AverageHeight>
 *     <GpuProgramParameters>   <!-- 顶点阶段：scale/scroll/noise/bumpSpeed -->
 *       <GpuConstants><GpuConstantDefinition>…</GpuConstantDefinition></GpuConstants>
 *       <AutoConstants>…</AutoConstants>
 *     </GpuProgramParameters>
 *     <GpuProgramParameters>   <!-- 片元阶段：waterColour/fresnelPower/… -->
 *       …
 *     </GpuProgramParameters>
 *   </WaterEffect>
 * </SCPDescriptor>
 * ```
 *
 * **没有 shader 源码，也没有纹理文件名**。着色器是 SuperMap 客户端内置的
 * Ogre 示例 `FresnelRefractReflect`（本地 SDK 里就有：`IEarth_Qt/Resource/scripts/
 * Fresnel_VP.glsl` + `Fresnel_FP.glsl`）；`ConstType 23` 的三个槽
 * （`noiseMap` / `reflectMap` / `refractMap`）由引擎在运行时提供，
 * 其中后两个是**反射/折射渲染目标**，不是静态贴图。
 *
 * ## 解析口径
 *
 * - 只认 `<FileType>WaterEffect</FileType>`，其余 XML（`.scp`、地形缓存）一律 `null`；
 * - 缺字段、空 `<Float>`、非数字 → 回落官方 Ogre 材质的 `default_params`，
 *   绝不把 NaN 送进材质（NaN 颜色会让整片水面变黑，且不报错，最难查）；
 * - 纯函数、零依赖：不引 XML 库，Worker / Node / 浏览器同一份实现。
 */

/** 解析出来的水面参数。字段名与 `.water` 里的 uniform 同名，方便对照原始文件 */
export interface WaterEffect {
  /**
   * 水面高程（米，数据集局部 ENU 的 z）。来自 `<AverageHeight>`。
   * 实测与 config 的 `rootTiles.boundingbox.center.z` 同源；缺失为 `null`。
   */
  averageHeight: number | null;
  /** 水体基色 RGBA（0..1）。着色器里是「远离视线时的底色」 */
  waterColour: [number, number, number, number];
  /** 折射色偏 RGBA */
  tintColour: [number, number, number, number];
  /** 整体亮度系数，片元最后一步乘上去 */
  waterBrightness: number;
  /** 菲涅尔指数 */
  fresnelPower: number;
  minFresnel: number;
  maxFresnel: number;
  /** 噪声法线扰动强度（屏幕投影 UV 的偏移量） */
  noiseScale: number;
  /** 噪声 UV 缩放：水体纹理由此决定「一米对应多少个 tile」 */
  scale: number;
  /** 噪声滚动量 */
  scroll: number;
  /** 噪声扰动随时间的变化率 */
  noise: number;
  /** 噪声 UV 的漂移速度（u/v 两个分量） */
  bumpSpeed: [number, number];
  /**
   * 这份配置要用到的纹理槽名字（`ConstType 23` = sampler2D）。
   * 典型是 `['noiseMap','reflectMap','refractMap']`。只记录不加载：
   * 其中 reflect / refract 是运行时渲染目标，缺了只能近似。
   */
  samplers: string[];
}

/**
 * 官方默认值，取自 Ogre 示例材质 `Examples-Water.material` 的 `default_params`
 * （`ConvertTool/Original(S3M 1.0)/IEarth_Qt/Resource/scripts/Examples-Water.material`）。
 *
 * 每一段 `GpuProgramParameters` 都可以只写改动的部分，其余由客户端按这里的默认值补 ——
 * 所以解析器必须做同样的兜底，否则「只写了 waterColour 的配置」会被当成全 0。
 */
export const DEFAULT_WATER_EFFECT: Omit<WaterEffect, 'averageHeight' | 'samplers'> = {
  waterColour: [0.1804, 0.2706, 0.3294, 1],
  tintColour: [0, 0.05, 0.05, 1],
  waterBrightness: 0.95,
  fresnelPower: 1.8,
  minFresnel: 0.3,
  maxFresnel: 0.7,
  noiseScale: 0.05,
  scale: 80,
  scroll: 1,
  noise: 1,
  bumpSpeed: [3, -3],
};

/** `ConstType` 里代表采样器的值（Ogre `GCT_SAMPLER2D`） */
const CONST_TYPE_SAMPLER2D = 23;

/** 抓一个 <Tag>…</Tag> 的文本内容（允许 XML 命名空间前缀） */
function tagText(xml: string, tag: string): string | null {
  const m = new RegExp(`<(?:[\\w.-]+:)?${tag}\\b[^>]*>([\\s\\S]*?)</(?:[\\w.-]+:)?${tag}\\s*>`, 'i').exec(xml);
  return m ? m[1]!.trim() : null;
}

/** 归一化数字：非有限值 / 空串一律返回 null，`-0` 归一成 `+0` */
function finiteOrNull(raw: string | null | undefined): number | null {
  if (raw === null || raw === undefined) return null;
  const t = raw.trim();
  if (!t) return null;
  const v = Number(t);
  if (!Number.isFinite(v)) return null;
  // -0 会让快照 / 断言出现「看起来相等但不 Object.is 相等」的幽灵差异
  return v === 0 ? 0 : v;
}

/**
 * 解析一份 `.water` 文本。
 *
 * 不是水面特效配置（无 `WaterEffect` 标记）时返回 `null` —— 调用方据此保持旧路径。
 */
export function parseWaterEffect(text: string): WaterEffect | null {
  if (typeof text !== 'string') return null;
  const xml = text.trim();
  // 必须以 XML 开头，且带 WaterEffect 标记：`.scp` / 地形缓存 / JSON 都挡在这里
  if (!xml.startsWith('<')) return null;
  if (!/<(?:[\w.-]+:)?FileType\b[^>]*>\s*WaterEffect\s*</i.test(xml)) return null;
  if (!/<(?:[\w.-]+:)?WaterEffect\b/i.test(xml)) return null;

  const out: WaterEffect = {
    averageHeight: finiteOrNull(tagText(xml, 'AverageHeight')),
    ...DEFAULT_WATER_EFFECT,
    // 元组要复制，否则所有实例共享同一个数组引用，改一个全变
    waterColour: [...DEFAULT_WATER_EFFECT.waterColour] as WaterEffect['waterColour'],
    tintColour: [...DEFAULT_WATER_EFFECT.tintColour] as WaterEffect['tintColour'],
    bumpSpeed: [...DEFAULT_WATER_EFFECT.bumpSpeed] as WaterEffect['bumpSpeed'],
    samplers: [],
  };

  // 逐个 GpuConstantDefinition 收集：顶点段与片元段的常量名不重复，合并成一张表
  const defs = xml.matchAll(
    /<(?:[\w.-]+:)?GpuConstantDefinition\b[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?GpuConstantDefinition\s*>/gi
  );
  for (const m of defs) {
    const body = m[1]!;
    const name = tagText(body, 'Name');
    if (!name) continue;

    const constType = finiteOrNull(tagText(body, 'ConstType'));
    const floats = [...body.matchAll(/<(?:[\w.-]+:)?Float\b[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?Float\s*>/gi)].map((f) =>
      finiteOrNull(f[1])
    );

    if (constType === CONST_TYPE_SAMPLER2D) {
      if (!out.samplers.includes(name)) out.samplers.push(name);
      continue;
    }

    // 向量按分量数校验：少一个分量就整体丢弃，半个颜色比没有颜色更糟
    const vec4 = (fallback: [number, number, number, number]): [number, number, number, number] => {
      if (floats.length !== 4 || floats.some((v) => v === null)) return fallback;
      return floats as [number, number, number, number];
    };

    switch (name) {
      case 'waterColour':
        out.waterColour = vec4([...DEFAULT_WATER_EFFECT.waterColour] as WaterEffect['waterColour']);
        break;
      case 'tintColour':
        out.tintColour = vec4([...DEFAULT_WATER_EFFECT.tintColour] as WaterEffect['tintColour']);
        break;
      case 'bumpSpeed': {
        const ok = floats.length === 2 && floats.every((v) => v !== null);
        out.bumpSpeed = ok
          ? [floats[0]!, floats[1]!]
          : ([...DEFAULT_WATER_EFFECT.bumpSpeed] as WaterEffect['bumpSpeed']);
        break;
      }
      default: {
        // 标量：只认第一个有限值
        const v = floats[0];
        if (v === null || v === undefined) break;
        if (name in DEFAULT_WATER_EFFECT) {
          (out as unknown as Record<string, number>)[name] = v;
        }
      }
    }
  }

  return out;
}
