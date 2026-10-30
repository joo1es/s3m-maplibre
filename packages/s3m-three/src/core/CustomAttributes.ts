import type { VertexAttribute, VertexPackage } from './types.js';

/**
 * 根据 descript（来自瓦片内嵌或 config.json 的 vertexAttributeDescript）
 * 将 custom 扩展属性槽（如 custom0, custom1...）重命名为实际的语义名（如 VertexWeight, TextureCoordMatrix）。
 */
export function applyCustomAttributeSemantics(
  vp: VertexPackage,
  extAttrs?: VertexAttribute[],
  configDescript?: unknown
): void {
  const attrsToRemap = extAttrs ?? vp.vertexAttributes.filter((a) => a.semantic.startsWith('custom'));
  if (attrsToRemap.length === 0) return;

  const descript = vp.customVertexAttribute ?? configDescript;

  for (let i = 0; i < attrsToRemap.length; i++) {
    const attr = attrsToRemap[i]!;
    if (!attr.semantic.startsWith('custom')) continue;
    const slotMatch = attr.semantic.match(/^custom(\d+)$/);
    const slot = slotMatch ? parseInt(slotMatch[1]!, 10) : i;

    let category: string | undefined;

    const resolveCategory = (source: unknown): string | undefined => {
      if (!source || typeof source !== 'object') return undefined;
      if (Array.isArray(source)) {
        const item = source[slot];
        if (typeof item === 'string') return item;
        if (item && typeof item === 'object' && typeof item.category === 'string') return item.category;
        return undefined;
      }
      for (const [k, v] of Object.entries(source as Record<string, unknown>)) {
        if (v === slot) return k;
      }
      return undefined;
    };

    category = resolveCategory(descript);
    if (!category && configDescript && configDescript !== descript) {
      category = resolveCategory(configDescript);
    }

    if (category) {
      delete vp.attrLocation[attr.semantic];
      delete vp.attrLocation[`a${attr.semantic}`];
      attr.semantic = category;
      const idx = vp.vertexAttributes.indexOf(attr);
      vp.attrLocation[category] = idx;
      vp.attrLocation[`a${category}`] = idx;
    }
  }
}
