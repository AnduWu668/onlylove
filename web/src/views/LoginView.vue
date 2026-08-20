<script setup lang="ts">
import { ref } from "vue";
import { useRoute, useRouter } from "vue-router";

const route = useRoute();
const router = useRouter();
const email = ref("");
const code = ref("");
const birthDate = ref("");
const challengeId = ref("");
const needsBirthDate = ref(false);
const step = ref<"email" | "code">("email");
const busy = ref(false);
const error = ref("");

const messages: Record<string, string> = {
  INVITATION_REQUIRED: "这个邮箱还没有有效邀请，请联系管理员。",
  OTP_RESEND_TOO_SOON: "验证码发送得太频繁，请稍后再试。",
  INVALID_OTP: "验证码不正确，请重新输入。",
  OTP_EXPIRED: "验证码已过期，请重新获取。",
  OTP_ATTEMPTS_EXCEEDED: "错误次数过多，请重新获取验证码。",
  ADULTS_ONLY: "OnlyLove 仅面向年满 18 岁的成员。",
};

async function post(path: string, body: object) {
  const response = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(messages[data.code] ?? "暂时无法完成，请稍后重试。");
  return data;
}

async function submit() {
  busy.value = true;
  error.value = "";
  try {
    if (step.value === "email") {
      const data = await post("/api/auth/otp", { email: email.value });
      challengeId.value = data.challengeId;
      needsBirthDate.value = data.requiresBirthDate;
      step.value = "code";
      return;
    }

    const data = await post("/api/auth/verify", {
      email: email.value,
      challengeId: challengeId.value,
      code: code.value,
      ...(needsBirthDate.value ? { birthDate: birthDate.value } : {}),
    });
    const requestedRedirect =
      typeof route.query.redirect === "string" ? route.query.redirect : "";
    await router.push(
      requestedRedirect.startsWith("/")
        ? requestedRedirect
        : data.member.role === "super_admin"
          ? "/admin"
          : "/app",
    );
  } catch (caught) {
    error.value = caught instanceof Error ? caught.message : "暂时无法完成。";
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <main class="login-page">
    <section class="brand-block" aria-labelledby="welcome-title">
      <span class="brand-mark" aria-hidden="true">OL</span>
      <p class="eyebrow">ONLYLOVE</p>
      <h1 id="welcome-title">认真了解，再决定靠近</h1>
      <p class="lede">从一封受邀邮件开始，遇见愿意认真理解彼此的人。</p>
    </section>

    <form class="auth-card" @submit.prevent="submit">
      <div>
        <p class="step-label">{{ step === "email" ? "成员登录" : "邮箱验证" }}</p>
        <h2>{{ step === "email" ? "用邮箱继续" : "输入六位验证码" }}</h2>
      </div>
      <template v-if="step === 'email'">
        <label for="email">受邀邮箱</label>
        <input
          id="email"
          v-model="email"
          name="email"
          type="email"
          inputmode="email"
          autocomplete="email"
          placeholder="name@example.com"
          required
        />
      </template>
      <template v-else>
        <p class="sent-to">验证码已发送至 {{ email }}</p>
        <label for="code">邮箱验证码</label>
        <input
          id="code"
          v-model="code"
          name="code"
          type="text"
          inputmode="numeric"
          autocomplete="one-time-code"
          pattern="[0-9]{6}"
          maxlength="6"
          placeholder="000000"
          required
        />
        <template v-if="needsBirthDate">
          <label for="birth-date">出生日期</label>
          <input
            id="birth-date"
            v-model="birthDate"
            name="birth-date"
            type="date"
            autocomplete="bday"
            required
          />
        </template>
      </template>
      <p v-if="error" class="form-error" role="alert">{{ error }}</p>
      <button type="submit" :disabled="busy">
        {{ busy ? "请稍候…" : step === "email" ? "获取验证码" : "进入 OnlyLove" }}
      </button>
      <button
        v-if="step === 'code'"
        class="text-button"
        type="button"
        :disabled="busy"
        @click="step = 'email'"
      >
        更换邮箱或重新获取
      </button>
      <p class="form-note">首次注册仅面向已受邀且年满 18 岁的成员。</p>
    </form>

    <RouterLink class="admin-link" to="/admin">管理入口</RouterLink>
  </main>
</template>
