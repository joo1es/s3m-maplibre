/**
 * 降级上报：解析成功、但能力不完整的数据要让调用方看得见
 *
 * 分界：**「解析不了」应该抛错，「解析得了但画不出该有的样子」必须显式说明。**
 * 前者是 fail loudly，后者最容易被写成静默降级 —— 用户看到一个能跑但不对的画面，
 * 会去怀疑数据、怀疑网络、怀疑显卡，很难怀疑到「这个分支还没做完」。
 *
 * 目前唯一一类降级是 3DGS：数据里的 `gsScale` / `gsRotation` 已经保留成顶点属性，
 * 但那 4 字节的量化格式没有标定，所以只能按 Points 渲染，画不出 EWA splatting。
 * 详见 `docs/FORMAT-NOTES.md` 第九节。
 *
 * 策略：
 *   'warn'（默认） —— 首次遇到告警一次，画照画。不传参时与旧版行为一致（旧版不抛）。
 *   'throw'        —— 直接拒绝这块瓦片，标 `permanent` 让调度器不要重试。
 *                     给「宁可不出图，也不要出一张错的图」的场景用。
 *   'silent'       —— 只记录到 `stats.degradations`，不告警。给已经自己接管提示的 UI 用。
 */
export type DegradationKind = 'gaussian-splatting-points';

export type UnsupportedPolicy = 'warn' | 'throw' | 'silent';

/** 告警文案要自己解释清楚「看到了什么」和「为什么不对」，不要只说一句 "unsupported" */
const MESSAGES: Record<DegradationKind, string> = {
  'gaussian-splatting-points':
    '[s3m] 数据声明是 3DGS（高斯泼溅），但骨架里没有 gsScale / gsRotation 这两条流，' +
    '只能按点云渲染。这不是数据损坏，但也不是预期的泼溅效果 —— ' +
    '若确认是导出配置问题，可以 unsupported: "throw" 让它直接报错。',
};

export interface DegradationPlan {
  /** 本次新出现的降级项（调用方据此告警） */
  fresh: DegradationKind[];
  /** 合并后的已知清单，写回 `stats.degradations` */
  known: DegradationKind[];
  /** 需要输出的告警文案（`silent` 时为空） */
  messages: string[];
  /** `throw` 策略下要抛的错（已标 `permanent`，调度器不要重试） */
  error?: Error;
}

/**
 * 纯函数：给定「本次遇到的降级项」和「已经报过的」，算出要做什么。
 *
 * 去重是必须的：一个 3DGS 服务一上来几十块瓦片都是同一个原因，
 * 不去重就是几十条一模一样的告警，把真正有用的日志冲掉。
 */
export function planDegradations(
  incoming: readonly DegradationKind[],
  known: readonly DegradationKind[],
  policy: UnsupportedPolicy
): DegradationPlan {
  const knownSet = new Set(known);
  const fresh: DegradationKind[] = [];
  for (const kind of incoming) {
    if (!knownSet.has(kind)) {
      knownSet.add(kind);
      fresh.push(kind);
    }
  }

  const messages = policy === 'warn' ? fresh.map((k) => MESSAGES[k] ?? `[s3m] 降级：${k}`) : [];

  if (policy === 'throw' && fresh.length > 0) {
    const err = new Error(
      `[s3m] 数据包含当前实现不完整的特性，已按 unsupported: "throw" 拒绝：${fresh.join(', ')}。` +
        `详见 docs/FORMAT-NOTES.md`
    ) as Error & { permanent?: boolean };
    // 格式层面的能力缺失，重试一万次也不会变好
    err.permanent = true;
    return { fresh, known: [...knownSet], messages, error: err };
  }

  return { fresh, known: [...knownSet], messages };
}
