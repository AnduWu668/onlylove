<script setup lang="ts">
import { ref } from "vue";
import { useRoute, useRouter } from "vue-router";

type Member = { email: string; role: string };
type Step = "password" | "email" | "code";

const route = useRoute();
const router = useRouter();
const email = ref("");
const password = ref("");
const code = ref("");
const birthDate = ref("");
const challengeId = ref("");
const needsBirthDate = ref(false);
const step = ref<Step>("password");
const busy = ref(false);
const error = ref("");

const messages: Record<string, string> = {
  INVITATION_REQUIRED: "这个邮箱还没有有效邀请，请联系管理员。",
  OTP_RESEND_TOO_SOON: "验证码发送得太频繁，请稍后再试。",
  INVALID_OTP: "验证码不正确，请重新输入。",
  OTP_EXPIRED: "验证码已过期，请重新获取。",
  OTP_ATTEMPTS_EXCEEDED: "错误次数过多，请重新获取验证码。",
  ADULTS_ONLY: "OnlyLove 仅面向年满 18 岁的成员。",
  INVALID_CREDENTIALS: "邮箱或密码不正确。尚未设置或忘记密码时，请使用验证码。",
};

async function post(path: string, body: object) {
  const response = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok) {
    throw new Error(messages[data.code] ?? "暂时无法完成，请稍后重试。");
  }
  return data;
}

function redirectFor(member: Member) {
  const requested =
    typeof route.query.redirect === "string" ? route.query.redirect : "";
  return requested.startsWith("/") && !requested.startsWith("//")
    ? requested
    : member.role === "super_admin"
      ? "/admin"
      : "/app";
}

function useEmailCode() {
  error.value = "";
  password.value = "";
  step.value = "email";
}

async function submit() {
  busy.value = true;
  error.value = "";
  try {
    if (step.value === "password") {
      const data = await post("/api/auth/login", {
        email: email.value,
        password: password.value,
      });
      await router.push(redirectFor(data.member));
      return;
    }

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
    await router.push({
      path: "/set-password",
      query: { redirect: redirectFor(data.member) },
    });
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
        <p class="step-label">
          {{ step === "password" ? "成员登录" : step === "email" ? "账户验证" : "邮箱验证" }}
        </p>
        <h2>
          {{ step === "password" ? "使用密码登录" : step === "email" ? "首次登录或找回密码" : "输入六位验证码" }}
        </h2>
      </div>

      <template v-if="step === 'password' || step === 'email'">
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
        <template v-if="step === 'password'">
          <label for="password">密码</label>
          <input
            id="password"
            v-model="password"
            name="password"
            type="password"
            autocomplete="current-password"
            required
          />
        </template>
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
        {{ busy ? "请稍候…" : step === "password" ? "登录" : step === "email" ? "获取验证码" : "验证邮箱" }}
      </button>
      <button
        v-if="step === 'password'"
        class="text-button"
        type="button"
        :disabled="busy"
        @click="useEmailCode"
      >
        首次登录或忘记密码
      </button>
      <button
        v-else
        class="text-button"
        type="button"
        :disabled="busy"
        @click="step = step === 'code' ? 'email' : 'password'"
      >
        {{ step === "code" ? "更换邮箱或重新获取" : "返回密码登录" }}
      </button>
      <p class="form-note">首次注册仅面向已受邀且年满 18 岁的成员。</p>
    </form>

    <RouterLink class="admin-link" to="/admin">管理入口</RouterLink>
  </main>
</template>
