# 调查记录协议与历史兼容

模型记录要求由 MCP 托管的各引擎 skill 独立维护，加载当前引擎的 `dbdog/dbm-<engine>/investigation-recording`。调查方法由当前引擎的 investigate skill 定义。使用可用的 skill 读取接口加载当前所需定义；没有托管连接时，以本地实际事件和解析诊断为准，不虚构规范或证据。

新记录使用 assistant 的 dbdog-investigation JSON 事件。checkpoint 记录问题与阶段结果；hypothesis/revise 保存主张历史；branch 明确追问父关系；relation 保存需独立取证的因果与条件关系；check/evidence/update/gap/finish 记录检查、观察解释、判断、缺口和结束。

telemetry.intent 只描述调用目的，可携带 check ID；它不承载完整协议。工具参数描述不会自动把新协议发送给模型。

旧 intent-v2、tags.hypothesis_id 和正文 ledger 的解析仍用于历史 trace 兼容。旧解析器的推断边不能补入新记录的追问树，也不能据此推定因果。混合记录中的未关联节点须明确显示。

图可由 SessionEnd worker 随 root span 上报，server 继续读原有 graph 接口。完整假设/步骤视图保留在 investigation.views；现有控制台仍使用兼容投影，未实现新的双视图页面。
