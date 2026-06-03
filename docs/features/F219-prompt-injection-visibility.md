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
**Why（一句话）**：把散落在代码和 L0 模板里的全部 effective prompt 注入段整理成可见可控的 manifest + template 体系，为 Phase 2 生命周期统一抽象和 auto harness 提供基础。

## What

### Prompt Surfaces / Scan Boundary（Phase A manifest 扫描范围）

> Phase A manifest 必须覆盖所有进入 effective prompt 的非用户内容。扫描边界不仅限于 SystemPromptBuilder，还包括 route 拼接层、invocation final mutators、hooks。

| 层 | 入口 | 来源文件 | 段 ID 前缀 |
|----|------|---------|-----------|
| **Compile-time L0** | `compile-system-prompt-l0.mjs` | `assets/system-prompts/system-prompt-l0.md` | L1-L7 |
| **Session-level Builder** | `buildStaticIdentity()` | `SystemPromptBuilder.ts` | S1-S13 |
| **Per-turn Builder** | `buildInvocationContext()` | `SystemPromptBuilder.ts` | D1-D21 |
| **Route 拼接层** | `route-serial.ts` / `route-parallel.ts` | route 文件 + mode config | R1-R2 |
| **Invocation mutators** | `invoke-single-cat.ts` | invocation 文件 | M1-M3 |
| **Session continuity** | `SessionBootstrap.ts` | session 服务 | B1 |
| **MCP fallback** | `McpPromptInjector.ts` | MCP 注入器 | C1 |
| **External hooks** | shell hooks | `.claude/hooks/user-level/` | H1-H3 |
| **Navigation** | `route-helpers.ts` | route helpers | N1-N2 |
| **Legacy (非生产主路径)** | `buildReviewerSection()` / `buildSystemPrompt()` | SystemPromptBuilder.ts | X1 |

> `manifest-drift-check` 的 `@segment` 扫描必须覆盖上述全部层，不仅仅是 SystemPromptBuilder。

### 现状：Effective Prompt Inventory（全量注入段）

> **注意**：inventory 覆盖全部 prompt surfaces：L0 编译段、SystemPromptBuilder、route 拼接层、invocation mutators、session bootstrap、MCP fallback、hooks。"全量"指 effective prompt 中所有非用户消息的注入内容。

#### Native L0（编译期，compile-system-prompt-l0.mjs）

| ID | 段名 | 来源 | 类型 |
|----|------|------|------|
| L1 | 平行世界自我意识 | system-prompt-l0.md §1 原生文本 | **hardcoded** |
| L2 | 客观性 carry-over + F218 常驻反射 | system-prompt-l0.md §2 | **hardcoded** |
| L3 | 传球三选一 + @ 路由规则 | system-prompt-l0.md §4 | **hardcoded** |
| L4 | 五条铁律 | system-prompt-l0.md §5 | **hardcoded** |
| L5 | MCP 工具 quick index | system-prompt-l0.md §7 | **hardcoded** |
| L6 | 能力唤醒指南 | system-prompt-l0.md §8 | **hardcoded** |
| L7 | 协作哲学 | system-prompt-l0.md §9 | **hardcoded** |

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
| D15 | Voice 模式 | voiceMode === true | conditional |
| D16 | Bootcamp 模式 | F087 bootcampState | conditional |
| D17 | Guide 候选 | F155 guide routing | conditional |
| D18 | 世界上下文 | F093 world context | conditional |
| D19 | Constitutional 知识 | F163 always_on | conditional |
| D20 | Signal 文章 | F091 linked articles | conditional |
| D21 | 传球决策树 | non-parallel + a2aEnabled | **hardcoded** |

#### Route 拼接层（route-serial.ts / route-parallel.ts）

| ID | 段名 | 来源 | 触发条件 | 类型 |
|----|------|------|---------|------|
| R1 | Mode System Prompt | route-serial.ts:658, route-parallel.ts:365 | always（per-cat fallback to default）| config-driven |
| R2 | Mode System Prompt (per-cat) | modeSystemPromptByCat config | cat 有独立 mode prompt 时 | config-driven |

#### Invocation Mutators（invoke-single-cat.ts）

| ID | 段名 | 来源 | 触发条件 | 类型 |
|----|------|------|---------|------|
| M1 | Dispatch Mission Context | invoke-single-cat.ts:1043-1062, :1412 | 外部项目 dispatch（非 host project） | rule-generated |
| M2 | Transcript Path Hints | transcript-path-hints.ts + invoke-single-cat.ts:1419 | 活跃会议转录（meta.json active=true）| conditional |

#### Session Continuity（SessionBootstrap.ts）

| ID | 段名 | 来源 | 触发条件 | 类型 |
|----|------|------|---------|------|
| B1 | Session Bootstrap | SessionBootstrap.ts:68-269 | Session #2+（首次 session 返回 null） | rule-generated |

#### MCP Fallback（McpPromptInjector.ts）

| ID | 段名 | 来源 | 触发条件 | 类型 |
|----|------|------|---------|------|
| C1 | MCP Callback Instructions | McpPromptInjector.ts:60-79 | native MCP 不可用 且 非 Antigravity provider | conditional |

#### 外部注入（不经 SystemPromptBuilder）

| ID | 段名 | 来源 | 类型 |
|----|------|------|------|
| N1 | 导航块 | route-helpers formatNavigationHeader | rule-generated |
| N2 | 对话历史增量 | assembleIncrementalContext | rule-generated |
| H1 | Startup Hook 输出 | session-start-recall.sh | hook |
| H2 | PostCompact 注入 | session digest + SOP bookmark | hook |
| H3 | Stop Hook 输出 | session-stop-check.sh | hook（不进 model prompt，是退出治理通知）|

#### Legacy（非生产主路径，显式排除）

| ID | 段名 | 来源 | 说明 |
|----|------|------|------|
| X1 | Reviewer Section | SystemPromptBuilder.ts:905-994 | `buildReviewerSection()` 导出但生产 route 不直接调用（走 buildStaticIdentity + buildInvocationContext）。标记 `legacy/exported-not-runtime`，drift check 排除。若未来 route 恢复调用，需重新纳入 manifest。|

### Phase 1: Manifest + Templates + Visibility + Editability（单一交付）

**目标**：给所有注入段建立 manifest，提取硬编码到模板，Console 完整展示 + 支持编辑覆盖。Phase 1 是 Phase 2 的基础设施。

#### 1. Manifest（`assets/prompt-injection-manifest.yaml`）

每段的完整 schema：

```yaml
segments:
  - id: S6
    name: Workflow Triggers
    category: collaboration          # identity | collaboration | feature-injection | hook | l0-native
    lifecycleStage: session-init     # compile-time | session-init | per-turn | external
    source: packages/api/.../SystemPromptBuilder.ts
    sourceType: hardcoded            # hardcoded | config-driven | rule-generated | conditional | per-project | hook
    trigger: always                  # always | condition description
    purpose: "Declares per-breed workflow triggers"  # developer-facing
    userExplanation: "告诉每只猫在什么情况下应该 @mention 哪位队友"  # CVO-facing
    priority: medium                 # critical | high | medium | low
    safetyTier: editable             # readonly | limited-edit | editable
    transparencyTier: visible-by-default  # visible-by-default | opt-in-view | debug-only
    governanceTier: human-gated      # auto-evolve | human-gated | immutable
    allowLocalOverride: true         # readonly 段必须为 false
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

**`allowLocalOverride` 约束**：`safetyTier: readonly` 的段 **必须** `allowLocalOverride: false`。即使被提取到模板文件（如 D8/D21），也只能可见不可覆盖。

**Safety tier 分配**：

| Tier | 段 | 规则 | allowLocalOverride |
|------|----|------|-------------------|
| `readonly` | S1 身份, S8 CVO 引用, D1 身份锚点, D8 A2A 球权, D21 传球决策树, L1-L7 全部 L0 原生段 | 核心安全/身份/路由，不可编辑不可禁用 | `false` |
| `limited-edit` | S4 协作格式, S5 名册, S9 治理摘要, D5 乒乓球, D7 模式 | 内容可编辑但不可完全禁用 | `true` |
| `editable` | S6 工作流触发, S13 MCP 工具, D14 SOP 提示, H1 Startup Hook, H2 PostCompact, H3 Stop Hook | 完全可编辑 + 可启用/禁用 | `true` |

> **D15 Voice 模式修正**（缅因猫 review）：D15 原来是 always inject，应改为 `trigger: voiceMode === true`（conditional），Voice OFF 时不注入。

**Governance tier 分配**：

| Tier | 含义 | 示例段 |
|------|------|--------|
| `immutable` | 永不自动治理 | S1 身份, D8 A2A 球权, D21 传球决策树, L3 路由规则, L4 铁律 |
| `human-gated` | Auto harness 可提案，人工审批 | S9 治理摘要, D14 SOP 提示, S6 工作流触发, Gate 规则 |
| `auto-evolve` | Auto harness 自主迭代 | D15 Voice 模式, 个人偏好, 习惯约束 |

**Necessity audit**：每段附 "why needed / what breaks without it" 注解。重点清理项：
- **H1 Startup Hook + H3 Stop Hook**：两者都有 "向铲屎官汇报/商量处理方式" 抢球权措辞。核心修复不是"可编辑"，而是**默认降级为 diagnostic notice**（低优先级通知，不抢对话方向）
- **R1/R2 Mode Prompt**：需审查是否与 D7 模式声明有重复注入
- **B1 Session Bootstrap**：2000 token 硬限，需确认 token budget 计算是否考虑了其他段的占用
- 冗余或优先级过高的段标记清理

**Manifest drift contract（AC-4 具体机制）**：
- SystemPromptBuilder 中每个 `lines.push()` 调用点必须用 `/* @segment S6 */` 注释标注 segment ID
- 测试用 AST/regex 扫描 Builder 代码中的 `@segment` 标注，assert 与 manifest 中的 IDs 对齐
- L0 编译器的模板段通过 section heading 标注匹配
- CI 增加 `manifest-drift-check` 作为 lint step

**API**：`GET /api/prompt-injection/manifest` 返回完整 manifest。

#### 2. 硬编码段提取到模板文件

| 段 | 当前位置 | 目标模板 | allowLocalOverride |
|----|---------|---------|-------------------|
| S6 工作流触发点 | `WORKFLOW_TRIGGERS` 常量 | `assets/prompt-templates/workflow-triggers.yaml`（per-breed）| `true` |
| S13 MCP 工具文档 | `MCP_TOOLS_SECTION` 常量 | `assets/prompt-templates/mcp-tools.md` | `true` |
| D8 A2A 球权检查 | inline string | `assets/prompt-templates/a2a-ball-check.md` | **`false`**（readonly） |
| D21 传球决策树 | inline string | `assets/prompt-templates/handoff-decision-tree.md` | **`false`**（readonly） |

> D8/D21 提取到文件是为了可见 + 版本控制 + Phase 2 迁移基础。但 `allowLocalOverride: false` 意味着 Console 展示内容但灰掉编辑按钮。

SystemPromptBuilder 改为从模板文件读取 + 渲染。注入时机不变，只是内容来源从代码迁移到文件。

#### 3. Console 注入面板（可见 + 可编辑）

**扩展 F203 Phase F 的 read-only viewer**：

- **完整清单**：全量段按 category 分组，每段显示 name / userExplanation / 当前内容预览 / source / safetyTier badge / transparencyTier
- **Per-cat 维度**：切换查看不同猫收到的注入内容
- **编辑 + 覆盖**：`allowLocalOverride: true` 段支持 inline 编辑；`readonly` 段展示但灰掉编辑
- **Hook 管理面板**：展示当前 hooks（来自 `~/.claude/settings.json` / `~/.codex/hooks.json`），启用/禁用 toggle（通过受管 Console API 写入，不允许任意脚本编辑），查看最近输出
- **覆盖标记**：每段显示 "customized" vs "default" badge
- **Reset**：删除 `.local` 文件回到默认

**Override 机制（详细）**：
- **路径**：`assets/prompt-templates/{id}.local.{yaml|md}`（与源模板同级）
- **gitignore**：`.local.*` 模式加入 `.gitignore`，避免用户覆盖误进公共源
- **保存前校验**：Console 编辑提交时，运行 compile preview（渲染模板 + overlay → 展示最终注入内容），用户确认后写入
- **Rollback**：每次覆盖前备份到 `.local.bak`，支持一键恢复上一版
- **Builder 读取**：模板文件 → 检查 `.local` overlay → 有则用 overlay → 渲染变量 → push to lines

#### 4. 实现 Checkpoint 顺序（单一交付，分步验证）

> 整体是一个 PR，但按 checkpoint 顺序实现和验证：

| Checkpoint | 内容 | 验证点 |
|------------|------|--------|
| A | Manifest yaml + API + read-only Console UI | manifest-drift-check 绿 + API 返回全量 + UI 展示 |
| B | 模板提取（S6/S13/D8/D21） | 回归测试绿（注入内容不变） |
| C | Overlay 编辑（Console 写 .local + Builder 读 .local） | 编辑 → 保存 → 生效 → reset 回默认 |
| D | Hook 管理面板（enable/disable + 查看输出） | toggle → 配置文件变更 → 下次 session 生效 |

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

- [ ] AC-1: `assets/prompt-injection-manifest.yaml` 覆盖全部 prompt surfaces（L0 native L1-L7 + Builder S1-S13 + D1-D21 + Route R1-R2 + Invocation M1-M2 + Session B1 + MCP C1 + External N1-N2/H1-H3）。Legacy X1 显式排除。
- [ ] AC-2: 每段有完整 schema（id / category / lifecycleStage / source / sourceType / trigger / purpose / userExplanation / priority / safetyTier / transparencyTier / governanceTier / allowLocalOverride / disableable / consumer / relatedFeature）
- [ ] AC-3: `GET /api/prompt-injection/manifest` 返回完整 manifest
- [ ] AC-4: manifest drift check — `@segment` 标注扫描与 manifest IDs 对齐（CI lint step）
- [ ] AC-5: S6 / S13 / D8 / D21 从 .ts 硬编码迁移到模板文件；D8/D21 标记 `allowLocalOverride: false`
- [ ] AC-6: SystemPromptBuilder 从模板文件读取 + 渲染，行为不变（回归测试绿）
- [ ] AC-7: Console 全量段列表完整呈现（分类展示 + userExplanation + safetyTier badge）
- [ ] AC-8: `allowLocalOverride: true` 段支持编辑 + compile preview + 保存 + 生效；readonly 段灰掉编辑
- [ ] AC-9: Hook 管理面板：展示 hooks、enable/disable toggle（通过受管 API）、查看最近输出
- [ ] AC-10: per-cat 维度切换
- [ ] AC-11: `.local.*` 文件 gitignore + 保存前 compile preview + reset/rollback 支持
- [ ] AC-12: H1 Startup Hook 默认措辞降级（移除 "向铲屎官汇报" 抢球权语言 → diagnostic notice）
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
