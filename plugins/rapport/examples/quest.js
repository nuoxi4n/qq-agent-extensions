// 外部任务扩展的接入示例；本文件不会注册扩展或模型工具。
// completedQuest 由任务系统校验并持久化，不能直接采用用户/模型传入的对象。
// rapportInput 使用 API.md 中的完整事件快照，创建一次，恢复时不改变。
function client(api) {
  const rapport = api.capability('rapport.v1', { consumer: 'quest' });
  if (rapport?.apiVersion !== 1) throw new Error('好感度通用接口不可用');
  return rapport;
}
function verifiedInput(completedQuest) {
  if (completedQuest?.completed !== true || !completedQuest.rapportInput) throw new Error('任务未完成或缺少已保存的事件输入');
  return completedQuest.rapportInput;
}
export function recordQuestEvent(api, completedQuest) {
  return client(api).recordEvent(verifiedInput(completedQuest));
}
export function rateQuestEvent(api, completedQuest, { delta, reason }) {
  const { scope, userId, eventId } = verifiedInput(completedQuest);
  // delta/reason 由来源工具核验本轮授权后提交；不让模型选择其他用户或业务 ID。
  return client(api).rateEvent({ scope, userId, eventId, delta, reason });
}
