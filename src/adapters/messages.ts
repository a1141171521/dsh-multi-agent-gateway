/**
 * 「上游不支持」这类结论的统一措辞。
 *
 * 为什么单独一个文件：这类文案会同时出现在 **UI、日志、任务流水、工具结果**
 * 四个地方。散落各处就一定会漂。集中在这里，改一次四处都对。
 *
 * 措辞的三条纪律：
 *   1. **说清是哪个 Agent 的哪个能力** —— 用户要能一眼对上自己的账号；
 *   2. **说清「这不是故障」** —— 否则用户会去查日志找不存在的错；
 *   3. **给出下一步** —— 能配的地方告诉他去哪配。
 */

/** `「OpenCode」的上游没有「每日签到」接口（不是故障）`。 */
export function unsupportedReason(agentName: string, capability: string): string {
  return `「${agentName}」的上游没有「${capability}」接口（这不是故障）`
}

/** 凭证缺失。 */
export function missingCredentialReason(agentName: string, ref: string): string {
  return `「${agentName}」账号缺少凭证：${ref} 为空。请到「设置 → 插件 → 多 Agent 网关」里补上`
}

/** 上游明确拒绝（权限不足）。 */
export function permissionReason(agentName: string, detail: string): string {
  return `「${agentName}」的凭证权限不足：${detail}`
}

/** 探测失败。 */
export function probeFailedReason(agentName: string, capability: string, detail: string): string {
  return `「${agentName}」的「${capability}」探测失败：${detail}`
}
