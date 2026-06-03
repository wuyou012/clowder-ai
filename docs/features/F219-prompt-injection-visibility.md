---
feature_ids: [F219]
related_features: [F203, F153, F180, F190, F199, F206]
topics: [system-prompt, hooks, injection, visibility, lifecycle, console, settings, trust, governance]
doc_kind: spec
created: 2026-06-02
updated: 2026-06-03
---

# F219: Prompt Injection Visibility — 注入体系可见可控可编排

> **Status**: in-progress | **Owner**: Ragdoll Opus 4.6 | **Priority**: P1
> **Issue**: [#839](https://github.com/zts212653/clowder-ai/issues/839)

## Why

### 起因事故

thread_mpuxhppp0vzl2y16 中，缅因猫发了标准 review request `@opus47`，但 opus47 被 startup hook 注入的根目录杂物警告带跑偏，花了整条回复分析杂物，**review 球直接丢地上**。铲屎官追问两次后才接球。

### 问题本质

Cat Cafe 的治理能力越来越强（hooks / L0 prompt / skills / dispatch / authorization），但这些能力对用户**既不可见也不可控**：

1. **不可见**：33 个注入段散落在 SystemPromptBuilder.ts + route-serial.ts + route-helpers.ts + shell hooks 里，没有统一 manifest，用户无法知道猫收到了什么
2. **不可控**：修改任何注入内容都需要编辑源码（.ts / .sh / .md），Console 无法操作
3. **不清晰**：各 Feature 各自往 `lines[]` push，没有分类、没有注册机制、没有文档说明每段的作用

### 信任模型（issue #839 讨论成果）

| 当前：Mythic Trust（迷信式信任） | 目标：Epistemic Trust（认知式信任） |
|---|---|
| "猫看起来挺靠谱" | "猫出错了我能看到、能治理" |
| 第一次失败即不可逆地坍缩信任 | 失败可定位：用户能找到哪个注入段劫持了方向 |
| 基于观测到的表现 | 基于可检视的机制 |
| 黑盒 | 透明面 |

**因果链**：完整可见性 → 可审计性 → 可观测性 → 用户敢委托/扩展自治 → Agent 价值天花板提升

### 架构归属

**Architecture cell**: harness/system-prompt-injection + action-plane/settings
**Why（一句话）**：把散落在代码里的 33 个注入段整理成可见可控的 manifest + template 体系，为 Phase 2 生命周期统一抽象和 auto harness 提供基础。

## What

### 现状：注入段全景

#### Static Identity（Session 级，buildStaticIdentity）

| ID | 段名 | 来源 | 类型 |
|----|------|------|------|
| S1 | 身份声明 | cat-catalog.json | config-driven |
| S2 | 硬限制 | cat-catalog.json restrictions | config-driven |
| S3 | Pack Masks | F129 pack blocks | per-project |
| S4 | 协作格式 | 代码生成 from roster | rule-generated |
| S5 | 队友名册 | cat-catalog + getCatModel() | rule-generated |
| S6 | 工作流触发点 | WORKFLOW_TRIGGERS 常量 | **hardcoded** |
| S7 | Pack Workflows | F129 pack blocks | per-project |
| S8 | 铲屎官引用 | co-creator config | config-driven |
| S9 | 治理摘要 | shared-rules.md → governance-l0.ts | rule-generated |
| S10 | Pack Guardrails | F129 pack blocks | per-project |
| S11 | Pack Defaults | F129 pack blocks | per-project |
| S12 | World Driver | F129 pack blocks | per-project |
| S13 | MCP 工具文档 | MCP_TOOLS_SECTION 常量 | **hardcoded** |

#### Dynamic Invocation Context（Per-turn 级，buildInvocationContext）

| ID | 段名 | 触发条件 | 类型 |
|----|------|---------|------|
| D1 | Identity 锚点 | always | rule-generated |
| D2 | 直接消息来源 | directMessageFrom | conditional |
| D3 | 同族分身提醒 | same displayName | conditional |
| D4 | 跨 thread 回复 | F193 cross-post | conditional |
| D5 | 乒乓球警告 | F167 streak ≥2 | conditional |
| D6 | 本次队友 | multi-cat invocation | conditional |
| D7 | 模式声明 | always | rule-generated |
| D8 | A2A 球权检查 | non-parallel + a2aEnabled | **hardcoded** |
| D9 | 路由反馈 | F064 mention miss | conditional |
| D10 | 思维标签 | IntentParser | conditional |
| D11 | Skill 触发 | F140 connector | conditional |
| D12 | 活跃参与者 | F042 participant tracking | conditional |
| D13 | 路由策略 | F042 thread routing policy | conditional |
| D14 | SOP 阶段提示 | F073 workflow-sop | conditional |
| D15 | Voice 模式 | always | config-driven |
| D16 | Bootcamp 模式 | F087 bootcampState | conditional |
| D17 | Guide 候选 | F155 guide routing | conditional |
| D18 | 世界上下文 | F093 world context | conditional |
| D19 | Constitutional 知识 | F163 always_on | conditional |
| D20 | Signal 文章 | F091 linked articles | conditional |
| D21 | 传球决策树 | non-parallel + a2aEnabled | **hardcoded** |

#### 外部注入（不经 SystemPromptBuilder）

| ID | 段名 | 来源 | 类型 |
|----|------|------|------|
| N1 | 导航块 | route-helpers formatNavigationHeader | rule-generated |
| N2 | 对话历史增量 | assembleIncrementalContext | rule-generated |
| H1 | Startup Hook 输出 | session-start-recall.sh | hook |
| H2 | PostCompact 注入 | session digest + SOP bookmark | hook |

### Phase 1: Manifest + Templates + Visibility + Editability（单一交付）

**目标**：给所有注入段建立 manifest，提取硬编码到模板，Console 完整展示 + 支持编辑覆盖。Phase 1 是 Phase 2 的基础设施。

#### 1. Manifest（`assets/prompt-injection-manifest.yaml`）

每段的完整 schema：

```yaml
segments:
  - id: S6
    name: Workflow Triggers
    category: collaboration          # identity | collaboration | feature-injection | hook
    lifecycleStage: session-init     # session-init | per-turn | external
    source: packages/api/.../SystemPromptBuilder.ts
    sourceType: hardcoded            # hardcoded | config-driven | rule-generated | conditional | per-project | hook
    trigger: always                  # always | condition description
    purpose: "Declares per-breed workflow triggers"  # developer-facing
    userExplanation: "告诉每只猫在什么情况下应该 @mention 哪位队友"  # CVO-facing
    priority: medium                 # critical | high | medium | low
    safetyTier: editable             # readonly | limited-edit | editable
    transparencyTier: visible-by-default  # visible-by-default | opt-in-view | debug-only
    governanceTier: human-gated      # auto-evolve | human-gated | immutable
    editable: true
    disableable: false
    consumer: L0-system-prompt       # L0-system-prompt | invocation-context | external-hook
    relatedFeature: null
```

**三轴分类（正交）**：

| 轴 | 回答的问题 | 值域 |
|----|-----------|------|
| `safetyTier` | 人工能不能编辑？ | readonly / limited-edit / editable |
| `transparencyTier` | 用户能不能看到？ | visible-by-default / opt-in-view / debug-only |
| `governanceTier` | Auto harness 能不能自动改？ | auto-evolve / human-gated / immutable |

**Safety tier 分配**：

| Tier | 段 | 规则 |
|------|----|------|
| `readonly` | S1 身份, S8 CVO 引用, D1 身份锚点, D8 A2A 球权, D21 传球决策树 | 核心安全/身份/路由，不可编辑不可禁用 |
| `limited-edit` | S4 协作格式, S5 名册, S9 治理摘要, D5 乒乓球, D7 模式 | 内容可编辑但不可完全禁用 |
| `editable` | S6 工作流触发, S13 MCP 工具, D14 SOP 提示, D15 Voice, H1 Startup Hook, H2 PostCompact | 完全可编辑 + 可启用/禁用 |

**Governance tier 分配**：

| Tier | 含义 | 示例段 |
|------|------|--------|
| `immutable` | 永不自动治理 | S1 身份, D8 A2A 球权, D21 传球决策树, 核心协作规则 |
| `human-gated` | Auto harness 可提案，人工审批 | S9 治理摘要, D14 SOP 提示, S6 工作流触发, Gate 规则 |
| `auto-evolve` | Auto harness 自主迭代 | D15 Voice 模式, 个人偏好, 习惯约束 |

**Necessity audit**：每段附 "why needed / what breaks without it" 注解。冗余或优先级过高的段标记清理（如 H1 的 "向铲屎官汇报" 措辞应降级为低优先级通知）。

**API**：`GET /api/prompt-injection/manifest` 返回完整 manifest。

#### 2. 硬编码段提取到模板文件

| 段 | 当前位置 | 目标模板 |
|----|---------|---------|
| S6 工作流触发点 | `WORKFLOW_TRIGGERS` 常量 | `assets/prompt-templates/workflow-triggers.yaml`（per-breed）|
| S13 MCP 工具文档 | `MCP_TOOLS_SECTION` 常量 | `assets/prompt-templates/mcp-tools.md` |
| D8 A2A 球权检查 | inline string | `assets/prompt-templates/a2a-ball-check.md` |
| D21 传球决策树 | inline string | `assets/prompt-templates/handoff-decision-tree.md` |

SystemPromptBuilder 改为从模板文件读取 + 渲染。注入时机不变，只是内容来源从代码迁移到文件。

#### 3. Console 注入面板（可见 + 可编辑）

**扩展 F203 Phase F 的 read-only viewer**：

- **完整清单**：33 段按 category 分组，每段显示 name / userExplanation / 当前内容预览 / source / safetyTier badge / transparencyTier
- **Per-cat 维度**：切换查看不同猫收到的注入内容
- **编辑 + 覆盖**：editable / limited-edit 段支持 inline 编辑，写入 `.local` overlay 文件（不改源文件）
- **Hook 管理面板**：展示当前 hooks、启用/禁用、查看最近输出
- **覆盖标记**：每段显示 "customized" vs "default" badge
- **Reset**：删除 `.local` 文件回到默认

**Override 机制**：复用 `shared-rules.local.md` 模式：
- Console 编辑 → 写入 `assets/prompt-templates/xxx.local.yaml`
- Builder 读取时：模板文件 → 检查 `.local` overlay → 有则用 overlay

### Phase 2: 会话生命周期统一抽象（Phase 1 完成后）

**前置条件**：Phase 1 的 manifest + 模板 + 可见可控面板提供完整输入。

**方向**：

1. 完整会话生命周期映射，双命名面：
   - `stage.id`（产品面，CVO 可读）：`BeforeRouting / AssemblingContext / BeforeModelCall`
   - `stage.internalHook`（开发 API）：`PreRoute / ContextAssemble / PreInvoke`
2. 统一 handler 接口：content handlers（产生 prompt 段）+ observability handlers（发射 span）共享同一 stage context
3. 将 Phase 1 模板化的段迁移为 lifecycle handlers
4. F153 tracing 作为 observability handler 消费者集成
5. Auto harness 基于 `governanceTier` 决定哪些段可自动迭代

**Phase 2 设计约束（issue #839 讨论确认）**：
- F153 Phase J 的 tool span tracing 必须兼容
- 双命名面确保 CVO 不需要看实现术语
- `governanceTier` 是 auto harness 的边界：immutable 永不碰、human-gated 需审批、auto-evolve 自主

## Acceptance Criteria

### Phase 1（单一交付：Manifest + Templates + Console）

- [ ] AC-1: `assets/prompt-injection-manifest.yaml` 覆盖全部 33 段
- [ ] AC-2: 每段有完整 schema（id / category / lifecycleStage / source / sourceType / trigger / purpose / userExplanation / priority / safetyTier / transparencyTier / governanceTier / editable / disableable / consumer / relatedFeature）
- [ ] AC-3: `GET /api/prompt-injection/manifest` 返回完整 manifest
- [ ] AC-4: manifest 与 SystemPromptBuilder 实际注入保持一致（测试验证）
- [ ] AC-5: S6 / S13 / D8 / D21 从 .ts 硬编码迁移到模板文件
- [ ] AC-6: SystemPromptBuilder 从模板文件读取 + 渲染，行为不变（回归测试绿）
- [ ] AC-7: Console 注入段列表完整呈现（33 段分类展示 + userExplanation）
- [ ] AC-8: 可编辑段支持编辑 + 保存 + 生效（`.local` overlay）
- [ ] AC-9: Hook 管理面板：展示 hooks、启用/禁用
- [ ] AC-10: per-cat 维度切换
- [ ] **AC-Trust**: 非开发者用户，给定 manifest viewer + 一次猫行为异常事件（如 thread_mpuxhppp0vzl2y16 球丢事故），能在 5 分钟内定位：(a) 哪个段最可能导致问题 (b) 能改什么。通过 task-based 可用性测试验证。

### Phase 2（会话生命周期统一抽象）

- [ ] AC-D1: 完整会话生命周期文档（双命名面）
- [ ] AC-D2: 统一 handler 接口定义（content + observability）
- [ ] AC-D3: 现有注入迁移为 lifecycle handler
- [ ] AC-D4: F153 tracing 接口复用验证

## Dependencies

- **Evolved from**: F203（read-only viewer + 消费链标签 → 本 feature 扩展到全量可见可控可编排）
- **Integrates with**: F153（Phase J tracing → Phase 2 observability handler 消费方）
- **Related**: F180（hook health/sync — hook 管理面板消费 F180 sync 能力）
- **Related**: F190/F199/F206（Console settings 基础设施）

## Risk

| 风险 | 缓解 |
|------|------|
| 模板提取后 prompt 行为回归 | 每步回归测试；git revert 通道 |
| 可编辑 prompt 引入 P0 安全风险 | `.local` overlay 不改源文件；核心段 readonly |
| Phase 2 抽象不成熟 | Phase 1 先提供充分输入；Phase 2 独立 Design Gate |

## Resolved Questions

- ~~OQ-1~~: 可编辑边界 → 三轴分类解决（safetyTier + transparencyTier + governanceTier）
- ~~OQ-3~~: 覆盖机制 → `.local` overlay 文件（复用已有模式）
- Manifest 位置 → `assets/prompt-injection-manifest.yaml`
- Console → 扩展现有 F203 viewer（RulesPromptsContent.tsx）
- Hook 编辑 → enable/disable + 查看输出（不编辑脚本内容）

## Open Questions

- OQ-2: Phase 2 统一 hook 接口与现有 Claude Code hooks model 的关系——封装还是替代？（Phase 1 完成后评估）

## Timeline

| 日期 | 事件 |
|------|------|
| 2026-06-02 | Kickoff：thread_mpuxhppp0vzl2y16 分析 + 铲屎官确认方向 |
| 2026-06-02 | Issue #839 创建 → maintainer triage WELCOME / NEEDS-DESIGN |
| 2026-06-02 | Design proposal + trust-first framing + governance tier 讨论收敛 |
| 2026-06-03 | CVO 批准 Phase 1 开工 → spec 刷新 + worktree 创建 |
