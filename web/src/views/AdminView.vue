<script setup lang="ts">
import { onMounted, ref } from "vue";
import { useRouter } from "vue-router";

interface Invitation {
  id: string;
  email: string;
  status: "active" | "revoked" | "expired" | "used";
  expiresAt: string;
}

interface RelationshipMetrics {
  dueConnections: number;
  mutualContinue: number;
  noFeedback: number;
  ended: number;
  confirmed: number;
  recoveryPending: number;
  resumed: number;
  mutualContinueRate: number;
}

const router = useRouter();
const email = ref("");
const invitations = ref<Invitation[]>([]);
const busy = ref(false);
const error = ref("");
const candidateCapacity = ref<number | null>(null);
const minimumReciprocalScore = ref<number | null>(null);
const settingsSuccess = ref("");
const ownAgentDailyLimit = ref<number | null>(null);
const candidateTwinDailyLimit = ref<number | null>(null);
const quotaSettingsSuccess = ref("");
const relationshipMetrics = ref<RelationshipMetrics>();

const statusText: Record<Invitation["status"], string> = {
  active: "有效",
  revoked: "已撤销",
  expired: "已过期",
  used: "已使用",
};

async function loadInvitations() {
  const response = await fetch("/api/admin/invitations");
  if (!response.ok) throw new Error("无法读取邀请记录");
  invitations.value = (await response.json()).invitations;
}

async function loadMatchingSettings() {
  const response = await fetch("/api/admin/matching-settings");
  if (!response.ok) throw new Error("无法读取推荐配置");
  const settings = await response.json();
  candidateCapacity.value = settings.candidateCapacity;
  minimumReciprocalScore.value = settings.minimumReciprocalScore;
}

async function loadAgentQuotaSettings() {
  const response = await fetch("/api/admin/agent-quota-settings");
  if (!response.ok) throw new Error("无法读取 Agent 额度配置");
  const settings = await response.json();
  ownAgentDailyLimit.value = settings.ownAgentDailyLimit;
  candidateTwinDailyLimit.value = settings.candidateTwinDailyLimit;
}

async function loadRelationshipMetrics() {
  const response = await fetch("/api/admin/relationship-metrics");
  if (!response.ok) throw new Error("无法读取关系指标");
  relationshipMetrics.value = await response.json();
}

onMounted(async () => {
  const session = await fetch("/api/session");
  if (!session.ok) {
    await router.replace({ path: "/login", query: { redirect: "/admin" } });
    return;
  }
  const { member, requiresPasswordSetup } = await session.json();
  if (requiresPasswordSetup) {
    await router.replace({
      path: "/set-password",
      query: { redirect: "/admin" },
    });
    return;
  }
  if (member.role !== "super_admin") {
    await router.replace("/app");
    return;
  }
  try {
    await Promise.all([
      loadInvitations(),
      loadMatchingSettings(),
      loadAgentQuotaSettings(),
      loadRelationshipMetrics(),
    ]);
  } catch (caught) {
    error.value = caught instanceof Error ? caught.message : "暂时无法读取邀请。";
  }
});

async function saveMatchingSettings() {
  busy.value = true;
  error.value = "";
  settingsSuccess.value = "";
  try {
    const response = await fetch("/api/admin/matching-settings", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        candidateCapacity: candidateCapacity.value,
        minimumReciprocalScore: minimumReciprocalScore.value,
      }),
    });
    if (!response.ok) throw new Error("推荐配置保存失败，请检查填写内容。");
    const settings = await response.json();
    candidateCapacity.value = settings.candidateCapacity;
    minimumReciprocalScore.value = settings.minimumReciprocalScore;
    settingsSuccess.value = "推荐配置已保存，修改记录已写入审计。";
  } catch (caught) {
    error.value = caught instanceof Error ? caught.message : "推荐配置保存失败。";
  } finally {
    busy.value = false;
  }
}

async function saveAgentQuotaSettings() {
  busy.value = true;
  error.value = "";
  quotaSettingsSuccess.value = "";
  try {
    const response = await fetch("/api/admin/agent-quota-settings", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ownAgentDailyLimit: ownAgentDailyLimit.value,
        candidateTwinDailyLimit: candidateTwinDailyLimit.value,
      }),
    });
    if (!response.ok) throw new Error("Agent 额度保存失败，请检查填写内容。");
    const settings = await response.json();
    ownAgentDailyLimit.value = settings.ownAgentDailyLimit;
    candidateTwinDailyLimit.value = settings.candidateTwinDailyLimit;
    quotaSettingsSuccess.value = "Agent 额度已保存，修改记录已写入审计。";
  } catch (caught) {
    error.value = caught instanceof Error ? caught.message : "Agent 额度保存失败。";
  } finally {
    busy.value = false;
  }
}

async function issue() {
  busy.value = true;
  error.value = "";
  try {
    const response = await fetch("/api/admin/invitations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: email.value }),
    });
    if (!response.ok) throw new Error("邀请签发失败，请检查邮箱后重试。");
    await loadInvitations();
    email.value = "";
  } catch (caught) {
    error.value = caught instanceof Error ? caught.message : "邀请签发失败。";
  } finally {
    busy.value = false;
  }
}

async function changeInvitation(invitation: Invitation, action: "revoke" | "reissue") {
  busy.value = true;
  error.value = "";
  try {
    const response = await fetch(
      `/api/admin/invitations/${invitation.id}/${action}`,
      { method: "POST" },
    );
    if (!response.ok) throw new Error("邀请状态已变化，请刷新后重试。");
    await loadInvitations();
  } catch (caught) {
    error.value = caught instanceof Error ? caught.message : "操作失败。";
  } finally {
    busy.value = false;
  }
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}
</script>

<template>
  <main class="admin-page">
    <header class="admin-header">
      <div>
        <p class="eyebrow">ONLYLOVE ADMIN</p>
        <h1>邀请管理</h1>
        <p>为指定邮箱签发七天有效、单次使用的注册准入。</p>
      </div>
      <RouterLink to="/app">成员界面</RouterLink>
    </header>

    <section class="admin-panel">
      <form class="invite-form" @submit.prevent="issue">
        <div>
          <label for="invite-email">成员邮箱</label>
          <input
            id="invite-email"
            v-model="email"
            type="email"
            autocomplete="email"
            placeholder="member@example.com"
            required
          />
        </div>
        <button type="submit" :disabled="busy">签发邀请</button>
      </form>
      <p v-if="error" class="form-error" role="alert">{{ error }}</p>
    </section>

    <section class="admin-panel matching-settings-panel">
      <div class="list-heading">
        <div>
          <h2>候选推荐配置</h2>
          <p>同一个容量同时限制每日新增和未处理候选；低于阈值的人不会用于补数。</p>
        </div>
      </div>
      <form class="matching-settings-form" @submit.prevent="saveMatchingSettings">
        <div>
          <label for="candidate-capacity">每日新增 / 未处理共同容量</label>
          <input id="candidate-capacity" v-model.number="candidateCapacity" type="number" min="1" max="100" required />
        </div>
        <div>
          <label for="minimum-reciprocal-score">最低互惠适合度</label>
          <input id="minimum-reciprocal-score" v-model.number="minimumReciprocalScore" type="number" min="0" max="100" step="0.01" required />
        </div>
        <button type="submit" :disabled="busy || candidateCapacity === null || minimumReciprocalScore === null">保存推荐配置</button>
      </form>
      <p v-if="settingsSuccess" class="save-success" role="status">{{ settingsSuccess }}</p>
    </section>

    <section class="admin-panel matching-settings-panel">
      <div class="list-heading">
        <div>
          <h2>Agent 每日额度</h2>
          <p>候选分身按访客跨候选共享；自己的画像访谈员和恋爱分身共享另一个额度池。</p>
        </div>
      </div>
      <form
        class="matching-settings-form agent-quota-settings-form"
        @submit.prevent="saveAgentQuotaSettings"
      >
        <div>
          <label for="own-agent-daily-limit">自己 Agent 每日额度</label>
          <input
            id="own-agent-daily-limit"
            v-model.number="ownAgentDailyLimit"
            type="number"
            min="1"
            max="10000"
            required
          />
        </div>
        <div>
          <label for="candidate-twin-daily-limit">候选分身每日共享额度</label>
          <input
            id="candidate-twin-daily-limit"
            v-model.number="candidateTwinDailyLimit"
            type="number"
            min="1"
            max="10000"
            required
          />
        </div>
        <button
          type="submit"
          :disabled="
            busy || ownAgentDailyLimit === null || candidateTwinDailyLimit === null
          "
        >
          保存 Agent 额度
        </button>
      </form>
      <p v-if="quotaSettingsSuccess" class="save-success" role="status">
        {{ quotaSettingsSuccess }}
      </p>
    </section>

    <section v-if="relationshipMetrics" class="admin-panel relationship-metrics">
      <div class="list-heading">
        <div>
          <h2>关系生命周期</h2>
          <p>区分七日继续、未反馈、结束、确认关系与恢复推荐状态。</p>
        </div>
      </div>
      <div class="relationship-rate">
        <strong>{{ relationshipMetrics.mutualContinueRate }}%</strong>
        <span>七日双向继续率</span>
      </div>
      <div class="relationship-metric-list">
        <span>到期联系 {{ relationshipMetrics.dueConnections }}</span>
        <span>双方继续 {{ relationshipMetrics.mutualContinue }}</span>
        <span>未反馈 {{ relationshipMetrics.noFeedback }}</span>
        <span>已结束 {{ relationshipMetrics.ended }}</span>
        <span>确认关系 {{ relationshipMetrics.confirmed }}</span>
        <span>待恢复 {{ relationshipMetrics.recoveryPending }}</span>
        <span>已恢复推荐 {{ relationshipMetrics.resumed }}</span>
      </div>
    </section>

    <section class="invitation-list" aria-labelledby="invitation-list-title">
      <div class="list-heading">
        <h2 id="invitation-list-title">邀请记录</h2>
        <span>{{ invitations.length }} 条</span>
      </div>
      <p v-if="!invitations.length" class="empty-state">还没有邀请记录。</p>
      <article v-for="invitation in invitations" :key="invitation.id">
        <div>
          <strong>{{ invitation.email }}</strong>
          <p>有效期至 {{ formatDate(invitation.expiresAt) }}</p>
        </div>
        <span class="status" :data-status="invitation.status">
          {{ statusText[invitation.status] }}
        </span>
        <div class="invitation-actions">
          <button
            v-if="invitation.status === 'active'"
            class="invitation-action"
            type="button"
            :disabled="busy"
            @click="changeInvitation(invitation, 'revoke')"
          >
            撤销
          </button>
          <button
            class="invitation-action"
            type="button"
            :disabled="busy"
            @click="changeInvitation(invitation, 'reissue')"
          >
            重新签发
          </button>
        </div>
      </article>
    </section>
  </main>
</template>
