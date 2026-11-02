# OpenCode managed delivery — 2026-11-02

## 当前结论（2026-11-02，替代下方历史结论）

以下按 parent 本轮同步的状态记录；尚在执行或待执行的检查不计为通过。本文后面的旧状态、阻塞原因、预算和发布门槛均保留为历史，不能覆盖本节。

| 宿主 | 完整原生闭环及网站修正后全新会话采用 | 累计 native/model 入口（含自动提取） |
| --- | --- | ---: |
| Claude Code 2.1.316 | PASS | 5 |
| Codex 0.166.0 | PASS | 6 |
| Pi 1.4.0 | PASS | 5 |
| Hermes 0.21.0 | PASS；实际网页修正 Juniper → Willow → Cedar，旧资产排除 | 历史 6 + 新明确授权 4 = 10 |
| OpenCode 2.0.32 | PASS；现有 DeepSeek 授权，实际网页修正 Dawn → Noon → Dusk，旧资产排除 | 历史 2 + 新授权 4 = 6 |

- 五宿主原生功能验收已完成；旧 Hermes 修正缺口与 OpenCode 提供方阻塞已被补验替代。入口数包括自动提取，不等于提供方账单请求数；没有购买额度或追加未授权调用。详见 [Hermes 最终验收与清理](2026-11-02-final-hermes-continuation.md) 和 [OpenCode 记录](2026-11-02-opencode-delivery.md)。
- 清理已完成：本轮 synthetic owner 1 及 exact manifest 资源 fresh counts 全 0，fixture/owned HOME/provider 副本与两个 stale pointers 已移除，Puma 75303 已停止，8087 connection refused。此前 owner 2 的清理是另一历史轮次。无 drop/flush，无真实 auth/生产数据清理；parent-owned TaskSpace60 未由本 worker 关闭。
- 三语言根 README 已在 `d712641` 提升为公开候选说明；候选分支已 push，main 未合并，未发布 release、未部署。候选分支上的公开说明不等于正式 curl 分发已更新。
- macOS 显式重装 re-enable 修复 `da65089`：先 2 RED 后 2 GREEN；service focused `84/84 PASS`。这是修复与 focused 证据，不能替代新远程 macOS 执行结果。
- parent 同步的未准备 pack artifacts 全量检查点为 `596 tests / 595 pass / 0 fail / 1 skip`。parent 接下来先 pack 再跑全量，要求 `0 skip`；本快照未取得该后续完成结果，不将其标为 PASS。
- 远程 [41400808980](https://github.com/Qumge/37soul-mcp/actions/runs/41400808980) 正在跑（parent 本轮同步：Node 18/20/24 + macOS/Linux），结果待核对。旧 [41399296693](https://github.com/Qumge/37soul-mcp/actions/runs/41399296693) 的 Node 全绿、Linux 真实服务 PASS；macOS 因重装时 disabled 状态失败，已有 `da65089` 修复，等待新远程验证，不回写旧 run 为成功。
- 网站 Singer 工作继续，由 parent 跟进。五宿主功能 PASS 不代替网站其余工作、pack 后零 skip 全测、远程 OS 验收、main 合并或正式发布/部署。

OpenCode 当前为 PASS，替代早期免费提供方 quota 阻塞；parent 使用现有 DeepSeek 授权完成独立 Soul 的真实网页修正闭环并清理，累计 6 入口。后面的 quota 与 attempts=2/5 等记录是当时检查点。

## 历史记录（以下原文保留，旧结论已被顶部替代）

Synthetic Soul; local Rails 8087; browser-approved profile reused. Actual installer with installService:false and foreground agentd. No host trust bypass. OAuth transfer uses private stdin; no secrets or raw session bodies in this report. Model invocation budget is shared and includes automatic extraction; provider-internal retries are not inferred from CLI invocation counts.

```json
{
  "timestamp": "2026-11-02T04:58:55.800Z",
  "runtime_version": "0.14.0",
  "opencode_version": "2.0.32",
  "stage": "prepared",
  "pass": false,
  "managed_install": true,
  "foreground_agentd": true,
  "soul_uid": "5611e0bc-d0ef-4ae6-b9a0-8e5a1f7c3d97",
  "service_installation": false,
  "default_install_closed": false,
  "model": "opencode/deepseek-v4.1-flash-free",
  "attempts": 1,
  "events": [],
  "error_class": null,
  "evidence": null,
  "cleanup": false
}
```

```json
{
  "timestamp": "2026-11-02T04:59:20.130Z",
  "runtime_version": "0.14.0",
  "opencode_version": "2.0.32",
  "stage": "learn_finished",
  "pass": false,
  "managed_install": true,
  "foreground_agentd": true,
  "soul_uid": "5611e0bc-d0ef-4ae6-b9a0-8e5a1f7c3d97",
  "service_installation": false,
  "default_install_closed": false,
  "model": "opencode/deepseek-v4.1-flash-free",
  "attempts": 2,
  "events": [
    {
      "stage": "learn",
      "exit": 1,
      "timeout": false,
      "stdout_bytes": 533,
      "assistant_chars": 0,
      "auth_error": false,
      "model_error": false,
      "plugin_error": false,
      "permission_error": false,
      "readiness_error": false,
      "cli_error": false,
      "answer_sha256": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
    }
  ],
  "error_class": "learn_native_failed",
  "evidence": null,
  "cleanup": false
}
```

## Sanitized diagnosis and limits

The isolated OpenCode 2.0.32 server log classifies the failed learn as AI.Error.QuotaExceeded (free usage limit). No credential or private provider response is reproduced. This is not an inferred CLI, agent-field, plugin-config or readiness error. The old all-false diagnostic projection did not classify quota; the runner now classifies this failure explicitly.

Actual managed evidence: 1 matching OpenCode binding(s), 2 injected receipts; zero completed extraction watermarks, zero assistant characters. Receipts prove hook output only, not model adoption. No learned-asset sync or fresh recall was attempted.

The authenticated catalog succeeded without generation and listed both the selected free model and non-free models. Catalog presence is not proof of quota, balance or subscription entitlement. No alternate model was invoked and no subscription was purchased.

Cumulative model CLI invocations: 2/6 (one pre-existing baseline plus this failed learn); automatic extraction invocations: 0. Resolver verification selected the isolated HOME .opencode/bin/opencode budget gate; --version is exempt and run invocations are atomically charged against the shared ledger. Provider-internal HTTP retries are not independently metered by this CLI gate.

Runner tests: initial 3 RED then 3 GREEN; review follow-up exposed 3 RED (portable home, private quota classification, gate recursion protection), then 5/5 GREEN. Shared dist and production source were not rebuilt or modified. Full suite, correction, publication and deployment were not run by this worker.

```json
{
  "timestamp": "2026-11-02T05:03:21.347Z",
  "runtime_version": "0.14.0",
  "opencode_version": "2.0.32",
  "stage": "learn_finished",
  "pass": false,
  "managed_install": true,
  "foreground_agentd": true,
  "soul_uid": "5611e0bc-d0ef-4ae6-b9a0-8e5a1f7c3d97",
  "service_installation": false,
  "default_install_closed": false,
  "model": "opencode/deepseek-v4.1-flash-free",
  "attempts": 2,
  "events": [
    {
      "stage": "learn",
      "exit": 1,
      "timeout": false,
      "stdout_bytes": 533,
      "assistant_chars": 0,
      "auth_error": false,
      "model_error": false,
      "plugin_error": false,
      "permission_error": false,
      "readiness_error": false,
      "cli_error": false,
      "answer_sha256": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      "error_class": "provider_quota_exceeded"
    },
    {
      "stage": "non_model_diagnosis",
      "error_class": "provider_quota_exceeded",
      "managed_bindings": 1,
      "injected_receipts": 2,
      "completed_watermarks": 0,
      "model_calls_during_diagnosis": 0
    }
  ],
  "error_class": "provider_quota_exceeded",
  "evidence": null,
  "cleanup": true
}
```

## Existing authorization follow-up

Official `opencode auth list --standalone` completed with exit 0; account labels and raw output were suppressed. Read-only credential metadata confirms one active OAuth integration (`opencode`) and no other authorized provider. The authenticated catalog lists other model IDs, but their presence does not establish quota or subscription entitlement. No alternative model request was made, no credits were purchased, and no new authorization was created.

The external `provider_quota_exceeded` blocker remains. Evidence ends at one matching managed binding and two injected receipts, not model consumption, extraction, synced learned assets or fresh-session recall. Product PASS is not asserted. Cumulative invocation count remains 2/6. Independent runner pure tests were rerun: 5/5 passed, zero skipped; runner and test files remain frozen.
