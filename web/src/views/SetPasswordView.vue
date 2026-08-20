<script setup lang="ts">
import { onMounted, ref } from "vue";
import { useRoute, useRouter } from "vue-router";

type Member = { email: string; role: string };

const route = useRoute();
const router = useRouter();
const member = ref<Member>();
const password = ref("");
const confirmation = ref("");
const loading = ref(true);
const busy = ref(false);
const error = ref("");

function destination(member: Member) {
  const requested =
    typeof route.query.redirect === "string" ? route.query.redirect : "";
  return requested.startsWith("/") && !requested.startsWith("//")
    ? requested
    : member.role === "super_admin"
      ? "/admin"
      : "/app";
}

onMounted(async () => {
  const response = await fetch("/api/session");
  if (!response.ok) {
    await router.replace({ path: "/login", query: route.query });
    return;
  }
  const data = (await response.json()) as {
    member: Member;
    requiresPasswordSetup?: boolean;
  };
  if (!data.requiresPasswordSetup) {
    await router.replace(destination(data.member));
    return;
  }
  member.value = data.member;
  loading.value = false;
});

async function submit() {
  error.value = "";
  if (password.value.length < 6) {
    error.value = "密码至少需要 6 个字符。";
    return;
  }
  if (password.value !== confirmation.value) {
    error.value = "两次输入的密码不一致。";
    return;
  }

  busy.value = true;
  try {
    const response = await fetch("/api/auth/password", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: password.value }),
    });
    const data = await response.json();
    if (!response.ok) {
      throw new Error(
        data.code === "INVALID_PASSWORD"
          ? "密码需要为 6 至 20 个字符。"
          : "密码未保存，请重新验证邮箱后再试。",
      );
    }
    await router.replace(destination(data.member));
  } catch (caught) {
    error.value = caught instanceof Error ? caught.message : "密码未保存。";
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <main class="login-page">
    <section class="brand-block" aria-labelledby="password-title">
      <span class="brand-mark" aria-hidden="true">OL</span>
      <p class="eyebrow">ONLYLOVE</p>
      <h1 id="password-title">为账户设置密码</h1>
      <p class="lede">以后使用邮箱和密码登录；忘记密码时仍可通过邮箱验证码重置。</p>
    </section>

    <p v-if="loading" class="loading-state">正在确认账户…</p>
    <form v-else class="auth-card" @submit.prevent="submit">
      <div>
        <p class="step-label">完成账户保护</p>
        <h2>设置登录密码</h2>
      </div>
      <p class="sent-to">{{ member?.email }}</p>
      <label for="new-password">新密码</label>
      <input
        id="new-password"
        v-model="password"
        type="password"
        autocomplete="new-password"
        minlength="6"
        maxlength="20"
        required
      />
      <label for="confirm-password">确认新密码</label>
      <input
        id="confirm-password"
        v-model="confirmation"
        type="password"
        autocomplete="new-password"
        minlength="6"
        maxlength="20"
        required
      />
      <p v-if="error" class="form-error" role="alert">{{ error }}</p>
      <button type="submit" :disabled="busy">
        {{ busy ? "正在保存…" : "保存密码并继续" }}
      </button>
      <p class="form-note">使用 6 至 20 个字符；不要与其他网站共用密码。</p>
    </form>
  </main>
</template>
